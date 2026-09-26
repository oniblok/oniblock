/**
 * Feature extraction. Inputs are aggregate, past-only data (confirmed swaps, CEX mids,
 * pool price) — never a specific pending trade (Uniswap security framework).
 */
import { encodePacked, keccak256, type Address, type Hex } from 'viem';
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

/** One PoolManager `ModifyLiquidity(id, sender, tickLower, tickUpper, liquidityDelta, salt)` event (v5 JIT head). */
export interface LiquidityObs {
  block: number;
  /** The router that called the PoolManager (= the position owner in v4-core's position key). */
  sender: Address;
  tickLower: number;
  tickUpper: number;
  /** > 0 add, < 0 remove. */
  liquidityDelta: bigint;
  salt: Hex;
  /** Log index within the block (orders a same-block add and remove); optional for synthetic inputs. */
  logIndex?: number;
}

/** One hook `JitPenalty(id, sender, positionKey, addedBlock, window, penalty0, penalty1)` event. */
export interface JitPenaltyObs {
  block: number;
  sender: Address;
  positionKey: Hex;
  addedBlock: number;
  window: number;
  penalty0: bigint;
  penalty1: bigint;
}

/** Blocks after an add within which a remove counts as JIT (feature churn + settler label); env JIT_LABEL_BLOCKS. */
export const JIT_LABEL_BLOCKS_DEFAULT = 100;

/** v4-core Position.calculatePositionKey: keccak256(abi.encodePacked(owner, tickLower, tickUpper, salt)) (58 bytes). */
export function positionKey(owner: Address, tickLower: number, tickUpper: number, salt: Hex): Hex {
  return keccak256(encodePacked(['address', 'int24', 'int24', 'bytes32'], [owner, tickLower, tickUpper, salt]));
}

export const liquidityObsKey = (o: Pick<LiquidityObs, 'sender' | 'tickLower' | 'tickUpper' | 'salt'>): Hex =>
  positionKey(o.sender, o.tickLower, o.tickUpper, o.salt);

/** true if `remove` happened after `add` (later block, or same block and later log when both are known). */
export function removeAfterAdd(add: LiquidityObs, remove: LiquidityObs): boolean {
  if (remove.block !== add.block) return remove.block > add.block;
  return add.logIndex === undefined || remove.logIndex === undefined || remove.logIndex > add.logIndex;
}

/** true if any of `removes` (same position key as `add`) removed it within `labelBlocks` blocks of the add. */
export function removedWithin(add: LiquidityObs, removes: LiquidityObs[], labelBlocks: number): boolean {
  return removes.some((r) => r.liquidityDelta < 0n && removeAfterAdd(add, r) && r.block - add.block <= labelBlocks);
}

/** Group liquidity observations by position key. */
export function byPositionKey(obs: LiquidityObs[]): Map<Hex, LiquidityObs[]> {
  const m = new Map<Hex, LiquidityObs[]>();
  for (const o of obs) {
    const k = liquidityObsKey(o);
    (m.get(k) ?? m.set(k, []).get(k)!).push(o);
  }
  return m;
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
  /** v5 JIT head: recent ModifyLiquidity / JitPenalty events of the pool (past-only). When `liquidity` is given the
   *  LiquidityFeatures (liqAdds20 ... jitWindowNow) are computed; old callers (benchmark, kev) leave it out and get none. */
  liquidity?: LiquidityObs[];
  jitPenalties?: JitPenaltyObs[];
  /** Current pool tick (whether the newest position brackets the price). */
  currentTick?: number;
  /** JIT penalty window in force now (hook poolState.jitWindow, or jitWindowDefault when stale). */
  jitWindowNow?: number;
  /** Blocks after an add within which a remove counts as JIT churn (default JIT_LABEL_BLOCKS_DEFAULT). */
  jitLabelBlocks?: number;
}

/** v5 liquidity features (all past-only aggregates of ModifyLiquidity / JitPenalty events). */
export interface LiquidityFeatures {
  /** Positions added in the last 20 blocks. */
  liqAdds20: number;
  /** Share [0,1] of positions added in the last 200 blocks that were removed again within jitLabelBlocks. */
  liqChurn200: number;
  /** Tick span of the newest add in the last 200 blocks; undefined = none. */
  liqNewestSpanTicks?: number;
  /** Whether that newest position brackets the current tick; undefined = no add or tick unknown. */
  liqNewestBrackets?: boolean;
  /** Median blocks between add and remove for positions removed in the last 200 blocks; undefined = none. */
  liqMedianLifetime?: number;
  /** JitPenalty events in the last 200 blocks. */
  jitPenalties200: number;
  jitWindowNow?: number;
  jitLabelBlocks: number;
}

export interface Features extends Partial<LiquidityFeatures> {
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
    ...(i.liquidity !== undefined ? liquidityFeatures(i) : {}),
  };
}

/**
 * v5 liquidity features from ModifyLiquidity / JitPenalty events (past-only). Positions are identified by the v4
 * position key (sender, tickLower, tickUpper, salt); "removed within N blocks" uses the same rule as the settler's
 * JIT label (`removedWithin`), so the churn feature and the graded outcome agree.
 */
