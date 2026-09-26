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
import { ATTACK_TYPES, attackProbabilities, clampBps, mapV6, PRICE_ATTACK_TYPES, type AttackHead, type AttackType, type FlowClass, type ModelScore } from './types.js';

export const JEV_MODEL = 'typesafe-ai/jev';
export const JEV_URL = env('JEV_URL', 'https://ai-gateway.vercel.sh/v1/evaluate')!;

/** v1-v3 typed questions (kept byte-identical so the frozen v1-v3 benchmark caches stay valid; test/jev.test.ts pins a hash). */
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
 * Byte-identical since v4 (benchmark/data/jev-cache.json `[jev-prompt:v4]` entries; test/jev.test.ts pins a hash).
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

/**
 * v5 ("the model decides two knobs", docs/review/V5_JIT_HEAD_SPEC.md): the v4 questions, byte-identical, plus a second
 * typed boolean — the JIT head. Its probability sets the pool's JIT penalty window for liquidity added from the next
 * block on (jitWindowMin + (jitWindowMax - jitWindowMin) * p * c / 1e8), and the settler grades it on its own Brier
 * record (calibration.jit.*). Pair with the v5 state text (featuresToState format 'v5' = the v4 lines + 3 liquidity
 * lines). The regime head still carries Jev's own confidence, shared by both knobs. The jit instructions end with an
 * explicit base-rate rule ("use liquidity_recent as the base rate ...") so Jev weighs the churn line; the keeper
 * additionally shrinks the answer toward the observed churn (keeper.ts blendPJit, JIT_CHURN_WEIGHT).
 * Byte-identical since v5 (test/jev.test.ts pins a hash).
 */
export const JEV_QUESTIONS_V5 = {
  ...JEV_QUESTIONS_V4,
  jit: {
    type: 'boolean',
    instructions:
      'Will liquidity added to this pool in the next block be opportunistic just-in-time liquidity: placed tightly around the current price to capture the fee of a large expected swap and removed again within about 100 blocks, rather than liquidity that stays? Answer with the probability that new liquidity in the next block is short-lived fee capture. Use liquidity_recent as the base rate: when most positions added recently were removed again within the window, the probability must be high (above 0.7); when recent liquidity stayed, it must be low.',
    criteria: {
      true: 'short-lived fee capture around a large swap (mint, swap, burn within ~100 blocks)',
      false: 'liquidity that stays, routine rebalancing, or no liquidity change expected',
    },
  },
} as const;

/**
 * v6 ("one score, one type", docs/JEV_NOTES.md "v6 questions and mapping"): the model answers ONE malicious score
 * (P(next block contains LP-costly flow)) plus ONE attack-type choice. The keeper keeps attesting the same two numbers
 * as v5 — the score is the magnitude and the type allocates it: price types -> pToxicBps (k), jit_liquidity ->
 * pJitBps (JIT window), see `mapV6` in types.ts. Pair with the v5 state text (featuresToState format 'v5', unchanged).
 * There is no separate regime head: `cls` is derived from the choice and the confidence is the choice head's own.
 * A single-choice type cannot express two attacks at once, which is why the keeper still blends observed churn into
 * pJitBps (blendPJit) after the mapping.
 */
