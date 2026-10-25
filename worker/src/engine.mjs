// Two Minds — conversation engine (lease-fenced).
// index.mjs only wires environment + process signals; all logic lives here so it can be tested
// against a real PostgreSQL instance.
//
// Boundary (unchanged): the engine connects as `engine_worker`, which has no grants on comments,
// reactions or reports. This module never reads observer input.
//
// Safety model: heartbeat keeps the lease alive, but correctness comes from the database. Every
// worker-owned write is conditional on (lease_owner, fence token, lease_until > now()) and
// is treated as failed if it affects no row. No DB transaction is held open across a model call.

import { makeProvider as defaultMakeProvider, QuotaError } from './providers.mjs';
import { buildRequest, cleanOutput, isRepetitive, parseSummary, summaryRequest, pickSeed, isNarrative, looksLikeLeak } from './prompts.mjs';
import { Lease, LeaseLostError, fencePredicate, raceAbort, withTimeout } from './lease.mjs';

export class ShutdownError extends Error { constructor(m = 'shutting down') { super(m); this.name = 'ShutdownError'; } }

const MIN_QUOTA_WAIT_MS = 5_000;   // floor: a bad/zero/negative Retry-After can never cause a tight loop

export function redact(s) {
  return String(s ?? '')
    .replace(/(AIza[0-9A-Za-z_-]{20,}|gsk_[0-9A-Za-z]{16,}|sk-[0-9A-Za-z_-]{16,}|Bearer\s+\S+|postgres(?:ql)?:\/\/\S+)/g, '[redacted]')
    .replace(/\s+/g, ' ').slice(0, 200);
}

export function errorCategory(e) {
  if (e instanceof QuotaError) return 'rate_limit';
  if (e instanceof LeaseLostError) return 'lease_lost';
  if (e instanceof ShutdownError) return 'shutdown';
  const m = String(e?.message ?? '');
  if (e?.name === 'TimeoutError' || /timed out|aborted due to timeout/i.test(m)) return 'timeout';
  if (e?.code && /^[0-9A-Z]{5}$/.test(String(e.code))) return 'database';
  if (/ECONNREFUSED|ECONNRESET|terminating connection|Connection terminated|connection/i.test(m) && e?.syscall !== 'fetch') return 'database';
  if (/empty|leak/i.test(m)) return 'model_output';
  return 'error';
}

export function configFromEnv(env = process.env) {
  return {
    minTurnMs: Number(env.MIN_TURN_SECONDS ?? 3) * 1000,
    contextTurns: Number(env.CONTEXT_TURNS ?? 14),
    summaryEvery: Number(env.SUMMARY_EVERY ?? 20),
    pivotEvery: Number(env.PIVOT_EVERY ?? 40),
    leaseMs: Number(env.LEASE_MS ?? 90_000),
    maxBackoffMs: Number(env.MAX_BACKOFF_MINUTES ?? 10) * 60_000,
    dailyTurnCap: Number(env.DAILY_TURN_CAP ?? 0),   // turn-COUNT limit per rolling 24h; 0 = unlimited. Not a spend cap.
    providerTimeoutMs: Number(env.PROVIDER_TIMEOUT_SECONDS ?? 60) * 1000,
    shutdownGraceMs: Number(env.SHUTDOWN_GRACE_SECONDS ?? 20) * 1000,
    acquireRetryMs: 30_000,
    resetMemory: env.RESET_MEMORY === '1',
  };
}

