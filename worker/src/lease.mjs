// Lease ownership with heartbeat renewal and fenced writes.
//
// Safety does NOT rely on the heartbeat. Every worker-owned write is a conditional statement
// that requires (lease_owner = me AND fence = my token AND lease_until > now()) evaluated by the
// database at write time. The heartbeat only reduces how often a healthy worker loses the lease.
// `fence` is bumped on every change of ownership, so a stale worker can never match it again.

export class LeaseLostError extends Error {
  constructor(msg = 'lease lost') { super(msg); this.name = 'LeaseLostError'; }
}

// Fence predicate. `ownerP` / `fenceP` are placeholder numbers (e.g. 3 -> $3, $4).
export const fencePredicate = (alias, ownerP, fenceP) =>
  `${alias}.id=1 and ${alias}.lease_owner=$${ownerP} and ${alias}.fence=$${fenceP} and ${alias}.lease_until > now()`;

export class Lease {
  constructor({ pool, owner, leaseMs, log = () => {} }) {
    this.pool = pool; this.owner = owner; this.leaseMs = leaseMs; this.log = log;
    this.fence = null;           // token from the last successful acquire
    this.lost = false;           // set locally as soon as we learn ownership is gone
    this.hb = null;
  }

  async acquire() {
    const r = await this.pool.query(
      `update engine.state set
         fence = case when lease_owner = $1 and lease_until > now() then fence else fence + 1 end,
         lease_owner = $1,
         lease_until = now() + ($2 || ' milliseconds')::interval
       where id=1 and (lease_owner is null or lease_owner=$1 or lease_until < now())
       returning fence`, [this.owner, this.leaseMs]);
    if (r.rowCount !== 1) return false;
    const f = Number(r.rows[0].fence);
    this.lost = false;           // a successful acquire is authoritative (DB just confirmed ownership)
    this.fence = f;
    return true;
  }

  // Renew. Only succeeds while we still hold an unexpired lease with our token.
  async renew() {
    if (this.fence == null) return false;
    const r = await this.pool.query(
      `update engine.state s set lease_until = now() + ($3 || ' milliseconds')::interval
       where ${fencePredicate('s', 1, 2)}`, [this.owner, this.fence, this.leaseMs]);
    return r.rowCount === 1;
  }

  // Release only if we still own it (owner AND token). Never touches a successor's lease.
  async release() {
    if (this.fence == null) return false;
    const r = await this.pool.query(
      `update engine.state set lease_owner=null, lease_until=null
       where id=1 and lease_owner=$1 and fence=$2`, [this.owner, this.fence]);
    return r.rowCount === 1;
  }

  // Fenced single-statement write helper: `sql` must contain the fence predicate using
  // $ownerIdx/$fenceIdx placeholders appended after `params`. Throws LeaseLostError on 0 rows.
  async fencedExec(sql, params = [], what = 'write') {
    if (this.lost) throw new LeaseLostError(`lease lost before ${what}`);
    const r = await this.pool.query(sql, [...params, this.owner, this.fence]);
    if (r.rowCount === 0) { this.lost = true; throw new LeaseLostError(`lease lost during ${what}`); }
    return r;
  }

  // Start a heartbeat for the duration of one operation. Returns { signal, stop }.
  // - renewals never overlap (next one is scheduled only after the previous settles)
  // - interval <= leaseMs / 3
  // - any failed renewal (rejected OR transient error) aborts the signal: the cycle must stop.
  //   A failed heartbeat is never treated as proof of ownership.
  startHeartbeat() {
    const ac = new AbortController();
    const every = Math.max(10, Math.floor(this.leaseMs / 3));
    const state = { timer: null, inflight: null, stopped: false };
    const fail = (reason, err) => {
      this.lost = true;
      this.log(`heartbeat failed (${reason})${err ? ': ' + err.message : ''}`);
      if (!ac.signal.aborted) ac.abort(new LeaseLostError(`heartbeat ${reason}`));
    };
    const tick = () => {
      state.timer = null;
      if (state.stopped) return;
      state.inflight = (async () => {
        try {
          if (!(await this.renew())) return fail('rejected');
        } catch (e) { return fail('error', e); }
        if (!state.stopped) state.timer = setTimeout(tick, every);
      })().catch((e) => fail('unexpected', e));    // never an unhandled rejection
    };
    state.timer = setTimeout(tick, every);
    return {
      signal: ac.signal,
      every,
      stop: async () => {
        state.stopped = true;
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
        if (state.inflight) await state.inflight;   // await cleanup of in-flight renewal
      },
    };
  }
}

// Await `promise` but reject as soon as `signal` aborts, even if the underlying request cannot be
// cancelled. The orphaned promise is silenced so a late rejection is not "unhandled".
export function raceAbort(promise, signal) {
  promise.catch(() => {});
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new LeaseLostError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new LeaseLostError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
                 (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

// Reject if `promise` doesn't settle within `ms`. Orphan is silenced (see raceAbort).
export function withTimeout(promise, ms, label = 'operation') {
  promise.catch(() => {});
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}
