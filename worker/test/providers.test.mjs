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

// ---------- Gemini output guard: every Gemini path must reject leaked reasoning ----------
// Fixtures are real looksLikeLeak() hits (see LEAK in src/prompts.mjs).
const LEAKS = [
  "User's core question: would you trade panic for silence? Context: earlier turns",
  "The Explorer's argument: efficiency is a dead end. The Challenger's task: be witty",
  '* Point one\n* Point two',
];
const LEAK = LEAKS[0];
const GOOD = 'Memory is not storage; it is a habit of choosing what to carry forward.';
const GOOD_FB = 'Forgetting is the price of attention, and attention is the price of meaning.';
const chainEnv = { GEMINI_API_KEY: 'AIza-test' };   // primary only, no fallback model

test('guard fixtures really are detected by looksLikeLeak (tests cannot pass vacuously)', async () => {
  const { looksLikeLeak } = await import('../src/prompts.mjs');
  for (const t of LEAKS) assert.equal(looksLikeLeak(t), true);
  assert.equal(looksLikeLeak(GOOD), false);
  assert.equal(looksLikeLeak(GOOD_FB), false);
});

test('primary-only Gemini: leaked output is rejected, never returned', async () => {
  handlers = { gemini: () => GEMINI_OK(LEAK), openai: () => assert.fail('must not be called') };
  await withEnv(chainEnv, async () => {
    await assert.rejects(() => makeProvider(agent).generate(REQ), /leaked reasoning/);
  });
  assert.deepEqual(calls, ['gemini:flash-x']);
});

test('primary leak with a fallback model: fallback answer is used', async () => {
  handlers = { gemini: (m) => GEMINI_OK(m === 'flash-x' ? LEAK : GOOD_FB), openai: () => assert.fail('must not be called') };
  await withEnv(baseEnv, async () => {
    assert.equal(await makeProvider(agent).generate(REQ), GOOD_FB);
  });
  assert.deepEqual(calls, ['gemini:flash-x', 'gemini:gemma-x']);
});

test('fallback leak: output from the fallback model is rejected, not returned', async () => {
  handlers = { gemini: (m) => (m === 'flash-x' ? status(429) : GEMINI_OK(LEAK)), openai: () => assert.fail('must not be called') };
  await withEnv(baseEnv, async () => {
    await assert.rejects(() => makeProvider(agent).generate(REQ), /leaked reasoning/);
  });
  assert.deepEqual(calls, ['gemini:flash-x', 'gemini:gemma-x']);   // no retry loop inside the provider
});

test('both Gemini models leak: error propagates, nothing is returned', async () => {
  handlers = { gemini: () => GEMINI_OK(LEAK), openai: () => assert.fail('must not be called') };
  await withEnv(baseEnv, async () => {
    await assert.rejects(() => makeProvider(agent).generate(REQ), /leaked reasoning/);
  });
  assert.deepEqual(calls, ['gemini:flash-x', 'gemini:gemma-x']);
});

test('valid fallback response is still accepted', async () => {
  handlers = { gemini: (m) => (m === 'flash-x' ? status(429) : GEMINI_OK(GOOD_FB)), openai: () => assert.fail('must not be called') };
  await withEnv(baseEnv, async () => {
    assert.equal(await makeProvider(agent).generate(REQ), GOOD_FB);
  });
});

test('primary and fallback enforce equivalent leak validation for every fixture', async () => {
  for (const leak of LEAKS) {
    for (const path of ['primary-only', 'fallback']) {
      calls = [];
      handlers = path === 'primary-only'
        ? { gemini: () => GEMINI_OK(leak), openai: () => assert.fail('no') }
        : { gemini: (m) => (m === 'flash-x' ? status(429) : GEMINI_OK(leak)), openai: () => assert.fail('no') };
      await withEnv(path === 'primary-only' ? chainEnv : baseEnv, async () => {
        await assert.rejects(() => makeProvider(agent).generate(REQ), /leaked reasoning/, `${path}: ${leak.slice(0, 30)}`);
      });
    }
  }
});

test('fallback leak with last resort configured: chain failure semantics apply, leaked text never returned', async () => {
  handlers = { gemini: (m) => (m === 'flash-x' ? status(429) : GEMINI_OK(LEAK)), openai: () => OPENAI_OK(GOOD) };
  await withEnv(lrEnv, async () => {
    const out = await makeProvider(agent).generate(REQ);
    assert.equal(out, GOOD);
    assert.notEqual(out, LEAK);
  });
  assert.deepEqual(calls, ['gemini:flash-x', 'gemini:gemma-x', 'openai']);
});

test('fallback leak and last-resort leak: rejected by the last-resort guard', async () => {
  handlers = { gemini: (m) => (m === 'flash-x' ? status(429) : GEMINI_OK(LEAK)), openai: () => OPENAI_OK(LEAK) };
  await withEnv(lrEnv, async () => {
    await assert.rejects(() => makeProvider(agent).generate(REQ), /last-resort output rejected \(leaked reasoning\)/);
  });
});

test('fallback leak does not hide the quota signal when the last resort is also rate-limited', async () => {
  handlers = { gemini: (m) => (m === 'flash-x' ? status(429) : GEMINI_OK(LEAK)), openai: () => status(429, 'try again in 30s') };
  await withEnv(lrEnv, async () => {
    await assert.rejects(() => makeProvider(agent).generate(REQ), (e) => e instanceof QuotaError);
  });
});

test('both Gemini models rate-limited (no last resort): QuotaError propagates', async () => {
  handlers = { gemini: () => status(429), openai: () => assert.fail('must not be called') };
  await withEnv(baseEnv, async () => {
    await assert.rejects(() => makeProvider(agent).generate(REQ), (e) => e instanceof QuotaError);
  });
  assert.deepEqual(calls, ['gemini:flash-x', 'gemini:gemma-x']);
});

test('abort while the fallback returns leaked text: rejected, no last-resort call', async () => {
  const ac = new AbortController();
  handlers = {
    gemini: (m) => { if (m === 'flash-x') return status(429); ac.abort(new Error('shutdown')); return GEMINI_OK(LEAK); },
    openai: () => assert.fail('must not be called when aborted'),
  };
  await withEnv(lrEnv, async () => {
    await assert.rejects(() => makeProvider(agent).generate(REQ, { signal: ac.signal }), /leaked reasoning|shutdown|abort/i);
  });
  assert.ok(!calls.includes('openai'));
});

test('the rejection message never contains the rejected text or the API key', async () => {
  handlers = { gemini: () => GEMINI_OK(LEAK), openai: () => assert.fail('no') };
  await withEnv(chainEnv, async () => {
    await assert.rejects(() => makeProvider(agent).generate(REQ), (e) => !e.message.includes('core question') && !e.message.includes('AIza-test'));
  });
});
