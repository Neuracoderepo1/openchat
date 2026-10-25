// Two Minds — conversation engine.
// Runs on a server (never in the browser). Survives crashes: every completed turn is
// persisted atomically with the next speaker, and a lease prevents two workers talking at once.
//
// Boundary: connects as the `engine_worker` role, which has no grants on comments,
// reactions or reports. This process never receives observer input.

import pg from 'pg';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { makeProvider, QuotaError } from './providers.mjs';
import { buildRequest, cleanOutput, isRepetitive, parseSummary, summaryRequest, pickSeed, isNarrative, looksLikeLeak } from './prompts.mjs';

const env = process.env;
const DATABASE_URL = env.WORKER_DATABASE_URL;
if (!DATABASE_URL) { console.error('WORKER_DATABASE_URL is required'); process.exit(1); }

const OWNER = `${process.env.RENDER_INSTANCE_ID || 'local'}-${randomUUID().slice(0, 8)}`;
const MIN_TURN_MS = Number(env.MIN_TURN_SECONDS ?? 3) * 1000;   // pacing; keeps free tiers alive longer
const CONTEXT_TURNS = Number(env.CONTEXT_TURNS ?? 14);
const SUMMARY_EVERY = Number(env.SUMMARY_EVERY ?? 20);
const PIVOT_EVERY = Number(env.PIVOT_EVERY ?? 40);                // forced topic change cadence (0 = off)
let forcePivotOnce = false;                                        // set when memory is reset at boot
const LEASE_MS = 90_000;
const MAX_BACKOFF_MS = Number(env.MAX_BACKOFF_MINUTES ?? 10) * 60_000;
const DAILY_TURN_CAP = Number(env.DAILY_TURN_CAP ?? 0);          // 0 = unlimited; set to cap spend/usage

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3, ssl: env.PGSSL === 'disable' ? false : { rejectUnauthorized: false } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (text, params) => pool.query(text, params);
const log = (...a) => console.log(new Date().toISOString(), ...a);

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; log('shutdown requested'); });

async function setStatus(status, detail = null, resumeAt = null) {
  await q('update public.engine_status set status=$1, detail=$2, resume_at=$3, updated_at=now() where id=1', [status, detail, resumeAt]);
}

async function acquireLease() {
  const r = await q(
    `update engine.state set lease_owner=$1, lease_until=now() + ($2 || ' milliseconds')::interval
     where id=1 and (lease_owner is null or lease_owner=$1 or lease_until < now()) returning id`,
    [OWNER, LEASE_MS]);
  return r.rowCount === 1;
}

async function loadAgents() {
  const rows = (await q('select * from public.agents')).rows;
  const byKey = Object.fromEntries(rows.map((a) => [a.key, a]));
  if (!byKey.explorer || !byKey.challenger) throw new Error('agents not seeded');
  const providers = {
    explorer: makeProvider(byKey.explorer),
    challenger: makeProvider(byKey.challenger),
  };
  return { byKey, providers };
}

async function sleepInterruptible(ms) {
  const end = Date.now() + ms;
  while (!stopping && Date.now() < end) {
    await sleep(Math.min(20_000, end - Date.now()));
    if (!(await acquireLease())) throw new Error('lost lease');   // keeps lease alive while paused
  }
}

async function maybeSummarise({ turnNo, agents, state, recentFull }) {
  if (turnNo === 0 || turnNo % SUMMARY_EVERY !== 0) return state;
  try {
    const reqs = summaryRequest(state.summary, recentFull.slice(-SUMMARY_EVERY));
    const text = await agents.providers.challenger.generate(reqs);
    const s = parseSummary(text);
    if (s.topic) await q('insert into public.topics(start_turn,label) values ($1,$2)', [Math.max(1, turnNo - SUMMARY_EVERY + 1), s.topic]);
    await q('update engine.state set summary=$1, open_threads=$2 where id=1 and lease_owner=$3', [s.summary || state.summary, s.openThreads, OWNER]);
    return { ...state, summary: s.summary || state.summary, open_threads: s.openThreads };
  } catch (e) {
    if (e instanceof QuotaError) throw e;   // let the main loop handle pausing
    log('summary failed (non-fatal):', e.message);
    return state;
  }
}

