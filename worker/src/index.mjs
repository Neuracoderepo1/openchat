// Two Minds — worker entrypoint. Wires environment, DB pool, health endpoint and process signals.
// All engine logic (lease, heartbeat, fencing, turns) lives in engine.mjs.

import pg from 'pg';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { createEngine, configFromEnv } from './engine.mjs';
import { evaluateHealth } from './health.mjs';

const env = process.env;
const DATABASE_URL = env.WORKER_DATABASE_URL;
if (!DATABASE_URL) { console.error('WORKER_DATABASE_URL is required'); process.exit(1); }

const OWNER = `${env.RENDER_INSTANCE_ID || 'local'}-${randomUUID().slice(0, 8)}`;
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3, ssl: env.PGSSL === 'disable' ? false : { rejectUnauthorized: false } });
pool.on('error', (e) => console.error(new Date().toISOString(), 'pool error:', e.message));   // idle-client errors must not crash the worker

const engine = createEngine({ pool, owner: OWNER, config: configFromEnv(env) });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => engine.stop());

// HTTP endpoints. `/` stays a trivial liveness reply (hosts that require an open port, and existing
// host health checks, keep working). `/healthz` is the real signal: 200 only if the database answers
// and the active worker is publishing turns; 503 otherwise. Point uptime monitors/alerts at /healthz.
if (env.PORT) {
  const staleMs = Number(env.HEALTH_STALE_MINUTES ?? 15) * 60_000;
  const probeDb = async () => { try { await Promise.race([pool.query('select 1'), new Promise((_, rej) => setTimeout(() => rej(new Error('db probe timeout')), 5_000))]); return true; } catch { return false; } };
  http.createServer(async (req, res) => {
    if (req.url?.split('?')[0] === '/healthz') {
      const h = evaluateHealth({ dbOk: await probeDb(), snap: engine.healthSnapshot(), staleMs });
      res.writeHead(h.ok ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(h));
    }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok');
  }).listen(Number(env.PORT));
}
// Free web services sleep after ~15 min without inbound traffic. Request our own public URL
// every 10 minutes so the host sees traffic and keeps the worker awake. No-op when not on Render.
if (env.RENDER_EXTERNAL_URL) {
  setInterval(() => { fetch(env.RENDER_EXTERNAL_URL).catch(() => {}); }, 10 * 60_000).unref?.();
}

engine.run()
  .then(() => pool.end())
  .then(() => console.log(new Date().toISOString(), 'bye'))
  .catch((e) => { console.error(e); process.exit(1); });
