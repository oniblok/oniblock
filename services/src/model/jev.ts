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

/** Typed questions. Two questions keep the call cheap; the choice head carries Jev's own confidence. */
export const JEV_QUESTIONS = {
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
  const key = typeof state === 'string' ? state : JSON.stringify(state);
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
      body: JSON.stringify({ model: JEV_MODEL, state, questions: JEV_QUESTIONS }),
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
