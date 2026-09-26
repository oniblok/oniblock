import { describe, expect, it } from 'vitest';
import type { Features } from '../src/features.js';
import { heuristicAttack, heuristicPJitBps, scoreHeuristic } from '../src/model/heuristic.js';
import { ATTACK_TYPES } from '../src/model/types.js';
import { degrade, score } from '../src/model/index.js';

const base: Features = { gapPips: 0, gapSign: 0, imbalance: 0, sizeToDepth: 0, realizedVolBps: 0, attestationAge: 1, nSwaps: 5, arbShare: 0, baseFee: 3000 };

describe('heuristic model', () => {
  it('is deterministic and in range', () => {
    const a = scoreHeuristic({ ...base, gapPips: 6000 });
    const b = scoreHeuristic({ ...base, gapPips: 6000 });
    expect(a.pToxicBps).toBe(b.pToxicBps);
    for (const s of [a, scoreHeuristic({ ...base, gapPips: 999999, imbalance: 1, realizedVolBps: 1e6, sizeToDepth: 10 })]) {
      expect(s.pToxicBps).toBeGreaterThanOrEqual(0);
      expect(s.pToxicBps).toBeLessThanOrEqual(10000);
      expect(s.confidenceBps).toBeGreaterThanOrEqual(0);
      expect(s.confidenceBps).toBeLessThanOrEqual(10000);
      expect(s.model).toBe('heuristic');
    }
  });

  it('monotone in gap: large gap => informed, no gap => low', () => {
    const lo = scoreHeuristic(base);
    const hi = scoreHeuristic({ ...base, gapPips: 9000, arbShare: 0.8, realizedVolBps: 4 });
    expect(hi.pToxicBps).toBeGreaterThan(lo.pToxicBps);
    expect(hi.cls).toBe('informed');
    expect(lo.pToxicBps).toBeLessThan(3000);
  });

  it('one-sided flow without gap => dump', () => {
    expect(scoreHeuristic({ ...base, imbalance: -0.9 }).cls).toBe('dump');
  });

  it('stale oracle lowers confidence', () => {
    expect(scoreHeuristic({ ...base, attestationAge: 50 }).confidenceBps).toBeLessThan(scoreHeuristic(base).confidenceBps);
  });

  it('degraded mode flips p and is overconfident', async () => {
    const s = scoreHeuristic({ ...base, gapPips: 9000 });
    const d = degrade(s);
    expect(d.pToxicBps).toBe(10000 - s.pToxicBps);
    expect(d.confidenceBps).toBe(9500);
    expect(d.degraded).toBe(true);
    const viaScore = await score({ ...base, gapPips: 9000 }, { mode: 'heuristic', degraded: true });
    expect(viaScore.pToxicBps).toBe(d.pToxicBps);
  });
});

describe('v5 JIT head of the heuristic', () => {
  it('10% without liquidity features, 1000 + 8000 * churn otherwise, clamped; degrade() leaves it alone', async () => {
    expect(scoreHeuristic(base).pJitBps).toBe(1000);
    expect(heuristicPJitBps({})).toBe(1000);
    expect(heuristicPJitBps({ liqChurn200: 0.5 })).toBe(5000);
    expect(heuristicPJitBps({ liqChurn200: 1 })).toBe(9000);
    expect(heuristicPJitBps({ liqChurn200: 7 })).toBe(9000);
    expect(heuristicPJitBps({ liqChurn200: -1 })).toBe(1000);
    const s = scoreHeuristic({ ...base, liqChurn200: 0.25 });
    expect(s.pJitBps).toBe(3000);
    expect(degrade(s).pJitBps).toBe(3000);
    expect((await score({ ...base, liqChurn200: 0.25 }, { mode: 'heuristic' })).pJitBps).toBe(3000);
  });
});

describe('v6 attack head of the heuristic', () => {
  const sum = (p: Record<string, number>) => Object.values(p).reduce((a, b) => a + b, 0);
  it('jit_liquidity when churn >= 0.5 and the edge is <= 0; cex_dex_arbitrage when the edge is > 0; else none', () => {
    expect(scoreHeuristic({ ...base, liqChurn200: 0.5 }).attack!.choice).toBe('jit_liquidity');
    expect(scoreHeuristic({ ...base, liqChurn200: 0.49 }).attack!.choice).toBe('none');
    expect(scoreHeuristic({ ...base, gapPips: 9000, liqChurn200: 0.9 }).attack!.choice).toBe('cex_dex_arbitrage'); // edge > 0 wins
    expect(scoreHeuristic({ ...base, gapPips: 9000 }).attack!.choice).toBe('cex_dex_arbitrage');
    expect(scoreHeuristic({ ...base, gapPips: 3000 }).attack!.choice).toBe('none'); // edge exactly 0
    expect(scoreHeuristic(base).attack!.choice).toBe('none');
    // the hook's arb fee (when known) is the cost, as for pToxic
    expect(scoreHeuristic({ ...base, gapPips: 3500, arbFeePips: 4000 }).attack!.choice).toBe('none');
  });
  it('probabilities: 0.7 on the choice, 0.05 on each other type, all 7 keys, sum 1; confidence = the score confidence', () => {
    const s = scoreHeuristic({ ...base, gapPips: 9000 });
    expect(Object.keys(s.attack!.probabilities)).toEqual([...ATTACK_TYPES]);
    expect(s.attack!.probabilities.cex_dex_arbitrage).toBe(0.7);
    expect(s.attack!.probabilities.jit_liquidity).toBeCloseTo(0.05, 9);
    expect(sum(s.attack!.probabilities)).toBeCloseTo(1, 9);
    expect(s.attack!.confidence).toBeCloseTo(s.confidenceBps / 10_000, 3);
    expect(heuristicAttack({ gapPips: 0, baseFee: 3000, liqChurn200: 1 }, 5).confidence).toBe(1);
  });
  it('pMaliciousBps = max(pToxic, pJit); the two heads stay independent (not mapped) and degrade() flips pMalicious with pToxic (attack untouched)', () => {
    const s = scoreHeuristic({ ...base, gapPips: 9000, liqChurn200: 0.25 });
    expect(s.pMaliciousBps).toBe(Math.max(s.pToxicBps, s.pJitBps));
    expect(s.pJitBps).toBe(3000);
    expect(s.pPriceShare).toBeUndefined();
    const d = degrade(s);
    expect(d.pMaliciousBps).toBe(10_000 - s.pMaliciousBps!);
    expect(d.attack).toEqual(s.attack);
    const lo = scoreHeuristic({ ...base, liqChurn200: 1 });
    expect(lo.pMaliciousBps).toBe(9000); // pJit dominates
  });
});
