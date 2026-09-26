/**
 * Rational arbitrage against a constant-product (single active range) v4 pool.
 *
 * With fee f (fraction), marginal prices seen by the arb:
 *   sell token0 (zeroForOne): receives P(1-f) token1 per token0 -> profitable while P(1-f) > M
 *                             -> push pool down to P* = M / (1-f)
 *   buy  token0 (oneForZero): pays P/(1-f) token1 per token0   -> profitable while P/(1-f) < M
 *                             -> push pool up to   P* = M (1-f)
 * [M(1-f), M/(1-f)] is the no-trade band. The fee is the per-block anchored fee quoted by
 * hook.quoteFee (fixed for the block), so the band edge is exact for the whole block.
 * Amounts use the in-range formulas: Δx = L(1/√P* − 1/√P), Δy = L(√P* − √P).
 */
import { Q96, isqrt } from '../price.js';

export interface ArbInput {
  sqrtPriceX96: bigint;
  liquidity: bigint;
  oracleX96: bigint;
  feePips: number;
}

export interface ArbPlan {
  zeroForOne: boolean;
  /** Price limit = band edge (swap stops there). */
  sqrtTargetX96: bigint;
  /** Gross input INCLUDING fee (raw units of the input token). */
  amountIn: bigint;
  /** Expected output (raw units of the output token). */
  amountOut: bigint;
  /** Expected profit valued at the oracle mid, in raw token1 units (float). */
  profitToken1: number;
  /** Fee paid (raw token1 units, float). */
  feeToken1: number;
}

export function planArb(i: ArbInput): ArbPlan | null {
  const { sqrtPriceX96: sp, liquidity: L, oracleX96: M, feePips } = i;
  if (L <= 0n || sp <= 0n || M <= 0n || feePips >= 1_000_000) return null;
  const P = (sp * sp) / Q96;
  const oneMinusF = 1_000_000n - BigInt(feePips);
  const zeroForOne = P > M;
  const targetX96 = zeroForOne ? (M * 1_000_000n) / oneMinusF : (M * oneMinusF) / 1_000_000n;
  if (zeroForOne ? P <= targetX96 : P >= targetX96) return null; // inside band
  const st = isqrt(targetX96 * Q96);
  let inNoFee: bigint;
  let out: bigint;
  if (zeroForOne) {
    // token0 in, token1 out; price falls sp -> st
    inNoFee = (L * Q96 * (sp - st)) / (sp * st);
    out = (L * (sp - st)) / Q96;
  } else {
    inNoFee = (L * (st - sp)) / Q96;
    out = (L * Q96 * (st - sp)) / (sp * st);
  }
  if (inNoFee <= 0n || out <= 0n) return null;
  const amountIn = (inNoFee * 1_000_000n) / oneMinusF;
  const px = Number(M) / Number(Q96); // token1 per token0 (raw)
  const feeIn = Number(amountIn - inNoFee);
  let profit: number;
  let feeToken1: number;
  if (zeroForOne) {
    profit = Number(out) - Number(amountIn) * px;
    feeToken1 = feeIn * px;
  } else {
    profit = Number(out) * px - Number(amountIn);
    feeToken1 = feeIn;
  }
  return { zeroForOne, sqrtTargetX96: st, amountIn, amountOut: out, profitToken1: profit, feeToken1 };
}

/** Interpolated sqrt-price limits for N sub-swaps from current to target. */
export function splitLimits(sqrtNow: bigint, sqrtTarget: bigint, n: number): bigint[] {
  const out: bigint[] = [];
  for (let k = 1; k <= n; k++) out.push(sqrtNow + ((sqrtTarget - sqrtNow) * BigInt(k)) / BigInt(n));
  return out;
}

/** Value raw token1 units in USD given the pair orientation and mid. */
export function token1ToUsd(x: number, o: { baseIsToken0: boolean; decimals1: number }, mid: number): number {
  const human = x / 10 ** o.decimals1;
  return o.baseIsToken0 ? human : human * mid; // token1 = USDC, or token1 = WETH
}