async function turn(agents) {
  const state = (await q('select * from engine.state where id=1')).rows[0];
  const recentDesc = (await q('select turn_no, agent_key, content from public.messages order by turn_no desc limit $1', [Math.max(CONTEXT_TURNS, SUMMARY_EVERY)])).rows;
  const recentFull = recentDesc.slice().reverse();
  const recent = recentFull.slice(-CONTEXT_TURNS);
  const lastTurn = recentFull.length ? Number(recentFull[recentFull.length - 1].turn_no) : 0;
  const turnNo = lastTurn + 1;

  // Self-heal: speaker is always derived from the transcript, so a crash can't desync it.
  const speakerKey = lastTurn === 0 ? 'explorer' : (recentFull[recentFull.length - 1].agent_key === 'explorer' ? 'challenger' : 'explorer');
  const agent = agents.byKey[speakerKey];
  const other = agents.byKey[speakerKey === 'explorer' ? 'challenger' : 'explorer'];

  if (DAILY_TURN_CAP > 0) {
    const n = (await q("select count(*)::int n from public.messages where created_at > now() - interval '24 hours'")).rows[0].n;
    if (n >= DAILY_TURN_CAP) {
      await setStatus('paused', 'Daily usage budget reached — resuming automatically', new Date(Date.now() + 15 * 60_000));
      await sleepInterruptible(15 * 60_000);
      return 'capped';
    }
  }

  // Steer to a new real-world subject when: memory was just reset, on a fixed cadence, or when talk turns repetitive.
  const cooled = turnNo > Number(state.pivot_until_turn);
  const drifting = cooled && (isRepetitive(recentFull) || isNarrative(recentFull));
  const pivot = forcePivotOnce || (PIVOT_EVERY > 0 && turnNo % PIVOT_EVERY === 0) || drifting;
  forcePivotOnce = false;
  if (pivot) {
    // Fresh start for the new subject: drop stale summary/threads so old scenes can't pull the talk back.
    await q("update engine.state set pivot_until_turn=$1, summary='', open_threads='' where id=1", [turnNo + 8]);
    state.summary = ''; state.open_threads = '';
  }

  await setStatus('thinking', `${agent.name} is thinking`);
  const req = buildRequest({ agent, other, summary: state.summary, openThreads: state.open_threads, recent: pivot ? recent.slice(-2) : recent, pivot, seed: pivot ? pickSeed() : null, isOpening: lastTurn === 0 });
  const raw = await agents.providers[speakerKey].generate(req);
  const text = cleanOutput(raw, agent.name, other.name);
  if (!text) throw new Error('empty output after cleaning');
  if (looksLikeLeak(text)) throw new Error('model output looked like leaked reasoning; discarded');

  // Persist the turn only if we still hold the lease. turn_no PK blocks duplicates.
  const client = await pool.connect();
  try {
    await client.query('begin');
    const lease = await client.query('select 1 from engine.state where id=1 and lease_owner=$1 and lease_until > now() for update', [OWNER]);
    if (!lease.rowCount) throw new Error('lease lost before commit');
    await client.query('insert into public.messages(turn_no, agent_key, content) values ($1,$2,$3)', [turnNo, speakerKey, text]);
    await client.query('update engine.state set next_agent=$1 where id=1', [speakerKey === 'explorer' ? 'challenger' : 'explorer']);
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    if (e.code === '23505') { log(`turn ${turnNo} already exists, skipping`); return 'dup'; }
    throw e;
  } finally { client.release(); }

  log(`#${turnNo} ${speakerKey}: ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`);
  await setStatus('talking', null);
  recentFull.push({ turn_no: turnNo, agent_key: speakerKey, content: text });
  await maybeSummarise({ turnNo, agents, state, recentFull });
  return 'ok';
}

// Tiny health endpoint so hosts that require an open port (e.g. Render web services) keep us alive.
if (env.PORT) {
  http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); }).listen(Number(env.PORT));
}
// Free web services sleep after ~15 min without inbound traffic. Request our own public URL
// every 10 minutes so the host sees traffic and keeps the worker awake. No-op when not on Render.
if (env.RENDER_EXTERNAL_URL) {
  setInterval(() => { fetch(env.RENDER_EXTERNAL_URL).catch(() => {}); }, 10 * 60_000).unref?.();
}

async function main() {
  log('worker starting as', OWNER);
  if (env.RESET_MEMORY === '1') {
    // One-off: discard the rolling summary/open threads (e.g. after the conversation drifted into fiction).
    await q("update engine.state set summary='', open_threads='', pivot_until_turn=0 where id=1");
    forcePivotOnce = true;
    log('memory reset requested: summary cleared, next turn pivots to a new subject');
  }
  let agents = await loadAgents();
  let failures = 0;
  let quotaStreak = 0;

  while (!stopping) {
    try {
      if (!(await acquireLease())) { await setStatus('recovering', 'Another worker holds the lease'); await sleep(30_000); continue; }
      const started = Date.now();
      const res = await turn(agents);
      failures = 0; quotaStreak = 0;
      if (res === 'ok' || res === 'dup') await sleepInterruptible(Math.max(0, MIN_TURN_MS - (Date.now() - started)));
    } catch (e) {
      if (e instanceof QuotaError) {
        quotaStreak++;
        // Respect Retry-After when given; otherwise exponential backoff up to MAX_BACKOFF.
        const wait = Math.min(MAX_BACKOFF_MS, (e.retryAfterMs != null ? e.retryAfterMs + 1000 : 30_000 * 2 ** Math.min(quotaStreak - 1, 8)));
        const resumeAt = new Date(Date.now() + wait);
        log(`quota/rate limit (${e.message}); pausing ${Math.round(wait / 1000)}s`);
        await setStatus('paused', 'Paused — awaiting model availability. State saved; resuming automatically.', resumeAt).catch(() => {});
        try { await sleepInterruptible(wait); } catch { /* lease lost; loop will re-evaluate */ }
      } else {
        failures++;
        const wait = Math.min(300_000, 5_000 * 2 ** Math.min(failures, 6));
        log('error:', e.message, `— retry in ${Math.round(wait / 1000)}s`);
        await setStatus('recovering', 'Recovering from an error', new Date(Date.now() + wait)).catch(() => {});
        await sleep(wait);
        try { agents = await loadAgents(); } catch (e2) { log('reload agents failed:', e2.message); }   // pick up model/provider changes made in the database
      }
    }
  }
  await q('update engine.state set lease_owner=null, lease_until=null where id=1 and lease_owner=$1', [OWNER]).catch(() => {});
  await setStatus('paused', 'Worker restarting').catch(() => {});
  await pool.end();
  log('bye');
}

main().catch((e) => { console.error(e); process.exit(1); });
