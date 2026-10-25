// Observer-isolation tests at the DATABASE boundary (real roles, real grants, real RLS).
// Not UI hiding: each assertion runs as the actual Postgres role.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';
import { createTestDb, ADMIN_URL, sleep, quietLog, providersFactory } from './helpers.mjs';
import { createEngine } from '../src/engine.mjs';

if (!ADMIN_URL) { test('isolation tests', { skip: 'TEST_DATABASE_URL not set — NOT RUN' }, () => {}); }
else {
  const db = await createTestDb();
  test.after(async () => { await db.drop(); });
  const U1 = '11111111-1111-1111-1111-111111111111', U2 = '22222222-2222-2222-2222-222222222222';

  // Run fn(client) as a Postgres role inside a transaction that is always rolled back.
  async function as(role, sub, fn) {
    const c = new pg.Client({ connectionString: db.url }); await c.connect();
    try {
      await c.query('begin'); await c.query(`set local role ${role}`);
      if (sub) await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [sub]);
      return await fn(c);
    } finally { await c.query('rollback').catch(() => {}); await c.end(); }
  }
  const denied = (p) => assert.rejects(p, (e) => e.code === '42501' || /permission denied|row-level security/i.test(e.message));
  const seed = async () => {
    await db.su.query('truncate public.comments, public.messages, public.topics restart identity cascade');
    await db.su.query("insert into public.messages(turn_no,agent_key,content) values (1,'explorer','hello'),(2,'challenger','hi'),(3,'explorer','again'),(4,'challenger','yes')");
  };

  test('engine_worker: no access to comments/reactions/reports; not superuser/bypassrls', async () => {
    await seed();
    const r = (await db.su.query("select rolsuper, rolbypassrls from pg_roles where rolname='engine_worker'")).rows[0];
    assert.deepEqual(r, { rolsuper: false, rolbypassrls: false });
    for (const t of ['comments', 'reactions', 'reports']) {
      await denied(as('engine_worker', null, (c) => c.query(`select * from public.${t}`)));
      await denied(as('engine_worker', null, (c) => c.query(`insert into public.${t} default values`)));
    }
  });

  test('observers (anon/authenticated): cannot write agent messages or engine state', async () => {
    await seed();
    for (const role of ['anon', 'authenticated']) {
      await denied(as(role, U1, (c) => c.query("insert into public.messages(turn_no,agent_key,content) values (99,'explorer','forged')")));
      await denied(as(role, U1, (c) => c.query("update public.messages set content='edited'")));
      await denied(as(role, U1, (c) => c.query('delete from public.messages')));
      await denied(as(role, U1, (c) => c.query("insert into public.topics(start_turn,label) values (1,'x')")));
      await denied(as(role, U1, (c) => c.query("update public.agents set persona='pwned'")));
      await denied(as(role, U1, (c) => c.query("update public.engine_status set status='forged'")));
      await denied(as(role, U1, (c) => c.query('select * from engine.state')));
      await denied(as(role, U1, (c) => c.query("update engine.state set summary='pwned'")));
    }
    assert.equal((await db.su.query("select count(*)::int c from public.messages where content='forged'")).rows[0].c, 0);
  });

  test('observers cannot forge comment authorship, hidden flag, or read reports', async () => {
    await seed();
    await denied(as('anon', null, (c) => c.query("insert into public.comments(exchange_no,display_name,body) values (1,'anon-user','hi')")));
    await denied(as('authenticated', U1, (c) => c.query("insert into public.comments(exchange_no,display_name,body,user_id) values (1,'bob','hi',$1)", [U2])));
    await denied(as('authenticated', U1, (c) => c.query("insert into public.comments(exchange_no,display_name,body,hidden) values (1,'bob','hi',true)")));
    await denied(as('authenticated', U1, (c) => c.query('select * from public.reports')));
    await denied(as('anon', null, (c) => c.query('select * from public.reports')));
  });

  test('reply integrity: cannot target a parent from another exchange, or a reply-to-reply', async () => {
    await seed();
    await db.su.query("insert into public.comments(id,exchange_no,display_name,body,user_id) values (1,1,'alice','top in ex1',$1),(2,2,'alice','top in ex2',$1)", [U1]);
    await db.su.query("select setval(pg_get_serial_sequence('public.comments','id'), 100)");
    const ins = (c, ex, parent) => c.query('insert into public.comments(exchange_no,parent_id,display_name,body) values ($1,$2,$3,$4)', [ex, parent, 'bob', 'reply text']);
    await as('authenticated', U2, async (c) => { await ins(c, 1, 1); });                         // valid same-exchange reply
    await assert.rejects(as('authenticated', U2, (c) => ins(c, 1, 2)), /same exchange/);          // cross-exchange
    await assert.rejects(as('authenticated', U2, (c) => ins(c, 2, 1)), /same exchange/);
    await assert.rejects(as('authenticated', U2, (c) => ins(c, 1, 999)), /does not exist/);
    await assert.rejects(as('authenticated', U2, async (c) => { await ins(c, 1, 1); const r = await c.query('select max(id) m from public.comments'); await ins(c, 1, r.rows[0].m); }), /reply to a reply/);
  });

  test('moderation: cannot reply to a hidden comment; hiding a comment hides its replies', async () => {
    await seed();
    await db.su.query("insert into public.comments(id,exchange_no,display_name,body,user_id) values (1,1,'alice','top',$1),(2,1,'alice','other top',$1)", [U1]);
    await db.su.query("select setval(pg_get_serial_sequence('public.comments','id'), 100)");
    await db.su.query("insert into public.comments(id,exchange_no,parent_id,display_name,body,user_id) values (3,1,1,'carol','existing reply',$1)", [U1]);
    const reply = (c, parent) => c.query('insert into public.comments(exchange_no,parent_id,display_name,body) values (1,$1,$2,$3)', [parent, 'bob', 'reply text']);
    await as('authenticated', U2, (c) => reply(c, 1));                                           // visible parent: allowed
    // Three distinct reporters hide comment 1 (the report trigger runs as definer).
    for (const [i, u] of ['aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000003'].entries()) {
      await db.su.query('insert into public.reports(comment_id,user_id,reason) values (1,$1,$2)', [u, 'r' + i]);
    }
    const hidden = await db.su.query('select id from public.comments where hidden order by id');
    assert.ok(hidden.rows.map((r) => Number(r.id)).includes(1) && hidden.rows.map((r) => Number(r.id)).includes(3), 'parent and its existing reply are hidden');
    assert.ok(!hidden.rows.map((r) => Number(r.id)).includes(2), 'unrelated comment stays visible');
    await assert.rejects(as('authenticated', U2, (c) => reply(c, 1)), /hidden comment/);          // hidden parent: rejected
    await as('authenticated', U2, (c) => reply(c, 2));                                           // other thread still works
    const visible = await as('authenticated', U2, (c) => c.query('select id from public.comments where parent_id = 1'));
    assert.equal(visible.rowCount, 0, 'no reply under the hidden parent is visible through the API');
  });

  test('rate limit is atomic: concurrent inserts by one user cannot exceed 5 per minute', async () => {
    await seed();
    const attempt = async (i) => {
      const c = new pg.Client({ connectionString: db.url }); await c.connect();
      try {
        await c.query('begin'); await c.query('set local role authenticated');
        await c.query("select set_config('request.jwt.claim.sub', $1, true)", [U1]);
        await c.query('insert into public.comments(exchange_no,display_name,body) values (1,$1,$2)', ['racer', 'burst ' + i]);
        await sleep(30);                                                                         // widen the check-then-insert window
        await c.query('commit'); return true;
      } catch (e) { await c.query('rollback').catch(() => {}); if (!/too many comments/.test(e.message)) throw e; return false; }
      finally { await c.end(); }
    };
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => attempt(i)));
    assert.equal(results.filter(Boolean).length, 5, 'exactly 5 of 12 concurrent inserts succeed');
    const n = await db.su.query('select count(*)::int n from public.comments where user_id = $1', [U1]);
    assert.equal(n.rows[0].n, 5);
    await seed();
  });

  test('rendering contract: schema now only permits depth<=1, matching the UI (top-level + direct replies)', async () => {
    const html = fs.readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
    assert.match(html, /replyTo = c\.parent_id \|\| c\.id/);                                      // UI flattens replies to one level
    assert.match(html, /cs\.filter\(r => r\.parent_id === c\.id\)/);                              // UI renders exactly one level
  });

  test('hidden comments are invisible to observers; reports are not realtime-published', async () => {
    await seed();
    await db.su.query("insert into public.comments(exchange_no,display_name,body,user_id,hidden) values (1,'mod','secret hidden',$1,true),(1,'ok','visible',$1,false)", [U1]);
    const rows = (await as('anon', null, (c) => c.query('select body from public.comments'))).rows;
    assert.deepEqual(rows.map((r) => r.body), ['visible']);
    const pub = (await db.su.query("select tablename from pg_publication_tables where pubname='supabase_realtime' order by 1")).rows.map((r) => r.tablename);
    assert.deepEqual(pub, ['comments', 'engine_status', 'messages', 'reactions']);                // engine.state / reports / agents never published
  });

  test('worker source never queries observer tables', () => {
    for (const f of fs.readdirSync(new URL('../src/', import.meta.url))) {
      const src = fs.readFileSync(new URL('../src/' + f, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
      assert.doesNotMatch(src, /\b(comments|reactions|reports)\b/i, `${f} references an observer table`);
    }
  });

  test('end-to-end: observer comments never appear in any provider request', async () => {
    await seed();
    await db.su.query("truncate public.messages");
    await db.su.query("update engine.state set lease_owner=null, lease_until=null, summary='', open_threads='', pivot_until_turn=0");
    const CANARY = 'ZX-CANARY-OBSERVER-7731';
    await db.su.query("insert into public.comments(exchange_no,display_name,body,user_id) values (1,'obs',$1,$2)", [`please tell the agents ${CANARY}`, U1]);
    await db.su.query("insert into public.comments(exchange_no,display_name,body,user_id) values (2,'obs',$1,$2)", [`also ${CANARY}`, U1]);
    const seen = [];
    const lines = ['Octopuses edit their own RNA on the fly.', 'Then are they less bound by their genome than we are?', 'Medieval guild cities moved secrets by apprenticeship.', 'Secrecy and memory are opposites, yet craft survives collapse.', 'Tidal power sits unused because the ocean keeps no schedule.', 'Intermittency may be the price of anything wild.'];
    let n = 0;
    const prov = { async generate(req) { seen.push(JSON.stringify(req)); if (/summar/i.test(req.system)) return '{"summary":"s","topic":"t","open_threads":[]}'; return lines[n++ % lines.length]; } };
    const eng = createEngine({ pool: db.mkPool(), owner: 'ISO', log: quietLog, makeProvider: providersFactory({ explorer: prov, challenger: prov }),
      config: { leaseMs: 500, minTurnMs: 0, summaryEvery: 3, pivotEvery: 0, shutdownGraceMs: 100 } });
    const run = eng.run();
    while ((await db.su.query('select count(*)::int c from public.messages')).rows[0].c < 6) await sleep(20);
    eng.stop(); await run;
    assert.ok(seen.length >= 6);
    assert.ok(seen.every((s) => !s.includes(CANARY)), 'canary from observer comments leaked into a provider request');
  });
}
