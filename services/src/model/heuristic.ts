/**
 * Deterministic baseline scorer. Intuition:
 *  - Arbitrage is profitable when the price gap exceeds the fee; the larger the edge,
 *    the more likely the next arb-direction flow is informed (toxic to LPs).
 *  - Persistent one-sided flow with an open gap and high CEX volatility raise toxicity.
 *  - One-sided flow WITHOUT a gap looks like an uninformed "dump".
 * Confidence grows with |edge| and with the amount of observed flow, and shrinks with a
 * stale oracle.
 *  - v5 JIT head: recent churn. If positions added lately were pulled again within JIT_LABEL_BLOCKS, the next add is
 *    likely fee capture too: pJit = 1000 + 8000 * churn (bps), 1000 without liquidity features.
 *  - v6 attack head (label only; the two heads above stay independent, they are NOT mapped through mapV6):
 *    jit_liquidity if churn >= 0.5 and the edge is <= 0, cex_dex_arbitrage if the edge is > 0, else none; the
 *    probabilities are 0.7 on the choice and the remaining 0.3 spread over the other six; pMalicious = max(pToxic, pJit).
 */
import type { Features } from '../features.js';
import { ATTACK_TYPES, clampBps, type AttackHead, type AttackType, type ModelScore } from './types.js';

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** JIT head of the heuristic: clamp(1000 + 8000 * liqChurn200); no liquidity features => 1000 (10%). */
export function heuristicPJitBps(f: Pick<Features, 'liqChurn200'>): number {
  const churn = Math.max(0, Math.min(1, f.liqChurn200 ?? 0));
  return clampBps(1000 + 8000 * churn);
}

/** Cost of arbitrage on this pool: the hook's arb-direction fee when known (base + k*gap), else the base fee. */
const arbCost = (f: Pick<Features, 'arbFeePips' | 'baseFee'>) => Math.max(1, f.arbFeePips ?? f.baseFee);
/** Relative edge: (gap - cost) / cost; > 0 => arbitrage profitable after fees. */
export const heuristicEdge = (f: Pick<Features, 'gapPips' | 'arbFeePips' | 'baseFee'>) => (f.gapPips - arbCost(f)) / arbCost(f);

/**
 * v6 attack head of the heuristic. `confidence` is the caller's overall confidence in [0,1].
 * Probabilities: 0.7 on the choice, 0.05 on each of the other six (sums to 1).
 */
export function heuristicAttack(f: Pick<Features, 'gapPips' | 'arbFeePips' | 'baseFee' | 'liqChurn200'>, confidence: number): AttackHead {
  const edge = heuristicEdge(f);
  const churn = Math.max(0, Math.min(1, f.liqChurn200 ?? 0));
  const choice: AttackType = churn >= 0.5 && edge <= 0 ? 'jit_liquidity' : edge > 0 ? 'cex_dex_arbitrage' : 'none';
  const rest = 0.3 / (ATTACK_TYPES.length - 1);
  const probabilities = {} as Record<AttackType, number>;
  for (const k of ATTACK_TYPES) probabilities[k] = k === choice ? 0.7 : rest;
  return { choice, probabilities, confidence: Math.max(0, Math.min(1, confidence)) };
}

export function scoreHeuristic(f: Features): ModelScore {
  const t0 = performance.now();
  const base = Math.max(1, f.baseFee);
  const edge = heuristicEdge(f); // >0 => arb profitable after fees
  const z =
    -1.0 +
    2.2 * Math.max(-1.5, Math.min(3, edge)) +
    0.9 * Math.abs(f.imbalance) * (f.gapPips > base / 2 ? 1 : -0.5) +
    0.8 * Math.min(1, f.realizedVolBps / 5) +
    0.6 * f.arbShare +
    3.0 * Math.min(0.2, f.sizeToDepth);
  const p = sigmoid(z);

  const evidence = Math.min(1, f.nSwaps / 10);
  const certainty = Math.abs(p - 0.5) * 2; // 0 at p=.5, 1 at extremes
  let conf = 0.35 + 0.4 * certainty + 0.25 * evidence;
  if (f.attestationAge > 5) conf *= 0.6;

  let cls: ModelScore['cls'] = 'unknown';
  if (p >= 0.6) cls = 'informed';
  else if (Math.abs(f.imbalance) > 0.6 && f.gapPips < base / 2) cls = 'dump';

  const pToxicBps = clampBps(p * 10_000);
  const pJitBps = heuristicPJitBps(f);
  return {
    pToxicBps,
    confidenceBps: clampBps(conf * 10_000),
    pJitBps,
    cls,
    latencyMs: Math.round((performance.now() - t0) * 1000) / 1000,
    model: 'heuristic',
    pMaliciousBps: Math.max(pToxicBps, pJitBps),
    attack: heuristicAttack(f, conf),
  };
}
