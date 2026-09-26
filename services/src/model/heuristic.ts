/**
 * Deterministic baseline scorer. Intuition:
 *  - Arbitrage is profitable when the price gap exceeds the fee; the larger the edge,
 *    the more likely the next arb-direction flow is informed (toxic to LPs).
 *  - Persistent one-sided flow with an open gap and high CEX volatility raise toxicity.
 *  - One-sided flow WITHOUT a gap looks like an uninformed "dump".
 * Confidence grows with |edge| and with the amount of observed flow, and shrinks with a
 * stale oracle.
 */
import type { Features } from '../features.js';
import { clampBps, type ModelScore } from './types.js';

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export function scoreHeuristic(f: Features): ModelScore {
  const t0 = performance.now();
  const base = Math.max(1, f.baseFee);
  // Cost of arbitrage: the hook's arb-direction fee when known (base + k*gap), else the base fee.
  const cost = Math.max(1, f.arbFeePips ?? f.baseFee);
  const edge = (f.gapPips - cost) / cost; // >0 => arb profitable after fees
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

  return {
    pToxicBps: clampBps(p * 10_000),
    confidenceBps: clampBps(conf * 10_000),
    cls,
    latencyMs: Math.round((performance.now() - t0) * 1000) / 1000,
    model: 'heuristic',
  };
}
