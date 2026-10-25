// Model provider adapters. Each takes { system, messages } and returns text.
// Throws QuotaError on rate/usage limits so the engine can pause and resume.
// Only authorised context (persona + the agents' own conversation) is ever sent.

import { looksLikeLeak } from './prompts.mjs';

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
  if (h.trim() !== '' && Number.isFinite(n)) return n >= 0 ? Math.min(n, 86_400) * 1000 : null;   // negative/absurd values are ignored/clamped
  const d = Date.parse(h);
  return Number.isNaN(d) ? null : Math.min(86_400_000, Math.max(0, d - Date.now()));
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

const PROVIDER_TIMEOUT_MS = () => Number(process.env.PROVIDER_TIMEOUT_SECONDS ?? 60) * 1000;
const fetchSignal = (opts, timeoutMs = PROVIDER_TIMEOUT_MS()) => AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(opts?.signal ? [opts.signal] : [])]);

// Every Gemini model (primary, fallback or standalone) returns text through this guard, so no Gemini
// path can hand leaked reasoning to the engine. The "400" prefix keeps the existing failover rule
// (a 400/403/404 on the primary moves on to the fallback model). The rejected text is deliberately
// NOT included in the error message, so it cannot end up in logs or be published by accident.
function checkedGeminiOutput(text) {
  if (looksLikeLeak(text)) throw new Error('400 leaked reasoning in output');
  return text;
}

const gemini = ({ model, apiKey, timeoutMs }) => ({
  async generate({ system, messages }, opts) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      signal: fetchSignal(opts, timeoutMs),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        generationConfig: { temperature: 1.0, maxOutputTokens: /gemma/i.test(model) ? 1800 : 300 },   // Gemma spends tokens on hidden reasoning first
      }),
    });
    const j = await checked(res, 'gemini');
    const t = j?.candidates?.[0]?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? '').join('') ?? '';
    if (!t.trim()) throw new Error('gemini returned empty text');
    return checkedGeminiOutput(t);
  },
});

