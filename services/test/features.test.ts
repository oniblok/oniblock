import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeFeatures, featuresToState, liquidityFeatures, liquidityStateLines, positionKey, removedWithin, JIT_LABEL_BLOCKS_DEFAULT, type JitPenaltyObs, type LiquidityObs, type SwapObs } from '../src/features.js';
import { Q96 } from '../src/price.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

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

describe('v5 liquidity features + state text (docs/review/V5_JIT_HEAD_SPEC.md §3.2)', () => {
  const ROUTER = '0x0DCd1Bf9A1b36cE34237eEaFef220932846BCD82' as const;
  const S = (n: number) => ('0x' + n.toString(16).padStart(64, '0')) as `0x${string}`;
  const lo = (block: number, liquidityDelta: bigint, salt: `0x${string}`, ticks: [number, number] = [-120, 60], logIndex?: number): LiquidityObs => ({
    block, sender: ROUTER, tickLower: ticks[0], tickUpper: ticks[1], liquidityDelta, salt, ...(logIndex !== undefined ? { logIndex } : {}),
  });
  const pen = (block: number, addedBlock: number, window: number): JitPenaltyObs => ({ block, sender: ROUTER, positionKey: S(9), addedBlock, window, penalty0: 1n, penalty1: 2n });
  const oracle = 1000n * Q96;
  const E18 = 10n ** 18n;
  // Same relative geometry as the pre-v5 hash fixture (swaps in the last 5 blocks, attestation 3 blocks old) at head 500.
  const swaps = [sw(495, false, 3n * E18, true), sw(496, false, 1n * E18), sw(497, true, 2n * E18)];
  const base = { swaps, oracleX96: oracle, poolX96: (oracle * 1005n) / 1000n, depth0: 1000n * E18, recentMids: [100, 101, 100, 101, 100], currentBlock: 500, lastAttestBlock: 497, baseFee: 3000, kBps: 5000, feeMax: 10000, arbThresholdPips: 3300 };
  // 500-block chain: an old position (outside the 200-block window), one long-lived add, two pulled adds, penalties.
  const liquidity = [
    lo(100, 1n, S(0)), lo(150, -1n, S(0)), // old: outside "last 200 blocks" at head 500
    lo(430, 100n, S(1)), lo(445, -100n, S(1)), // removed at +15 (JIT)
    lo(485, 100n, S(2), [-60, 180]), // stays
    lo(495, 100n, S(3), [600, 720]), lo(498, -100n, S(3), [600, 720]), // removed at +3 (JIT); newest add, away from tick 100
  ];
  const jitPenalties = [pen(250, 240, 10), pen(498, 495, 20)];
  const liqInput = { liquidity, jitPenalties, currentBlock: 500, currentTick: 100, jitWindowNow: 20, jitLabelBlocks: 100 };

  it('positionKey = keccak256(abi.encodePacked(owner, int24 tickLower, int24 tickUpper, bytes32 salt)) (cast vectors, negative ticks packed two\'s complement)', () => {
    expect(positionKey(ROUTER, -120, 60, S(7))).toBe('0x1f4c195404e53187632175993cace5442904ccc5219e9ad630e928e2a1035ea3');
    expect(positionKey(ROUTER, -887220, 887220, S(0))).toBe('0x2432630efb320b498fd7da2ad3878d618c54580c49ebe10a5a1d7a416b81f634');
    expect(positionKey(ROUTER, 60, 120, S(0))).toBe('0x6ea6d576a65b164d0910138ad1b8786c8e0441ee9675dfd65af821cf2d20a48a');
  });

  it('computes adds20, churn200, newest span / bracketing, median lifetime, penalties200, window', () => {
    const f = liquidityFeatures(liqInput);
    expect(f).toEqual({
      liqAdds20: 2, // 485, 495
      liqChurn200: 0.667, // of 430, 485, 495: two removed within 100 blocks
      liqNewestSpanTicks: 120,
      liqNewestBrackets: false,
      liqMedianLifetime: 9, // lifetimes 15 and 3
      jitPenalties200: 1, // the one at 498; 250 is out of range
      jitWindowNow: 20,
      jitLabelBlocks: 100,
    });
    expect(liquidityFeatures({ ...liqInput, currentTick: 650 }).liqNewestBrackets).toBe(true);
    expect(liquidityFeatures({ ...liqInput, currentTick: undefined }).liqNewestBrackets).toBeUndefined();
    // churn uses the label window: with a 10-block window only the +3 removal counts
    expect(liquidityFeatures({ ...liqInput, jitLabelBlocks: 10 }).liqChurn200).toBe(0.333);
    expect(liquidityFeatures({ liquidity: [], currentBlock: 500 })).toEqual({ liqAdds20: 0, liqChurn200: 0, jitPenalties200: 0, jitLabelBlocks: JIT_LABEL_BLOCKS_DEFAULT });
    // computeFeatures carries them only when liquidity observations are given
    expect(computeFeatures({ ...base, ...liqInput }).liqChurn200).toBe(0.667);
    expect(computeFeatures(base).liqChurn200).toBeUndefined();
    // removedWithin honours the same-block log order
    const add = lo(10, 1n, S(5), [-120, 60], 4);
    expect(removedWithin(add, [lo(10, -1n, S(5), [-120, 60], 6)], 100)).toBe(true);
    expect(removedWithin(add, [lo(10, -1n, S(5), [-120, 60], 2)], 100)).toBe(false);
    expect(removedWithin(add, [lo(111, -1n, S(5))], 100)).toBe(false);
  });

  it('v5 state = the v4 lines + exactly the three liquidity lines (snapshot)', () => {
    const f = computeFeatures({ ...base, ...liqInput });
    const v4 = featuresToState(f, { format: 'v4' });
    const v5 = featuresToState(f, { format: 'v5' });
    const lines = [
      'liquidity_recent: 2 positions added in the last 20 blocks; 67% of positions added in the last 200 blocks were removed again within 100 blocks.',
      'liquidity_shape: newest position spans 120 ticks away from the current price; median lifetime of recently removed positions 9 blocks.',
      'jit_enforcement: 1 JIT penalties in the last 200 blocks; current penalty window 20 blocks.',
    ];
    expect(v5).toBe(v4 + '\n' + lines.join('\n'));
    expect(v5.split('\n')).toHaveLength(12);
    expect(liquidityStateLines(f)).toEqual(lines);
    expect(liquidityStateLines(computeFeatures({ ...base, ...liqInput, currentTick: 650 }))[1]).toContain('spans 120 ticks around the current price');
    // no liquidity data at all: still three deterministic lines
    expect(liquidityStateLines({})).toEqual([
      'liquidity_recent: 0 positions added in the last 20 blocks; 0% of positions added in the last 200 blocks were removed again within 100 blocks.',
      'liquidity_shape: no position added in the last 200 blocks; median lifetime of recently removed positions n/a.',
      'jit_enforcement: 0 JIT penalties in the last 200 blocks; current penalty window unknown.',
    ]);
  });

  it('v4 and auto texts are byte-identical to the pre-v5 build (pinned hashes) and blind to the liquidity features', () => {
    const f = computeFeatures(base);
    expect(sha256(featuresToState(f, { format: 'v4' }))).toBe('e20b27837f4618f1fde4e51bdd311d9e8eebd209de44f9548781aa5cdf7485ec');
    expect(sha256(featuresToState(f))).toBe('5eaa09fd954ba304811f6d410b876c44e35443249e58f4b58da0a76d6f7fc2d1');
    expect(sha256(featuresToState(f, { baseIsToken0: false }))).toBe('de39af1374181e4323da09186596b323d5674158b662fba6651cd8aca0074269');
    const g = computeFeatures({ ...base, ...liqInput });
    expect(featuresToState(g, { format: 'v4' })).toBe(featuresToState(f, { format: 'v4' }));
    expect(featuresToState(g)).toBe(featuresToState(f));
    expect(featuresToState(g, { format: 'v5' })).not.toBe(featuresToState(f, { format: 'v5' })); // only the appended lines differ
  });
});
