import { describe, expect, it } from 'vitest';
import {
  Q96, midToPriceX96, priceX96ToMid, sqrtPriceX96ToPriceX96, priceX96ToSqrtPriceX96,
  gapPips, isArbDir, arbZeroForOne, feeLaw, isqrt, toE18, sqrtPriceX96ToMid,
} from '../src/price.js';

const WETH0 = { decimals0: 18, decimals1: 6, baseIsToken0: true };   // token0 = mWETH, token1 = mUSDC
const USDC0 = { decimals0: 6, decimals1: 18, baseIsToken0: false };  // token0 = mUSDC, token1 = mWETH

describe('price conversions', () => {
  it('toE18 parses exactly', () => {
    expect(toE18('2681.065')).toBe(2681065000000000000000n);
    expect(toE18(1.5)).toBe(1500000000000000000n);
  });

  it('WETH=token0 (18) / USDC=token1 (6): mid 2000 -> 2000e6/1e18 * 2^96', () => {
    const p = midToPriceX96(2000, WETH0);
    expect(p).toBe((2000n * Q96) / 10n ** 12n);
    expect(priceX96ToMid(p, WETH0)).toBeCloseTo(2000, 6);
  });

  it('USDC=token0 (6) / WETH=token1 (18): mid 2000 -> 5e8 * 2^96 exactly', () => {
    const p = midToPriceX96(2000, USDC0);
    expect(p).toBe(500_000_000n * Q96);
    expect(priceX96ToMid(p, USDC0)).toBeCloseTo(2000, 9);
  });

  it('round-trips arbitrary mids in both orders', () => {
    for (const m of [1234.56, 2681.07, 3999.99, 0.5, 100000]) {
      expect(priceX96ToMid(midToPriceX96(m, WETH0), WETH0) / m).toBeCloseTo(1, 9);
      expect(priceX96ToMid(midToPriceX96(m, USDC0), USDC0) / m).toBeCloseTo(1, 9);
    }
  });

  it('equal decimals, 1:1 price => sqrtPriceX96 = 2^96', () => {
    const o = { decimals0: 18, decimals1: 18, baseIsToken0: true };
    const p = midToPriceX96(1, o);
    expect(p).toBe(Q96);
    expect(priceX96ToSqrtPriceX96(p)).toBe(Q96);
    expect(sqrtPriceX96ToPriceX96(Q96)).toBe(Q96);
  });

  it('sqrtPrice <-> price round trip (USDC/WETH at $2000: sqrt(5e8)*2^96)', () => {
    const p = midToPriceX96(2000, USDC0);
    const s = priceX96ToSqrtPriceX96(p);
    // sqrt(5e8) = 22360.6797749979
    expect(Number(s) / Number(Q96)).toBeCloseTo(22360.6797749979, 6);
    const back = sqrtPriceX96ToPriceX96(s);
    expect(Number(p - back) / Number(p)).toBeLessThan(1e-12);
    expect(sqrtPriceX96ToMid(s, USDC0)).toBeCloseTo(2000, 6);
  });

  it('isqrt is floor sqrt for large values', () => {
    const n = 12345678901234567890123456789012345678901234567890n;
    const r = isqrt(n);
    expect(r * r <= n && (r + 1n) * (r + 1n) > n).toBe(true);
  });
});

describe('gap & arb direction (contract mirror)', () => {
  it('gap pips', () => {
    const o = 1_000_000n * Q96;
    expect(gapPips(o, o)).toBe(0);
    expect(gapPips((o * 101n) / 100n, o)).toBe(10_000); // +1% = 10000 pips
    expect(gapPips((o * 995n) / 1000n, o)).toBe(5_000);
    expect(gapPips(o * 5n, o)).toBe(1_000_000); // clamped
  });

  it('arbDir = (pool > oracle) == zeroForOne', () => {
    expect(isArbDir(110n, 100n, true)).toBe(true);   // pool high, sell token0 lowers it
    expect(isArbDir(110n, 100n, false)).toBe(false);
    expect(isArbDir(90n, 100n, false)).toBe(true);
    expect(arbZeroForOne(110n, 100n)).toBe(true);
    expect(arbZeroForOne(100n, 100n)).toBe(null);
  });

  it('fee law', () => {
    expect(feeLaw({ arbDir: false, gapPips: 5000, kBps: 5000, baseFee: 3000, feeMax: 10000 })).toBe(3000);
    expect(feeLaw({ arbDir: true, gapPips: 5000, kBps: 5000, baseFee: 3000, feeMax: 10000 })).toBe(5500);
    expect(feeLaw({ arbDir: true, gapPips: 50000, kBps: 5000, baseFee: 3000, feeMax: 10000 })).toBe(10000);
  });
});