export const JEV_QUESTIONS_V6 = {
  malicious: {
    type: 'boolean',
    instructions:
      "Will the next block bring flow that costs this pool's liquidity providers money? That means either profitable informed arbitrage toward the Binance mid at the base fee (arb_edge_at_base_fee positive, including split arbitrage and backruns after a large move), or opportunistic just-in-time liquidity placed around a large swap and removed again within the window. Answer with the probability that the next block contains such an exploit. If arb_edge_at_base_fee is zero or negative AND recent liquidity stayed, the probability must be near 0.",
    criteria: {
      true: 'LP-costly flow: profitable informed arbitrage toward the Binance mid at the base fee (arb_edge_at_base_fee positive; plain, split or backrun), or opportunistic just-in-time liquidity placed around a large swap and removed again within the window',
      false: 'no exploit: arb_edge_at_base_fee zero or negative and recent liquidity stayed; ordinary uninformed flow or routine rebalancing, charge only the base fee',
    },
  },
  attack: {
    type: 'choice',
    instructions:
      'Which kind of flow is most likely in the next block? Use liquidity_recent/liquidity_shape for jit_liquidity, arb_edge_at_base_fee and cex_volatility for the arbitrage types, recent_swaps for split_arbitrage/backrun.',
    criteria: {
      none: 'no LP-costly flow: no profitable gap at the base fee and recent liquidity stayed',
      cex_dex_arbitrage: 'informed arb against a stale price',
      split_arbitrage: 'the same arbitrage split into many sub-swaps in one block',
      backrun: 're-alignment right after a large displacing swap',
      jit_liquidity: 'mint→swap→burn fee capture',
      sandwich: 'front+back-run around a victim swap (not defended by this hook, label only)',
      unknown: 'no clear signal',
    },
  },
} as const;

export type JevPrompt = 'v1' | 'v4' | 'v5' | 'v6';
/** Keeper default: v6 (env JEV_PROMPT=v5 restores the two-boolean v5 questions, v4 the arb-only question + state, v1 the pre-v4 texts). */
export const defaultJevPrompt = (): JevPrompt => {
  const p = env('JEV_PROMPT', 'v6');
  return p === 'v1' ? 'v1' : p === 'v4' ? 'v4' : p === 'v5' ? 'v5' : 'v6';
};
/** Default questions of this build (v6 = one malicious score + one attack type). */
export const JEV_QUESTIONS = JEV_QUESTIONS_V6;
export const jevQuestions = (p: JevPrompt) => (p === 'v1' ? JEV_QUESTIONS_V1 : p === 'v4' ? JEV_QUESTIONS_V4 : p === 'v5' ? JEV_QUESTIONS_V5 : JEV_QUESTIONS_V6);
/** Cache key: v1 keys are the bare state text (old caches stay valid); v4/v5/v6 keys are namespaced by the prompt. */
export const jevCacheKey = (state: string, p: JevPrompt) => (p === 'v1' ? state : `[jev-prompt:${p}]\n${state}`);

export interface JevRaw {
  answers?: {
    toxic?: { type?: string; probability?: number };
    regime?: { type?: string; choice?: string; probabilities?: Record<string, number>; confidence?: number };
    /** v5 JIT head (absent under the v1/v4 prompts). */
    jit?: { type?: string; probability?: number };
    /** v6: the one malicious score and the one attack-type choice (absent under v1-v5). */
    malicious?: { type?: string; probability?: number };
    attack?: { type?: string; choice?: string; probabilities?: Record<string, number>; confidence?: number };
  };
  providerMetadata?: { typesafe?: { confidence?: Record<string, number> } };
}

const validProb = (p: unknown): p is number => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1;
const isAttackType = (c: unknown): c is AttackType => typeof c === 'string' && (ATTACK_TYPES as readonly string[]).includes(c);

/**
 * Parse a raw /v1/evaluate response into our typed score (null if unusable). Prompt-agnostic: a `malicious` answer
 * selects the v6 path (below); otherwise the v1-v5 path reads `toxic` (+ optional `regime`, `jit`). A
 * missing/malformed `jit` answer is never a failure: pJitBps = 0 ("no JIT signal"), so v1/v4 answers (and cached ones)
 * parse exactly as before.
 *
 * v6: pMaliciousBps from `malicious.probability`; the `attack` head (choice, all-7-key probabilities, confidence) is
 * mapped onto the two attested numbers by `mapV6`. A missing/unusable `attack` answer falls back to v5-style
 * behaviour (pToxicBps = p, pJitBps = 0, choice 'unknown'); a missing `malicious` answer is null (heuristic fallback).
 */
