// Two Minds — worker entrypoint. Wires environment, DB pool, health endpoint and process signals.
// All engine logic (lease, heartbeat, fencing, turns) lives in engine.mjs.

import pg from 'pg';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { createEngine, configFromEnv } from './engine.mjs';

const env = process.env;
const DATABASE_URL = env.WORKER_DATABASE_URL;
if (!DATABASE_URL) { console.error('WORKER_DATABASE_URL is required'); process.exit(1); }

const OWNER = `${env.RENDER_INSTANCE_ID || 'local'}-${randomUUID().slice(0, 8)}`;
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3, ssl: env.PGSSL === 'disable' ? false : { rejectUnauthorized: false } });
pool.on('error', (e) => console.error(new Date().toISOString(), 'pool error:', e.message));   // idle-client errors must not crash the worker

const engine = createEngine({ pool, owner: OWNER, config: configFromEnv(env) });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => engine.stop());

// Tiny health endpoint so hosts that require an open port (e.g. Render web services) keep us alive.
if (env.PORT) {
  http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); }).listen(Number(env.PORT));
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
