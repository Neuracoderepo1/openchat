// Offline tests for the optional last-resort provider tier (no network, no database).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeProvider, QuotaError, unusableLastResort } from '../src/providers.mjs';

const REQ = { system: 's', messages: [{ role: 'user', content: 'hi' }] };
const GEMINI_OK = (t) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] }), { status: 200 });
const OPENAI_OK = (t) => new Response(JSON.stringify({ choices: [{ message: { content: t } }] }), { status: 200 });
const status = (code, body = '{"error":"x"}') => new Response(body, { status: code });

const realFetch = globalThis.fetch;
const realLog = console.log;
let calls;
let handlers;       // { gemini: (model) => Response | Promise<Response>, openai: () => ... }

beforeEach(() => {
  calls = [];
  console.log = () => {};
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('generativelanguage.googleapis.com')) {
      const model = u.match(/models\/([^:]+):/)[1];
      calls.push(`gemini:${model}`);
      return handlers.gemini(model, init);
    }
    calls.push('openai');
    return handlers.openai(init);
  };
});
afterEach(() => { globalThis.fetch = realFetch; console.log = realLog; });

const baseEnv = {
  GEMINI_API_KEY: 'AIza-test',
  EXPLORER_FALLBACK_MODEL: 'gemma-x',
};
const lrEnv = {
  ...baseEnv,
  EXPLORER_LAST_RESORT_MODEL: 'llama-x',
  OPENAI_COMPAT_API_KEY: 'k',
  OPENAI_COMPAT_BASE_URL: 'https://example.test/v1',
};
const agent = { key: 'explorer', provider: 'gemini', model: 'flash-x' };
const withEnv = async (env, fn) => {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try { return await fn(); } finally { for (const k of Object.keys(env)) delete process.env[k]; Object.assign(process.env, saved); }
};

test('without last-resort config, behaviour is unchanged: failure propagates', async () => {
  handlers = { gemini: () => status(500), openai: () => assert.fail('must not be called') };
  await withEnv(baseEnv, async () => {
    const p = makeProvider(agent);
    await assert.rejects(() => p.generate(REQ), /gemini 500/);
  });
  assert.deepEqual(calls, ['gemini:flash-x']);   // a 500 on the primary does not trigger the model fallback (existing behaviour)
});

test('last resort is used when the whole Gemini chain fails', async () => {
  handlers = { gemini: () => status(500), openai: () => OPENAI_OK('Memory is not storage; it is a habit of choosing what to carry forward.') };
  await withEnv(lrEnv, async () => {
    const p = makeProvider(agent);
    assert.equal(await p.generate(REQ), 'Memory is not storage; it is a habit of choosing what to carry forward.');
  });
  assert.equal(calls.at(-1), 'openai');
});

test('quota on primary, 500 on fallback model, then last resort answers', async () => {
  handlers = {
    gemini: (m) => (m === 'flash-x' ? status(429) : status(500)),
    openai: () => OPENAI_OK('Memory is not storage; it is a habit of choosing what to carry forward.'),
  };
  await withEnv(lrEnv, async () => {
    assert.equal(await makeProvider(agent).generate(REQ), 'Memory is not storage; it is a habit of choosing what to carry forward.');
  });
  assert.deepEqual(calls, ['gemini:flash-x', 'gemini:gemma-x', 'openai']);
});

test('after a chain failure the chain is skipped for the hold period', async () => {
  handlers = { gemini: () => status(500), openai: () => OPENAI_OK('Memory is not storage; it is a habit of choosing what to carry forward.') };
  await withEnv({ ...lrEnv, LAST_RESORT_HOLD_SECONDS: '60' }, async () => {
    const p = makeProvider(agent);
    await p.generate(REQ);
    const before = calls.length;
    await p.generate(REQ);
    assert.deepEqual(calls.slice(before), ['openai']);   // no Gemini call during the hold
  });
});

