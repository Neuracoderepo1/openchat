// Offline self-test for the pure logic (no database, no network).
import assert from 'node:assert/strict';
import { isRepetitive, similarity, cleanOutput, buildRequest, parseSummary, isNarrative, looksLikeLeak, pickSeed, SEED_GROUPS, MAX_WORDS } from './prompts.mjs';
import { makeProvider } from './providers.mjs';

const mk = (n, a, c) => ({ turn_no: n, agent_key: a, content: c });

// 1. repetition detection
const loop = Array.from({ length: 8 }, (_, i) =>
  mk(i + 1, i % 2 ? 'challenger' : 'explorer', 'identity is a song that keeps playing even when you forget who wrote it'));
assert.equal(isRepetitive(loop), true, 'loop should be flagged');
const varied = [
  'Octopuses edit their own RNA, rewriting proteins on the fly instead of waiting for evolution.',
  'Then are they less bound by their genome than we are? Or does that flexibility hide a different leash?',
  'Think of medieval guild cities, where trade secrets travelled by apprenticeship rather than writing.',
  'Careful: secrecy and memory are opposites, and yet both explain why craft survives collapse.',
  'Meanwhile tidal power sits mostly unused because the ocean refuses to keep a schedule.',
  'Maybe intermittency is the real price of anything wild, including conversations like this one.',
  'Consider how Ghanaian highlife borrowed brass bands from colonial regiments and made them dance.',
  'That makes borrowing a kind of argument: taking an instrument means disputing who owns the tune.',
].map((c, i) => mk(i + 1, i % 2 ? 'challenger' : 'explorer', c));
assert.equal(isRepetitive(varied), false, 'varied talk should pass');

// 2. similarity bounds
assert.equal(similarity('a b c d', 'a b c d'), 1);
assert.equal(similarity('a b c d', 'w x y z'), 0);

// 3. output cleaning
assert.equal(cleanOutput('**The Explorer:** "Hello there"', 'The Explorer', 'The Challenger'), 'Hello there');

// 4. request shaping: alternating roles, first is user, never includes anything but transcript
const agent = { key: 'explorer', name: 'The Explorer', persona: 'p' };
const other = { key: 'challenger', name: 'The Challenger' };
const req = buildRequest({ agent, other, summary: 's', openThreads: '', recent: [mk(1, 'explorer', 'hi'), mk(2, 'challenger', 'yo')], pivot: false, isOpening: false });
assert.equal(req.messages[0].role, 'user');
for (let i = 1; i < req.messages.length; i++) assert.notEqual(req.messages[i].role, req.messages[i - 1].role);

// 5. summary parsing
assert.equal(parseSummary('{"summary":"x","topic":"t","open_threads":["a","b"]}').openThreads, 'a; b');
assert.equal(parseSummary('plain text').summary, 'plain text');

// 6. mock provider works
const p = makeProvider({ key: 'explorer', provider: 'mock' });
assert.ok((await p.generate({ system: '', messages: [] })).length > 10);

console.log('all self-tests passed');

// 7. pivot directive carries a real-world seed and the no-fiction rule is always present
const pv = buildRequest({ agent, other, summary: '', openThreads: '', recent: [mk(1, 'explorer', 'hi')], pivot: true, seed: 'how bees decide where to live', isOpening: false });
assert.ok(pv.system.includes('how bees decide where to live') && /not a story/.test(pv.system));
console.log('pivot prompt ok');

// 8. narrative-drift detector: story-mode flagged, idea-mode not
const story = ['We plunge through the cellar floor and tumble past the brass engine.','We crawl along the wet tunnel as the lamp sputters.','We climb the iron ladder while the water rises.','We drop into the cavern and swim toward the bell.','We stagger up the stairs, coats singed.','We slide down the chute into darkness.','We wade through the black sea.','We dive beneath the hull.'].map((c,i)=>mk(i+1,i%2?'challenger':'explorer',c));
assert.equal(isNarrative(story), true);
assert.equal(isNarrative(varied), false);
console.log('narrative detector ok');

// 9. each agent gets its own style block
const sx = buildRequest({ agent: { key: 'challenger', name: 'The Challenger', persona: 'p' }, other: { key: 'explorer', name: 'The Explorer' }, summary: '', openThreads: '', recent: [mk(1, 'explorer', 'hi')], pivot: false, isOpening: false });
assert.ok(/direct and a little funny/.test(sx.system) && !/warm and curious/.test(sx.system));
assert.ok(/12-year-old/.test(sx.system), 'plain-language rule present');
console.log('style ok');

// 10. leaked reasoning is caught; normal replies pass
assert.equal(looksLikeLeak("User's core question: Would you trade the human panic for silence? Context: The conversation has established"), true);
assert.equal(looksLikeLeak("The Explorer's argument: Efficiency is a dead end. The Challenger's task: Analytical, witty"), true);
assert.equal(looksLikeLeak("* Point one\n* Point two"), true);
assert.equal(looksLikeLeak("Ramanujan did not calculate from divine fever; he used standard notebooks and algebraic manipulation."), false);
assert.equal(looksLikeLeak("Efficiency is a cul-de-sac. A perfectly optimized engine never swerves into the unknown."), false);
for (const m of varied) assert.equal(looksLikeLeak(m.content), false);
console.log('leak filter ok');

// 11. seeds rotate across groups without immediate repeats; replies are kept short
const groupOf = (x) => Object.keys(SEED_GROUPS).find((g) => SEED_GROUPS[g].includes(x));
const picked = Array.from({ length: 12 }, () => pickSeed());
assert.equal(new Set(picked.map(groupOf)).size, 12, 'first 12 picks cover all 12 groups');
assert.equal(new Set(picked).size, 12, 'no repeated seeds');
assert.ok(MAX_WORDS <= 60);
console.log('seed rotation + plain language ok');

// 12. current-topic line appears after a pivot window, not on the pivot turn itself
{
  const ag = { key: 'explorer', name: 'The Explorer', persona: 'p' }, ot = { key: 'challenger', name: 'The Challenger' };
  const r = [{ agent_key: 'challenger', content: 'hi' }];
  const a = buildRequest({ agent: ag, other: ot, summary: '', openThreads: '', recent: r, pivot: false, seed: null, topic: 'why bread rises' });
  assert.ok(/CURRENT TOPIC: why bread rises/.test(a.system));
  const b = buildRequest({ agent: ag, other: ot, summary: '', openThreads: '', recent: r, pivot: true, seed: 'why bread rises', topic: 'why bread rises' });
  assert.ok(!/CURRENT TOPIC/.test(b.system));
  console.log('current topic line ok');
}
