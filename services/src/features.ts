/**
 * Feature extraction. Inputs are aggregate, past-only data (confirmed swaps, CEX mids,
 * pool price) — never a specific pending trade (Uniswap security framework).
 */
import { feeLaw, gapPips as gapPipsFn } from './price.js';
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
   *  regime fee min(base + max(0, gap - arbThresholdPips)*k, feeMax), which is what an arbitrageur actually pays on this pool. */
  kBps?: number;
  feeMax?: number;
  /** v3: gap (pips) below which the hook charges exactly baseFee (poolConfig.arbThresholdPips). Default 0 = the
   *  v2 law (premium from the first pip) — keeps old callers / benchmark cache keys unchanged. */
  arbThresholdPips?: number;
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
  /** Arb threshold (pips) of the fee law; present only when > 0 (v3 pools). */
  arbThresholdPips?: number;
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
      ? {
          kBps: i.kBps,
          arbFeePips: feeLaw({ arbDir: true, gapPips: gap, kBps: i.kBps, baseFee: i.baseFee ?? 3000, feeMax: i.feeMax ?? 1_000_000, arbThresholdPips: i.arbThresholdPips ?? 0 }),
          ...(i.arbThresholdPips ? { arbThresholdPips: i.arbThresholdPips } : {}),
        }
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
export type StateFormat = 'auto' | 'v4';

export function featuresToState(f: Features, opts: { baseIsToken0?: boolean; format?: StateFormat } = {}): string {
  const base = opts.baseIsToken0 === false ? 'token1 (ETH)' : 'token0 (ETH)';
  const poolVs = f.gapSign > 0 ? 'above' : f.gapSign < 0 ? 'below' : 'equal to';
  const gapPct = (f.gapPips / 1e4).toFixed(3);
  const feePct = (f.baseFee / 1e4).toFixed(2);
  if (opts.format === 'v4') return featuresToStateV4(f, base, poolVs, gapPct, feePct);
  // With the hook's regime fee known, describe the fee an arbitrageur really pays (base + k*gap on swaps toward
  // the mid); otherwise (plain pools, benchmark cache keys) keep the original base-fee wording byte-for-byte.
  const feeLines =
    f.arbFeePips !== undefined
      ? [
          `price_gap: pool price is ${poolVs} the Binance mid by ${gapPct}% (${f.gapPips} pips); base swap fee ${feePct}%, and swaps toward the Binance mid pay ${(f.arbFeePips / 1e4).toFixed(3)}% ${
            f.arbThresholdPips
              ? `(base + k x (gap - ${(f.arbThresholdPips / 1e4).toFixed(2)}% arb threshold), base only below the threshold, k = ${((f.kBps ?? 0) / 1e4).toFixed(2)})`
              : `(base + k x gap, k = ${((f.kBps ?? 0) / 1e4).toFixed(2)})`
          }.`,
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

/**
 * v4 ("the AI decides the fee") state. Deliberately k-free: the edge is stated against the BASE fee (what an
 * arbitrageur would pay if the model says "no extra fee"), so the model's answer does not feed back into its own
 * input (a k-dependent edge would oscillate: high k -> edge < 0 -> "calm" -> k = 0 -> edge > 0 -> "toxic" ...).
 * It also spells out the consequence of the answer: the extra fee is proportional to the probability, and a
 * probability near 0 means the pool charges exactly its base fee, like a vanilla pool.
 */
function featuresToStateV4(f: Features, base: string, poolVs: string, gapPct: string, feePct: string): string {
  const edge = f.gapPips - f.baseFee;
  const lines = [
    'Uniswap v4 ETH/USDC pool, per-block snapshot (past data only). The pool charges an extra fee on swaps toward the Binance mid in proportion to the probability that the next block has profitable arbitrage; probability near 0 = only the normal base fee.',
    `price_gap: pool price is ${poolVs} the Binance mid by ${gapPct}% (${f.gapPips} pips).`,
    `base_fee: ${feePct}%. Arbitrage toward the Binance mid is profitable only when the gap is larger than the base fee (plus about 0.02% exchange costs).`,
    `arb_edge_at_base_fee: gap minus base fee = ${(edge / 1e4).toFixed(3)}% (${edge > 0 ? 'positive: arbitrage IS profitable at the base fee' : 'zero or negative: NO profitable arbitrage at the base fee'}).`,
    `flow_imbalance: ${f.imbalance.toFixed(3)} on [-1,1] (+1 = all recent swaps bought ${base}, -1 = all sold).`,
    `recent_swaps: ${f.nSwaps} in last blocks, ${(f.arbShare * 100).toFixed(0)}% moved the pool toward the Binance mid.`,
    `size_to_depth: average swap is ${(f.sizeToDepth * 100).toFixed(3)}% of pool depth.`,
    `cex_volatility: ${f.realizedVolBps.toFixed(2)} bps per interval (stdev of log returns).`,
    `oracle_age: ${f.attestationAge} blocks since last price attestation.`,
  ];
  return lines.join('\n');
}