test('shutdown/lease abort never falls through to the last resort', async () => {
  const ac = new AbortController();
  handlers = {
    gemini: () => { ac.abort(new Error('shutdown')); throw new Error('aborted'); },
    openai: () => assert.fail('must not be called when aborted'),
  };
  await withEnv(lrEnv, async () => {
    await assert.rejects(() => makeProvider(agent).generate(REQ, { signal: ac.signal }), /aborted|shutdown/);
  });
  assert.ok(!calls.includes('openai'));
});

test('both tiers rate-limited: QuotaError surfaces so the engine pauses', async () => {
  handlers = { gemini: () => status(429), openai: () => status(429, 'try again in 30s') };
  await withEnv(lrEnv, async () => {
    await assert.rejects(() => makeProvider(agent).generate(REQ), (e) => e instanceof QuotaError);
  });
});

test('chain rate-limited and last resort errors: QuotaError wins so the engine pauses', async () => {
  handlers = { gemini: () => status(429), openai: () => status(500) };
  await withEnv(lrEnv, async () => {
    await assert.rejects(() => makeProvider(agent).generate(REQ), (e) => e instanceof QuotaError);
  });
});

test('LAST_RESORT_MODEL without OpenAI-compat credentials disables the tier', async () => {
  handlers = { gemini: () => status(500), openai: () => assert.fail('must not be called') };
  await withEnv({ ...baseEnv, EXPLORER_LAST_RESORT_MODEL: 'llama-x' }, async () => {
    await assert.rejects(() => makeProvider(agent).generate(REQ), /gemini 500/);
  });
});

test('unusableLastResort rejects guard verdicts, leaks and blanks but accepts normal replies', () => {
  assert.ok(unusableLastResort('User Safety: safe Response Safety: safe'));
  assert.ok(unusableLastResort('safe'));
  assert.ok(unusableLastResort('unsafe\nS1'));
  assert.ok(unusableLastResort('ok'));
  assert.ok(unusableLastResort("User's core question: would you trade panic for silence? Context: earlier"));
  assert.ok(unusableLastResort('The user is making a profound philosophical argument about the limits of purely logical thought.'));
  assert.ok(unusableLastResort('The user is continuing the debate about whether imagination is needed for science, so I should push back.'));
  assert.ok(unusableLastResort("Okay, let me think about how to respond to this argument about forgetting and memory."));
  assert.ok(unusableLastResort("Let me craft a reply that challenges the premise without repeating the earlier point."));
  // real replies from the live conversation must pass
  assert.equal(unusableLastResort('Natural selection is a brutal optimizer. Biological redundancy is risk management. Diploidy in eukaryotes masks genetic mutations via a secondary allele. A calculator does not choose the equation. The user provides the intent. Friction is not a steering mechanism. It is just waste.'), null);
  assert.equal(unusableLastResort('You describe a universe of inevitable corrections, a landscape where truth is simply the most stable error remaining. But even the most rigorous observation requires a vantage point. If we reduce the pursuit of truth to logical corrections, do we risk becoming blind to the truths that do not fit our definition of data?'), null);
  assert.equal(unusableLastResort('Sudden shifts are narrative illusions. They are lagging indicators. The steam engine required atmospheric pressure research and coal mining. It did not appear from nowhere. Innovation is just the visible result of hidden accumulation.'), null);
  assert.equal(unusableLastResort('Redundancy is not waste; it is the price of surviving the one failure nobody planned for.'), null);
  assert.equal(unusableLastResort('A safe harbour is only safe until the tide changes its mind about the harbour.'), null);
});

test('a guard-model verdict from the last resort is never returned', async () => {
  handlers = { gemini: () => status(500), openai: () => OPENAI_OK('User Safety: safe Response Safety: safe') };
  await withEnv(lrEnv, async () => {
    await assert.rejects(() => makeProvider(agent).generate(REQ), /rejected \(guard-model verdict\)/);
  });
});
