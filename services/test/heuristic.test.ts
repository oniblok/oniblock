import { describe, expect, it } from 'vitest';
import type { Features } from '../src/features.js';
import { scoreHeuristic } from '../src/model/heuristic.js';
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
