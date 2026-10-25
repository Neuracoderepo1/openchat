// Lease/fencing/heartbeat regression tests against REAL PostgreSQL (no mocked locking).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, ADMIN_URL, sleep, quietLog, deferred, controllableProvider, providersFactory } from './helpers.mjs';
import { Lease, LeaseLostError, raceAbort } from '../src/lease.mjs';
import { createEngine, ShutdownError } from '../src/engine.mjs';
import { QuotaError } from '../src/providers.mjs';

if (!ADMIN_URL) { test('real-DB tests', { skip: 'TEST_DATABASE_URL not set — NOT RUN' }, () => {}); }
else {
  const unhandled = [];
  process.on('unhandledRejection', (r) => unhandled.push(r));

  const db = await createTestDb();
  test.after(async () => { await db.drop(); });

  const resetState = async () => {
    await db.su.query("truncate public.messages, public.topics");
    await db.su.query("update engine.state set lease_owner=null, lease_until=null, summary='', open_threads='', pivot_until_turn=0, next_agent='explorer' where id=1");
    await db.su.query("update public.engine_status set status='starting', detail=null, resume_at=null where id=1");
  };
  const state = async () => (await db.su.query('select * from engine.state where id=1')).rows[0];
  const status = async () => (await db.su.query('select * from public.engine_status where id=1')).rows[0];
  const msgs = async () => (await db.su.query('select turn_no, agent_key, content from public.messages order by turn_no')).rows;
  const mkEngine = (owner, providers, cfg = {}, pool = db.mkPool()) => createEngine({
    pool, owner, log: quietLog, makeProvider: providersFactory(providers),
    config: { leaseMs: 600, minTurnMs: 0, providerTimeoutMs: 5000, shutdownGraceMs: 200, summaryEvery: 1000, pivotEvery: 0, acquireRetryMs: 50, ...cfg },
  });
  const instantProvider = (text) => ({ async generate() { return text; } });
  const pair = (a = 'Explorer says something curious about tides and moons.', b = 'Challenger replies with a skeptical counterpoint about causes.') =>
    ({ explorer: instantProvider(a), challenger: instantProvider(b) });

  test('schema: fence column exists and is bumped on ownership change only', async () => {
    await resetState();
    const pool = db.mkPool();
    const a = new Lease({ pool, owner: 'A', leaseMs: 500 });
    assert.equal(await a.acquire(), true); const f1 = a.fence;
    assert.equal(await a.acquire(), true); assert.equal(a.fence, f1, 're-acquire of live own lease keeps token');
    await a.release();
    const b = new Lease({ pool, owner: 'B', leaseMs: 500 });
    assert.equal(await b.acquire(), true); assert.ok(b.fence > f1, 'new owner gets higher token');
  });

  test('1. long provider call: heartbeat keeps lease valid beyond the lease duration', async () => {
    await resetState();
    const prov = controllableProvider();
    const eng = mkEngine('W1', { explorer: prov, challenger: instantProvider('x y z') }, { leaseMs: 600 });
    assert.equal(await eng.lease.acquire(), true);
    const agents = await eng.loadAgents();
    const turnP = eng.withHeartbeat((sig) => eng.turn(agents, sig));
    while (!prov.calls.length) await sleep(10);
    await sleep(1600);                       // > 2.5x lease duration, provider still running
    const s = await state();
    assert.equal(s.lease_owner, 'W1');
    assert.ok(new Date(s.lease_until) > new Date(), 'lease still unexpired after long call');
    prov.calls[0].resolve('A long but valid answer about slow thinking and the sea.');
    assert.equal(await turnP, 'ok');
    assert.equal((await msgs()).length, 1);
  });

  test('2. lease loss: response generated after losing ownership is NOT committed', async () => {
    await resetState();
    const prov = controllableProvider();
    const eng = mkEngine('W1', { explorer: prov, challenger: instantProvider('x y z') }, { leaseMs: 100000 });
    await eng.lease.acquire();
    const agents = await eng.loadAgents();
    const turnP = eng.turn(agents, new AbortController().signal);        // no heartbeat: isolate DB fencing
    while (!prov.calls.length) await sleep(10);
    await db.su.query("update engine.state set lease_until = now() - interval '1 second'");   // lease expires
    const thief = new Lease({ pool: db.mkPool(), owner: 'W2', leaseMs: 100000 });
    assert.equal(await thief.acquire(), true);                           // successor takes over
    prov.calls[0].resolve('Late answer that must never be saved to the transcript.');
    await assert.rejects(turnP, LeaseLostError);
    assert.equal((await msgs()).length, 0);
    assert.equal((await state()).lease_owner, 'W2');
  });

  test('2b. expired-but-unclaimed lease also blocks commit (non-expired requirement)', async () => {
    await resetState();
    const prov = controllableProvider();
    const eng = mkEngine('W1', { explorer: prov, challenger: instantProvider('x y z') }, { leaseMs: 100000 });
    await eng.lease.acquire();
    const agents = await eng.loadAgents();
    const turnP = eng.turn(agents, new AbortController().signal);
    while (!prov.calls.length) await sleep(10);
    await db.su.query("update engine.state set lease_until = now() - interval '1 second'");
    prov.calls[0].resolve('Answer arriving after expiry with nobody else owning the lease.');
    await assert.rejects(turnP, LeaseLostError);
    assert.equal((await msgs()).length, 0);
  });

  test('3. competing workers: exactly one commits a turn; speaker state never conflicts', async () => {
    await resetState();
    const pa = controllableProvider(), pb = controllableProvider();
    const A = mkEngine('WA', { explorer: pa, challenger: instantProvider('x y z') }, { leaseMs: 100000 });
    const B = mkEngine('WB', { explorer: pb, challenger: instantProvider('x y z') }, { leaseMs: 100000 });
    assert.equal(await A.lease.acquire(), true);
    assert.equal(await B.lease.acquire(), false, 'B cannot acquire while A holds a live lease');
    // Force the split-brain case: A expires, B takes over, both have generated an answer for turn 1.
    const agentsA = await A.loadAgents();
    const ta = A.turn(agentsA, new AbortController().signal);
    while (!pa.calls.length) await sleep(10);
    await db.su.query("update engine.state set lease_until = now() - interval '1 second'");
    assert.equal(await B.lease.acquire(), true);
    const tb = B.turn(await B.loadAgents(), new AbortController().signal);
    while (!pb.calls.length) await sleep(10);
    pb.calls[0].resolve('Worker B answer: the first turn about harbours and their tides.');
    assert.equal(await tb, 'ok');
    pa.calls[0].resolve('Worker A stale answer: must not be committed as turn one.');
    await assert.rejects(ta, LeaseLostError);
    const m = await msgs();
    assert.equal(m.length, 1); assert.match(m[0].content, /Worker B/);
    assert.equal((await state()).next_agent, 'challenger');
  });

  test('3b. concurrent commit race (same instant, real row locks): at most one row per turn_no', async () => {
    await resetState();
    const pool = db.mkPool(undefined, 8);
    const engs = ['R1', 'R2', 'R3'].map((o) => mkEngine(o, pair(`${o} says an interesting thing about rivers.`, `${o} counters with a sceptical point.`), { leaseMs: 100000 }, pool));
    const wins = await Promise.all(engs.map((e) => e.lease.acquire()));
    assert.equal(wins.filter(Boolean).length, 1, 'exactly one acquire wins');
    const results = await Promise.allSettled(engs.map(async (e) => e.turn(await e.loadAgents(), new AbortController().signal)));
    const ok = results.filter((r) => r.status === 'fulfilled' && r.value === 'ok');
    assert.equal(ok.length, 1);
    assert.equal((await msgs()).length, 1);
  });

  test('4. stale status update: old worker cannot overwrite the active worker\'s status', async () => {
    await resetState();
    const pool = db.mkPool();
    const old = mkEngine('OLD', pair(), { leaseMs: 100000 }, pool);
    const fresh = mkEngine('NEW', pair(), { leaseMs: 100000 }, pool);
    await old.lease.acquire();
    await db.su.query("update engine.state set lease_until = now() - interval '1 second'");
    await fresh.lease.acquire();
    await fresh.setStatus('talking', 'new worker is live');
    await assert.rejects(old.setStatus('recovering', 'stale write'), LeaseLostError);
    const s = await status();
    assert.equal(s.status, 'talking'); assert.equal(s.detail, 'new worker is live');
  });

  test('4b. a worker that cannot acquire never writes status', async () => {
    await resetState();
    const pool = db.mkPool();
    const holder = mkEngine('HOLD', pair(), { leaseMs: 100000 }, pool);
    await holder.lease.acquire(); await holder.setStatus('talking', 'holder');
    const waiter = mkEngine('WAIT', pair(), { leaseMs: 100000, acquireRetryMs: 20 }, pool);
    const run = waiter.run();
    await sleep(150); waiter.stop(); await run;
    assert.equal((await status()).detail, 'holder');
    assert.equal((await state()).lease_owner, 'HOLD');
  });

  test('5. heartbeat failure: renewal error aborts the cycle safely, no commit, no unhandled rejection', async () => {
    await resetState();
    const real = db.mkPool();
    let failRenew = false;
    const flaky = { query: (t, p) => (failRenew && /set lease_until = now\(\)/.test(t) ? Promise.reject(new Error('simulated db failure')) : real.query(t, p)), connect: () => real.connect() };
    const prov = controllableProvider();
    const eng = mkEngine('HB', { explorer: prov, challenger: instantProvider('x y z') }, { leaseMs: 300 }, flaky);
    await eng.lease.acquire();
    const agents = await eng.loadAgents();
    const p = eng.withHeartbeat((sig) => eng.turn(agents, sig));
    while (!prov.calls.length) await sleep(10);
    failRenew = true;
    await assert.rejects(p, (e) => e instanceof LeaseLostError);
    prov.calls[0].resolve('Answer that finishes after the heartbeat already failed.');
    await sleep(100);
    assert.equal((await msgs()).length, 0);
    assert.deepEqual(unhandled, []);
  });

  test('5b. heartbeat rejection (0 rows) aborts and renewals never overlap', async () => {
    await resetState();
    const real = db.mkPool();
    let active = 0, maxActive = 0, renewals = 0;
    const slow = { query: async (t, p) => { if (/set lease_until = now\(\)/.test(t)) { active++; maxActive = Math.max(maxActive, active); renewals++; await sleep(120); try { return await real.query(t, p); } finally { active--; } } return real.query(t, p); }, connect: () => real.connect() };
    const l = new Lease({ pool: slow, owner: 'OV', leaseMs: 300 });
    await l.acquire();
    const hb = l.startHeartbeat();
    assert.ok(hb.every <= 100, 'interval <= leaseMs/3');
    await sleep(700); await hb.stop();
    assert.ok(renewals >= 2); assert.equal(maxActive, 1, 'renewals must not overlap');
    // now lose it and see the abort
    await db.su.query("update engine.state set lease_owner='X', fence=fence+1");
    const hb2 = l.startHeartbeat();
    await sleep(500);
    assert.equal(hb2.signal.aborted, true); assert.equal(l.lost, true);
    await hb2.stop();
  });

  test('6. provider timeout: no unhandled rejection, no commit, lease intact', async () => {
    await resetState();
    const hang = { generate: () => new Promise((_, rej) => setTimeout(() => rej(new Error('late failure after timeout')), 400)) };
    const eng = mkEngine('TO', { explorer: hang, challenger: instantProvider('x y z') }, { leaseMs: 100000, providerTimeoutMs: 100 });
    await eng.lease.acquire();
    const agents = await eng.loadAgents();
    await assert.rejects(eng.withHeartbeat((s) => eng.turn(agents, s)), /timed out/);
    await sleep(500);                                      // the orphaned provider promise rejects now
    assert.deepEqual(unhandled, []);
    assert.equal((await msgs()).length, 0);
    const s = await state(); assert.equal(s.lease_owner, 'TO');
  });

  test('7. database failure during commit: turn is NOT reported successful, nothing partial persisted', async () => {
    await resetState();
    const real = db.mkPool();
    let failInsert = true;
    const wrapClient = (c) => new Proxy(c, { get: (t, k) => k === 'query' ? (sql, ...r) => (failInsert && /insert into public.messages/.test(sql) ? Promise.reject(Object.assign(new Error('connection terminated'), { code: '57P01' })) : t.query(sql, ...r)) : (typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
    const flaky = { query: (t, p) => real.query(t, p), connect: async () => wrapClient(await real.connect()) };
    const eng = mkEngine('DB', pair(), { leaseMs: 100000 }, flaky);
    await eng.lease.acquire();
    const agents = await eng.loadAgents();
    await assert.rejects(eng.turn(agents, new AbortController().signal), /connection terminated/);
    assert.equal((await msgs()).length, 0);
    assert.equal((await state()).next_agent, 'explorer', 'next_agent untouched by rolled-back tx');
    failInsert = false;
    assert.equal(await eng.turn(agents, new AbortController().signal), 'ok');   // recovers
    assert.equal((await msgs()).length, 1);
  });

  test('8. shutdown: release is owner+fence guarded; cleanup never disturbs a successor', async () => {
    await resetState();
    const pool = db.mkPool();
    const A = mkEngine('SA', pair(), { leaseMs: 100000 }, pool);
    await A.lease.acquire();
    await db.su.query("update engine.state set lease_until = now() - interval '1 second'");
    const B = mkEngine('SB', pair(), { leaseMs: 100000 }, pool);
    await B.lease.acquire(); await B.setStatus('talking', 'B live');
    await A.shutdownCleanup();                                       // A is stale: must be a no-op
    const s = await state(); assert.equal(s.lease_owner, 'SB'); assert.ok(new Date(s.lease_until) > new Date());
    assert.equal((await status()).detail, 'B live');
    // owner string equal but token stale must also fail to release
    const ghost = new Lease({ pool, owner: 'SB', leaseMs: 1000 }); ghost.fence = Number(s.fence) - 1;
    assert.equal(await ghost.release(), false);
    assert.equal((await state()).lease_owner, 'SB');
  });

  test('8b. graceful shutdown mid-run: stops new turns, heartbeat stopped, lease released by owner', async () => {
    await resetState();
    const eng = mkEngine('GS', pair(), { leaseMs: 300, minTurnMs: 30 });
    const run = eng.run();
    while ((await msgs()).length < 2) await sleep(20);
    eng.stop(); await run;
    const n = (await msgs()).length; await sleep(200);
    assert.equal((await msgs()).length, n, 'no turns after shutdown');
    const s = await state(); assert.equal(s.lease_owner, null);
    assert.equal((await status()).detail, 'Worker restarting');
    assert.deepEqual(unhandled, []);
  });

  test('8c. shutdown while a non-cancellable provider call is in flight returns after grace', async () => {
    await resetState();
    const prov = controllableProvider();                              // never resolves
    const eng = mkEngine('GH', { explorer: prov, challenger: instantProvider('x y z') }, { leaseMs: 300, shutdownGraceMs: 150 });
    const run = eng.run();
    while (!prov.calls.length) await sleep(10);
    const t0 = Date.now(); eng.stop(); await run;
    assert.ok(Date.now() - t0 < 2000);
    assert.equal((await state()).lease_owner, null); assert.equal((await msgs()).length, 0);
  });

  test('9. normal operation: alternating agents, persistence, summaries, topics', async () => {
    await resetState();
    const lines = [
      'Octopuses edit their own RNA, rewriting proteins on the fly instead of waiting for evolution.',
      'Then are they less bound by their genome than we are? Or does that flexibility hide a different leash?',
      'Think of medieval guild cities, where trade secrets travelled by apprenticeship rather than writing.',
      'Careful: secrecy and memory are opposites, and yet both explain why craft survives collapse.',
      'Meanwhile tidal power sits mostly unused because the ocean refuses to keep a schedule.',
      'Maybe intermittency is the real price of anything wild, including conversations like this one.',
      'Consider how Ghanaian highlife borrowed brass bands from colonial regiments and made them dance.',
      'That makes borrowing a kind of argument: taking an instrument means disputing who owns the tune.',
      'Lichens are not one organism but a treaty between fungus and alga that outlasts both signatories.',
      'A treaty needs enforcement though; what polices the border inside a lichen?',
    ];
    let n = 0;
    const gen = () => ({ async generate(req) { if (/summar/i.test(req.system)) return '{"summary":"They discussed tides.","topic":"Tides","open_threads":["moon"]}'; return lines[n++ % lines.length]; } });
    const eng = mkEngine('NO', { explorer: gen(), challenger: gen() }, { leaseMs: 500, minTurnMs: 0, summaryEvery: 4 });
    const run = eng.run();
    let topics = 0;
    for (let i = 0; i < 500 && topics < 2; i++) { await sleep(10); topics = (await db.su.query('select count(*)::int c from public.topics')).rows[0].c; }
    eng.stop(); await run;
    assert.ok(topics >= 2, 'summary every 4 turns produced topic rows');
    const m = await msgs();
    assert.ok(m.length >= 8);
    m.forEach((r, i) => { assert.equal(r.turn_no, String(i + 1)); assert.equal(r.agent_key, i % 2 ? 'challenger' : 'explorer'); assert.ok(r.content.length > 10); });
    const st = await state();
    assert.equal(st.summary, 'They discussed tides.'); assert.equal(st.open_threads, 'moon');
    assert.equal(st.next_agent, m[m.length - 1].agent_key === 'explorer' ? 'challenger' : 'explorer');
  });

  test('quota: Retry-After of 0 / negative cannot produce a tight retry loop', async () => {
    await resetState();
    let calls = 0;
    const prov = { async generate() { calls++; throw new QuotaError('429', 0); } };
    const eng = mkEngine('Q', { explorer: prov, challenger: instantProvider('x y z') }, { leaseMs: 10000 });
    const run = eng.run(); await sleep(1500); eng.stop(); await run;
    assert.equal(calls, 1, 'floor of 5s between quota retries');
    assert.equal((await status()).status, 'paused');
  });

  test('raceAbort: late rejection of orphaned promise is silenced', async () => {
    const ac = new AbortController();
    const orphan = new Promise((_, rej) => setTimeout(() => rej(new Error('late')), 50));
    const p = raceAbort(orphan, ac.signal); ac.abort(new LeaseLostError('x'));
    await assert.rejects(p, LeaseLostError); await sleep(120);
    assert.deepEqual(unhandled, []);
  });
}
