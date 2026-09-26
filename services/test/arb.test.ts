import { describe, expect, it } from 'vitest';
import { planArb, splitLimits } from '../src/bots/arbMath.js';
import { Q96, priceX96ToSqrtPriceX96, sqrtPriceX96ToPriceX96 } from '../src/price.js';
import { poisson, rng } from '../src/bots/retail.js';

const E18 = 10n ** 18n;

describe('arb math', () => {
  const M = Q96; // oracle price 1.0 (equal decimals)
  const L = 1_000_000n * E18;
  it('inside the no-trade band => no trade', () => {
    const sp = priceX96ToSqrtPriceX96((M * 1002n) / 1000n); // +0.2% < 0.3% fee
    expect(planArb({ sqrtPriceX96: sp, liquidity: L, oracleX96: M, feePips: 3000 })).toBeNull();
  });
  it('pool above oracle => sell token0 down to M/(1-f), profitable', () => {
    const sp = priceX96ToSqrtPriceX96((M * 101n) / 100n);
    const p = planArb({ sqrtPriceX96: sp, liquidity: L, oracleX96: M, feePips: 3000 })!;
    expect(p.zeroForOne).toBe(true);
    const target = Number(sqrtPriceX96ToPriceX96(p.sqrtTargetX96)) / Number(Q96);
    expect(target).toBeCloseTo(1 / 0.997, 6);
    expect(p.profitToken1).toBeGreaterThan(0);
    expect(p.amountIn).toBeGreaterThan(0n);
  });
  it('pool below oracle => buy token0 up to M(1-f)', () => {
    const sp = priceX96ToSqrtPriceX96((M * 98n) / 100n);
    const p = planArb({ sqrtPriceX96: sp, liquidity: L, oracleX96: M, feePips: 3000 })!;
    expect(p.zeroForOne).toBe(false);
    expect(Number(sqrtPriceX96ToPriceX96(p.sqrtTargetX96)) / Number(Q96)).toBeCloseTo(0.997, 6);
    expect(p.profitToken1).toBeGreaterThan(0);
  });
  it('higher fee => smaller trade and profit', () => {
    const sp = priceX96ToSqrtPriceX96((M * 101n) / 100n);
    const lo = planArb({ sqrtPriceX96: sp, liquidity: L, oracleX96: M, feePips: 3000 })!;
    const hi = planArb({ sqrtPriceX96: sp, liquidity: L, oracleX96: M, feePips: 6000 })!;
    expect(hi.amountIn).toBeLessThan(lo.amountIn);
    expect(hi.profitToken1).toBeLessThan(lo.profitToken1);
  });
  it('split limits are monotone and end at target', () => {
    const ls = splitLimits(1000n, 400n, 3);
    expect(ls).toEqual([800n, 600n, 400n]);
  });
});

describe('retail rng', () => {
  it('is seeded / replayable and Poisson mean ~ lambda', () => {
    const a = rng(1), b = rng(1);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    const u = rng(7);
    let s = 0;
    for (let i = 0; i < 5000; i++) s += poisson(0.5, u);
    expect(s / 5000).toBeGreaterThan(0.45);
    expect(s / 5000).toBeLessThan(0.55);
  });
});
