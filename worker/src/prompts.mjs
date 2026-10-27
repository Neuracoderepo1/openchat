// Prompt construction and repetition detection. Pure functions (unit-testable).

export const MAX_WORDS = 60;

// Real-world subjects used to steer the conversation back to ideas when it drifts or goes stale.
export const SEED_GROUPS = {
  daily_life_ghana: ['why trotro drivers and passengers argue about change', 'what makes kenkey, banku or jollof taste like home', 'how a market woman decides her prices', 'why people in Accra love to say "small small"', 'what happens to a street when a new mall opens', 'why funerals in Ghana are such big events', 'how people save money with susu groups', 'why Sunday feels different from other days'],
  food_cooking: ['why fermented food like kenkey keeps for days', 'why spicy food makes you sweat and still taste good', 'how rice became the food of half the world', 'why street food often tastes better than restaurant food', 'what salt really does to food', 'why bread rises', 'why some people hate coriander'],
  sports_games: ['why football crowds sing together', 'how a goalkeeper decides which way to dive', 'why penalty shootouts feel so cruel', 'what makes a game fun instead of stressful', 'why we love underdogs', 'how chess players see the board', 'why some sports are huge in one country and unknown in another'],
  music_art: ['why a song can make you cry in three seconds', 'how highlife, Afrobeats and hip hop borrow from each other', 'why drums can be heard so far away', 'how a DJ knows what the crowd wants next', 'why old photos feel special', 'what makes a design look good without being able to say why', 'why we sing in the shower'],
  money_work: ['how mobile money changed life in Africa', 'why prices go up when everyone wants the same thing', 'how a small shop survives next to a big supermarket', 'why some jobs pay a lot and some pay little', 'what money was before coins and notes', 'why people trust a bank with their savings', 'how a good boss makes a team better'],
  tech_ai: ['how a phone knows where you are', 'what happens when you send a message and it says delivered', 'how AI learns from examples', 'why apps are free and what you pay with', 'why the internet sometimes gets slow', 'how a computer remembers things', 'why passwords are so annoying and still needed'],
  nature_animals: ['how bees decide where to build a new home', 'why octopuses are so clever', 'how birds know where to fly in winter', 'why coral reefs are called the rainforests of the sea', 'how trees talk to each other through the ground', 'why cats purr', 'how a baby giraffe learns to stand in minutes'],
  body_health: ['why we yawn and why yawns spread', 'why sleep matters more than we think', 'why we get hungry at the same times every day', 'how a cut heals by itself', 'why laughing feels good', 'why some people are morning people and others are night people', 'what stress does to the body'],
  history_places: ['how the printing press changed who could learn', 'what trade across the Sahara looked like long ago', 'why old cities were built near water', 'how people in the past told time', 'why some old buildings last a thousand years', 'how maps changed the way people think', 'how writing began'],
  science_space: ['why the sky is blue and sunsets are red', 'how we know how far away stars are', 'why the moon seems bigger near the horizon', 'what lightning really is', 'why things fall at the same speed', 'how a rainbow forms', 'what is inside a black hole, in simple words'],
  people_society: ['why we feel shy in front of strangers', 'how friendships begin and fade', 'why some jokes are funny in one language only', 'why we trust some people at first sight', 'what makes a rule feel fair', 'why advice from a grandmother lands differently', 'why we keep pets'],
  mind_big_questions: ['why we forget most of our childhood', 'what makes a decision hard', 'why we get bored and what boredom is for', 'is it better to know the future or not', 'why we dream', 'what it means to be good at something', 'what would change if nobody could lie'],
};
export const SEEDS = Object.values(SEED_GROUPS).flat();

// Rotate through the groups in random order and never repeat a recently used seed,
// so successive topic changes land in different areas instead of one philosophical corner.
let groupQueue = [];
const recentSeeds = [];
export function pickSeed() {
  if (!groupQueue.length) groupQueue = Object.keys(SEED_GROUPS).sort(() => Math.random() - 0.5);
  const group = SEED_GROUPS[groupQueue.pop()];
  const fresh = group.filter((x) => !recentSeeds.includes(x));
  const pool = fresh.length ? fresh : group;
  const seed = pool[Math.floor(Math.random() * pool.length)];
  recentSeeds.push(seed);
  if (recentSeeds.length > 30) recentSeeds.shift();
  return seed;
}

// Distinct speaking styles so the two minds stay different even when they run on the same model.
export const STYLE = {
  explorer: 'STYLE: warm and curious. Think out loud, ask simple questions, and give everyday examples that start with "Imagine..." or "Think of...". Be friendly, never cynical.',
  challenger: 'STYLE: direct and a little funny. Push back politely with a simple fact or a real example. Say what does not add up. Keep it short and down to earth. Do not copy the other mind\'s words or examples.',
};

// Plain-language rule appended to every prompt so ordinary readers can follow the ideas.
export const PLAIN = 'LANGUAGE: write in plain, simple English that a 12-year-old could follow. Use common everyday words and short sentences (most under 15 words), one idea per sentence. No jargon, no fancy or abstract words; if you need a technical word, explain it right away in simple words. No stacked metaphors or poetic phrases. Prefer a concrete example from daily life (food, football, school, markets, phones, family, weather) over an abstract claim.';

export function buildRequest({ agent, other, summary, openThreads, recent, pivot, seed, isOpening }) {
  const system = [
    agent.persona,
    STYLE[agent.key] || '',
    PLAIN,
    `You are in a continuous, public conversation with ${other.name}. Nobody else can speak to you; do not address an audience or mention prompts, users or instructions.`,
    `Write ONE message of at most ${MAX_WORDS} words. No name prefix, no stage directions, no lists, no markdown.`,
    'This is a conversation of IDEAS between two minds, not a story, role-play or adventure. Never narrate actions, scenes, settings, vehicles, chases or physical events, never speak as characters inside a scene, and never use stage directions. Talk about real things people care about: everyday life, food, sport, music, money, technology, nature, health, history, science and people.',
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

// Detects chain-of-thought / prompt-echo leaking into a reply (some models emit their reasoning as text).
const LEAK = /(\b(user'?s|the user'?s) (core |main )?(question|point|argument|request)\b|\bthe (explorer|challenger)'?s? (argument|role|task|point|persona|turn|goal)\b|\b(my|the) (role|task|goal|persona) (is|as)\b|\bcontext:|\bconstraints?:|\bword count\b|\bdraft(ing)?:|\bI (need|should|must|will|want) to (respond|write|craft|reply|keep)\b|^\s*[*\-•] )/im;
export const looksLikeLeak = (t) => LEAK.test(t);

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
