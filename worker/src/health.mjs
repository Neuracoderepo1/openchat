// Worker health evaluation. Pure function so it can be unit-tested; engine.mjs supplies the snapshot,
// index.mjs supplies the DB probe. "ok" means: the database answers AND (we are a healthy standby OR
// the active worker is actually making progress). A plain 200 from a listening socket proves none of that.

export function evaluateHealth({ dbOk, snap, now = Date.now(), staleMs = 15 * 60_000, maxFailures = 5 }) {
  const reasons = [];
  if (!dbOk) reasons.push('database unreachable');
  if (snap.failures >= maxFailures) reasons.push(`${snap.failures} consecutive failures (last: ${snap.lastError?.category ?? 'unknown'})`);
  const role = snap.shuttingDown ? 'stopping' : snap.holdsLease ? 'active' : 'standby';
  // Only the active worker is expected to publish turns. A standby (another instance holds the lease)
  // and an intentional daily-cap pause are healthy even without recent turns.
  if (role === 'active' && !snap.capped) {
    const since = snap.lastTurnAt ?? snap.startedAt;
    if (now - since > staleMs) reasons.push(`no turn published for ${Math.round((now - since) / 60_000)} min`);
  }
  return {
    ok: reasons.length === 0,
    role,
    reasons,
    lastTurnAt: snap.lastTurnAt ? new Date(snap.lastTurnAt).toISOString() : null,
    consecutiveFailures: snap.failures,
    lastError: snap.lastError ? { category: snap.lastError.category, at: new Date(snap.lastError.at).toISOString() } : null,
    uptimeSeconds: Math.round((now - snap.startedAt) / 1000),
  };
}
