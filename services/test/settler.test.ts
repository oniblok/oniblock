import { describe, expect, it } from 'vitest';
import { namehash, type Hex } from 'viem';
import { attestationIndex, brierStats, calibrate, gateBps, labelBlocks, labelJitBlocks, ruleModelNode, usdPerRawToken1, type JitLabelStats } from '../src/settler.js';
import { jitCalibrationKey, type AttestationLog, type ReceiptLog } from '../src/chain.js';
import { Q96 } from '../src/price.js';
import type { LiquidityObs } from '../src/features.js';

const NODE = ('0x' + '11'.repeat(32)) as Hex;
const NODE2 = ('0x' + '22'.repeat(32)) as Hex;
// Equal-decimals toy pair: price 1 token1 per token0.
const r = (block: number, a0: bigint, a1: bigint, fee = 3000, extra: Partial<ReceiptLog> = {}): ReceiptLog => ({
  poolId: '0x00', blockNumber: block, sender: '0x0000000000000000000000000000000000000001', zeroForOne: a0 < 0n, arbDir: true,
  gapPips: 0, kBps: 0, feePips: fee, amount0: a0, amount1: a1, modelNode: NODE, stale: false, txHash: '0x00', logIndex: 0, ...extra,
});

describe('settler labelling + calibration', () => {
  it('labels informed when net markout at next mid > 0', () => {
    // Swapper sells 100 token0, receives 101 token1; next mid = 1 => net +1 => informed
    // Swapper sells 100 token0, receives 99 token1; next mid = 1 => net -1 => not informed
    const labels = labelBlocks([r(1, -100n, 101n), r(2, -100n, 99n)], () => Q96, () => 0.8);
    expect(labels.map((l) => l.y)).toEqual([1, 0]);
    expect(labels[0]!.feePaid).toBeCloseTo(0.3, 6);
  });
  it('skips non-arb, stale, and blocks without next mid / p', () => {
    const labels = labelBlocks(
      [r(1, -100n, 101n, 3000, { arbDir: false }), r(2, -100n, 101n, 3000, { stale: true }), r(3, -100n, 101n), r(4, -100n, 101n)],
      (b) => (b === 3 ? undefined : Q96),
      () => 0.5,
    );
    expect(labels.map((l) => l.block)).toEqual([4]);
  });
  it('aggregates multiple swaps in a block', () => {
    const labels = labelBlocks([r(5, -100n, 99n), r(5, -100n, 102n)], () => Q96, () => 0.5);
    expect(labels).toHaveLength(1);
    expect(labels[0]!.markoutNet).toBeCloseTo(1, 9);
    expect(labels[0]!.nSwaps).toBe(2);
  });
  it('Brier + hit rate per model, windowed', () => {
    const L = (block: number, p: number, y: 0 | 1, modelNode = NODE) => ({ block, modelNode, p, y, markoutNet: 0, feePaid: 0, nSwaps: 1 });
    const cal = calibrate([L(1, 0.9, 1), L(2, 0.2, 0), L(3, 0.8, 0), L(4, 0.1, 1, NODE2)], 0, 'raw');
    const a = cal.find((c) => c.modelNode === NODE)!;
    expect(a.n).toBe(3);
    expect(a.brierBps).toBe(Math.round(((0.01 + 0.04 + 0.64) / 3) * 10000));
    expect(a.hitRateBps).toBe(6667);
    const b = cal.find((c) => c.modelNode === NODE2)!;
    expect(b.brierBps).toBe(8100);
    expect(b.hitRateBps).toBe(0);
    expect(calibrate([L(1, 0.9, 1), L(2, 0.9, 0)], 1, 'raw')[0]!.brierBps).toBe(8100);
    expect(a.rawBrierBps).toBe(a.brierBps);
  });
  it('skill gate: 2500 == base-rate predictor, lower is better, demotes a worse-than-climatology model', () => {
    const L = (block: number, p: number, y: 0 | 1) => ({ block, modelNode: NODE, p, y, markoutNet: 0, feePaid: 0, nSwaps: 1 });
    const ys: (0 | 1)[] = [1, 0, 0, 1, 0, 0, 1, 0];
    // Climatology itself (smoothed base rate) scores exactly 2500.
    const q = (3 + 1) / (8 + 2);
    const clim = calibrate(ys.map((y, i) => L(i, q, y)), 0, 'skill')[0]!;
    expect(clim.brierBps).toBe(2500);
    expect(clim.skillBps).toBe(0);
    expect(clim.baseRateBps).toBe(3750);
    // An informative model beats it; its inversion (the demo's "degraded" model) is far worse.
    const good = calibrate(ys.map((y, i) => L(i, y ? 0.8 : 0.2, y)), 0, 'skill')[0]!;
    const bad = calibrate(ys.map((y, i) => L(i, y ? 0.2 : 0.8, y)), 0, 'skill')[0]!;
    expect(good.brierBps).toBeLessThan(2500);
    expect(good.skillBps).toBeGreaterThan(0);
    expect(bad.brierBps).toBeGreaterThan(2500);
    expect(bad.skillBps).toBeLessThan(0);
    expect(good.rawBrierBps).toBe(400);
    // Single-class window: smoothing keeps the reference finite.
    const st = brierStats([0.1, 0.1, 0.1], [0, 0, 0]);
    expect(st.ref).toBeCloseTo(0.04, 9);
    expect(gateBps(st.brier, st.ref, 'skill')).toBe(625);
    expect(gateBps(1, 0.01, 'skill')).toBe(10000);
  });
  it('attestation index: receipt attestation by model + k + log order, and next mid', () => {
    const at = (mined: number, p: number, mid: bigint, node = NODE, kBps = 0, logIndex = 0): AttestationLog => ({
      poolId: '0x00', blockNumber: mined, minedBlock: mined, oracleMidX96: mid, pToxicBps: p, confidenceBps: 0, kBps, modelNode: node, quoter: '0x0000000000000000000000000000000000000001', txHash: `0x${mined.toString(16)}${logIndex}` as Hex, logIndex, pJitBps: 0, jitWindow: 10,
    });
    const rc = (block: number, logIndex: number, node = NODE, kBps = 0) => ({ blockNumber: block, logIndex, modelNode: node, kBps });
    const idx = attestationIndex([at(10, 7000, 1n), at(12, 2000, 3n), at(11, 5000, 2n, NODE2)]);
    expect(idx.forReceipt(rc(9, 5))).toBeUndefined();
    expect(idx.forReceipt(rc(11, 5))!.pToxicBps).toBe(7000);
    expect(idx.forReceipt(rc(12, 5))!.pToxicBps).toBe(2000);
    expect(idx.forReceipt(rc(11, 5, NODE2))!.oracleMidX96).toBe(2n);
    expect(idx.midAfter(10)).toBe(2n);
    expect(idx.midAfter(12)).toBeUndefined();
    expect(idx.inForce(9)).toBeUndefined();
    expect(idx.inForce(11)!.oracleMidX96).toBe(2n);
    expect(idx.inForce(20)!.oracleMidX96).toBe(3n);
  });

  it('audit #3: a lower-k same-block attestation does not take over the anchor; one logged after the swap is not in force', () => {
    const at = (mined: number, logIndex: number, p: number, kBps: number, mid: bigint, node = NODE): AttestationLog => ({
      poolId: '0x00', blockNumber: mined, minedBlock: mined, oracleMidX96: mid, pToxicBps: p, confidenceBps: 0, kBps, modelNode: node, quoter: '0x0000000000000000000000000000000000000001', txHash: `0x${mined.toString(16)}${logIndex}` as Hex, logIndex, pJitBps: 0, jitWindow: 10,
    });
    // A (block 10, k 6000) is anchored in block 12 by a swap at log 1; B (block 12, log 3, k 4000) lands mid-block:
    // lower k => the anchor keeps A (receipts at log 5 still say k 6000). C (block 12, log 8, k 6500) takes over.
    const A = at(10, 0, 8000, 6000, 1n);
    const B = at(12, 3, 1000, 4000, 2n);
    const C = at(12, 8, 9000, 6500, 3n);
    const idx = attestationIndex([C, B, A]);
    const rc = (logIndex: number, kBps: number) => ({ blockNumber: 12, logIndex, modelNode: NODE, kBps });
    expect(idx.forReceipt(rc(1, 6000))).toBe(A); // before B
    expect(idx.forReceipt(rc(5, 6000))).toBe(A); // after lower-k B: still A (old code graded against B's p = 0.1)
    expect(idx.forReceipt(rc(9, 6500))).toBe(C); // after higher-k C: C
    // arb landing BEFORE a k-raising attestation in the same block is graded against the previous one
    const D = at(13, 4, 9500, 7000, 4n);
    expect(attestationIndex([A, D]).forReceipt({ blockNumber: 13, logIndex: 2, modelNode: NODE, kBps: 6000 })).toBe(A);
    // next block: the stored state is the last accepted attestation (C), even though B was lower
    expect(idx.forReceipt({ blockNumber: 13, logIndex: 0, modelNode: NODE, kBps: 6500 })).toBe(C);
    // no attestation with that k (e.g. k clamped by a config update) => not graded
    expect(idx.forReceipt({ blockNumber: 13, logIndex: 0, modelNode: NODE, kBps: 1234 })).toBeUndefined();
  });

  it('audit #3: labelBlocks splits a block per attestation via groupKey', () => {
    const rs = [r(12, -100n, 101n, 3000, { logIndex: 1, kBps: 6000 }), r(12, -100n, 99n, 3000, { logIndex: 9, kBps: 6500 })];
    const p = (x: ReceiptLog) => (x.kBps === 6000 ? 0.8 : 0.9);
    const merged = labelBlocks(rs, () => Q96, p);
    expect(merged).toHaveLength(1);
    const split = labelBlocks(rs, () => Q96, p, { groupKey: (x) => `${x.blockNumber}:${x.kBps}` });
    expect(split.map((l) => [l.p, l.y])).toEqual([[0.8, 1], [0.9, 0]]);
    // the mid callback sees the group's receipt (attested-mid mode uses the receipt's own attestation mid)
    const seen: number[] = [];
    labelBlocks(rs, (_b, x) => (seen.push(x.kBps), Q96), p, { groupKey: (x) => `${x.blockNumber}:${x.kBps}` });
    expect(seen.sort()).toEqual([6000, 6500]);
  });
});

