// Offline tests for the optional last-resort provider tier (no network, no database).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeProvider, QuotaError } from '../src/providers.mjs';

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
  handlers = { gemini: () => status(500), openai: () => OPENAI_OK('from groq') };
  await withEnv(lrEnv, async () => {
    const p = makeProvider(agent);
    assert.equal(await p.generate(REQ), 'from groq');
  });
  assert.equal(calls.at(-1), 'openai');
});

test('quota on primary, 500 on fallback model, then last resort answers', async () => {
  handlers = {
    gemini: (m) => (m === 'flash-x' ? status(429) : status(500)),
    openai: () => OPENAI_OK('ok'),
  };
  await withEnv(lrEnv, async () => {
    assert.equal(await makeProvider(agent).generate(REQ), 'ok');
  });
  assert.deepEqual(calls, ['gemini:flash-x', 'gemini:gemma-x', 'openai']);
});

test('after a chain failure the chain is skipped for the hold period', async () => {
  handlers = { gemini: () => status(500), openai: () => OPENAI_OK('ok') };
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