export function parseJev(raw: unknown, latencyMs: number): ModelScore | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as JevRaw;
  const pm = r.answers?.malicious?.probability;
  if (validProb(pm)) return parseJevV6(r, pm, latencyMs);
  const p = r.answers?.toxic?.probability;
  if (!validProb(p)) return null;
  const reg = r.answers?.regime;
  let cls: FlowClass = 'unknown';
  if (reg?.choice === 'informed' || reg?.choice === 'dump' || reg?.choice === 'unknown') cls = reg.choice;
  let conf: number | undefined = reg?.confidence ?? r.providerMetadata?.typesafe?.confidence?.regime;
  if (typeof conf !== 'number' || !Number.isFinite(conf)) {
    // fall back to how decisive the boolean head is
    conf = Math.abs(2 * p - 1);
  }
  const pj = r.answers?.jit?.probability;
  const pJitBps = validProb(pj) ? clampBps(pj * 10_000) : 0;
  return {
    pToxicBps: clampBps(p * 10_000),
    confidenceBps: clampBps(conf * 10_000),
    pJitBps,
    cls,
    latencyMs: Math.round(latencyMs),
    model: 'jev',
  };
}

function parseJevV6(r: JevRaw, p: number, latencyMs: number): ModelScore {
  const at = r.answers?.attack;
  const rawProbs = at?.probabilities && typeof at.probabilities === 'object' ? at.probabilities : undefined;
  const hasProbs = !!rawProbs && Object.values(rawProbs).some((v) => typeof v === 'number' && Number.isFinite(v));
  const choiceOk = isAttackType(at?.choice);
  const decisive = Math.abs(2 * p - 1);
  const pMaliciousBps = clampBps(p * 10_000);
  const base = { pMaliciousBps, latencyMs: Math.round(latencyMs), model: 'jev' as const };
  if (!choiceOk && !hasProbs) {
    // no usable attack answer: v5-style (the whole score goes to k, no JIT signal)
    const attack: AttackHead = { choice: 'unknown', probabilities: attackProbabilities(undefined), confidence: decisive };
    return { ...base, pToxicBps: pMaliciousBps, pJitBps: 0, confidenceBps: clampBps(decisive * 10_000), cls: 'unknown', attack, pPriceShare: 1, pJitShare: 0 };
  }
  // a valid choice without any probabilities reads as one-hot on the choice
  const probabilities = hasProbs ? attackProbabilities(rawProbs) : { ...attackProbabilities(undefined), [at!.choice as AttackType]: 1 };
  let choice: AttackType;
  if (choiceOk) choice = at!.choice as AttackType;
  else {
    // probabilities without a valid choice: take the argmax (ties -> first in ATTACK_TYPES order)
    choice = ATTACK_TYPES.reduce((best, k) => (probabilities[k] > probabilities[best] ? k : best), 'none' as AttackType);
  }
  let conf: number | undefined = at?.confidence ?? r.providerMetadata?.typesafe?.confidence?.attack;
  if (typeof conf !== 'number' || !Number.isFinite(conf)) conf = decisive;
  conf = Math.max(0, Math.min(1, conf));
  const m = mapV6(p, probabilities);
  const cls: FlowClass = PRICE_ATTACK_TYPES.includes(choice) ? 'informed' : 'unknown';
  return {
    ...base,
    pToxicBps: m.pToxicBps,
    pJitBps: m.pJitBps,
    confidenceBps: clampBps(conf * 10_000),
    cls,
    attack: { choice, probabilities, confidence: conf },
    pPriceShare: m.pPriceShare,
    pJitShare: m.pJitShare,
  };
}

/** Optional response cache keyed by exact state text (benchmark determinism / cost). */
export class JevCache {
  private m = new Map<string, ModelScore>();
  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      try {
        // Pre-v5 cache entries have no pJitBps: fill 0 so cached scores satisfy ModelScore (the v1/v4 prompts never
        // asked the JIT question, so 0 = "no JIT signal" is the truthful value).
        const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Omit<ModelScore, 'pJitBps'> & { pJitBps?: number }>;
        for (const [k, v] of Object.entries(raw)) this.m.set(k, { ...v, pJitBps: v.pJitBps ?? 0 });
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
  /** Question set (default: defaultJevPrompt(), i.e. v6 unless JEV_PROMPT=v5|v4|v1). Also namespaces the cache key. */
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