describe('v3: settler skips the rule-v1 node', () => {
  it('labelBlocks drops receipts of skipModelNodes', () => {
    const labels = labelBlocks([r(1, -100n, 101n), r(2, -100n, 101n, 3000, { modelNode: NODE2 })], () => Q96, () => 0.5, { skipModelNodes: [NODE2] });
    expect(labels.map((l) => l.block)).toEqual([1]);
  });
  it('v4 base-fee label: an arb that paid a high AI fee (net < 0) was still profitable at the base fee => informed', () => {
    // sells 1000 token0 for 998 token1 paying 0.80% (k raised by the model): net -2, gross 6 > base cost 3
    const rs = [r(1, -100n * 10n, 998n, 8000), r(2, -1000n, 996n, 3000)];
    expect(labelBlocks(rs, () => Q96, () => 0.9).map((l) => l.y)).toEqual([0, 0]); // pre-v4: net markout > 0
    // block 2: net -4, gross -1 < base cost 3 => benign under both labels
    expect(labelBlocks(rs, () => Q96, () => 0.9, { labelFee: 'base', baseFeePips: 3000 }).map((l) => l.y)).toEqual([1, 0]);
  });
  it('dead band: |markout| <= max($1, 1 bp of volume) is not graded and counted as ambiguous', () => {
    // toy pair: token1 = quote with 6 decimals (usd per raw token1 = 1e-6); amounts scaled so 1 raw = 1e-6 USD
    const usd = 1e6;
    const rs = [
      r(1, BigInt(-1000 * usd), BigInt(1000 * usd) + BigInt(0.5 * usd), 3000), // net +$0.5, gross $3.5 vs base cost $3: m = +$0.5 <= T = $1 => ambiguous
      r(2, BigInt(-1000 * usd), BigInt(1005 * usd), 3000), // m = gross 8 - base 3 = +$5 > T => informed
      r(3, BigInt(-1000 * usd), BigInt(990 * usd), 3000), // m = gross -7 - 3 = -$10 < -T => benign
      r(4, BigInt(-100000 * usd), BigInt(100000 * usd) + BigInt(5 * usd), 3000), // m = 5 + 300 - 300 = +$5, T = max(1, 1bp of 100k = $10) => ambiguous
    ];
    const stats = { skippedAmbiguous: 0, graded: 0 };
    const labels = labelBlocks(rs, () => Q96, () => 0.5, { labelFee: 'base', baseFeePips: 3000, deadbandUsd: 1, deadbandBps: 1, usdPerRawToken1: () => 1e-6, stats });
    expect(labels.map((l) => [l.block, l.y])).toEqual([[2, 1], [3, 0]]);
    expect(stats).toEqual({ skippedAmbiguous: 2, graded: 2 });
    // 0/0 = sign-only label (old behaviour): every block graded
    expect(labelBlocks(rs, () => Q96, () => 0.5, { labelFee: 'base', baseFeePips: 3000, deadbandUsd: 0, deadbandBps: 0 }).map((l) => l.y)).toEqual([1, 1, 0, 1]);
    // no USD conversion available => not graded under a dead band
    expect(labelBlocks(rs, () => Q96, () => 0.5, { labelFee: 'base', baseFeePips: 3000, deadbandUsd: 1, deadbandBps: 1 })).toHaveLength(0);
  });
  it('usdPerRawToken1 handles both token orders', () => {
    expect(usdPerRawToken1({ token0: '0x1', token1: '0x2', decimals0: 18, decimals1: 6, baseIsToken0: true }, Q96)).toBe(1e-6);
    // token0 = USDC (6), token1 = WETH (18): px = raw wei per raw usdc; at $2000/ETH px = 1e18/(2000*1e6) = 5e8 => usd per wei = 1e-6/5e8 = 2e-15
    const px = (10n ** 18n * Q96) / (2000n * 10n ** 6n);
    expect(usdPerRawToken1({ token0: '0x1', token1: '0x2', decimals0: 6, decimals1: 18, baseIsToken0: false }, px)).toBeCloseTo(2e-15, 20);
  });
  it('ruleModelNode = namehash(rule-v1.models.oniblock.eth)', () => {
    expect(ruleModelNode()).toBe(namehash('rule-v1.models.oniblock.eth'));
  });
  it('labels against the CEX mid at the swap block: an arb that looks unprofitable vs a lagged mid is informed', () => {
    // Swapper sells 1000 token0 for 995 token1 (fee inside). CEX mid at the block = 0.99 (price fell) => +5 informed;
    // the lagged attested mid (1.00) would say -5 => not informed.
    const cexMid = (Q96 * 99n) / 100n;
    expect(labelBlocks([r(7, -1000n, 995n)], () => cexMid, () => 0.9)[0]!.y).toBe(1);
    expect(labelBlocks([r(7, -1000n, 995n)], () => Q96, () => 0.9)[0]!.y).toBe(0);
  });
});

