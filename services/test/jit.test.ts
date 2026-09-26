import { describe, expect, it } from 'vitest';
import { amountInForUsd, jitRange, jitSwapZeroForOne, liquidityForUsd, sqrtRatioAtTick } from '../src/bots/jit.js';
import { midToPriceX96, priceX96ToSqrtPriceX96, Q96 } from '../src/price.js';

const WETH0 = { token0: '0x1', token1: '0x2', decimals0: 18, decimals1: 6, baseIsToken0: true } as const; // token0 = mWETH, token1 = mUSDC
const USDC0 = { token0: '0x1', token1: '0x2', decimals0: 6, decimals1: 18, baseIsToken0: false } as const;

describe('jit bot math (offline)', () => {
  it('jitRange is centred on the price: [align - ticks*sp, align + (ticks+1)*sp], price >= ticks*sp from both edges', () => {
    expect(jitRange(123, 60, 1)).toEqual({ tickLower: 60, tickUpper: 240 });
    expect(jitRange(-7, 60, 1)).toEqual({ tickLower: -120, tickUpper: 60 });
    expect(jitRange(-200311, 60, 2)).toEqual({ tickLower: -200460, tickUpper: -200160 });
    // the live-run case: pool at -197228 used to get [-197340, -197220] (8 ticks below the upper edge); default ticks = 3
    expect(jitRange(-197228, 60, 3)).toEqual({ tickLower: -197460, tickUpper: -197040 });
    for (const [t, sp, n] of [[123, 60, 1], [-7, 60, 1], [-200311, 60, 2], [0, 10, 3], [-197228, 60, 3], [59, 60, 1]] as const) {
      const r = jitRange(t, sp, n);
      expect(r.tickLower <= t && t < r.tickUpper).toBe(true);
      expect(t - r.tickLower).toBeGreaterThanOrEqual(n * sp);
      expect(r.tickUpper - t).toBeGreaterThanOrEqual(n * sp);
      expect(Math.abs(r.tickLower % sp)).toBe(0);
      expect(Math.abs(r.tickUpper % sp)).toBe(0);
    }
  });

  it('jitSwapZeroForOne: default = the NON-arb direction (away from the attested mid), --arb-dir = toward it', () => {
    const mid = 2000n * Q96;
    const above = 2010n * Q96; // pool price above the mid: the arb sells token0 (zeroForOne = true)
    const below = 1990n * Q96;
    expect(jitSwapZeroForOne(above, mid, true)).toBe(true);
    expect(jitSwapZeroForOne(above, mid, false)).toBe(false);
    expect(jitSwapZeroForOne(below, mid, true)).toBe(false);
    expect(jitSwapZeroForOne(below, mid, false)).toBe(true);
    // pool == mid: the arb direction is undefined; sell token0 counts as arb (old default), non-arb is the opposite
    expect(jitSwapZeroForOne(mid, mid, true)).toBe(true);
    expect(jitSwapZeroForOne(mid, mid, false)).toBe(false);
    for (const p of [above, below, mid]) expect(jitSwapZeroForOne(p, mid, false)).toBe(!jitSwapZeroForOne(p, mid, true));
  });

  it('liquidityForUsd sizes a position worth ~JIT_SIZE_USD at the current price (both token orders)', () => {
    for (const [meta, mid] of [[WETH0, 2000], [USDC0, 2000]] as const) {
      const priceX96 = midToPriceX96(mid, meta);
      const sqrtP = priceX96ToSqrtPriceX96(priceX96);
      const tick = Math.floor(Math.log(Number(priceX96) / Number(Q96)) / Math.log(1.0001));
      const { tickLower, tickUpper } = jitRange(tick, 60, 1);
      const L = liquidityForUsd(2000, sqrtP, tickLower, tickUpper, meta);
      expect(L).toBeGreaterThan(0n);
      // value of the position at the current price, in USD, from the v4 amount formulas
      const sp = Number(sqrtP) / Number(Q96);
      const sl = sqrtRatioAtTick(tickLower);
      const su = sqrtRatioAtTick(tickUpper);
      const amount0 = (Number(L) * (su - sp)) / (sp * su); // raw token0
      const amount1 = Number(L) * (sp - sl); // raw token1
      const usd = meta.baseIsToken0 ? (amount0 / 1e18) * mid + amount1 / 1e6 : amount0 / 1e6 + (amount1 / 1e18) * mid;
      expect(usd / 2000).toBeCloseTo(1, 2);
    }
    expect(liquidityForUsd(2000, 0n, -60, 60, WETH0)).toBe(0n);
  });

  it('amountInForUsd converts the swap notional to the paid token', () => {
    expect(amountInForUsd(5000, true, WETH0, 2000)).toBe(25n * 10n ** 17n); // pay 2.5 ETH
    expect(amountInForUsd(5000, false, WETH0, 2000)).toBe(5000n * 10n ** 6n); // pay 5000 USDC
    expect(amountInForUsd(5000, true, USDC0, 2000)).toBe(5000n * 10n ** 6n);
    expect(amountInForUsd(5000, false, USDC0, 2000)).toBe(25n * 10n ** 17n);
  });
});
