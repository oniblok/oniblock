/** Typed model output (BUILD_SPEC). The model never outputs a fee — only a regime score. */
export type FlowClass = 'informed' | 'dump' | 'unknown';

/**
 * v6 attack-type head: the ONE choice the model makes per block about what kind of LP-costly flow is most likely.
 * The keeper never acts on the label directly; `mapV6` allocates the single malicious score across the two attested
 * knobs (price types -> pToxicBps -> k; jit_liquidity -> pJitBps -> JIT window; sandwich/none/unknown -> neither).
 */
export const ATTACK_TYPES = ['none', 'cex_dex_arbitrage', 'split_arbitrage', 'backrun', 'jit_liquidity', 'sandwich', 'unknown'] as const;
export type AttackType = (typeof ATTACK_TYPES)[number];
/** Attack types that are defended by the arbitrage knob (k). */
export const PRICE_ATTACK_TYPES: readonly AttackType[] = ['cex_dex_arbitrage', 'split_arbitrage', 'backrun'];

export interface AttackHead {
  choice: AttackType;
  /** All 7 keys present (missing/malformed answers read as 0), each in [0,1]. */
  probabilities: Record<AttackType, number>;
  /** The choice head's own confidence in [0,1] (fallback |2p-1| of the malicious score). */
  confidence: number;
}

export interface ModelScore {
  /** P(next block's arb-direction flow is informed/toxic) in bps (0..10000). */
  pToxicBps: number;
  /** Model confidence in bps (0..10000). */
  confidenceBps: number;
  /**
   * v5 JIT head: P(liquidity added in the next block is opportunistic just-in-time fee capture, removed again within
   * ~JIT_LABEL_BLOCKS) in bps (0..10000). The hook turns it into the JIT penalty window
   * (jitWindowMin + (jitWindowMax - jitWindowMin) * p * c / 1e8). 0 = "no JIT signal" (kev/tabular have no JIT head).
   */
  pJitBps: number;
  cls: FlowClass;
  latencyMs: number;
  /** 'rule' = the keeper's deterministic below-threshold rule (v3 gate; no model was called). */
  /** 'kev' = local fine-tuned Kev (MODEL_MODE=kev), 'tabular' = LightGBM trees (MODEL_MODE=tabular or oniblock1: the oniblock1 model); see ml/RESULTS.md. */
  model: 'jev' | 'heuristic' | 'rule' | 'kev' | 'tabular';
  /** true if the degraded (deliberately wrong) transform was applied — calibration-gate demo. */
  degraded?: boolean;
  /**
   * v6: the ONE malicious score (P(next block contains LP-costly flow), bps). Under the v6 prompt pToxicBps and
   * pJitBps are this score allocated by the attack head (`mapV6`); the heuristic reports max(pToxic, pJit).
   */
  pMaliciousBps?: number;
  /** v6: the attack-type head (absent for kev/tabular/rule and for v1-v5 Jev answers). */
  attack?: AttackHead;
  /**
   * v6: the allocation actually applied, pToxicBps = pMalicious * pPriceShare, pJitBps = pMalicious * pJitShare
   * (before the keeper's churn blend). Set only when the score went through `mapV6` (or its "attack missing"
   * fallback: 1 / 0); undefined for the heuristic, whose two heads are scored independently.
   */
  pPriceShare?: number;
  pJitShare?: number;
}

export const clampBps = (x: number) => Math.max(0, Math.min(10_000, Math.round(x)));

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** Normalise a (possibly partial / malformed) probabilities object to all 7 attack keys, each clamped to [0,1]. */
export function attackProbabilities(raw: unknown): Record<AttackType, number> {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = {} as Record<AttackType, number>;
  for (const k of ATTACK_TYPES) {
    const v = src[k];
    out[k] = typeof v === 'number' ? clamp01(v) : 0;
  }
  return out;
}

/**
 * v6 mapping (docs/JEV_NOTES.md "v6 questions and mapping"): one malicious score p in [0,1] is the magnitude, the
 * attack-type distribution allocates it across the two defenses.
 *   denom       = max(1 - P(none) - P(unknown), 0.05)          (mass that names an attack type)
 *   pPriceShare = min(1, (P(cex_dex_arbitrage) + P(split_arbitrage) + P(backrun)) / denom)
 *   pJitShare   = min(1, P(jit_liquidity) / denom)
 *   pToxicBps   = clamp(p * pPriceShare * 1e4),  pJitBps = clamp(p * pJitShare * 1e4)
 * sandwich mass allocates to neither knob (label only: not defended by this hook). Pure; never throws.
 */
export function mapV6(pMalicious: number, probs: Partial<Record<AttackType, number>> | Record<string, number> | undefined): { pToxicBps: number; pJitBps: number; pPriceShare: number; pJitShare: number } {
  const P = attackProbabilities(probs);
  const p = clamp01(pMalicious);
  const denom = Math.max(1 - P.none - P.unknown, 0.05);
  const pPrice = P.cex_dex_arbitrage + P.split_arbitrage + P.backrun;
  // shares rounded to 6 decimals: deterministic, free of float noise (1 - 0.2 - 0.1 = 0.7000000000000001), log-friendly
  const pPriceShare = round6(Math.min(1, pPrice / denom));
  const pJitShare = round6(Math.min(1, P.jit_liquidity / denom));
  return { pToxicBps: clampBps(p * pPriceShare * 10_000), pJitBps: clampBps(p * pJitShare * 10_000), pPriceShare, pJitShare };
}