describe('v5: settler JIT label (docs/review/V5_JIT_HEAD_SPEC.md §3.4)', () => {
  const ROUTER = '0x0DCd1Bf9A1b36cE34237eEaFef220932846BCD82' as const;
  const OTHER = '0x0000000000000000000000000000000000000abc' as const;
  const S = (n: number): Hex => ('0x' + n.toString(16).padStart(64, '0')) as Hex;
  const lo = (block: number, liquidityDelta: bigint, salt = S(1), logIndex?: number, ticks: [number, number] = [-120, 60], sender: `0x${string}` = ROUTER): LiquidityObs => ({
    block, sender, tickLower: ticks[0], tickUpper: ticks[1], liquidityDelta, salt, ...(logIndex !== undefined ? { logIndex } : {}),
  });
  const att = (mined: number, pJitBps: number, node = NODE): AttestationLog => ({
    poolId: '0x00', blockNumber: mined, minedBlock: mined, oracleMidX96: Q96, pToxicBps: 0, confidenceBps: 0, kBps: 0, modelNode: node, quoter: OTHER, txHash: `0x${mined.toString(16)}` as Hex, logIndex: 0, pJitBps, jitWindow: 10,
  });
  const stats = (): JitLabelStats => ({ graded: 0, pending: 0, skippedNoLiquidity: 0, skippedNoAttestation: 0, skippedStale: 0 });

  it('y = 1 when a position added in b is removed within the window, 0 when removed after; blocks without adds are not graded', () => {
    const liq = [
      lo(12, 100n, S(1)), lo(20, -100n, S(1)), // removed at +8  => JIT
      lo(30, 100n, S(2)), lo(200, -100n, S(2)), // removed at +170 > 100 => stayed
      lo(40, -50n, S(3)), // a remove without an add in range: not an "adds" block
    ];
    const st = stats();
    const labels = labelJitBlocks(liq, [att(10, 8000)], { labelBlocks: 100, head: 400, stats: st });
    expect(labels.map((l) => [l.block, l.y, l.p, l.nSwaps])).toEqual([[12, 1, 0.8, 1], [30, 0, 0.8, 1]]);
    expect(labels[0]!.modelNode).toBe(NODE);
    expect(st).toEqual({ graded: 2, pending: 0, skippedNoLiquidity: 1, skippedNoAttestation: 0, skippedStale: 0 }); // the attested block 10 had no adds
    expect(labelJitBlocks([], [att(10, 8000)], { labelBlocks: 100, head: 400 })).toEqual([]);
  });

  it('grades a block only once b + labelBlocks <= head (pending until then), default window 100', () => {
    const liq = [lo(12, 100n), lo(20, -100n)];
    const st = stats();
    expect(labelJitBlocks(liq, [att(10, 8000)], { labelBlocks: 100, head: 111, stats: st })).toHaveLength(0);
    expect(st.pending).toBe(1);
    expect(labelJitBlocks(liq, [att(10, 8000)], { labelBlocks: 100, head: 112 })).toHaveLength(1);
    expect(labelJitBlocks(liq, [att(10, 8000)], { head: 112 })).toHaveLength(1);
    // the same add removed exactly at the window edge counts, one block later does not
    expect(labelJitBlocks([lo(12, 1n), lo(112, -1n)], [att(10, 1)], { labelBlocks: 100, head: 500 })[0]!.y).toBe(1);
    expect(labelJitBlocks([lo(12, 1n), lo(113, -1n)], [att(10, 1)], { labelBlocks: 100, head: 500 })[0]!.y).toBe(0);
  });

  it('position identity is the v4 position key (sender, tickLower, tickUpper, salt): other salt / range / owner removes do not count', () => {
    const liq = [lo(12, 100n, S(1)), lo(15, -100n, S(2)), lo(16, -100n, S(1), undefined, [-60, 60]), lo(17, -100n, S(1), undefined, [-120, 60], OTHER)];
    expect(labelJitBlocks(liq, [att(10, 5000)], { labelBlocks: 100, head: 500 })[0]!.y).toBe(0);
    expect(labelJitBlocks([...liq, lo(18, -100n, S(1))], [att(10, 5000)], { labelBlocks: 100, head: 500 })[0]!.y).toBe(1);
    // any one of several adds in the block being pulled makes the block JIT
    const two = [lo(12, 1n, S(7)), lo(12, 1n, S(8)), lo(30, -1n, S(8))];
    expect(labelJitBlocks(two, [att(10, 5000)], { labelBlocks: 100, head: 500 }).map((l) => [l.y, l.nSwaps])).toEqual([[1, 2]]);
  });

  it('same-block mint -> burn counts (log order); a remove logged before the add does not', () => {
    expect(labelJitBlocks([lo(12, 100n, S(1), 3), lo(12, -100n, S(1), 9)], [att(10, 5000)], { labelBlocks: 100, head: 500 })[0]!.y).toBe(1);
    expect(labelJitBlocks([lo(12, -100n, S(1), 1), lo(12, 100n, S(1), 5)], [att(10, 5000)], { labelBlocks: 100, head: 500 })[0]!.y).toBe(0);
  });

  it('p and model come from the attestation in force at b (latest mined at or before b); rule-v1 is never graded', () => {
    const rule = ruleModelNode();
    const atts = [att(10, 1000, NODE), att(20, 9000, NODE2), att(30, 0, rule)];
    const liq = [lo(5, 1n, S(0)), lo(15, 1n, S(1)), lo(16, -1n, S(1)), lo(25, 1n, S(2)), lo(26, -1n, S(2)), lo(35, 1n, S(3)), lo(36, -1n, S(3))];
    const st = stats();
    const labels = labelJitBlocks(liq, atts, { labelBlocks: 100, head: 500, skipModelNodes: [rule], stats: st });
    expect(labels.map((l) => [l.block, l.modelNode, l.p])).toEqual([[15, NODE, 0.1], [25, NODE2, 0.9]]);
    expect(st.skippedNoAttestation).toBe(2); // block 5 (before any attestation) and block 35 (rule-v1 in force)
    expect(attestationIndex(atts).inForce(9)).toBeUndefined();
    expect(attestationIndex(atts).inForce(20)!.pJitBps).toBe(9000);
  });

  it('audit #3: an add logged before a same-block attestation is graded against the previous attestation', () => {
    const late = { ...att(12, 9000, NODE2), logIndex: 5 };
    const liq = [lo(12, 1n, S(1), 2), lo(12, 1n, S(2), 7), lo(13, -1n, S(2), 0)];
    const labels = labelJitBlocks(liq, [att(10, 1000), late], { labelBlocks: 100, head: 500 });
    expect(labels.map((l) => [l.block, l.modelNode, l.p, l.y, l.nSwaps])).toEqual([[12, NODE, 0.1, 0, 1], [12, NODE2, 0.9, 1, 1]]);
  });

  it('audit #14: adds made while the attestation is stale are not graded (hook used jitWindowDefault)', () => {
    const liq = [lo(15, 1n, S(1)), lo(16, -1n, S(1)), lo(40, 1n, S(2)), lo(41, -1n, S(2))];
    const st = stats();
    const labels = labelJitBlocks(liq, [att(10, 8000)], { labelBlocks: 100, head: 500, staleBlocks: 20, stats: st });
    expect(labels.map((l) => l.block)).toEqual([15]); // 15 - 10 <= 20 fresh; 40 - 10 > 20 stale
    expect(st.skippedStale).toBe(1);
    // without staleBlocks (unknown config) both are graded, as before
    expect(labelJitBlocks(liq, [att(10, 8000)], { labelBlocks: 100, head: 500 })).toHaveLength(2);
  });

  it('feeds calibrate() like the arb head, and jitCalibrationKey matches the contract derivation (cast vector)', () => {
    const liq = [lo(12, 1n, S(1)), lo(20, -1n, S(1)), lo(30, 1n, S(2)), lo(31, -1n, S(2)), lo(40, 1n, S(3))];
    const cal = calibrate(labelJitBlocks(liq, [att(10, 8000)], { labelBlocks: 100, head: 500 }), 0, 'raw');
    expect(cal).toHaveLength(1);
    expect(cal[0]!.n).toBe(3);
    expect(cal[0]!.brierBps).toBe(Math.round(((0.04 + 0.04 + 0.64) / 3) * 10000));
    expect(cal[0]!.hitRateBps).toBe(6667);
    expect(cal[0]!.baseRateBps).toBe(6667);
    // keccak256(abi.encodePacked(node, keccak256("jit"))) for the jev-v1 node, computed with `cast`
    expect(jitCalibrationKey('0x32a8db0cb3a8a2e435ad7fdcd6b92d2e61ba5c4f8276bdcb6937dde855e0cdcf')).toBe('0x2ccc4a08aeae3ff0269b307ffa9a8ac1577f1d9e79d625c8d35b87dce29111e6');
    expect(jitCalibrationKey(NODE)).not.toBe(jitCalibrationKey(NODE2));
  });
});
