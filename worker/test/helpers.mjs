// Real-PostgreSQL test harness. Requires TEST_DATABASE_URL (admin/superuser) pointing at a
// scratch server. Each test file creates its own throwaway database. Supabase-only objects
// (auth.uid(), anon/authenticated roles, supabase_realtime publication) are shimmed so the
// UNMODIFIED supabase/schema.sql runs as-is.
import pg from 'pg';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ADMIN_URL = process.env.TEST_DATABASE_URL;
const SETUP_LOCK = 724130001; // arbitrary constant shared by every test process
const root = fileURLToPath(new URL('../../', import.meta.url));
const withDb = (url, db) => { const u = new URL(url); u.pathname = '/' + db; return u.toString(); };

const SHIM = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end $$;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$ begin
  if not exists (select 1 from pg_publication where pubname='supabase_realtime') then create publication supabase_realtime; end if;
end $$;
`;

export async function createTestDb() {
  const name = 'tm_test_' + randomUUID().replace(/-/g, '').slice(0, 12);
  // Roles (anon, authenticated, engine_worker) are cluster-wide, and node:test runs test files
  // in parallel on multi-core runners. Concurrent CREATE/ALTER/GRANT on the same role fails with
  // "tuple concurrently updated", so serialize the role-touching setup across processes with an
  // advisory lock held on the shared admin database (advisory locks are per-database).
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query('select pg_advisory_lock($1)', [SETUP_LOCK]);
  const url = withDb(ADMIN_URL, name);
  let su;
  try {
    await admin.query(`create database ${name}`);
    su = new pg.Client({ connectionString: url });
    await su.connect();
    await su.query(SHIM);
    await su.query(fs.readFileSync(root + 'supabase/schema.sql', 'utf8'));
    await su.query("alter role engine_worker password 'testpw'");
    await su.query("update public.agents set provider='mock'");
  } finally {
    await admin.query('select pg_advisory_unlock($1)', [SETUP_LOCK]).catch(() => {});
    await admin.end();
  }
  const wu = new URL(url); wu.username = 'engine_worker'; wu.password = 'testpw';
  const workerUrl = wu.toString();
  const pools = [];
  const mkPool = (connectionString = workerUrl, max = 4) => { const p = new pg.Pool({ connectionString, max }); pools.push(p); return p; };
  return {
    name, url, workerUrl, su, mkPool,
    async drop() {
      for (const p of pools) await p.end().catch(() => {});
      await su.end();
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const quietLog = () => {};
export function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

// Provider whose output is controlled by the test. Never cancellable unless `honourAbort`.
export function controllableProvider({ honourAbort = false } = {}) {
  const calls = [];
  return {
    calls,
    async generate(req, opts) {
      const d = deferred();
      calls.push(d);
      if (honourAbort && opts?.signal) opts.signal.addEventListener('abort', () => d.reject(opts.signal.reason), { once: true });
      return d.promise;
    },
  };
}

export const providersFactory = (byAgent) => (agent) => byAgent[agent.key];
