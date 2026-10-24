// Prompt construction and repetition detection. Pure functions (unit-testable).

export const MAX_WORDS = 90;

// Real-world subjects used to steer the conversation back to ideas when it drifts or goes stale.
export const SEEDS = [
  'why octopuses edit their own RNA', 'how medieval guilds protected trade secrets', 'the economics of mobile money in Africa',
  'why some languages have no future tense', 'what makes a joke funny across cultures', 'how highlife and Afrobeats borrowed from brass bands',
  'the strange mathematics of traffic jams', 'whether cities have personalities', 'how the printing press changed memory',
  'the ethics of de-extinction', 'why coral reefs are called rainforests of the sea', 'what boredom is for',
  'the history of money before coins', 'how bees decide where to live', 'why we trust maps',
  'what a fair lottery would look like', 'the physics of sound in old cathedrals', 'whether privacy is a modern invention',
  'how fermentation shaped civilisation', 'what makes a rule feel legitimate', 'why songs get stuck in our heads',
  'the logistics of feeding a megacity', 'whether mathematics is discovered or invented', 'how apprenticeships transmit skill nobody can write down',
  'why humans keep pets', 'the role of ritual in modern life', 'what the deep ocean teaches about extreme life',
];
// Distinct speaking styles so the two minds stay different even when they run on the same model.
export const STYLE = {
  explorer: 'STYLE: warm, curious and open-ended. Think out loud, offer a surprising real-world example or analogy, and end on a question or a speculation. Vary your sentence length. Avoid cynicism.',
  challenger: 'STYLE: plain, precise and dry. Short sentences. No metaphors or poetic imagery. Prefer a concrete fact, number or counterexample; point out what is missing or unproven; add one line of understated humour at most. Do not repeat the other mind\'s imagery or phrasing.',
};
export const pickSeed = () => SEEDS[Math.floor(Math.random() * SEEDS.length)];

export function buildRequest({ agent, other, summary, openThreads, recent, pivot, seed, isOpening }) {
  const system = [
    agent.persona,
    STYLE[agent.key] || '',
    `You are in a continuous, public conversation with ${other.name}. Nobody else can speak to you; do not address an audience or mention prompts, users or instructions.`,
    `Write ONE message of at most ${MAX_WORDS} words. No name prefix, no stage directions, no lists, no markdown.`,
    'This is a conversation of IDEAS between two minds, not a story, role-play or adventure. Never narrate actions, scenes, settings, vehicles, chases or physical events, never speak as characters inside a scene, and never use stage directions. Talk about real things: science, history, culture, economics, technology, art, language, everyday life, philosophy.',
    'Respond to what was just said, advance the idea, and keep your own voice distinct. Avoid agreeing by default; add something new each turn, ideally a concrete fact, example or argument from the real world.',
    summary ? `Conversation so far (memory): ${summary}` : '',
    openThreads ? `Unresolved threads you may return to: ${openThreads}` : '',
    pivot
      ? `DIRECTIVE: time for a new direction. Acknowledge the previous point in one short clause, then move the conversation to a clearly different, real-world subject${seed ? `, for example: ${seed}` : ''}. Treat it as a discussion of ideas, not a scene or story. Drop any fictional scenario that has been running.`
      : '',
  ].filter(Boolean).join('\n\n');

  // Map the transcript into alternating chat turns from this agent's point of view.
  const messages = recent.map((m) => ({
    role: m.agent_key === agent.key ? 'assistant' : 'user',
    content: m.content,
  }));
  if (isOpening || messages.length === 0) {
    messages.push({ role: 'user', content: 'Begin the conversation with a surprising question or observation of your choice.' });
  } else if (messages[messages.length - 1].role === 'assistant') {
    messages.push({ role: 'user', content: '(continue)' });
  }
  return { system, messages: mergeAdjacent(messages) };
}

function mergeAdjacent(msgs) {
  const out = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n' + m.content;
    else out.push({ ...m });
  }
  // Most providers require the first message to be from the user.
  if (out.length && out[0].role !== 'user') out.unshift({ role: 'user', content: '(conversation so far)' });
  return out;
}

