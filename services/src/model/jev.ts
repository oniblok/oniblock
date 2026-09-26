/**
 * Jev (TypeSafe "System One" evaluation model) via Vercel AI Gateway.
 *
 * Empirically verified (see docs/JEV_NOTES.md):
 *   POST https://ai-gateway.vercel.sh/v1/evaluate   (Bearer AI_GATEWAY_API_KEY)
 *   body   { model: "typesafe-ai/jev", state: string|object, questions: { key: {type, instructions, criteria?} } }
 *   types  boolean -> {type:'boolean', probability}
 *          choice  -> {type:'choice', choice, probabilities:{..}, confidence}
 *          score   -> {type:'score', score, probabilities:{'0':..}, confidence}
 * The OpenAI-compatible /v1/chat/completions rejects Jev ("evaluation model, not a language model").
 *
 * `scoreWithJev` never throws: any failure / timeout / malformed answer returns null so the
 * caller falls back to the heuristic.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { env } from '../config.js';
import { clampBps, type FlowClass, type ModelScore } from './types.js';

export const JEV_MODEL = 'typesafe-ai/jev';
export const JEV_URL = env('JEV_URL', 'https://ai-gateway.vercel.sh/v1/evaluate')!;

/** v1-v3 typed questions (kept byte-identical so the frozen v1-v3 benchmark caches stay valid). */
export const JEV_QUESTIONS_V1 = {
  toxic: {
    type: 'boolean',
    instructions:
      "Will the next block's arbitrage-direction swaps into this pool be informed flow that is toxic to liquidity providers (the trader profits because the pool price is stale versus the Binance price)?",
    criteria: {
      true: 'informed / toxic: a price gap larger than the fee is open and arbitrageurs are likely to close it at LPs expense',
      false: 'benign: no profitable gap, flow is noise or uninformed',
    },
  },
  regime: {
    type: 'choice',
    instructions: 'Classify the flow regime of this pool for the next block.',
    criteria: {
      informed: 'informed arbitrage against a stale pool price',
      dump: 'one-sided uninformed selling or buying without a price gap',
      unknown: 'no clear signal',
    },
  },
} as const;

/**
 * v4 ("the AI decides the fee", docs/review/V4_AI_DECIDES.md): Jev is asked every block and its probability IS the
 * fee decision (hook: k = kMax * p * c with kMin = 0, arbThresholdPips = 0). The question says so, and says that
 * without profitable arbitrage at the base fee the probability must be near 0 (then the pool charges exactly base).
 * Pair with the v4 state text (featuresToState format 'v4'). The regime head still carries Jev's own confidence.
 */
export const JEV_QUESTIONS_V4 = {
  toxic: {
    type: 'boolean',
    instructions:
      'Should this pool charge an extra arbitrage fee on the next block? Answer true only if there is profitable, informed arbitrage: the pool price is stale versus the Binance mid by MORE than the base fee (arb_edge_at_base_fee positive), so arbitrageurs will trade toward the Binance mid at liquidity providers expense. The extra fee is proportional to your probability. If arb_edge_at_base_fee is zero or negative there is no profitable arbitrage: the probability must be near 0, because an extra fee would only push ordinary traders to other pools.',
    criteria: {
      true: 'profitable arbitrage at the base fee: arb_edge_at_base_fee is positive and arbitrageurs will close the gap at LPs expense',
      false: 'no profitable arbitrage at the base fee (arb_edge_at_base_fee zero or negative): ordinary flow, charge only the base fee',
    },
  },
  regime: JEV_QUESTIONS_V1.regime,
} as const;

