// Offline self-test for the pure logic (no database, no network).
import assert from 'node:assert/strict';
import { isRepetitive, similarity, cleanOutput, buildRequest, parseSummary } from './prompts.mjs';
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