// Works with any OpenAI-compatible endpoint (Groq, OpenRouter, Together, local vLLM/Ollama...)
const openaiCompat = ({ model, apiKey, baseUrl, timeoutMs }) => ({
  async generate({ system, messages }, opts) {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      signal: fetchSignal(opts, timeoutMs),
      body: JSON.stringify({
        model,
        temperature: 1.0,
        max_tokens: Number(process.env.OPENAI_COMPAT_MAX_TOKENS) > 0 ? Number(process.env.OPENAI_COMPAT_MAX_TOKENS) : 300,   // free "thinking" models spend this on hidden reasoning first; raise it if replies come back empty
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

// A last-resort model is an arbitrary third-party model, so its output is checked before it can be published:
// guard/safety-classifier verdicts (e.g. "User Safety: safe"), leaked reasoning and near-empty replies are rejected.
const GUARD_VERDICT = /\b(user|response|assistant|prompt) safety\s*:|\b(safe|unsafe)\s*\n?\s*(s\d{1,2}\b|categories)|^\s*(safe|unsafe)\s*$/im;
// Reasoning-style openers a free model may emit instead of a reply: talking *about* "the user" or the task.
// The two agents never address or describe a "user", so a reply that does is the model's scratchpad.
const META_REASONING = /^\s*(the|this) user\b|\buser (is|has|wants|asks|asked|argues|argued|said|says|seems|continues|presents|makes|making|raises)\b|^\s*(okay|ok|alright|let me|let's|i('ll| will| need| should)|first,? i|here('s| is) (a|my|the) (response|reply|draft))\b/im;
export function unusableLastResort(t) {
  const x = String(t ?? '').trim();
  if (x.length < 20) return 'too short';
  if (GUARD_VERDICT.test(x)) return 'guard-model verdict';
  if (looksLikeLeak(x)) return 'leaked reasoning';
  if (META_REASONING.test(x)) return 'meta-commentary about "the user"';
  return null;
}

// Optional last-resort tier: an OpenAI-compatible endpoint (e.g. Groq, OpenRouter) used only when
// the whole Gemini chain fails. Enabled per agent by <AGENT>_LAST_RESORT_MODEL together with
// OPENAI_COMPAT_API_KEY and OPENAI_COMPAT_BASE_URL. With any of those missing it is simply off.
function lastResortFor(K, env) {
  const model = env[`${K}_LAST_RESORT_MODEL`];
  if (!model) return null;
  if (!env.OPENAI_COMPAT_API_KEY || !env.OPENAI_COMPAT_BASE_URL) {
    console.log(`${new Date().toISOString()} ${K}_LAST_RESORT_MODEL is set but OPENAI_COMPAT_API_KEY / OPENAI_COMPAT_BASE_URL are missing; last-resort tier disabled`);
    return null;
  }
  return openaiCompat({ model, apiKey: env.OPENAI_COMPAT_API_KEY, baseUrl: env.OPENAI_COMPAT_BASE_URL });
}

function withLastResort(chain, lastResort, env) {
  const holdMs = Number(env.LAST_RESORT_HOLD_SECONDS ?? 120) * 1000;
  let skipChainUntil = 0;
  return {
    async generate(req, opts) {
      let chainErr = null;
      if (Date.now() >= skipChainUntil) {
        try { return await chain.generate(req, opts); }
        catch (e) {
          if (opts?.signal?.aborted) throw e;            // shutdown / lease loss: never fall through
          chainErr = e;
          skipChainUntil = Date.now() + holdMs;          // stop hammering a failing chain for a short while
          console.log(`${new Date().toISOString()} gemini chain failed (${String(e.message).slice(0, 70).replace(/\s+/g, ' ')}); using last-resort model for ${Math.round(holdMs / 1000)}s`);
        }
      }
      try {
        const out = await lastResort.generate(req, opts);
        const bad = unusableLastResort(out);
        if (bad) throw new Error(`last-resort output rejected (${bad}) - empty or leaked reply`);
        return out;
      } catch (e) {
        if (opts?.signal?.aborted) throw e;
        // If either tier was rate-limited, surface that so the engine pauses instead of spinning.
        if (chainErr instanceof QuotaError && !(e instanceof QuotaError)) throw chainErr;
        throw e;
      }
    },
  };
}

export function makeProvider(agent) {
  const env = process.env;
  const K = agent.key.toUpperCase();
  // Environment overrides take precedence over the agents table (lets ops change models without SQL).
  const p = env[`${K}_PROVIDER`] || agent.provider;
  const model = env[`${K}_MODEL`] || agent.model;
  if (p === 'mock') return mock({ label: agent.key });
  if (p === 'gemini') {
    if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing');
    const lastResort = lastResortFor(K, env);
    // With a last-resort tier, the Gemini tiers get a shorter per-call limit so a hung call
    // cannot use up the whole provider budget before the last resort gets its turn.
    const tierMs = lastResort ? Math.min(PROVIDER_TIMEOUT_MS(), Number(env.GEMINI_TIER_TIMEOUT_SECONDS ?? 25) * 1000) : undefined;
    const primary = gemini({ model, apiKey: env.GEMINI_API_KEY, timeoutMs: tierMs });
    const fbModel = env[`${K}_FALLBACK_MODEL`];
    let chain = primary;
    if (fbModel && fbModel !== model) {
      // Model fallback: if the primary model is rejected or out of quota, use the fallback model
      // (a separate model has its own free quota). The failing model is skipped for a while.
      // Only when BOTH are unavailable does a QuotaError propagate, so the engine pauses.
      const fallback = gemini({ model: fbModel, apiKey: env.GEMINI_API_KEY, timeoutMs: tierMs });
      let skipPrimaryUntil = 0;
      chain = {
        async generate(req, opts) {
          if (Date.now() >= skipPrimaryUntil) {
            try {
              return await primary.generate(req, opts);   // leak-checked inside gemini(); a rejection falls through to the fallback model
            } catch (e) {
              const quota = e instanceof QuotaError;
              if (!quota && !/\b(400|403|404)\b|empty text/.test(String(e.message))) throw e;
              const holdMs = quota ? Math.max(e.retryAfterMs ?? 0, 10 * 60_000) : 30 * 60_000;
              skipPrimaryUntil = Date.now() + holdMs;
              console.log(`${new Date().toISOString()} model ${model} ${quota ? 'out of quota' : 'rejected'} (${String(e.message).slice(0, 70).replace(/\s+/g, ' ')}); using ${fbModel} for ${Math.round(holdMs / 60000)} min`);
            }
          }
          return fallback.generate(req, opts);
        },
      };
    }
    return lastResort ? withLastResort(chain, lastResort, env) : chain;
  }
  if (p === 'openai_compat') {
    if (!env.OPENAI_COMPAT_API_KEY || !env.OPENAI_COMPAT_BASE_URL)
      throw new Error('OPENAI_COMPAT_API_KEY / OPENAI_COMPAT_BASE_URL missing');
    return openaiCompat({ model, apiKey: env.OPENAI_COMPAT_API_KEY, baseUrl: env.OPENAI_COMPAT_BASE_URL });
  }
  throw new Error(`Unknown provider: ${p}`);
}
