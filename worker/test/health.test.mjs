import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHealth } from '../src/health.mjs';

const NOW = 1_000_000_000_000, MIN = 60_000;
const snap = (o = {}) => ({ startedAt: NOW - 60 * MIN, lastTurnAt: NOW - MIN, failures: 0, lastError: null, holdsLease: true, capped: false, shuttingDown: false, ...o });
const ev = (s, o = {}) => evaluateHealth({ dbOk: true, snap: s, now: NOW, ...o });

test('healthy active worker', () => { const h = ev(snap()); assert.equal(h.ok, true); assert.equal(h.role, 'active'); });
test('database down is unhealthy', () => { const h = ev(snap(), { dbOk: false }); assert.equal(h.ok, false); assert.match(h.reasons[0], /database/); });
test('active worker with stale turns is unhealthy', () => { const h = ev(snap({ lastTurnAt: NOW - 30 * MIN })); assert.equal(h.ok, false); assert.match(h.reasons.join(), /no turn published for 30 min/); });
test('never published a turn: staleness counts from process start', () => {
  assert.equal(ev(snap({ lastTurnAt: null, startedAt: NOW - 2 * MIN })).ok, true);
  assert.equal(ev(snap({ lastTurnAt: null, startedAt: NOW - 20 * MIN })).ok, false);
});
test('repeated failures are unhealthy even if a turn was recent', () => {
  const h = ev(snap({ failures: 5, lastError: { category: 'timeout', at: NOW } })); assert.equal(h.ok, false); assert.match(h.reasons[0], /5 consecutive failures \(last: timeout\)/);
});
test('standby worker is healthy without turns', () => { const h = ev(snap({ holdsLease: false, lastTurnAt: null, startedAt: NOW - 99 * MIN })); assert.equal(h.ok, true); assert.equal(h.role, 'standby'); });
test('intentional daily-cap pause is not stale', () => assert.equal(ev(snap({ capped: true, lastTurnAt: NOW - 99 * MIN })).ok, true));
test('custom staleness window is honoured', () => assert.equal(ev(snap({ lastTurnAt: NOW - 5 * MIN }), { staleMs: 3 * MIN }).ok, false));