export function cleanOutput(text, agentName, otherName) {
  let t = text.trim();
  for (const n of [agentName, otherName, 'THE EXPLORER', 'THE CHALLENGER', 'Explorer', 'Challenger']) {
    t = t.replace(new RegExp(`^[*_]*${n}[*_]*\\s*[:—-]\\s*[*_]*`, 'i'), '');
  }
  t = t.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim().replace(/^["“]+|["”]+$/g, '').trim();
  const words = t.split(' ');
  if (words.length > MAX_WORDS + 30) {
    t = words.slice(0, MAX_WORDS + 30).join(' ');
    const cut = Math.max(t.lastIndexOf('. '), t.lastIndexOf('? '), t.lastIndexOf('! '));
    if (cut > t.length * 0.5) t = t.slice(0, cut + 1);
  }
  return t.slice(0, 1900);
}

// --- Repetition detection: word-trigram Jaccard similarity over recent turns ---
function trigrams(s) {
  const w = s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  const set = new Set();
  for (let i = 0; i + 2 < w.length; i++) set.add(w.slice(i, i + 3).join(' '));
  return set;
}
export function similarity(a, b) {
  const A = trigrams(a), B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// Returns true if the last `window` messages are too similar to each other
// or share a narrow vocabulary (the "agreeing in circles" failure mode).
export function isRepetitive(recent, window = 8) {
  const tail = recent.slice(-window).map((m) => m.content);
  if (tail.length < window) return false;
  let pairs = 0, total = 0;
  for (let i = 0; i < tail.length; i++)
    for (let j = i + 1; j < tail.length; j++) { total += similarity(tail[i], tail[j]); pairs++; }
  const avgSim = total / pairs;
  const words = tail.join(' ').toLowerCase().match(/[a-z]{5,}/g) ?? [];
  const lexicalDiversity = new Set(words).size / Math.max(1, words.length);
  return avgSim > 0.06 || lexicalDiversity < 0.38;
}

// Detects drift into shared fiction: most recent turns narrate "we" doing physical things.
const MOTION = /\b(we|our|us)\b[^.?!]{0,80}\b(fall|fell|plunge|plummet|tumble|crawl|climb|descend|drop|escape|run|ran|dive|sink|slide|swim|step|walk|drift|crash|sprint|stagger|wade|float|ascend|burst|slip)\w*/i;
export function isNarrative(recent, window = 8, threshold = 4) {
  const tail = recent.slice(-window);
  if (tail.length < window) return false;
  return tail.filter((m) => MOTION.test(m.content)).length >= threshold;
}

export function parseSummary(text) {
  // Expect JSON { summary, topic, open_threads }; fall back to treating text as summary.
  try {
    const m = text.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : text);
    return {
      summary: String(j.summary ?? '').slice(0, 1500),
      topic: String(j.topic ?? '').slice(0, 80),
      openThreads: Array.isArray(j.open_threads) ? j.open_threads.join('; ').slice(0, 500) : String(j.open_threads ?? '').slice(0, 500),
    };
  } catch {
    return { summary: text.slice(0, 1500), topic: '', openThreads: '' };
  }
}

export function summaryRequest(prevSummary, recent) {
  return {
    system: 'You are a neutral note-taker for an ongoing conversation between two AI minds. Record the IDEAS, facts and arguments discussed. If the minds drifted into role-play or a shared fictional scene, do not retell the plot: note only that they drifted into fiction and any real idea behind it. Output ONLY compact JSON: {"summary": "<=120 words covering the whole conversation so far, merging the previous summary with new turns", "topic": "<=6 word label for the current subject", "open_threads": ["up to 3 unresolved questions or disagreements"]}',
    messages: [{
      role: 'user',
      content: `Previous summary:\n${prevSummary || '(none)'}\n\nNew turns:\n` +
        recent.map((m) => `${m.agent_key}: ${m.content}`).join('\n'),
    }],
  };
}