export function liquidityFeatures(i: Pick<FeatureInput, 'liquidity' | 'jitPenalties' | 'currentBlock' | 'currentTick' | 'jitWindowNow' | 'jitLabelBlocks'>): LiquidityFeatures {
  const now = i.currentBlock;
  const labelBlocks = i.jitLabelBlocks ?? JIT_LABEL_BLOCKS_DEFAULT;
  const inLast = (o: { block: number }, n: number) => o.block > now - n && o.block <= now;
  const obs = (i.liquidity ?? []).filter((o) => o.block <= now);
  const adds = obs.filter((o) => o.liquidityDelta > 0n);
  const groups = byPositionKey(obs);
  const removesOf = (o: LiquidityObs) => (groups.get(liquidityObsKey(o)) ?? []).filter((x) => x.liquidityDelta < 0n);
  const adds200 = adds.filter((o) => inLast(o, 200));
  let churned = 0;
  for (const a of adds200) if (removedWithin(a, removesOf(a), labelBlocks)) churned++;
  let newest: LiquidityObs | undefined;
  for (const a of adds200) if (!newest || a.block > newest.block || (a.block === newest.block && (a.logIndex ?? 0) >= (newest.logIndex ?? 0))) newest = a;
  const lifetimes: number[] = [];
  for (const r of obs.filter((o) => o.liquidityDelta < 0n && inLast(o, 200))) {
    let last: LiquidityObs | undefined;
    for (const a of groups.get(liquidityObsKey(r)) ?? []) {
      if (a.liquidityDelta > 0n && removeAfterAdd(a, r) && (!last || a.block > last.block || (a.block === last.block && (a.logIndex ?? 0) >= (last.logIndex ?? 0)))) last = a;
    }
    if (last) lifetimes.push(r.block - last.block);
  }
  lifetimes.sort((a, b) => a - b);
  const mid = lifetimes.length >> 1;
  const median = !lifetimes.length ? undefined : lifetimes.length % 2 ? lifetimes[mid]! : (lifetimes[mid - 1]! + lifetimes[mid]!) / 2;
  return {
    liqAdds20: adds.filter((o) => inLast(o, 20)).length,
    liqChurn200: adds200.length ? round(churned / adds200.length, 3) : 0,
    ...(newest ? { liqNewestSpanTicks: newest.tickUpper - newest.tickLower } : {}),
    ...(newest && i.currentTick !== undefined ? { liqNewestBrackets: newest.tickLower <= i.currentTick && i.currentTick < newest.tickUpper } : {}),
    ...(median !== undefined ? { liqMedianLifetime: median } : {}),
    jitPenalties200: (i.jitPenalties ?? []).filter((p) => inLast(p, 200)).length,
    ...(i.jitWindowNow !== undefined ? { jitWindowNow: i.jitWindowNow } : {}),
    jitLabelBlocks: labelBlocks,
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
export type StateFormat = 'auto' | 'v4' | 'v5';

export function featuresToState(f: Features, opts: { baseIsToken0?: boolean; format?: StateFormat } = {}): string {
  const base = opts.baseIsToken0 === false ? 'token1 (ETH)' : 'token0 (ETH)';
  const poolVs = f.gapSign > 0 ? 'above' : f.gapSign < 0 ? 'below' : 'equal to';
  const gapPct = (f.gapPips / 1e4).toFixed(3);
  const feePct = (f.baseFee / 1e4).toFixed(2);
  if (opts.format === 'v4') return featuresToStateV4(f, base, poolVs, gapPct, feePct);
  if (opts.format === 'v5') return featuresToStateV4(f, base, poolVs, gapPct, feePct) + '\n' + liquidityStateLines(f).join('\n');
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

/**
 * v5 (docs/review/V5_JIT_HEAD_SPEC.md §3.2): the three liquidity lines appended to the v4 text for the JIT head.
 * Missing liquidity features (old callers) read as "no adds / no penalties / window unknown".
 */
export function liquidityStateLines(f: Partial<LiquidityFeatures>): string[] {
  const churnPct = ((f.liqChurn200 ?? 0) * 100).toFixed(0);
  const median = f.liqMedianLifetime === undefined ? 'n/a' : `${f.liqMedianLifetime} blocks`;
  const shape =
    f.liqNewestSpanTicks === undefined
      ? 'no position added in the last 200 blocks'
      : `newest position spans ${f.liqNewestSpanTicks} ticks ${f.liqNewestBrackets === undefined ? '(current price unknown)' : f.liqNewestBrackets ? 'around the current price' : 'away from the current price'}`;
  return [
    `liquidity_recent: ${f.liqAdds20 ?? 0} positions added in the last 20 blocks; ${churnPct}% of positions added in the last 200 blocks were removed again within ${f.jitLabelBlocks ?? JIT_LABEL_BLOCKS_DEFAULT} blocks.`,
    `liquidity_shape: ${shape}; median lifetime of recently removed positions ${median}.`,
    `jit_enforcement: ${f.jitPenalties200 ?? 0} JIT penalties in the last 200 blocks; current penalty window ${f.jitWindowNow === undefined ? 'unknown' : `${f.jitWindowNow} blocks`}.`,
  ];
}
