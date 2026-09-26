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
  /** true if the base asset (ETH) is token0 — phrases "buy/sell ETH" in text and orients the v2 ret*Bps features
   *  (undefined = false there, the training orientation). */
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
  /** Model v2 (/tmp SPEC_v2 "New past-only features"): time-stamped CEX mids (t = unix ms, oldest first), e.g.
   *  MidHistory.entries(). When given, the MidFeatures (edgePips ... ret900Bps) are computed; old callers leave it out
   *  and their Features are unchanged. */
  midHistory?: readonly MidObs[];
  /** Snapshot time t_obs (unix ms) = the keeper's CEX read time; default = the newest midHistory entry. */
  tObsMs?: number;
}

/** One time-stamped CEX mid (human units). */
export interface MidObs {
  t: number;
  mid: number;
}

/** Model v2 features (all past-only; see computeMidFeatures). */
export interface MidFeatures {
  /** gapPips - baseFee (integer pips): the arb edge at the base fee (k-free). */
  edgePips: number;
  /** edgePips / max(realizedVolBps * 100, 1): the edge in units of the typical 12 s Binance move (1 bp = 100 pips). */
  edgeSigma: number;
  /** Realized vol (bps, ddof=1) of 25 mids sampled every 12 s ending at t_obs (nearest at-or-before). */
  vol5mBps: number;
  /** ln(mid(t_obs) / mid(t_obs - h)) * 1e4 * dir, h = 12 / 36 / 900 s, mid = USDC per ETH, dir = baseIsToken0 ?
   *  -gapSign : +gapSign: + = Binance moved away from the pool price (the gap widened). Orientation-free.
   *  0 when the history does not reach back h seconds. */
  ret12Bps: number;
  ret36Bps: number;
  ret900Bps: number;
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

export interface Features extends Partial<LiquidityFeatures>, Partial<MidFeatures> {
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
    ...(i.midHistory !== undefined
      ? computeMidFeatures({ gapPips: gap, gapSign: i.poolX96 === i.oracleX96 ? 0 : i.poolX96 > i.oracleX96 ? 1 : -1, baseFee: i.baseFee ?? 3000, realizedVolBps: round(realizedVol(i.recentMids), 3) }, i.midHistory, { tObsMs: i.tObsMs, baseIsToken0: i.baseIsToken0 })
      : {}),
  };
}

