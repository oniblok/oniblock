/**
 * Feature extraction. Inputs are aggregate, past-only data (confirmed swaps, CEX mids,
 * pool price) — never a specific pending trade (Uniswap security framework).
 */
import { gapPips as gapPipsFn } from './price.js';
import { realizedVolBps as realizedVol } from './cex.js';

export interface SwapObs {
  block: number;
  /** true = swapper sold token0 for token1. */
  zeroForOne: boolean;
  /** Signed executed amounts (BalanceDelta convention: negative = paid by swapper). */
  amount0: bigint;
  amount1: bigint;
  /** Fee charged in pips. */
  fee: number;
  /** Whether the swap moved the pool toward the oracle mid. */
  arbDir: boolean;
}

export interface FeatureInput {
  swaps: SwapObs[];
  /** Current CEX mid in priceX96 and current pool price in priceX96. */
  oracleX96: bigint;
  poolX96: bigint;
  /** Virtual token0 depth of the pool (raw units), e.g. L * 2^96 / sqrtP. */
  depth0: bigint;
  /** Recent CEX mids (human units, oldest first) for realized vol. */
  recentMids: number[];
  currentBlock: number;
  lastAttestBlock: number;
  /** Base fee (pips) — lets the model compare gap vs cost of arbitrage. */
  baseFee?: number;
  /** Look-back window in blocks for swaps (default 20). */
  windowBlocks?: number;
  /** true if the base asset (ETH) is token0 — used only to phrase "buy/sell ETH" in text. */
  baseIsToken0?: boolean;
  /** Current attested k (bps) and fee cap of the hook pool. When given, the features carry the arb-direction
   *  regime fee min(base + gap*k, feeMax), which is what an arbitrageur actually pays on this pool. */
  kBps?: number;
  feeMax?: number;
}

export interface Features {
  /** |pool - oracle| / oracle in pips. */
  gapPips: number;
  /** Sign of pool vs oracle: +1 pool above oracle, -1 below, 0 equal. */
  gapSign: number;
  /** Net token0 buy pressure over the window in [-1, 1] (+1 = all buys of token0). */
  imbalance: number;
  /** Mean |amount0| per swap / depth0. */
  sizeToDepth: number;
  /** Stdev of log returns of recent CEX mids, bps. */
  realizedVolBps: number;
  /** Blocks since the last accepted attestation. */
  attestationAge: number;
  /** Swaps in window and fraction of them that were arb-direction. */
  nSwaps: number;
  arbShare: number;
  baseFee: number;
  /** Arb-direction fee (pips) under the hook's law at the current k; undefined for plain pools / old callers. */
  arbFeePips?: number;
  kBps?: number;
}

const abs = (x: bigint) => (x < 0n ? -x : x);

export { realizedVol };

export function computeFeatures(i: FeatureInput): Features {
  const window = i.windowBlocks ?? 20;
  const recent = i.swaps.filter((s) => s.block > i.currentBlock - window && s.block <= i.currentBlock);
  let signed = 0n;
  let total = 0n;
  let arb = 0;
  for (const s of recent) {
    const a0 = abs(s.amount0);
    total += a0;
    // zeroForOne => swapper sells token0 (negative pressure on token0)
    signed += s.zeroForOne ? -a0 : a0;
    if (s.arbDir) arb++;
  }
  const imbalance = total > 0n ? Number((signed * 1_000_000n) / total) / 1_000_000 : 0;
  const meanSize = recent.length ? total / BigInt(recent.length) : 0n;
  const sizeToDepth = i.depth0 > 0n ? Number((meanSize * 1_000_000_000n) / i.depth0) / 1e9 : 0;
  const gap = gapPipsFn(i.poolX96, i.oracleX96);
  return {
    gapPips: gap,
    gapSign: i.poolX96 === i.oracleX96 ? 0 : i.poolX96 > i.oracleX96 ? 1 : -1,
    imbalance: round(imbalance, 4),
    sizeToDepth: round(sizeToDepth, 6),
    realizedVolBps: round(realizedVol(i.recentMids), 3),
    attestationAge: Math.max(0, i.currentBlock - i.lastAttestBlock),
    nSwaps: recent.length,
    arbShare: recent.length ? round(arb / recent.length, 3) : 0,
    baseFee: i.baseFee ?? 3000,
    ...(i.kBps !== undefined
      ? { kBps: i.kBps, arbFeePips: Math.min((i.baseFee ?? 3000) + Math.floor((gap * i.kBps) / 10_000), i.feeMax ?? 1_000_000) }
      : {}),
  };
}

function round(x: number, d: number): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

/**
 * Compact, self-describing text state for Jev. Deterministic ordering so identical
 * features produce identical text (cacheable). Units are spelled out because Jev reads
 * natural language.
 */
export function featuresToState(f: Features, opts: { baseIsToken0?: boolean } = {}): string {
  const base = opts.baseIsToken0 === false ? 'token1 (ETH)' : 'token0 (ETH)';
  const poolVs = f.gapSign > 0 ? 'above' : f.gapSign < 0 ? 'below' : 'equal to';
  const gapPct = (f.gapPips / 1e4).toFixed(3);
  const feePct = (f.baseFee / 1e4).toFixed(2);
  // With the hook's regime fee known, describe the fee an arbitrageur really pays (base + k*gap on swaps toward
  // the mid); otherwise (plain pools, benchmark cache keys) keep the original base-fee wording byte-for-byte.
  const feeLines =
    f.arbFeePips !== undefined
      ? [
          `price_gap: pool price is ${poolVs} the Binance mid by ${gapPct}% (${f.gapPips} pips); base swap fee ${feePct}%, and swaps toward the Binance mid pay ${(f.arbFeePips / 1e4).toFixed(3)}% (base + k x gap, k = ${((f.kBps ?? 0) / 1e4).toFixed(2)}).`,
          `arb_edge: gap minus the fee for swaps toward the mid = ${((f.gapPips - f.arbFeePips) / 1e4).toFixed(3)}% (positive means arbitrage is profitable after fees).`,
        ]
      : [
          `price_gap: pool price is ${poolVs} the Binance mid by ${gapPct}% (${f.gapPips} pips); base swap fee ${feePct}%.`,
          `arb_edge: gap minus base fee = ${((f.gapPips - f.baseFee) / 1e4).toFixed(3)}% (positive means arbitrage is profitable).`,
        ];
  const lines = [
    'Uniswap v4 ETH/USDC pool, per-block regime snapshot (past data only).',
    ...feeLines,
    `flow_imbalance: ${f.imbalance.toFixed(3)} on [-1,1] (+1 = all recent swaps bought ${base}, -1 = all sold).`,
    `recent_swaps: ${f.nSwaps} in last blocks, ${(f.arbShare * 100).toFixed(0)}% moved the pool toward the Binance mid.`,
    `size_to_depth: average swap is ${(f.sizeToDepth * 100).toFixed(3)}% of pool depth.`,
    `cex_volatility: ${f.realizedVolBps.toFixed(2)} bps per interval (stdev of log returns).`,
    `oracle_age: ${f.attestationAge} blocks since last price attestation.`,
  ];
  return lines.join('\n');
}
