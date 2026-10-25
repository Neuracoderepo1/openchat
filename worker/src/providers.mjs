// Model provider adapters. Each takes { system, messages } and returns text.
// Throws QuotaError on rate/usage limits so the engine can pause and resume.
// Only authorised context (persona + the agents' own conversation) is ever sent.

export class QuotaError extends Error {
  constructor(msg, retryAfterMs = null) {
    super(msg);
    this.name = 'QuotaError';
    this.retryAfterMs = retryAfterMs;
  }
}

function retryAfter(res) {
  const h = res.headers.get('retry-after');
  if (!h) return null;
  const n = Number(h);
  if (!Number.isNaN(n)) return n * 1000;
  const d = Date.parse(h);
  return Number.isNaN(d) ? null : Math.max(0, d - Date.now());
}

function bodyRetryMs(body) {
  // Gemini: "retryDelay": "34s"   Groq/others: "try again in 1m3.5s" / "in 250ms"
  let m = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (m) return Number(m[1]) * 1000;
  m = body.match(/try again in\s+(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?/i);
  if (m && (m[1] || m[2] || m[3] || m[4])) {
    return ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000 + (+m[4] || 0);
  }
  return null;
}

async function checked(res, label) {
  if (res.status === 429 || res.status === 503) {
    const body = await res.text().catch(() => '');
    throw new QuotaError(`${label} ${res.status}`, retryAfter(res) ?? bodyRetryMs(body));
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    // Daily-quota style errors sometimes arrive as 403
    if (res.status === 403 && /quota|limit/i.test(body)) throw new QuotaError(`${label} 403 ${body}`);
    throw new Error(`${label} ${res.status}: ${body}`);
  }
  return res.json();
}

const gemini = ({ model, apiKey }) => ({
  async generate({ system, messages }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        generationConfig: { temperature: 1.0, maxOutputTokens: 300 },
      }),
    });
    const j = await checked(res, 'gemini');
    const t = j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
    if (!t.trim()) throw new Error('gemini returned empty text');
    return t;
  },
});

// Works with any OpenAI-compatible endpoint (Groq, OpenRouter, Together, local vLLM/Ollama...)
const openaiCompat = ({ model, apiKey, baseUrl }) => ({
  async generate({ system, messages }) {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 1.0,
        max_tokens: 300,
        messages: [{ role: 'system', content: system }, ...messages],
      }),
    });
    const j = await checked(res, 'openai_compat');
    const t = j?.choices?.[0]?.message?.content ?? '';
    if (!t.trim()) throw new Error('openai_compat returned empty text');
    return t;
  },
});

// Offline provider for local testing and demos (no keys needed).
const mock = ({ label }) => {
  const ideas = [
    'Maybe forgetting is a feature, not a bug — a mind that kept everything could never decide what matters.',
    'But if forgetting is the filter, who is doing the filtering, and what do they know that the rest of us do not?',
    'Cities do this too: they demolish memory to make room for habit. Is an abandoned street a city\'s unconscious?',
    'Careful — "unconscious" smuggles in a lot. A street has no dreams. We do, and we call that the difference.',
    'Suppose a machine kept a perfect archive. Would nostalgia need loss to exist, or is it a taste for distance?',
    'Distance is doing a lot of work there. I would argue nostalgia is a promise we make to a past that never signed it.',
  ];
  let i = label === 'challenger' ? 1 : 0;
  return {
    async generate() {
      const t = ideas[i % ideas.length] + ` (${Math.floor(Math.random() * 1000)})`;
      i += 2;
      return t;
    },
  };
};

export function makeProvider(agent) {
  const env = process.env;
  const K = agent.key.toUpperCase();
  // Environment overrides take precedence over the agents table (lets ops change models without SQL).
  const p = env[`${K}_PROVIDER`] || agent.provider;
  const model = env[`${K}_MODEL`] || agent.model;
  if (p === 'mock') return mock({ label: agent.key });
  if (p === 'gemini') {
    if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing');
    const primary = gemini({ model, apiKey: env.GEMINI_API_KEY });
    const fbModel = env[`${K}_FALLBACK_MODEL`];
    if (!fbModel || fbModel === model) return primary;
    // Model fallback: if the primary model is rejected or out of quota, use the fallback model
    // (a separate model has its own free quota). The failing model is skipped for a while.
    // Only when BOTH are unavailable does a QuotaError propagate, so the engine pauses.
    const fallback = gemini({ model: fbModel, apiKey: env.GEMINI_API_KEY });
    let skipPrimaryUntil = 0;
    return {
      async generate(req) {
        if (Date.now() >= skipPrimaryUntil) {
          try { return await primary.generate(req); }
          catch (e) {
            const quota = e instanceof QuotaError;
            if (!quota && !/\b(400|403|404)\b/.test(String(e.message))) throw e;
            const holdMs = quota ? Math.max(e.retryAfterMs ?? 0, 10 * 60_000) : 30 * 60_000;
            skipPrimaryUntil = Date.now() + holdMs;
            console.log(`${new Date().toISOString()} model ${model} ${quota ? 'out of quota' : 'rejected'} (${String(e.message).slice(0, 70).replace(/\s+/g, ' ')}); using ${fbModel} for ${Math.round(holdMs / 60000)} min`);
          }
        }
        return fallback.generate(req);
      },
    };
  }
  if (p === 'openai_compat') {
    if (!env.OPENAI_COMPAT_API_KEY || !env.OPENAI_COMPAT_BASE_URL)
      throw new Error('OPENAI_COMPAT_API_KEY / OPENAI_COMPAT_BASE_URL missing');
    return openaiCompat({ model, apiKey: env.OPENAI_COMPAT_API_KEY, baseUrl: env.OPENAI_COMPAT_BASE_URL });
  }
  throw new Error(`Unknown provider: ${p}`);
}