/** Index of the newest entry with t <= tMs in a time-sorted history, -1 if none. */
function atOrBefore(h: readonly MidObs[], tMs: number): number {
  let lo = 0;
  let hi = h.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (h[m]!.t <= tMs) {
      ans = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return ans;
}

/** Mid at tMs: nearest entry at-or-before (forward fill), undefined if the history starts later. */
export function midAtOrBefore(h: readonly MidObs[], tMs: number): number | undefined {
  const i = atOrBefore(h, tMs);
  return i >= 0 ? h[i]!.mid : undefined;
}

/** Samples, spacing (s) and horizons (s) of the v2 mid features (SPEC_v2: BinanceMids.vol_bps(t, n=25, step=12)). */
export const VOL5M_SAMPLES = 25;
export const VOL5M_STEP_S = 12;
export const RET_HORIZONS_S = [12, 36, 900] as const;

/**
 * Model v2 past-only features from the k-free price features and a time-stamped mid history (SPEC_v2; rounded to 4 dp
 * exactly like ml/src/build_v2.py, edgePips an unrounded integer, realizedVolBps the already 3-dp-rounded value):
 *   edgePips = gapPips - baseFee; edgeSigma = edgePips / max(realizedVolBps * 100, 1);
 *   vol5mBps = realizedVolBps(mid(t_obs - 12 i), i = 24..0) (nearest at-or-before; samples before the history dropped);
 *   retHBps  = ln(mid(t_obs) / mid(t_obs - h)) * 1e4 * dir, dir = baseIsToken0 ? -gapSign : +gapSign (mid = USDC per
 *              ETH; pool prices are token1/token0, so "pool above the mid" means ETH is dear in the pool when ETH is
 *              token0 and cheap when it is token1), 0 if no entry at-or-before t_obs - h.
 * The history is sorted by t (MidHistory appends in time order); entries after t_obs are ignored.
 * baseIsToken0 undefined = false (the training orientation: USDC token0, WETH token1).
 */
export function computeMidFeatures(
  f: Pick<Features, 'gapPips' | 'gapSign' | 'baseFee' | 'realizedVolBps'>,
  history: readonly MidObs[],
  opts: { tObsMs?: number; baseIsToken0?: boolean } = {},
): MidFeatures {
  const tObsMs = opts.tObsMs ?? (history.length ? history[history.length - 1]!.t : 0);
  const edgePips = f.gapPips - f.baseFee;
  const samples: number[] = [];
  for (let i = VOL5M_SAMPLES - 1; i >= 0; i--) {
    const m = midAtOrBefore(history, tObsMs - i * VOL5M_STEP_S * 1000);
    if (m !== undefined) samples.push(m);
  }
  const now = midAtOrBefore(history, tObsMs);
  const dir = opts.baseIsToken0 ? -f.gapSign : f.gapSign;
  const ret = (hS: number): number => {
    const past = midAtOrBefore(history, tObsMs - hS * 1000);
    if (now === undefined || past === undefined || !(now > 0) || !(past > 0) || dir === 0) return 0;
    return round(Math.log(now / past) * 1e4 * dir, 4);
  };
  return {
    edgePips,
    edgeSigma: edgeSigmaOf(edgePips, f.realizedVolBps),
    vol5mBps: round(realizedVol(samples), 4),
    ret12Bps: ret(12),
    ret36Bps: ret(36),
    ret900Bps: ret(900),
  };
}

/**
 * SPEC_v2 "Orientation": every training row comes from a USDC = token0 / WETH = token1 pool (baseIsToken0 = false).
 * gapSign and imbalance are token-order dependent (pool price = token1/token0, imbalance = token0 buy pressure), so for
 * an ETH = token0 pool they are mirrored into the training orientation before any MODEL input is built (Kev state,
 * tabular). Orientation-free fields (gapPips, edge*, sizeToDepth, vols, ret*Bps, nSwaps, arbShare) are unchanged.
 * baseIsToken0 undefined / false = already canonical (returned as is). Jev keeps the orientation-aware input.
 */
export function canonicalFeatures(f: Features, baseIsToken0?: boolean): Features {
  if (!baseIsToken0) return f;
  return { ...f, gapSign: f.gapSign === 0 ? 0 : -f.gapSign, imbalance: f.imbalance === 0 ? 0 : -f.imbalance };
}

/** SPEC_v2: edge in units of the 12 s move (realizedVolBps bps = realizedVolBps * 100 pips), floor 1 pip; 4 dp like ml build_v2.py. */
export const edgeSigmaOf = (edgePips: number, realizedVolBps: number): number => round(edgePips / Math.max(realizedVolBps * 100, 1), 4);

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
export type StateFormat = 'auto' | 'v4' | 'v5' | 'kev2';

/** JS toFixed with an explicit "+" unless negative (SPEC_v2 `sg`; "-0.00" for small negatives stays as JS prints it). */
const sg = (x: number, d: number): string => {
  const s = x.toFixed(d);
  return s.startsWith('-') ? s : '+' + s;
};

/**
 * Model v2 Kev state lines (SPEC_v2 "State text format kev2"), appended to the k-free base-fee text. Missing fields
 * (callers without a mid history) read as: edge from gapPips/baseFee/realizedVolBps, vol and trends 0. Present fields
 * are formatted as given (never recomputed), so the text matches ml/src/states.py features_to_state_kev2 byte for byte.
 */
export function kev2StateLines(f: Features): string[] {
  const edgeSigma = f.edgeSigma ?? edgeSigmaOf(f.edgePips ?? f.gapPips - f.baseFee, f.realizedVolBps);
  return [
    `edge_in_volatility: arb edge at the base fee is ${sg(edgeSigma, 2)} typical 12 s Binance moves.`,
    `cex_volatility_5m: ${(f.vol5mBps ?? 0).toFixed(2)} bps per interval over the last 5 minutes.`,
    `cex_trend: Binance moved ${sg(f.ret12Bps ?? 0, 2)} bps over 12 s, ${sg(f.ret36Bps ?? 0, 2)} bps over 36 s and ${sg(f.ret900Bps ?? 0, 2)} bps over 15 min in the arbitrage direction (positive = the gap is widening).`,
  ];
}

export function featuresToState(f: Features, opts: { baseIsToken0?: boolean; format?: StateFormat } = {}): string {
  const base = opts.baseIsToken0 === false ? 'token1 (ETH)' : 'token0 (ETH)';
  const poolVs = f.gapSign > 0 ? 'above' : f.gapSign < 0 ? 'below' : 'equal to';
  const gapPct = (f.gapPips / 1e4).toFixed(3);
  const feePct = (f.baseFee / 1e4).toFixed(2);
  if (opts.format === 'v4') return featuresToStateV4(f, base, poolVs, gapPct, feePct);
  if (opts.format === 'v5') return featuresToStateV4(f, base, poolVs, gapPct, feePct) + '\n' + liquidityStateLines(f).join('\n');
  if (opts.format === 'kev2') {
    // k-free: the base-fee wording of 'auto' (what the v1 adapter was trained on) + the three v2 lines.
    const { kBps: _k, arbFeePips: _fee, arbThresholdPips: _thr, ...kFree } = f;
    return featuresToState(kFree, { baseIsToken0: opts.baseIsToken0 }) + '\n' + kev2StateLines(f).join('\n');
  }
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
