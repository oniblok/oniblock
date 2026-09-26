/**
 * Price conversions. Convention (BUILD_SPEC): priceX96 = (raw token1 per raw token0) * 2^96,
 * the same unit as sqrtPriceX96^2 / 2^96.
 *
 * "mid" is always the human quote-per-base price (USDC per ETH), regardless of token order.
 */
import type { PairMeta } from './config.js';

export const Q96 = 1n << 96n;
export const PIPS = 1_000_000n;
/** Fixed-point scale used for decimal <-> bigint conversions of human prices. */
const SCALE = 10n ** 18n;

export type TokenOrder = Pick<PairMeta, 'decimals0' | 'decimals1' | 'baseIsToken0'>;

/** Parse a decimal (number or string, e.g. "2681.065") to bigint scaled by 1e18, exactly for strings. */
export function toE18(x: number | string): bigint {
  let s = typeof x === 'number' ? x.toFixed(18) : x.trim();
  if (s.includes('e') || s.includes('E')) s = Number(s).toFixed(18);
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  const [int, frac = ''] = s.split('.');
  const v = BigInt(int || '0') * SCALE + BigInt((frac + '0'.repeat(18)).slice(0, 18) || '0');
  return neg ? -v : v;
}

export function fromE18(x: bigint): number {
  const neg = x < 0n;
  const a = neg ? -x : x;
  const v = Number(a / SCALE) + Number(a % SCALE) / 1e18;
  return neg ? -v : v;
}

const pow10 = (n: number) => 10n ** BigInt(n);

/** Human mid (quote per base, e.g. USDC per ETH) -> priceX96 for the given pool token order. */
export function midToPriceX96(mid: number | string, o: TokenOrder): bigint {
  const m = toE18(mid);
  if (m <= 0n) throw new Error('mid must be > 0');
  if (o.baseIsToken0) {
    // token1 (quote) per token0 (base) = mid; raw = mid * 10^(d1-d0)
    return (m * pow10(o.decimals1) * Q96) / (SCALE * pow10(o.decimals0));
  }
  // token0 = quote, token1 = base: raw token1 per raw token0 = (1/mid) * 10^(d1-d0)
  return (SCALE * pow10(o.decimals1) * Q96) / (m * pow10(o.decimals0));
}

/** priceX96 -> human mid (quote per base). */
export function priceX96ToMid(priceX96: bigint, o: TokenOrder): number {
  if (priceX96 <= 0n) throw new Error('priceX96 must be > 0');
  if (o.baseIsToken0) {
    // mid = priceX96 / 2^96 * 10^(d0-d1)
    return fromE18((priceX96 * SCALE * pow10(o.decimals0)) / (Q96 * pow10(o.decimals1)));
  }
  // mid = 1 / (priceX96/2^96 * 10^(d0-d1)) = 2^96 * 10^(d1-d0) / priceX96
  return fromE18((Q96 * SCALE * pow10(o.decimals1)) / (priceX96 * pow10(o.decimals0)));
}

/** Same as the contract: FullMath.mulDiv(sqrtP, sqrtP, 1 << 96). */
export function sqrtPriceX96ToPriceX96(sqrtPriceX96: bigint): bigint {
  return (sqrtPriceX96 * sqrtPriceX96) / Q96;
}

/** Integer square root (floor). */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error('isqrt of negative');
  if (n < 2n) return n;
  // Seed strictly above the root (float estimate * (1 + 2^-20) + 1), then Newton decreases monotonically.
  let x = BigInt(Math.ceil(Math.sqrt(Number(n)) * (1 + 2 ** -20))) + 1n;
  if (x * x <= n) x = n; // float overflow / imprecision guard
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** priceX96 -> sqrtPriceX96 = sqrt(priceX96 * 2^96). */
export function priceX96ToSqrtPriceX96(priceX96: bigint): bigint {
  return isqrt(priceX96 * Q96);
}

export function sqrtPriceX96ToMid(sqrtPriceX96: bigint, o: TokenOrder): number {
  return priceX96ToMid(sqrtPriceX96ToPriceX96(sqrtPriceX96), o);
}

/** Gap in pips, identical to the contract: mulDiv(|pool - oracle|, 1e6, oracle), clamped to 1e6. */
export function gapPips(poolX96: bigint, oracleX96: bigint): number {
  if (oracleX96 <= 0n) return 1_000_000;
  const d = poolX96 > oracleX96 ? poolX96 - oracleX96 : oracleX96 - poolX96;
  const g = (d * PIPS) / oracleX96;
  return Number(g > PIPS ? PIPS : g);
}

/** Arbitrage direction per the fee law: a swap is arb-direction if it moves pool toward oracle. */
export function isArbDir(poolX96: bigint, oracleX96: bigint, zeroForOne: boolean): boolean {
  return (poolX96 > oracleX96) === zeroForOne;
}

/** The zeroForOne direction that moves the pool toward the oracle (null if equal). */
export function arbZeroForOne(poolX96: bigint, oracleX96: bigint): boolean | null {
  if (poolX96 === oracleX96) return null;
  return poolX96 > oracleX96; // selling token0 lowers token1/token0 price
}

/**
 * Fee law mirror (v3 threshold law, for simulation / bots / checks):
 *   fee = arbDir ? min(base + floor(max(0, gap - arbThresholdPips) * k / 1e4), feeMax) : base
 * `gapPips` is the raw (high-water) gap as reported in Receipt.gapPips; `arbThresholdPips` comes from
 * hook.poolConfig(id).arbThresholdPips (0 = the v2 law, premium from the first pip). Below the threshold the pool
 * charges exactly baseFee in both directions.
 */
export function feeLaw(p: { arbDir: boolean; gapPips: number; kBps: number; baseFee: number; feeMax: number; arbThresholdPips: number }): number {
  if (!p.arbDir) return p.baseFee;
  const excess = Math.max(0, p.gapPips - p.arbThresholdPips);
  return Math.min(p.baseFee + Math.floor((excess * p.kBps) / 10_000), p.feeMax);
}

/** Excess gap above the arbitrage threshold (pips); 0 at/below it. */
export function excessGap(gapPips: number, arbThresholdPips: number): number {
  return Math.max(0, gapPips - arbThresholdPips);
}