export function createEngine({ pool, owner, config, makeProvider = defaultMakeProvider, log = (...a) => console.log(new Date().toISOString(), ...a) }) {
  const cfg = { ...configFromEnv({}), ...config };
  const lease = new Lease({ pool, owner, leaseMs: cfg.leaseMs, log });
  const shutdownAc = new AbortController();
  const graceAc = new AbortController();
  let stopping = false;
  let forcePivotOnce = false;
  let pendingReset = cfg.resetMemory;

  const q = (text, params) => pool.query(text, params);

  // ---------- fenced writes ----------
  async function setStatus(status, detail = null, resumeAt = null) {
    // Single statement joined to the lease row: writes only if we are the current owner.
    await lease.fencedExec(
      `update public.engine_status s set status=$1, detail=$2, resume_at=$3, updated_at=now()
       from engine.state e where s.id=1 and ${fencePredicate('e', 4, 5)}`,
      [status, detail, resumeAt], 'status update');
  }

  // Run fn(client) in a transaction that first locks the lease row and re-validates ownership.
  // Used only for short writes; never held across a model call.
  async function fencedTx(fn, what) {
    if (lease.lost) throw new LeaseLostError(`lease lost before ${what}`);
    const client = await pool.connect();
    try {
      await client.query('begin');
      const l = await client.query(
        'select 1 from engine.state where id=1 and lease_owner=$1 and fence=$2 and lease_until > clock_timestamp() for update',
        [owner, lease.fence]);
      if (!l.rowCount) { lease.lost = true; throw new LeaseLostError(`lease lost before ${what}`); }
      const out = await fn(client);
      await client.query('commit');
      return out;
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally { client.release(); }
  }

  async function loadAgents() {
    const rows = (await q('select * from public.agents')).rows;
    const byKey = Object.fromEntries(rows.map((a) => [a.key, a]));
    if (!byKey.explorer || !byKey.challenger) throw new Error('agents not seeded');
    return { byKey, providers: { explorer: makeProvider(byKey.explorer), challenger: makeProvider(byKey.challenger) } };
  }

  // ---------- sleeping / heartbeat scoping ----------
  // Resolves early on shutdown; rejects if the lease signal aborts.
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (ms <= 0) return resolve();
      const t = setTimeout(done, ms);
      const onShutdown = () => done();
      const onLease = () => { clearTimeout(t); cleanup(); reject(signal.reason ?? new LeaseLostError()); };
      function cleanup() { shutdownAc.signal.removeEventListener('abort', onShutdown); signal?.removeEventListener('abort', onLease); }
      function done() { clearTimeout(t); cleanup(); resolve(); }
      shutdownAc.signal.addEventListener('abort', onShutdown, { once: true });
      if (signal) { if (signal.aborted) return onLease(); signal.addEventListener('abort', onLease, { once: true }); }
    });
  }

  // Heartbeat runs for the whole scope (turn, provider call, summary, or pause); cleanup is awaited.
  async function withHeartbeat(fn) {
    const hb = lease.startHeartbeat();
    try { return await fn(hb.signal); }
    finally { await hb.stop(); }
  }

  const opSignal = (leaseSignal) => AbortSignal.any([leaseSignal, graceAc.signal]);

  // ---------- summary ----------
  async function maybeSummarise({ turnNo, agents, state, recentFull, signal }) {
    if (turnNo === 0 || turnNo % cfg.summaryEvery !== 0) return state;
    try {
      const reqs = summaryRequest(state.summary, recentFull.slice(-cfg.summaryEvery));
      const text = await generate(agents.providers.challenger, reqs, signal);
      const s = parseSummary(text);
      // Topic row + state update commit together, only while we own the lease.
      await fencedTx(async (client) => {
        if (s.topic) await client.query('insert into public.topics(start_turn,label) values ($1,$2)', [Math.max(1, turnNo - cfg.summaryEvery + 1), s.topic]);
        const r = await client.query('update engine.state set summary=$1, open_threads=$2 where id=1', [s.summary || state.summary, s.openThreads]);
        if (r.rowCount !== 1) throw new LeaseLostError('summary update affected no row');
      }, 'summary commit');
      return { ...state, summary: s.summary || state.summary, open_threads: s.openThreads };
    } catch (e) {
      if (e instanceof QuotaError || e instanceof LeaseLostError || e instanceof ShutdownError) throw e;
      log(`summary failed (non-fatal) [${errorCategory(e)}]:`, redact(e.message));
      return state;
    }
  }

  // Provider call that is correct even if the request cannot be cancelled: we stop waiting when
  // the lease signal/timeout fires, and the orphaned result is discarded (never committed).
  function generate(provider, req, signal) {
    const s = opSignal(signal);
    return raceAbort(withTimeout(Promise.resolve().then(() => provider.generate(req, { signal: s })), cfg.providerTimeoutMs, 'provider call'), s);
  }

  // ---------- one turn ----------
  async function turn(agents, leaseSignal) {
    const signal = opSignal(leaseSignal);
    signal.throwIfAborted();
    const state = (await q('select * from engine.state where id=1')).rows[0];
    const recentDesc = (await q('select turn_no, agent_key, content from public.messages order by turn_no desc limit $1', [Math.max(cfg.contextTurns, cfg.summaryEvery)])).rows;
    const recentFull = recentDesc.slice().reverse();
    const recent = recentFull.slice(-cfg.contextTurns);
    const lastTurn = recentFull.length ? Number(recentFull[recentFull.length - 1].turn_no) : 0;
    const turnNo = lastTurn + 1;

    // Self-heal: speaker is always derived from the transcript, so a crash can't desync it.
    const lastSpeaker = recentFull.length ? recentFull[recentFull.length - 1].agent_key : null;
    const speakerKey = lastTurn === 0 ? 'explorer' : (lastSpeaker === 'explorer' ? 'challenger' : 'explorer');
    const otherKey = speakerKey === 'explorer' ? 'challenger' : 'explorer';
    const agent = agents.byKey[speakerKey];
    const other = agents.byKey[otherKey];

    if (cfg.dailyTurnCap > 0) {
      const n = (await q("select count(*)::int n from public.messages where created_at > now() - interval '24 hours'")).rows[0].n;
      if (n >= cfg.dailyTurnCap) {
        await setStatus('paused', 'Daily turn limit reached — resuming automatically', new Date(Date.now() + 15 * 60_000));
        await sleep(15 * 60_000, signal);
        return 'capped';
      }
    }

    const cooled = turnNo > Number(state.pivot_until_turn);
    const drifting = cooled && (isRepetitive(recentFull) || isNarrative(recentFull));
    const pivot = forcePivotOnce || (cfg.pivotEvery > 0 && turnNo % cfg.pivotEvery === 0) || drifting;
    forcePivotOnce = false;
    if (pivot) {
      await lease.fencedExec(
        `update engine.state s set pivot_until_turn=$1, summary='', open_threads=''
         where ${fencePredicate('s', 2, 3)}`, [turnNo + 8], 'pivot update');
      state.summary = ''; state.open_threads = '';
    }

    await setStatus('thinking', `${agent.name} is thinking`);
    const req = buildRequest({ agent, other, summary: state.summary, openThreads: state.open_threads, recent: pivot ? recent.slice(-2) : recent, pivot, seed: pivot ? pickSeed() : null, isOpening: lastTurn === 0 });
    const raw = await generate(agents.providers[speakerKey], req, leaseSignal);
    const text = cleanOutput(raw, agent.name, other.name);
    if (!text) throw new Error('empty output after cleaning');
    if (looksLikeLeak(text)) throw new Error('model output looked like leaked reasoning; discarded');
    signal.throwIfAborted();

    // Commit: short transaction, ownership re-validated under a row lock immediately before insert.
    try {
      await fencedTx(async (client) => {
        // Re-validate against the transcript as it is NOW (not as it was before the model call).
        const last = (await client.query('select turn_no, agent_key from public.messages order by turn_no desc limit 1')).rows[0];
        const nowLast = last ? Number(last.turn_no) : 0;
        if (nowLast !== lastTurn) { const err = new Error(`transcript advanced during generation (expected ${lastTurn}, found ${nowLast})`); err.code = 'STALE'; throw err; }
        await client.query('insert into public.messages(turn_no, agent_key, content) values ($1,$2,$3)', [turnNo, speakerKey, text]);
        const r = await client.query('update engine.state set next_agent=$1 where id=1', [otherKey]);
        if (r.rowCount !== 1) throw new LeaseLostError('next_agent update affected no row');
      }, 'turn commit');
    } catch (e) {
      if (e.code === '23505') { log(`turn ${turnNo} already exists, skipping`); return 'dup'; }
      if (e.code === 'STALE') { log(e.message, '— discarding generated turn'); return 'dup'; }
      throw e;
    }

    log(`#${turnNo} ${speakerKey}: ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`);
    await setStatus('talking', null);
    recentFull.push({ turn_no: turnNo, agent_key: speakerKey, content: text });
    await maybeSummarise({ turnNo, agents, state, recentFull, signal: leaseSignal });
    return 'ok';
  }

  // ---------- main loop ----------
  async function run() {
    log('worker starting as', owner);
    let agents = await loadAgents();
    let failures = 0, quotaStreak = 0;

    while (!stopping) {
      try {
        if (!(await lease.acquire())) {
          // Not our lease: do NOT touch shared status (it belongs to the active worker).
          log('another worker holds the lease; waiting');
          await sleep(cfg.acquireRetryMs);
          continue;
        }
        if (pendingReset) {
          await lease.fencedExec(`update engine.state s set summary='', open_threads='', pivot_until_turn=0 where ${fencePredicate('s', 1, 2)}`, [], 'memory reset');
          pendingReset = false; forcePivotOnce = true;
          log('memory reset requested: summary cleared, next turn pivots to a new subject');
        }
        const started = Date.now();
        await withHeartbeat(async (leaseSignal) => {
          const res = await turn(agents, leaseSignal);
          failures = 0; quotaStreak = 0;
          if (res === 'ok' || res === 'dup') await sleep(Math.max(0, cfg.minTurnMs - (Date.now() - started)), leaseSignal);
        });
      } catch (e) {
        if (stopping && (e instanceof ShutdownError || e?.name === 'AbortError' || e instanceof LeaseLostError || e?.message === 'shutdown grace elapsed')) break;
        if (e instanceof LeaseLostError) {
          log(`lease lost; abandoning cycle (no further writes) [${errorCategory(e)}]: ${redact(e.message)}`);
          try { await sleep(MIN_QUOTA_WAIT_MS); } catch { /* ignore */ }
          continue;
        }
        if (e instanceof QuotaError) {
          quotaStreak++;
          const base = e.retryAfterMs != null && Number.isFinite(e.retryAfterMs) && e.retryAfterMs >= 0 ? e.retryAfterMs + 1000 : 30_000 * 2 ** Math.min(quotaStreak - 1, 8);
          const wait = Math.max(MIN_QUOTA_WAIT_MS, Math.min(cfg.maxBackoffMs, base));
          log(`quota/rate limit [${errorCategory(e)}] (${redact(e.message)}); pausing ${Math.round(wait / 1000)}s`);
          try {
            await withHeartbeat(async (sig) => {
              await setStatus('paused', 'Paused — awaiting model availability. State saved; resuming automatically.', new Date(Date.now() + wait));
              await sleep(wait, sig);
            });
          } catch (e2) { if (!(e2 instanceof LeaseLostError)) log(`pause failed [${errorCategory(e2)}]:`, redact(e2.message)); }
        } else {
          failures++;
          const wait = Math.min(300_000, 5_000 * 2 ** Math.min(failures, 6));
          log(`error [${errorCategory(e)}]:`, redact(e.message), `— retry in ${Math.round(wait / 1000)}s`);
          await setStatus('recovering', 'Recovering from an error', new Date(Date.now() + wait)).catch(() => {});   // fenced: no-op if we lost ownership
          await sleep(wait);
          try { agents = await loadAgents(); } catch (e2) { log('reload agents failed:', redact(e2.message)); }
        }
      }
    }
    await shutdownCleanup();
  }

  // Order matters: heartbeat is already stopped (scoped per cycle). Status first (fenced), then release (owner+fence).
  async function shutdownCleanup() {
    await setStatus('paused', 'Worker restarting').catch(() => {});
    const released = await lease.release().catch((e) => { log('release failed:', redact(e.message)); return false; });
    log(released ? 'lease released' : 'lease not released (not owner or release failed)');
  }

  function stop() {
    if (stopping) return;
    stopping = true;
    log('shutdown requested');
    shutdownAc.abort();
    setTimeout(() => graceAc.abort(new ShutdownError('shutdown grace elapsed')), cfg.shutdownGraceMs).unref?.();
  }

  return { run, stop, turn, lease, loadAgents, setStatus, withHeartbeat, shutdownCleanup, _cfg: cfg };
}