export type JevPrompt = 'v1' | 'v4';
/** Keeper default: v4 (env JEV_PROMPT=v1 restores the pre-v4 question + state). */
export const defaultJevPrompt = (): JevPrompt => (env('JEV_PROMPT', 'v4') === 'v1' ? 'v1' : 'v4');
/** Default questions of this build (v4). */
export const JEV_QUESTIONS = JEV_QUESTIONS_V4;
export const jevQuestions = (p: JevPrompt) => (p === 'v1' ? JEV_QUESTIONS_V1 : JEV_QUESTIONS_V4);
/** Cache key: v1 keys are the bare state text (old caches stay valid); v4 keys are namespaced by the prompt. */
export const jevCacheKey = (state: string, p: JevPrompt) => (p === 'v1' ? state : `[jev-prompt:${p}]\n${state}`);

export interface JevRaw {
  answers?: {
    toxic?: { type?: string; probability?: number };
    regime?: { type?: string; choice?: string; probabilities?: Record<string, number>; confidence?: number };
  };
  providerMetadata?: { typesafe?: { confidence?: Record<string, number> } };
}

/** Parse a raw /v1/evaluate response into our typed score (null if unusable). */
export function parseJev(raw: unknown, latencyMs: number): ModelScore | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as JevRaw;
  const p = r.answers?.toxic?.probability;
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) return null;
  const reg = r.answers?.regime;
  let cls: FlowClass = 'unknown';
  if (reg?.choice === 'informed' || reg?.choice === 'dump' || reg?.choice === 'unknown') cls = reg.choice;
  let conf: number | undefined = reg?.confidence ?? r.providerMetadata?.typesafe?.confidence?.regime;
  if (typeof conf !== 'number' || !Number.isFinite(conf)) {
    // fall back to how decisive the boolean head is
    conf = Math.abs(2 * p - 1);
  }
  return {
    pToxicBps: clampBps(p * 10_000),
    confidenceBps: clampBps(conf * 10_000),
    cls,
    latencyMs: Math.round(latencyMs),
    model: 'jev',
  };
}

/** Optional response cache keyed by exact state text (benchmark determinism / cost). */
export class JevCache {
  private m = new Map<string, ModelScore>();
  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      try {
        for (const [k, v] of Object.entries(JSON.parse(readFileSync(file, 'utf8')) as Record<string, ModelScore>)) this.m.set(k, v);
      } catch {
        /* corrupt cache: start fresh */
      }
    }
  }
  get(k: string) {
    return this.m.get(k);
  }
  set(k: string, v: ModelScore) {
    this.m.set(k, v);
  }
  get size() {
    return this.m.size;
  }
  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.m)));
  }
}

export interface JevOpts {
  /** Question set (default: defaultJevPrompt(), i.e. v4 unless JEV_PROMPT=v1). Also namespaces the cache key. */
  prompt?: JevPrompt;
  timeoutMs?: number;
  apiKey?: string;
  cache?: JevCache;
  fetchImpl?: typeof fetch;
  /** Called with raw response (for probes / notes). */
  onRaw?: (raw: unknown, latencyMs: number, status: number) => void;
}

/**
 * Ask Jev the typed questions about `state`. Returns null on any failure (never throws).
 */
export async function scoreWithJev(state: string | object, opts: JevOpts = {}): Promise<ModelScore | null> {
  const prompt = opts.prompt ?? defaultJevPrompt();
  const key = jevCacheKey(typeof state === 'string' ? state : JSON.stringify(state), prompt);
  const cached = opts.cache?.get(key);
  if (cached) return { ...cached, latencyMs: 0 };

  const apiKey = opts.apiKey ?? env('AI_GATEWAY_API_KEY');
  if (!apiKey) return null;
  const timeoutMs = opts.timeoutMs ?? Number(env('JEV_TIMEOUT_MS', '2500'));
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const res = await fetchImpl(JEV_URL, {
      method: 'POST',
      signal: ctl.signal,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: JEV_MODEL, state, questions: jevQuestions(prompt) }),
    });
    const text = await res.text();
    const latency = performance.now() - t0;
    let raw: unknown = null;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = { nonJson: text.slice(0, 200) };
    }
    opts.onRaw?.(raw, latency, res.status);
    if (!res.ok) return null;
    const s = parseJev(raw, latency);
    if (s && opts.cache) opts.cache.set(key, s);
    return s;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
