import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { attestationIndex, brierStats, calibrate, gateBps, labelBlocks } from '../src/settler.js';
import type { AttestationLog, ReceiptLog } from '../src/chain.js';
import { Q96 } from '../src/price.js';

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
  it('attestation index: p in force and next mid', () => {
    const at = (mined: number, p: number, mid: bigint, node = NODE): AttestationLog => ({
      poolId: '0x00', blockNumber: mined, minedBlock: mined, oracleMidX96: mid, pToxicBps: p, confidenceBps: 0, kBps: 0, modelNode: node, quoter: '0x0000000000000000000000000000000000000001', txHash: '0x00',
    });
    const idx = attestationIndex([at(10, 7000, 1n), at(12, 2000, 3n), at(11, 5000, 2n, NODE2)]);
    expect(idx.pAt(9, NODE)).toBeUndefined();
    expect(idx.pAt(11, NODE)).toBe(0.7);
    expect(idx.pAt(12, NODE)).toBe(0.2);
    expect(idx.midAfter(10)).toBe(2n);
    expect(idx.midAfter(12)).toBeUndefined();
    expect(idx.midInForce(9)).toBeUndefined();
    expect(idx.midInForce(11)).toBe(2n);
    expect(idx.midInForce(20)).toBe(3n);
  });
});
