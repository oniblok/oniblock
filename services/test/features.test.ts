import { describe, expect, it } from 'vitest';
import { computeFeatures, featuresToState, type SwapObs } from '../src/features.js';
import { Q96 } from '../src/price.js';

const E18 = 10n ** 18n;
const sw = (block: number, zeroForOne: boolean, eth: bigint, arbDir = false): SwapObs => ({
  block, zeroForOne, amount0: zeroForOne ? -eth : eth, amount1: 0n, fee: 3000, arbDir,
});

describe('features', () => {
  const oracle = 1000n * Q96;
  it('computes gap, imbalance, size/depth, vol, age', () => {
    const f = computeFeatures({
      swaps: [sw(95, false, 3n * E18, true), sw(96, false, 1n * E18), sw(97, true, 2n * E18), sw(10, true, 100n * E18)],
      oracleX96: oracle,
      poolX96: (oracle * 1005n) / 1000n,
      depth0: 1000n * E18,
      recentMids: [100, 101, 100, 101, 100],
      currentBlock: 100,
      lastAttestBlock: 97,
      baseFee: 3000,
    });
    expect(f.gapPips).toBe(5000);
    expect(f.gapSign).toBe(1);
    expect(f.nSwaps).toBe(3); // block 10 is outside the 20-block window
    expect(f.imbalance).toBeCloseTo((3 + 1 - 2) / 6, 4);
    expect(f.sizeToDepth).toBeCloseTo(2 / 1000, 6);
    expect(f.arbShare).toBeCloseTo(1 / 3, 3);
    expect(f.realizedVolBps).toBeGreaterThan(90);
    expect(f.attestationAge).toBe(3);
  });

  it('handles empty inputs', () => {
    const f = computeFeatures({ swaps: [], oracleX96: oracle, poolX96: oracle, depth0: 0n, recentMids: [], currentBlock: 1, lastAttestBlock: 1 });
    expect(f).toMatchObject({ gapPips: 0, gapSign: 0, imbalance: 0, sizeToDepth: 0, realizedVolBps: 0, attestationAge: 0, nSwaps: 0 });
  });

  it('serialises deterministically', () => {
    const f = computeFeatures({ swaps: [sw(1, true, E18)], oracleX96: oracle, poolX96: oracle - Q96, depth0: 100n * E18, recentMids: [1, 1.01, 1], currentBlock: 1, lastAttestBlock: 0 });
    const s1 = featuresToState(f);
    expect(s1).toBe(featuresToState({ ...f }));
    expect(s1).toContain('below the Binance mid');
    expect(s1).toContain('flow_imbalance: -1.000');
    expect(s1.length).toBeLessThan(1200);
  });

  it('carries the hook arb-direction fee when k is known (and keeps the base-fee wording otherwise)', () => {
    const inp = { swaps: [], oracleX96: oracle, poolX96: oracle + oracle / 100n, depth0: 0n, recentMids: [], currentBlock: 1, lastAttestBlock: 1, baseFee: 3000 };
    const plain = computeFeatures(inp);
    expect(plain.arbFeePips).toBeUndefined();
    expect(featuresToState(plain)).toContain('arb_edge: gap minus base fee');
    const f = computeFeatures({ ...inp, kBps: 5000, feeMax: 10000 });
    expect(f.gapPips).toBe(10000);
    expect(f.arbFeePips).toBe(8000); // 3000 + 10000 * 0.5
    expect(featuresToState(f)).toContain('swaps toward the Binance mid pay 0.800% (base + k x gap, k = 0.50)');
    expect(computeFeatures({ ...inp, kBps: 8000, feeMax: 10000 }).arbFeePips).toBe(10000); // capped
  });

  it('v4 state is k-free and states the edge at the base fee', () => {
    const inp = { swaps: [], oracleX96: oracle, poolX96: oracle + oracle / 1000n, depth0: 0n, recentMids: [], currentBlock: 1, lastAttestBlock: 1, baseFee: 3000 };
    const a = featuresToState(computeFeatures({ ...inp, kBps: 0, feeMax: 10000 }), { format: 'v4' });
    const b = featuresToState(computeFeatures({ ...inp, kBps: 8000, feeMax: 10000 }), { format: 'v4' });
    expect(a).toBe(b); // the model's own k never feeds back into its input
    expect(a).toContain('arb_edge_at_base_fee: gap minus base fee = -0.200%');
    expect(a).toContain('NO profitable arbitrage');
    const hi = featuresToState(computeFeatures({ ...inp, poolX96: oracle + oracle / 200n }), { format: 'v4' });
    expect(hi).toContain('arbitrage IS profitable at the base fee');
  });
});
