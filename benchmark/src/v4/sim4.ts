/**
 * Benchmark v4 ("the AI decides the fee"; copy of v3's simulator src/v3/sim3.ts): one price window, seven MARKETS
 * (vanilla BASE_FEE pool + competitor pool each, equal liquidity), fresh anvil.
 *
 * v4 keeper (model pools ai / aiheur / aigated / aidz): NO gate. Every step the keeper asks the pool's model (Jev with
 * the v4 question + k-free state, or the heuristic) and posts its score; the pools have arbThresholdPips = 0 and
 * kMin = kDefault = 0, so k = kMax * p * c and a "no profitable arbitrage" answer means the base fee. The settler
 * grades every block with arb-direction flow (retail or arb), marking it out vs the CEX mid at the swap's block time.
 * aigated: Jev scores inverted from mid-window (calibration-gate arm). aidz (exploratory): the keeper emulates a
 * proposed contract-side dead-zone on p*c (posts p' = max(0, p*c - z)/(1 - z), c' = 1; the settler grades the raw p).
 *
 * Every price step t (one 1s kline) is three blocks:
 *   A_t keeper: settler calibration every M steps, then setAttestation on the 5 hooked pools. The attested oracle mid
 *       is what the keeper could know BEFORE the block: mid[t - keeperLag] (default lag 1 step). With probability
 *       missProb the keeper misses the step (no attestation on any pool; the previous one stays in force and ages).
 *       The keeper only has a turn on steps t % keeperEvery == 0 (default 1 = every step). On a turn, each pool's
 *       post goes through services/src/postPolicy.ts postDecision (the live keeper's rule): `last` = the state in
 *       force on-chain (last AttestationPosted), `now` = the k / JIT window setAttestation would store (the hook's
 *       demotion + kFromScore + maxKStep replicated from poolConfig; every posted k is checked against the event).
 *       postMode 'every' (default) posts on every turn = the original benchmark. Every setAttestation's gasUsed is
 *       read from its receipt (txs go at gasPrice 0; gasUsed does not depend on it) for the keeper-cost accounting.
 *   B_t arbitrage vs the TRUE mid[t]: two competing arbitrageurs with their own CEX taker fee and gas cost; per step
 *       a random priority order and an independent "late" draw per arb (shared by all pools = common random numbers).
 *       On each pool the first on-time arb whose profit (net of CEX fee and gas) exceeds minProfit trades to ITS
 *       no-trade band edge at the hook-quoted fee (quoteFee on the pending block); only one arb per pool per step.
 *   C_t retail: seeded orders (Poisson count, lognormal heavy-tailed USD size, autocorrelated direction, a small
 *       informed fraction that trades the sign of the mid move over the next H steps). The SAME orders hit every
 *       market; in each market an order is routed between the two pools by the best execution (quoted fee + price
 *       impact): optimal split, or the single better pool when the smaller leg would be < minSplitFrac.
 * All txs come from one EOA in nonce order, blocks are mined manually => deterministic.
 *
 * Mainnet block mode (cfg.blockMode, default off => the 1 s loop above, unchanged): time advances in 12 s blocks and
 * everything of a block happens at its timestamp s (mid[s] for arbs, retail and the LP mark); nothing trades between
 * blocks. Per block: K_b (settler; coop keeper post) and S_b (arbs, then retail in the SAME anvil block, so retail
 * after an arb pays the hook's per-block high-water fee; realistic keeper post last). Keeper placement:
 *   realistic: the post lands at the END of the previous block (no builder deal): it reads Binance at s - 13 and the
 *              chain before that block is built (pool state and swaps up to block b-1), prices block b+1.
 *   coop     : a cooperating builder puts the post FIRST in the block: Binance read at s - 2, chain after block b-1.
 * Retail arrives at lambda per second (Poisson(12 lambda) per block), informedHorizon is in seconds. Staleness and
 * the heartbeat count 2 anvil blocks per mainnet block. Tabular pools (cfg.tabularPools, block mode only) score with
 * the in-process LightGBM (services/src/model/tabular.ts) on the features the live keeper computes: a MidHistory
 * with one CEX read per block (pre-filled from cfg.warmupMids, the 1 s mids before the window), recentMids = its last
 * 120 entries, the 20-block swap window, canonical orientation; then the keeper's charge gate at the model JSON's
 * chargeThreshold (services/src/keeper.ts applyChargeThreshold).
 */
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, maxUint256, createPublicClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { signAttestation, resolveAttestDomain } from '../../../services/src/attest.js';
import { computeFeatures, type SwapObs } from '../../../services/src/features.js';
import { labelBlocks, calibrate } from '../../../services/src/settler.js';
import type { ReceiptLog } from '../../../services/src/chain.js';
import { poolStateSlot } from '../../../services/src/chain.js';
import { midToPriceX96, Q96 } from '../../../services/src/price.js';
import { planArb } from '../../../services/src/bots/arbMath.js';
import { ACTOR, ATTESTOR_PK, Anvil } from '../chain.js';
import { loadAbi, lognormal, log, poisson, rng, type Rpc } from '../util.js';
import { HOOKED, MARKETS, MODEL_POOLS, NODES, POOLS, deployV4, type DeploymentV4, type Hooked, type ModelPool, type Pool } from './chain4.js';
import type { PathV2 } from '../v2/windows.js';
import { ScorerV4, heuristicV4, type SourceV4 } from './scorer4.js';
import { postDecision, type PostMode, type PostReason, type PostedState } from '../../../services/src/postPolicy.js';
import { canonicalFeatures, type MidObs } from '../../../services/src/features.js';
import { loadTabularModel, scoreTabular, type TabularModel } from '../../../services/src/model/tabular.js';
import { applyChargeThreshold } from '../../../services/src/keeper.js';

/** services/src/keeper.ts: MidHistory(1_000), RECENT_MIDS = 120, computeFeatures default windowBlocks = 20. */
const KEEPER_MID_HISTORY = 1_000;
const KEEPER_RECENT_MIDS = 120;
const KEEPER_WINDOW_BLOCKS = 20;

export interface ArbSpec {
  cexBps: number;
  gasUsd: number;
}

export interface RunConfigV4 {
  label: string;
  path: PathV2;
  split: number;
  jevMode: 'jev' | 'heuristic';
  jevBudget: number;
  port: number;
  seed: number;
  tvlUsd: number;
  keeperLag: number;
  missProb: number;
  arbs: ArbSpec[];
  arbLateProb: number;
  minProfitUsd: number;
  lambda: number;
  retailMedianUsd: number;
  retailSigma: number;
  retailCapUsd: number;
  dirAutocorr: number;
  informedFrac: number;
  informedHorizon: number;
  routing: 'split' | 'best';
  minSplitFrac: number;
  degradeAtFrac: number;
  settleEvery: number;
  calibWindow: number;
  calibMinN: number;
  staleSteps: number;
  labelMid: 'attested' | 'true';
  bucketSteps: number;
  /** base fee of every pool (vanilla fee tier = hooked baseFee), pips */
  baseFee: number;
  /** arbThresholdPips of the hard-coded threshold reference arm (b, thrk); every other hooked pool has 0 */
  thrPips: number;
  /** AI pools: kMax, maxKStep, kDefault (kMin = 0, threshold 0) */
  aiKMax: number;
  aiKStep: number;
  aiKDefault: number;
  /** aidz (exploratory): dead-zone on p*c in bps (k = kMax * max(0, pc - z) / (1 - z)) */
  dzBps: number;
  /** settler label: 'base' (v4: profitable at the base fee = the Jev question) | 'paid' (pre-v4: net of the fee paid) */
  labelFee: 'base' | 'paid';
  /** settler dead band (services default $1 / 1 bp; the frozen results_v4 runs used 0 / 0 = sign-only labels) */
  deadbandUsd: number;
  deadbandBps: number;
  /**
   * Keeper post policy (services/src/postPolicy.ts, the live keeper's rule). Optional so older configs / raw JSON
   * still load; unset = 'every' (post on every keeper turn: the original benchmark).
   */
  postMode?: PostMode;
  postMidBps?: number;
  postKBps?: number;
  postJitBlocks?: number;
  postPBps?: number;
  /** heartbeat in chain blocks; unset = the pool's staleBlocks - 1 (3 sim blocks per step) */
  heartbeatBlocks?: number;
  /**
   * Keeper cadence in steps (default 1): the keeper only gets a turn on steps t % keeperEvery == 0 (e.g. 12 = one
   * post opportunity per 12 s mainnet block); the attestation then stays in force for the steps in between. Arbs and
   * retail still act every 1 s step. Needs staleSteps > keeperEvery or the pool goes stale between turns.
   */
  keeperEvery?: number;
  /** keeper cost accounting only (txs are still sent at gasPrice 0; gasUsed is read from the receipts) */
  keeperGasGwei?: number;
  /** USD per ETH for keeper gas; unset = the window's mean mid for ETH windows, 2500 otherwise */
  ethUsd?: number;
  /**
   * Mainnet block mode (header). Unset = the 1 s loop. settleEvery and staleSteps are then in blocks, keeperLag /
   * keeperEvery are unused, heartbeatBlocks is in anvil blocks (2 per mainnet block).
   */
  blockMode?: { placement: 'realistic' | 'coop'; blockSec?: number; midAgeSec?: number };
  /** 1 s mids before the window (oldest first), for the keeper's MidHistory warm-up in block mode (not saved). */
  warmupMids?: number[];
  /** Model pools scored by a tabular LightGBM JSON (block mode only); gate = the keeper's charge gate at chargeThreshold. */
  tabularPools?: Partial<Record<ModelPool, { path: string; gate: boolean }>>;
}

/** Per tabular pool: keeper decisions and the settler-graded selective metrics at the model's charge threshold. */
export interface TabularDiag {
  model: string;
  path: string;
  gate: boolean;
  threshold: number;
  decisions: number;
  /** decisions with p >= threshold */
  charged: number;
  meanP: number;
  edgePosShare: number;
  meanGapPips: number;
  meanEdgeSigma: number;
  meanAbsRet12Bps: number;
  meanRealizedVolBps: number;
  meanNSwaps: number;
  fallback: number;
  /** settler labels (same labelBlocks call as the calibration) of the blocks graded for this pool: [p in force, y] */
  pairs: [number, number][];
}

export interface PoolTotals {
  lpMinusHodl: number;
  lpFees: number;
  arbFees: number;
  retailFees: number;
  retailCost: number;
  retailVol: number;
  arbVol: number;
  nArb: number;
  arbSubSwaps: number;
  arbProfit: number; // value to the arb at the true mid (LVR proxy), before CEX fee / gas
  arbNet: number; // after CEX fee and gas
  meanArbFeePips: number | null;
  meanRetailFeePips: number | null;
  meanK: number | null;
  staleSteps: number;
}

/** Per-bucket (bucketSteps) series, used for within-window block bootstrap. */
export interface PoolBuckets {
  dLp: number[];
  retailCost: number[];
  retailVol: number[];
  arbProfit: number[];
}

export interface CalibPost {
  step: number;
  pool: Hooked;
  brierBps: number;
  n: number;
  ok: boolean;
}

export interface RunResultV4 {
  label: string;
  windowId: string;
  asset: string;
  regime: string;
  vol1mBps: number;
  variant: string;
  config: Omit<RunConfigV4, 'path'> & { steps: number; startIso: string; initialMid: number; finalMid: number; liquidity: string };
  initialTvlUsd: number;
  degradeAtStep: number;
  totals: Record<Pool, PoolTotals>;
  buckets: Record<Pool, PoolBuckets>;
  /**
   * Model pools: share of k records (steps in the 1 s loop, blocks in block mode) with k forced to kDefault by Brier
   * demotion, by half (t < degradeAt vs after); activeAtStep = first record with the node not demoted.
   * seasonedAtStep: runs saved before PR #5 (probation removed) carry this instead of activeAtStep: the first record
   * with the node past probation (n >= minSamples) and not demoted.
   */
  demoted: Record<ModelPool, { firstHalf: number; secondHalf: number; activeAtStep: number | null; seasonedAtStep?: number | null }>;
  /**
   * 'records': demoted.* is divided by the number of k records in each half. Absent (block-mode runs saved before this
   * field existed): divided by the half's length in seconds, i.e. blockSec x too small in block mode.
   */
  demotedDenom?: 'records';
  /** v4: model pools' attested steps (the model is asked on every one) and steps with stored k = 0 (fee = base) */
  kZero: Record<Hooked, { zero: number; low: number; steps: number }>;
  /** mean p*c (bps) posted by each model pool, by regime of the underlying gap: edge > 0 (gap > base fee) vs edge <= 0 */
  scoreByEdge: Record<ModelPool, { posPc: number; posN: number; negPc: number; negN: number }>;
  /** arb swaps on hooked pools that paid exactly baseFee vs all arbs */
  arbAtBase: Record<Hooked, { atBase: number; n: number }>;
  kBuckets: Record<Hooked, number[]>;
  labelDiag: Record<ModelPool, { n: number; baseRate: number; meanP: number; meanPwhenY1: number; meanPwhenY0: number; brier: number; nArbBlocks: number; baseRateArbBlocks: number }>;
  calibrations: CalibPost[];
  missedPosts: number;
  arbWins: number[];
  retailOrders: number;
  retailUsd: number;
  jev: { mode: string; calls: number; failures: number; retries: number; counts: Record<SourceV4, number>; fallbackShare: number; p50LatencyMs: number | null };
  reverts: { label: string; pool?: string; step: number }[];
  txCount: number;
  runtimeSec: number;
  /** keeper posts per hooked pool: setAttestation receipts (gasUsed is independent of the 0 gas price) */
  blockMode?: { placement: 'realistic' | 'coop'; blockSec: number; midAgeSec: number; blocks: number; retailAfterArbQuotes: number; retailQuoteChangedByArb: number };
  tabular?: Partial<Record<ModelPool, TabularDiag>>;
  keeper?: {
    policy: { mode: PostMode; midBps: number; kStepBps: number; jitStepBlocks: number; pStepBps: number; heartbeatBlocks: number };
    keeperEvery: number;
    gasGwei: number;
    ethUsd: number;
    /** keeper turns that were not missed (decisions taken), per pool = the same for every pool */
    decisions: number;
    /** keeper turns including missed ones (= ceil(T / keeperEvery)) */
    turns: number;
    pools: Record<Hooked, { posts: number; gas: number; reverted: number; reasons: Partial<Record<PostReason, number>>; kPredictMiss: number }>;
  };
}

type TxMeta = { label: 'attest' | 'calib' | 'arb' | 'retail' | 'approve'; pool?: Pool };
type Tx = { to: Address; data: Hex; gas: number; meta: TxMeta };

interface PoolRt {
  name: Pool;
  id: Hex;
  key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
  hooked: boolean;
  sqrtP: bigint;
  L: bigint;
  fg0: bigint;
  fg1: bigint;
  sqrtLo: number;
  sqrtHi: number;
  x0: number;
  y0: number;
  hist: SwapObs[];
  receipts: ReceiptLog[];
  lastAttestBlock: number;
  kBps: number;
  /** what is in force on-chain (from the last AttestationPosted event) */
  posted: PostedState | undefined;
  pInForce: number | undefined;
  pAtBlock: Map<number, number>;
  prevLmh: number;
  prevFees: { base: number; quote: number };
  tot: PoolTotals;
  bk: PoolBuckets;
  arbFeeSum: number;
  retailFeeW: number;
  kSum: number;
  kN: number;
}

const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
const nodeOf = (n: Hooked): Hex => (n === 'ai' ? NODES.ai : n === 'aiheur' ? NODES.aiheur : n === 'aigated' ? NODES.aigated : n === 'aidz' ? NODES.aidz : NODES.const);
const isModel = (n: Hooked): n is ModelPool => (MODEL_POOLS as readonly string[]).includes(n);
/** Stream-separated seeded RNG: (seed, step, purpose) -> independent sequence. */
const stream = (seed: number, t: number, purpose: number) => rng((seed * 1_000_003 + t * 2_654_435_761 + purpose * 97_531) >>> 0);

const emptyTotals = (): PoolTotals => ({
  lpMinusHodl: 0,
  lpFees: 0,
  arbFees: 0,
  retailFees: 0,
  retailCost: 0,
  retailVol: 0,
  arbVol: 0,
  nArb: 0,
  arbSubSwaps: 0,
  arbProfit: 0,
  arbNet: 0,
  meanArbFeePips: null,
  meanRetailFeePips: null,
  meanK: null,
  staleSteps: 0,
});

/** Constant-product (single full-range position) exact-input output with fee f on the input. */
const cpOut = (a: number, rin: number, rout: number, f: number) => (rout * a * (1 - f)) / (rin + a * (1 - f));

/** Optimal split of input X between two CP pools (marginal outputs equal), clamped to [0, X]. Returns amount to pool 1. */
function optimalSplit(X: number, p1: { rin: number; rout: number; f: number }, p2: { rin: number; rout: number; f: number }): number {
  const g1 = 1 - p1.f;
  const g2 = 1 - p2.f;
  const c1 = Math.sqrt(g1 * p1.rin * p1.rout);
  const c2 = Math.sqrt(g2 * p2.rin * p2.rout);
  const x = (c1 * p2.rin + c1 * g2 * X - c2 * p1.rin) / (c2 * g1 + c1 * g2);
  return Math.max(0, Math.min(X, x));
}

export async function runOneV4(cfg: RunConfigV4): Promise<RunResultV4> {
  const t0 = Date.now();
  const { path } = cfg;
  const mids = path.mids;
  const T = mids.length;
  const anvil = new Anvil(cfg.port);
  const hookAbi = loadAbi('OniblockHook');
  const pmAbi = loadAbi('PoolManager');
  const routerAbi = loadAbi('SplitSwapRouter');
  const erc20Abi = loadAbi('ERC20');
  const reverts: RunResultV4['reverts'] = [];
  const calibrations: CalibPost[] = [];
  let txCount = 0;
  const liquidity = BigInt(Math.round(cfg.tvlUsd / (2e-12 * Math.sqrt(mids[0]!))));
  const assetTag = path.window.asset.startsWith('BTC') ? 'BTC' : 'ETH';

  await anvil.start();
  try {
    const d: DeploymentV4 = await deployV4(anvil, {
      initMid: mids[0]!,
      liquidity,
      staleBlocks: cfg.staleSteps * (cfg.blockMode ? 2 : 3),
      baseFee: cfg.baseFee,
      thrPips: cfg.thrPips,
      aiKMax: cfg.aiKMax,
      aiKStep: cfg.aiKStep,
      aiKDefault: cfg.aiKDefault,
    });
    const rpc: Rpc = anvil.rpc;
    const baseIsToken0 = d.wethIsToken0;
    const meta = { baseIsToken0, decimals0: baseIsToken0 ? 18 : 6, decimals1: baseIsToken0 ? 6 : 18 };
    const toHuman = (a0: bigint, a1: bigint) =>
      baseIsToken0 ? { base: Number(a0) / 1e18, quote: Number(a1) / 1e6 } : { base: Number(a1) / 1e18, quote: Number(a0) / 1e6 };
    const X96 = (mid: number) => midToPriceX96(mid.toFixed(8), meta);
    const attestor = privateKeyToAccount(ATTESTOR_PK);
    const pc = createPublicClient({ transport: http(anvil.url) });
    const domain = await resolveAttestDomain(pc as never, d.hook, { name: 'Oniblock' });
    // one Jev scorer (shared cache + budget) for the three Jev pools; the states are k-free, so they overlap heavily
    const jevScorer = new ScorerV4(cfg.jevMode, cfg.jevBudget, T, baseIsToken0, assetTag);
    const degradeAt = Math.floor(T * cfg.degradeAtFrac);
    const nB = Math.ceil(T / cfg.bucketSteps);

    const pools = {} as Record<Pool, PoolRt>;
    for (const name of POOLS) {
      const pj = d.pools[name];
      const ts = Number(pj.tickSpacing);
      const maxTick = Math.floor(887272 / ts) * ts;
      pools[name] = {
        name,
        id: pj.poolId,
        key: { currency0: d.currency0, currency1: d.currency1, fee: Number(pj.fee), tickSpacing: ts, hooks: pj.hooks },
        hooked: pj.hooked,
        sqrtP: 0n,
        L: 0n,
        fg0: 0n,
        fg1: 0n,
        sqrtLo: Math.pow(1.0001, -maxTick / 2),
        sqrtHi: Math.pow(1.0001, maxTick / 2),
        x0: 0,
        y0: 0,
        hist: [],
        receipts: [],
        lastAttestBlock: 0,
        kBps: pj.kDefaultBps !== undefined ? Number(pj.kDefaultBps) : 5000,
        posted: undefined,
        pInForce: undefined,
        pAtBlock: new Map(),
        prevLmh: 0,
        prevFees: { base: 0, quote: 0 },
        tot: emptyTotals(),
        bk: { dLp: new Array(nB).fill(0), retailCost: new Array(nB).fill(0), retailVol: new Array(nB).fill(0), arbProfit: new Array(nB).fill(0) },
        arbFeeSum: 0,
        retailFeeW: 0,
        kSum: 0,
        kN: 0,
      };
    }

    // ---- keeper post policy: replicate the hook's setAttestation k / JIT window from the on-chain pool config, so
    // `now` in postDecision is exactly what a post would put in force (checked against every AttestationPosted k).
    const hcfg = {} as Record<Hooked, { kMin: number; kMax: number; kDefault: number; maxKStep: number; staleBlocks: number; brierDemote: number; jitMin: number; jitDefault: number }>;
    for (const n of HOOKED) {
      const c = (await pc.readContract({ address: d.hook, abi: hookAbi, functionName: 'poolConfig', args: [pools[n].id] })) as Record<string, number | bigint>;
      hcfg[n] = {
        kMin: Number(c.kMinBps),
        kMax: Number(c.kMaxBps),
        kDefault: Number(c.kDefaultBps),
        maxKStep: Number(c.maxKStepBps),
        staleBlocks: Number(c.staleBlocks),
        brierDemote: Number(c.brierDemoteBps),
        jitMin: Number(c.jitWindowMin),
        jitDefault: Number(c.jitWindowDefault),
      };
      pools[n].kBps = hcfg[n].kDefault; // _afterInitialize: st.kBps = kDefault
    }
    const keeperEvery = Math.max(1, Math.round(cfg.keeperEvery ?? 1));
    const policy = {
      mode: cfg.postMode ?? ('every' as PostMode),
      midBps: cfg.postMidBps ?? 2,
      kStepBps: cfg.postKBps ?? 500,
      jitStepBlocks: cfg.postJitBlocks ?? 5,
      pStepBps: cfg.postPBps ?? 1000,
      heartbeatBlocks: cfg.heartbeatBlocks ?? hcfg.ai.staleBlocks - 1,
    };
    const ethUsd = cfg.ethUsd ?? (assetTag === 'ETH' ? mids.reduce((a, b) => a + b, 0) / T : 2500);
    const kp = Object.fromEntries(HOOKED.map((n) => [n, { posts: 0, gas: 0, reverted: 0, reasons: {} as Partial<Record<PostReason, number>>, kPredictMiss: 0 }])) as NonNullable<
      RunResultV4['keeper']
    >['pools'];
    const bm = cfg.blockMode;
    if (cfg.tabularPools && !bm) throw new Error('tabularPools needs blockMode (the v2 features assume one CEX read per 12 s block)');
    const tabular = {} as Partial<Record<ModelPool, { model: TabularModel; path: string; gate: boolean; threshold: number }>>;
    const tabDiag = {} as Partial<Record<ModelPool, { decisions: number; charged: number; sumP: number; edgePos: number; sumGap: number; sumEdgeSigma: number; sumAbsRet12: number; sumVol: number; sumNSwaps: number; fallback: number }>>;
    for (const [n, spec] of Object.entries(cfg.tabularPools ?? {}) as [ModelPool, { path: string; gate: boolean }][]) {
      const m = loadTabularModel(spec.path);
      if (!m) throw new Error(`tabular model not found: ${spec.path}`);
      if (typeof m.chargeThreshold !== 'number') throw new Error(`tabular model ${spec.path} has no chargeThreshold`);
      tabular[n] = { model: m, path: spec.path, gate: spec.gate, threshold: m.chargeThreshold };
      tabDiag[n] = { decisions: 0, charged: 0, sumP: 0, edgePos: 0, sumGap: 0, sumEdgeSigma: 0, sumAbsRet12: 0, sumVol: 0, sumNSwaps: 0, fallback: 0 };
    }
    /** block mode: blocks, blocks with a post-arb retail quote (trial), of which a hooked pool's quote changed */
    const blockStats = { blocks: 0, trials: 0, quoteChanged: 0 };
    let keeperTurns = 0;
    let keeperDecisions = 0;
    const predictedK = new Map<Hooked, number>();

    // ---- tx plumbing
    let nonce = Number(await rpc.call<string>('eth_getTransactionCount', [ACTOR, 'pending']));
    let head = Number(await rpc.call<string>('eth_blockNumber'));
    const sendAndMine = async (txs: Tx[], step: number) => {
      const res = await rpc.batchSettled<Hex>(
        txs.map((tx) => ['eth_sendTransaction', [{ from: ACTOR, to: tx.to, data: tx.data, gas: hex(tx.gas), gasPrice: '0x0', nonce: hex(nonce++) }]]),
      );
      const byHash = new Map<string, TxMeta>();
      let resync = false;
      res.forEach((r, i) => {
        if ('error' in r) {
          reverts.push({ label: `send:${txs[i]!.meta.label}`, pool: txs[i]!.meta.pool, step });
          if (reverts.length <= 20) log('send_error', { step, label: txs[i]!.meta.label, pool: txs[i]!.meta.pool, error: r.error });
          resync = true;
        } else byHash.set(r.result.toLowerCase(), txs[i]!.meta);
      });
      await rpc.call('evm_mine');
      head++;
      if (resync) nonce = Number(await rpc.call<string>('eth_getTransactionCount', [ACTOR, 'pending']));
      txCount += txs.length;
      const rcs = txs.length ? await rpc.call<any[]>('eth_getBlockReceipts', [hex(head)]) : [];
      for (const rc of rcs) {
        if (rc.status !== '0x1') {
          const m = byHash.get(rc.transactionHash.toLowerCase());
          reverts.push({ label: m?.label ?? '?', pool: m?.pool, step });
          if (reverts.length <= 20) log('tx_reverted', { step, label: m?.label, pool: m?.pool, hash: rc.transactionHash });
        }
      }
      return { rcs, byHash };
    };

    const readStates = async () => {
      const res = await rpc.batch<Hex>(
        POOLS.map((n) => [
          'eth_call',
          [{ to: d.poolManager, data: encodeFunctionData({ abi: pmAbi, functionName: 'extsload', args: [poolStateSlot(pools[n].id), 4n] }) }, 'latest'],
        ]),
      );
      POOLS.forEach((n, i) => {
        const w = decodeFunctionResult({ abi: pmAbi, functionName: 'extsload', data: res[i]!, args: [poolStateSlot(pools[n].id), 4n] } as never) as unknown as Hex[];
        const p = pools[n];
        p.sqrtP = BigInt(w[0]!) & ((1n << 160n) - 1n);
        p.fg0 = BigInt(w[1]!);
        p.fg1 = BigInt(w[2]!);
        p.L = BigInt(w[3]!) & ((1n << 128n) - 1n);
      });
    };

    /** Fee each hooked pool would charge in each direction for the first swap of the NEXT block ('pending'). */
    const quoteNext = async (tag: 'pending' | 'latest' = 'pending') => {
      const reqs: [string, unknown[]][] = [];
      for (const n of HOOKED)
        for (const zfo of [true, false])
          reqs.push(['eth_call', [{ to: d.hook, data: encodeFunctionData({ abi: hookAbi, functionName: 'quoteFee', args: [pools[n].key, zfo] }) }, tag]]);
      const res = await rpc.batch<Hex>(reqs);
      const q = {} as Record<Hooked, { t: number; f: number; stale: boolean }>;
      HOOKED.forEach((n, i) => {
        const dec = (h: Hex) => decodeFunctionResult({ abi: hookAbi, functionName: 'quoteFee', data: h }) as unknown as [number | bigint, boolean, number | bigint, boolean];
        const a = dec(res[2 * i]!);
        const b = dec(res[2 * i + 1]!);
        q[n] = { t: Number(a[0]), f: Number(b[0]), stale: a[3] };
      });
      return q;
    };
    const feeFor = (n: Pool, zfo: boolean, q: Record<Hooked, { t: number; f: number }>) =>
      pools[n].hooked ? (zfo ? q[n as Hooked].t : q[n as Hooked].f) : pools[n].key.fee;

    const lpAmounts = (p: PoolRt) => {
      const s = Number(p.sqrtP) / 2 ** 96;
      const L = Number(p.L);
      const x = L * (1 / s - 1 / p.sqrtHi);
      const y = L * (s - p.sqrtLo);
      const f0 = Number((p.fg0 * p.L) >> 128n);
      const f1 = Number((p.fg1 * p.L) >> 128n);
      const pos = baseIsToken0 ? { base: x / 1e18, quote: y / 1e6 } : { base: y / 1e18, quote: x / 1e6 };
      const fees = baseIsToken0 ? { base: f0 / 1e18, quote: f1 / 1e6 } : { base: f1 / 1e18, quote: f0 / 1e6 };
      return { pos, fees };
    };

    // ---- setup
    await sendAndMine(
      [d.currency0, d.currency1].map((t) => ({
        to: t,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [d.splitSwapRouter, maxUint256] }),
        gas: 100_000,
        meta: { label: 'approve' as const },
      })),
      -1,
    );
    await readStates();
    let initialTvlUsd = 0;
    for (const n of POOLS) {
      const { pos } = lpAmounts(pools[n]);
      pools[n].x0 = pos.base;
      pools[n].y0 = pos.quote;
      if (n === 'v_control_a') initialTvlUsd = pos.base * mids[0]! + pos.quote;
    }

    const stepOfBlock = new Map<number, number>();
    const bBlocks = new Set<number>();
    const attMidAtBlock = new Map<number, bigint>();
    let attMidInForce: bigint | undefined;
    const nodeCalib: Record<string, { brier: number; n: number }> = {};
    const demoteBps = Number(d.pools.ai.brierDemoteBps ?? 2500);
    const kZero = Object.fromEntries(HOOKED.map((n) => [n, { zero: 0, low: 0, steps: 0 }])) as Record<Hooked, { zero: number; low: number; steps: number }>;
    const scoreByEdge = Object.fromEntries(MODEL_POOLS.map((n) => [n, { posPc: 0, posN: 0, negPc: 0, negN: 0 }])) as RunResultV4['scoreByEdge'];
    const arbAtBase = Object.fromEntries(HOOKED.map((n) => [n, { atBase: 0, n: 0 }])) as Record<Hooked, { atBase: number; n: number }>;
    const isDemoted = (n: Hooked) => {
      const c = nodeCalib[nodeOf(n)];
      return c !== undefined && c.n > 0 && demoteBps > 0 && c.brier > demoteBps; // allowlist + Brier only: no record => active
    };
    /**
     * OniblockHook._demoted(id, node, node) with the calibration the settler has posted (all models allowlisted):
     * demoted iff brierDemoteBps > 0 AND a record exists (n > 0) AND its Brier exceeds the threshold. No record =>
     * active (no probation since PR #5).
     */
    const hookDemoted = (n: Hooked) => {
      const c = nodeCalib[nodeOf(n)];
      const nn = c?.n ?? 0;
      return hcfg[n].brierDemote !== 0 && nn !== 0 && c!.brier > hcfg[n].brierDemote;
    };
    /** The k setAttestation would store for score (p, c): kDefault if demoted, else step-limited toward kFromScore. */
    const hookK = (n: Hooked, pBps: number, cBps: number) => {
      const h = hcfg[n];
      if (hookDemoted(n)) return h.kDefault;
      const target = h.kMin + Math.floor(((h.kMax - h.kMin) * Math.min(pBps, 10_000) * Math.min(cBps, 10_000)) / 1e8);
      const cur = pools[n].kBps;
      return target > cur ? Math.min(target, cur + h.maxKStep) : Math.max(target, cur - h.maxKStep);
    };
    /**
     * jitWindowFromScore with pJit = 0: no JIT head in the benchmark, so the JIT calibration key is never written
     * (n = 0) and, the parent being allowlisted, isJitDemoted is false => window = jitWindowMin + span * 0 = jitWindowMin.
     */
    const hookJit = (n: Hooked) => hcfg[n].jitMin;
    const demCount = Object.fromEntries(MODEL_POOLS.map((n) => [n, { a: 0, b: 0, active: null as number | null }])) as Record<(typeof MODEL_POOLS)[number], { a: number; b: number; active: number | null }>;
    const demRecords = { a: 0, b: 0 }; // k records per half: one per step (1 s loop) or per block (block mode)
    const kBk = Object.fromEntries(HOOKED.map((n) => [n, new Array(nB).fill(0)])) as Record<Hooked, number[]>;
    let missedPosts = 0;
    const arbWins = new Array(cfg.arbs.length).fill(0);
    let retailOrders = 0;
    let retailUsd = 0;
    let lastBuy = true;

    // USD per raw token1 at a block (quote = mUSDC, 6 decimals): token1 is the quote iff baseIsToken0
    const usdPerRaw1 = (b: number): number | undefined => {
      if (baseIsToken0) return 1e-6;
      const st = stepOfBlock.get(b);
      return st === undefined ? undefined : 1e-6 / (Number(X96(mids[st]!)) / Number(Q96));
    };
    const calibFor = (p: PoolRt, uptoBlock: number) => {
      const rs = p.receipts.filter((r) => r.blockNumber < uptoBlock);
      const labels = labelBlocks(
        rs,
        (b) => {
          if (cfg.labelMid === 'attested') return attMidAtBlock.get(b);
          const s = stepOfBlock.get(b);
          return s === undefined ? undefined : X96(mids[s]!);
        },
        (r) => p.pAtBlock.get(r.blockNumber),
        { labelFee: cfg.labelFee, baseFeePips: cfg.baseFee, deadbandUsd: cfg.deadbandUsd, deadbandBps: cfg.deadbandBps, usdPerRawToken1: (b) => usdPerRaw1(b) },
      );
      return calibrate(labels, cfg.calibWindow, 'raw')[0];
    };

    /** Decode PoolManager Swap + hook Receipt logs of one block into per-pool accumulators. */
    const byId = new Map(POOLS.map((n) => [pools[n].id.toLowerCase(), n]));
    const parseBlock = (rb: { rcs: any[]; byHash: Map<string, TxMeta> }, mid: number, onSwap: (n: Pool, label: string, h: { base: number; quote: number }, feePips: number) => void) => {
      for (const rc of rb.rcs) {
        const m = rb.byHash.get(rc.transactionHash.toLowerCase());
        for (const lg of rc.logs as { address: string; topics: Hex[]; data: Hex }[]) {
          const addr = lg.address.toLowerCase();
          if (addr === d.poolManager.toLowerCase()) {
            let ev: { eventName: string; args: any };
            try {
              ev = decodeEventLog({ abi: pmAbi, data: lg.data, topics: lg.topics as [Hex, ...Hex[]] }) as never;
            } catch {
              continue;
            }
            if (ev.eventName !== 'Swap') continue;
            const n = byId.get(String(ev.args.id).toLowerCase());
            if (!n) continue;
            onSwap(n, m?.label ?? '?', toHuman(ev.args.amount0 as bigint, ev.args.amount1 as bigint), Number(ev.args.fee));
          } else if (addr === d.hook.toLowerCase()) {
            let ev: { eventName: string; args: any };
            try {
              ev = decodeEventLog({ abi: hookAbi, data: lg.data, topics: lg.topics as [Hex, ...Hex[]] }) as never;
            } catch {
              continue;
            }
            if (ev.eventName !== 'Receipt') continue;
            const n = byId.get(String(ev.args.id).toLowerCase());
            if (!n) continue;
            const r: ReceiptLog = {
              poolId: ev.args.id,
              blockNumber: Number(ev.args.blockNumber),
              sender: ev.args.sender,
              zeroForOne: ev.args.zeroForOne,
              arbDir: ev.args.arbDir,
              gapPips: Number(ev.args.gapPips),
              kBps: Number(ev.args.kBps),
              feePips: Number(ev.args.feePips),
              amount0: ev.args.amount0,
              amount1: ev.args.amount1,
              modelNode: ev.args.modelNode,
              stale: ev.args.stale,
              txHash: rc.transactionHash,
              logIndex: 0,
            };
            const p = pools[n];
            p.receipts.push(r);
            if (p.receipts.length > 3000) p.receipts.splice(0, p.receipts.length - 3000);
            p.hist.push({ block: r.blockNumber, zeroForOne: r.zeroForOne, amount0: r.amount0, amount1: r.amount1, fee: r.feePips, arbDir: r.arbDir });
          }
        }
      }
      void mid;
    };

    log('run_start', { label: cfg.label, steps: T, split: cfg.split, jev: cfg.jevMode, degradeAt, tvlUsd: Math.round(initialTvlUsd), L: liquidity.toString() });

    // ------------------------------------------------------------------ step pieces shared by the 1 s loop and block mode
    type Scores = Partial<Record<Hooked, { p: number; c: number; pRaw: number; source: string; node: Hex }>>;
    /** Settler: setCalibration txs for the model nodes (labels of blocks < A). */
    const calibTxs = (t: number, A: number): Tx[] => {
      const txs: Tx[] = [];
      for (const n of MODEL_POOLS) {
        const c = calibFor(pools[n], A);
        if (!c || c.n < cfg.calibMinN) continue;
        txs.push({
          to: d.hook,
          data: encodeFunctionData({ abi: hookAbi, functionName: 'setCalibration', args: [nodeOf(n), c.brierBps, c.hitRateBps, c.n] }),
          gas: 200_000,
          meta: { label: 'calib', pool: n },
        });
        calibrations.push({ step: t, pool: n, brierBps: c.brierBps, n: c.n, ok: true });
        nodeCalib[nodeOf(n)] = { brier: c.brierBps, n: c.n };
      }
      return txs;
    };
    /**
     * One keeper decision on every hooked pool: score (model pools), then the post policy; returns the signed
     * setAttestation txs (attestation blockNumber A = the block they are mined in). `mf` (block mode): the keeper's
     * time-stamped CEX history + read time for the v2 features of the tabular pools (as services/src/keeper.ts).
     */
    const keeperTurn = async (A: number, t: number, Mk: bigint, recentMids: number[], mf?: { hist: MidObs[]; tObsMs: number; windowBlocks: number }) => {
      const scores: Scores = {};
      const txs: Tx[] = [];
      for (const n of HOOKED) {
        const p = pools[n];
        if (!isModel(n)) {
          scores[n] = { p: 10_000, c: 10_000, pRaw: 10_000, source: '', node: nodeOf(n) };
          continue;
        }
        const tab = tabular[n];
        if (tab && mf) {
          // model v2 (in-process LightGBM): features exactly as the live keeper computes them (MidHistory of one read
          // per block, recentMids = its last 120 mids, 20-block swap window), canonicalised to the training
          // orientation (model/index.ts score() for MODEL_MODE=tabular), then the charge gate (keeper.ts).
          const f = computeFeatures({
            swaps: p.hist,
            oracleX96: Mk,
            poolX96: (p.sqrtP * p.sqrtP) / Q96,
            depth0: p.sqrtP > 0n ? (p.L * Q96) / p.sqrtP : 0n,
            recentMids: mf.hist.slice(-KEEPER_RECENT_MIDS).map((x) => x.mid),
            midHistory: mf.hist,
            tObsMs: mf.tObsMs,
            currentBlock: A - 1,
            lastAttestBlock: p.lastAttestBlock || A - 1,
            baseFee: cfg.baseFee,
            windowBlocks: mf.windowBlocks,
            baseIsToken0,
          });
          const raw = scoreTabular(canonicalFeatures(f, baseIsToken0), tab.model) ?? heuristicV4(f);
          const s = applyChargeThreshold(raw, tab.gate ? tab.threshold : undefined);
          const td = tabDiag[n]!;
          td.decisions++;
          td.sumP += s.pToxicBps / 1e4;
          if (s.pToxicBps / 1e4 >= tab.threshold) td.charged++;
          if (f.gapPips > cfg.baseFee) td.edgePos++;
          td.sumGap += f.gapPips;
          td.sumEdgeSigma += f.edgeSigma ?? 0;
          td.sumAbsRet12 += Math.abs(f.ret12Bps ?? 0);
          td.sumVol += f.realizedVolBps;
          td.sumNSwaps += f.nSwaps;
          if (raw.model !== 'tabular') td.fallback++;
          const pc = (s.pToxicBps * s.confidenceBps) / 1e4;
          const se = scoreByEdge[n];
          if (f.gapPips > cfg.baseFee) (se.posPc += pc), se.posN++;
          else (se.negPc += pc), se.negN++;
          scores[n] = { p: s.pToxicBps, c: s.confidenceBps, pRaw: s.pToxicBps, source: 'tabular', node: nodeOf(n) };
          continue;
        }
        // v4: no gate — the model is asked on every step, with k-free features (edge vs the base fee)
        const f = computeFeatures({
          swaps: p.hist,
          oracleX96: Mk,
          poolX96: (p.sqrtP * p.sqrtP) / Q96,
          depth0: p.sqrtP > 0n ? (p.L * Q96) / p.sqrtP : 0n,
          recentMids,
          currentBlock: A,
          lastAttestBlock: p.lastAttestBlock || A - 3,
          baseFee: cfg.baseFee,
          windowBlocks: 120,
          baseIsToken0,
        });
        const { s, source } = n === 'aiheur' ? { s: heuristicV4(f), source: 'heuristic' as SourceV4 } : await jevScorer.score(f, t, n === 'aigated' && t >= degradeAt);
        const pc = (s.pToxicBps * s.confidenceBps) / 1e4;
        const se = scoreByEdge[n];
        if (f.gapPips > cfg.baseFee) (se.posPc += pc), se.posN++;
        else (se.negPc += pc), se.negN++;
        if (n === 'aidz') {
          // emulated contract dead-zone: the hook would compute k = kMax * max(0, p*c - z) / (1 - z) from the raw
          // (p, c); the keeper reproduces that k by posting p' with c' = 1. The settler still grades the raw p.
          const z = cfg.dzBps;
          const pDz = Math.max(0, Math.round(((pc - z) * 10_000) / (10_000 - z)));
          scores[n] = { p: pDz, c: 10_000, pRaw: s.pToxicBps, source, node: nodeOf(n) };
        } else scores[n] = { p: s.pToxicBps, c: s.confidenceBps, pRaw: s.pToxicBps, source, node: nodeOf(n) };
      }
      predictedK.clear();
      for (const n of HOOKED) {
        const sc = scores[n]!;
        // post policy: `last` = what is in force on-chain, `now` = what this post would put in force
        const now: PostedState = { block: A, kBps: hookK(n, sc.p, sc.c), jitWindow: hookJit(n), midX96: Mk, pToxicBps: sc.p, pJitBps: 0 };
        const dec = postDecision(pools[n].posted, now, policy);
        kp[n].reasons[dec.reason] = (kp[n].reasons[dec.reason] ?? 0) + 1;
        if (!dec.post) continue;
        predictedK.set(n, now.kBps);
        const att = await signAttestation(
          attestor,
          31337,
          d.hook,
          { poolId: pools[n].id, blockNumber: BigInt(A), oracleMidX96: Mk, pToxicBps: sc.p, confidenceBps: sc.c, pJitBps: 0 /* v5: no JIT head in the benchmark */, modelNode: sc.node },
          domain,
        );
        txs.push({
          to: d.hook,
          data: encodeFunctionData({ abi: hookAbi, functionName: 'setAttestation', args: [pools[n].key, att] }),
          gas: 400_000,
          meta: { label: 'attest', pool: n },
        });
      }
      return { scores, txs };
    };
    /** After the block holding a keeper turn's txs (mined as block A): keeper gas + the AttestationPosted state in force. */
    const afterKeeper = (ra: { rcs: any[]; byHash: Map<string, TxMeta> }, scores: Scores, Mk: bigint, A: number) => {
      for (const rc of ra.rcs) {
        const m = ra.byHash.get(String(rc.transactionHash).toLowerCase());
        if (m?.label === 'attest' && m.pool) {
          const k = kp[m.pool as Hooked];
          k.gas += Number(BigInt(rc.gasUsed));
          if (rc.status === '0x1') k.posts++;
          else k.reverted++;
        }
      }
      for (const rc of ra.rcs) {
        for (const lg of rc.logs as { address: string; topics: Hex[]; data: Hex }[]) {
          if (lg.address.toLowerCase() !== d.hook.toLowerCase()) continue;
          try {
            const ev = decodeEventLog({ abi: hookAbi, data: lg.data, topics: lg.topics as [Hex, ...Hex[]] }) as { eventName: string; args: any };
            if (ev.eventName !== 'AttestationPosted') continue;
            const n = byId.get(String(ev.args.id).toLowerCase()) as Hooked | undefined;
            if (!n) continue;
            pools[n].kBps = Number(ev.args.kBps);
            if (predictedK.has(n) && predictedK.get(n) !== pools[n].kBps) kp[n].kPredictMiss++;
            pools[n].posted = { block: Number(ev.args.blockNumber), kBps: Number(ev.args.kBps), jitWindow: Number(ev.args.jitWindow), midX96: BigInt(ev.args.oracleMidX96), pToxicBps: Number(ev.args.pToxicBps), pJitBps: Number(ev.args.pJitBps) };
            pools[n].lastAttestBlock = A;
            pools[n].pInForce = scores[n]!.pRaw / 10_000;
            attMidInForce = Mk; // shared across pools: only exact for labelMid 'attested' when every pool posts together
          } catch {
            /* other events */
          }
        }
      }
    };
    /**
     * Per-step k / demotion bookkeeping (the k in force for this step's swaps). secPerRecord = seconds this record
     * stands for: 1 in the 1 s loop, blockSec in block mode (one call per block), so the per-bucket k mean is not
     * blockSec x too small.
     */
    const recordK = (t: number, bIdx: number, secPerRecord = 1) => {
      if (t < degradeAt) demRecords.a++;
      else demRecords.b++;
      for (const n of MODEL_POOLS) {
        const dm = isDemoted(n);
        if (t < degradeAt) demCount[n].a += dm ? 1 : 0;
        else demCount[n].b += dm ? 1 : 0;
        if (!dm && demCount[n].active === null) demCount[n].active = t;
      }
      for (const n of HOOKED) {
        kZero[n].steps++;
        if (pools[n].kBps === 0) kZero[n].zero++;
        if (pools[n].kBps < 500) kZero[n].low++;
        kBk[n][bIdx] += (pools[n].kBps * secPerRecord) / cfg.bucketSteps;
        pools[n].kSum += pools[n].kBps;
        pools[n].kN++;
      }
    };
    /** Competing arbitrageurs vs the TRUE mid at the fee quote q: at most one arb per pool. */
    const planArbs = (t: number, mid: number, q: Record<Hooked, { t: number; f: number; stale: boolean }>) => {
      const M = X96(mid);
      const uA = stream(cfg.seed, t, 2);
      const order = cfg.arbs.map((_, i) => ({ i, r: uA() })).sort((a, b) => a.r - b.r).map((x) => x.i);
      const late = cfg.arbs.map(() => uA() < cfg.arbLateProb);
      const txs: Tx[] = [];
      const arbOf = new Map<Pool, number>();
      for (const n of POOLS) {
        const p = pools[n];
        if (p.hooked && q[n as Hooked].stale) p.tot.staleSteps++;
        const P = (p.sqrtP * p.sqrtP) / Q96;
        const zfo = P > M;
        const fee = feeFor(n, zfo, q);
        for (const ai of order) {
          if (late[ai]) continue;
          const a = cfg.arbs[ai]!;
          const c = a.cexBps * 100; // pips
          const feeEff = Math.round(fee + (c * (1e6 - fee)) / 1e6);
          const plan = planArb({ sqrtPriceX96: p.sqrtP, liquidity: p.L, oracleX96: M, feePips: feeEff });
          if (!plan) continue;
          const profitUsd = baseIsToken0 ? plan.profitToken1 / 1e6 : (plan.profitToken1 / 1e18) * mid; // net of CEX fee (approx.)
          if (profitUsd - a.gasUsd < cfg.minProfitUsd) continue;
          const amt = -((plan.amountIn * 1005n) / 1000n);
          const data =
            cfg.split > 1
              ? encodeFunctionData({ abi: routerAbi, functionName: 'swapSplit', args: [p.key, plan.zeroForOne, amt, BigInt(cfg.split), plan.sqrtTargetX96, ACTOR] })
              : encodeFunctionData({ abi: routerAbi, functionName: 'swap', args: [p.key, plan.zeroForOne, amt, plan.sqrtTargetX96, ACTOR] });
          txs.push({ to: d.splitSwapRouter, data, gas: 600_000 * Math.max(1, cfg.split), meta: { label: 'arb', pool: n } });
          arbOf.set(n, ai);
          arbWins[ai]++;
          break;
        }
      }
      return { txs, arbOf };
    };
    /** Arb and retail swap accounting of one mined block (marked at `mid`). */
    const accountSwaps = (rb: { rcs: any[]; byHash: Map<string, TxMeta> }, mid: number, bIdx: number, arbOf: Map<Pool, number>) => {
      const arbCounted = new Set<Pool>();
      const arbFeeSeen = new Map<Pool, number>();
      parseBlock(rb, mid, (n, label, h, feePips) => {
        const p = pools[n];
        const value = h.base * mid + h.quote;
        const inUsd = h.base < 0 ? -h.base * mid : h.quote < 0 ? -h.quote : 0;
        if (label === 'arb') {
          const a = cfg.arbs[arbOf.get(n) ?? 0]!;
          p.tot.arbProfit += value;
          p.bk.arbProfit[bIdx] += value;
          p.tot.arbNet += value - Math.abs(h.quote) * (a.cexBps / 1e4);
          p.tot.arbFees += (inUsd * feePips) / 1e6;
          p.tot.arbVol += Math.abs(h.quote);
          p.tot.arbSubSwaps++;
          if (!arbCounted.has(n)) {
            arbCounted.add(n);
            p.tot.nArb++;
            if (p.hooked) {
              arbAtBase[n as Hooked].n++;
              if (feePips === cfg.baseFee) arbAtBase[n as Hooked].atBase++;
            }
            p.tot.arbNet -= a.gasUsd;
            arbFeeSeen.set(n, feePips);
          }
        } else if (label === 'retail') {
          p.tot.retailCost -= value;
          p.bk.retailCost[bIdx] -= value;
          p.tot.retailFees += (inUsd * feePips) / 1e6;
          p.tot.retailVol += Math.abs(h.quote);
          p.bk.retailVol[bIdx] += Math.abs(h.quote);
          p.retailFeeW += Math.abs(h.quote) * feePips;
        }
      });
      for (const [n, f] of arbFeeSeen) pools[n].arbFeeSum += f;
    };
    /** Seeded retail orders of step t (Poisson(lambda) count, lognormal size, autocorrelated / informed direction). */
    const makeOrders = (t: number, mid: number, lambda: number) => {
      const uR = stream(cfg.seed, t, 3);
      const k = poisson(lambda, uR);
      const orders: { usd: number; buyBase: boolean }[] = [];
      for (let i = 0; i < k; i++) {
        const usd = Math.min(cfg.retailCapUsd, lognormal(cfg.retailMedianUsd, uR, cfg.retailSigma));
        let buyBase: boolean;
        if (uR() < cfg.informedFrac) {
          const fut = mids[Math.min(T - 1, t + cfg.informedHorizon)]!;
          buyBase = fut === mid ? uR() < 0.5 : fut > mid;
        } else {
          buyBase = uR() < cfg.dirAutocorr ? lastBuy : !lastBuy;
          lastBuy = buyBase;
        }
        orders.push({ usd, buyBase });
        retailOrders++;
        retailUsd += usd;
      }
      return orders;
    };
    /** Route the orders per market between its two pools by best execution at the fee quote q (current pool state). */
    const routeRetail = (orders: { usd: number; buyBase: boolean }[], mid: number, q: Record<Hooked, { t: number; f: number }>): Tx[] => {
      const txC: Tx[] = [];
      if (!orders.length) return txC;
      for (const mk of MARKETS) {
        const pair = [mk.vanilla, mk.comp] as Pool[];
        // virtual reserves (raw) of each pool, updated after every routed order of this block
        const R = pair.map((n) => {
          const s = Number(pools[n].sqrtP) / 2 ** 96;
          const L = Number(pools[n].L);
          return { x: L / s, y: L * s };
        });
        for (const o of orders) {
          const payToken0 = o.buyBase ? !baseIsToken0 : baseIsToken0;
          const payIsBase = !o.buyBase;
          const X = payIsBase ? (o.usd / mid) * 1e18 : o.usd * 1e6;
          const side = pair.map((n, i) => ({
            rin: payToken0 ? R[i]!.x : R[i]!.y,
            rout: payToken0 ? R[i]!.y : R[i]!.x,
            f: feeFor(n, payToken0, q) / 1e6,
          }));
          let x0: number;
          const out0 = cpOut(X, side[0]!.rin, side[0]!.rout, side[0]!.f);
          const out1 = cpOut(X, side[1]!.rin, side[1]!.rout, side[1]!.f);
          if (cfg.routing === 'best') x0 = out0 >= out1 ? X : 0;
          else {
            x0 = optimalSplit(X, side[0]!, side[1]!);
            if (Math.min(x0, X - x0) < cfg.minSplitFrac * X) x0 = out0 >= out1 ? X : 0;
          }
          const legs = [x0, X - x0];
          legs.forEach((a, i) => {
            if (a < 1) return;
            const s = side[i]!;
            const out = cpOut(a, s.rin, s.rout, s.f);
            const ain = a * (1 - s.f);
            if (payToken0) (R[i]!.x += ain), (R[i]!.y -= out);
            else (R[i]!.y += ain), (R[i]!.x -= out);
            const amountIn = payIsBase ? BigInt(Math.floor(a / 1e6)) * 10n ** 6n : BigInt(Math.floor(a));
            if (amountIn <= 0n) return;
            txC.push({
              to: d.splitSwapRouter,
              data: encodeFunctionData({ abi: routerAbi, functionName: 'swap', args: [pools[pair[i]!].key, payToken0, -amountIn, payToken0 ? MIN_SQRT : MAX_SQRT, ACTOR] }),
              gas: 600_000,
              meta: { label: 'retail', pool: pair[i]! },
            });
          });
        }
      }
      return txC;
    };
    /** LP accounting marked at the true mid. */
    const markLp = (mid: number, bIdx: number) => {
      for (const n of POOLS) {
        const p = pools[n];
        if (p.hist.length > 400) p.hist.splice(0, p.hist.length - 400);
        const { pos, fees } = lpAmounts(p);
        const lmh = (pos.base + fees.base) * mid + pos.quote + fees.quote - (p.x0 * mid + p.y0);
        p.bk.dLp[bIdx] += lmh - p.prevLmh;
        p.prevLmh = lmh;
        p.tot.lpFees += (fees.base - p.prevFees.base) * mid + (fees.quote - p.prevFees.quote);
        p.prevFees = { base: fees.base, quote: fees.quote };
      }
    };
    const markCalibReverts = (t: number) => {
      for (const c of calibrations) if (c.step === t && reverts.some((x) => x.step === t && x.label === 'calib' && x.pool === c.pool)) c.ok = false;
    };
    const progress = (t: number, mid: number) =>
      log('progress', {
        label: cfg.label,
        step: t,
        of: T,
        mid,
        sec: Math.round((Date.now() - t0) / 1000),
        lmh: Object.fromEntries(POOLS.filter((n) => !n.startsWith('v_') || n === 'v_control_a').map((n) => [n, Math.round(pools[n].prevLmh)])),
        k: Object.fromEntries(HOOKED.map((n) => [n, pools[n].kBps])),
        jev: jevScorer.counts,
      });

    if (!bm) {
      for (let t = 0; t < T; t++) {
        const mid = mids[t]!;
        const bIdx = Math.floor(t / cfg.bucketSteps);
        const knownIdx = Math.max(0, t - cfg.keeperLag);
        const knownMid = mids[knownIdx]!;
        const Mk = X96(knownMid);
        const recentMids = mids.slice(Math.max(0, knownIdx - 29), knownIdx + 1);
        const uK = stream(cfg.seed, t, 1);
        const missed = t > 0 && uK() < cfg.missProb;

        // ================= block A: settler + keeper
        const A = head + 1;
        const txA: Tx[] = t > 0 && t % cfg.settleEvery === 0 ? calibTxs(t, A) : [];
        let scores: Scores = {};
        const turn = t % keeperEvery === 0; // keeperEvery 1 (default): a keeper turn every step, as before
        if (turn) keeperTurns++;
        if (turn && missed) missedPosts++;
        else if (turn) {
          keeperDecisions++;
          const kt = await keeperTurn(A, t, Mk, recentMids);
          scores = kt.scores;
          txA.push(...kt.txs);
        }
        const ra = await sendAndMine(txA, t);
        markCalibReverts(t);
        afterKeeper(ra, scores, Mk, A);
        recordK(t, bIdx);

        // ================= block B: competing arbitrageurs vs the TRUE mid
        const B = head + 1;
        stepOfBlock.set(B, t);
        bBlocks.add(B);
        if (attMidInForce !== undefined) attMidAtBlock.set(B, attMidInForce);
        const qB = await quoteNext();
        const arb = planArbs(t, mid, qB);
        const rb = await sendAndMine(arb.txs, t);
        accountSwaps(rb, mid, bIdx, arb.arbOf);
        for (const n of HOOKED) if (pools[n].pInForce !== undefined) pools[n].pAtBlock.set(B, pools[n].pInForce!);
        await readStates();

        // ================= block C: retail, routed per market by best execution
        const C = head + 1;
        stepOfBlock.set(C, t);
        if (attMidInForce !== undefined) attMidAtBlock.set(C, attMidInForce);
        const qC = await quoteNext();
        const orders = makeOrders(t, mid, cfg.lambda);
        const txC = routeRetail(orders, mid, qC);
        const rc = await sendAndMine(txC, t);
        accountSwaps(rc, mid, bIdx, new Map());
        for (const n of HOOKED) if (pools[n].pInForce !== undefined) pools[n].pAtBlock.set(C, pools[n].pInForce!);
        if (txC.length) await readStates();

        // ---- per-step LP accounting (marked at the true mid)
        markLp(mid, bIdx);

        if (t > 0 && t % 300 === 0) jevScorer.save(); // do not lose live Jev answers if the run is killed
        if (t % 600 === 0 || t === T - 1) progress(t, mid);
      }
    } else {
      // ================= mainnet block mode: one 12 s block per iteration, everything at the block timestamp s
      //   K_b (anvil block): settler setCalibration; coop: the keeper's post (first in the block; mid read at s - 2)
      //   S_b (anvil block): arbitrageurs vs mid[s], then retail (same block: the hook's per-block high-water gap
      //        applies to retail after an arb); realistic: the keeper's post for block b+1 lands LAST (mid read at
      //        s_{b+1} - 13 = s - 1, pool state after block b-1: block b is not built yet at read time)
      // K_b holds no swaps, so a coop post in K_b prices S_b exactly as a first-in-block tx would (the anchor is created
      // by the first swap); staleness / heartbeat count 2 anvil blocks per mainnet block.
      const BS = bm.blockSec ?? 12;
      const age = bm.midAgeSec ?? (bm.placement === 'coop' ? 2 : 13);
      const warm = cfg.warmupMids ?? [];
      const W = warm.length;
      const midAtSec = (s: number) => (s >= 0 ? mids[Math.min(T - 1, s)]! : (warm[W + s] ?? mids[0]!));
      const msOf = (s: number) => path.window.startMs + s * 1000;
      const nBlk = Math.floor((T - 1) / BS) + 1;
      blockStats.blocks = nBlk;
      const hist: MidObs[] = []; // the keeper's MidHistory: one CEX read per keeper tick (services/src/keeper.ts)
      // A read at time x sees the close of the 1 s kline that opened at x - 1: mid age `age` at the block = the kline
      // that opened at s - age - 1 (ml build_v2 convention: the teacher LightGBM reads mid(ts - 3) = age 2 s;
      // mids[s] = the kline that opened at s, the arbs' and the settler's mid).
      const readAt = (x: number) => midAtSec(x - 1);
      const pushMid = (s: number) => {
        hist.push({ t: msOf(s), mid: readAt(s) });
        if (hist.length > KEEPER_MID_HISTORY) hist.shift();
      };
      // a keeper that has been running before the window: one read per block, as far back as the warm-up mids go
      for (let s = -age - BS * Math.floor(Math.max(0, W - age - 1) / BS); s < -age; s += BS) pushMid(s);
      const tick = async (A: number, obs: number, t: number) => {
        pushMid(obs);
        const Mk = X96(readAt(obs));
        const rm: number[] = [];
        for (let i = obs - 29; i <= obs; i++) rm.push(readAt(i));
        const kt = await keeperTurn(A, t, Mk, rm, { hist: hist.slice(), tObsMs: msOf(obs), windowBlocks: 2 * KEEPER_WINDOW_BLOCKS });
        return { ...kt, Mk };
      };
      for (let b = 0; b < nBlk; b++) {
        const s = b * BS;
        const mid = mids[s]!;
        const bIdx = Math.floor(s / cfg.bucketSteps);
        const u = stream(cfg.seed, s, 1)();
        // ---- K_b
        const K = head + 1;
        stepOfBlock.set(K, s);
        const txK: Tx[] = b > 0 && b % cfg.settleEvery === 0 ? calibTxs(s, K) : [];
        let kt: Awaited<ReturnType<typeof tick>> | undefined;
        if (bm.placement === 'coop' || b === 0) {
          // coop: every block; realistic: only the post for block 0 (it would have landed at the end of block -1)
          keeperTurns++;
          if (bm.placement === 'coop' && b > 0 && u < cfg.missProb) (missedPosts++, pushMid(s - age));
          else {
            keeperDecisions++;
            kt = await tick(K, s - age, s);
            txK.push(...kt.txs);
          }
        }
        const rk = await sendAndMine(txK, s);
        markCalibReverts(s);
        if (kt) afterKeeper(rk, kt.scores, kt.Mk, K);
        recordK(s, bIdx, BS);
        // ---- S_b
        const S = head + 1;
        stepOfBlock.set(S, s);
        bBlocks.add(S);
        if (attMidInForce !== undefined) attMidAtBlock.set(S, attMidInForce);
        let rt: Awaited<ReturnType<typeof tick>> | undefined;
        if (bm.placement === 'realistic' && b < nBlk - 1) {
          keeperTurns++;
          if (u < cfg.missProb) (missedPosts++, pushMid(s + BS - age));
          else {
            keeperDecisions++;
            rt = await tick(S, s + BS - age, s);
          }
        }
        const qA = await quoteNext();
        const arb = planArbs(s, mid, qA);
        const orders = makeOrders(s, mid, cfg.lambda * BS);
        let qR = qA;
        if (orders.length && arb.txs.length) {
          // retail follows the arbs in the same block: quote the hook after them (anchor + high-water gap of this
          // block) on a throw-away copy of the chain, then revert and mine the real block
          const snap = await rpc.call<Hex>('evm_snapshot');
          const n0 = nonce;
          await rpc.batchSettled<Hex>(
            arb.txs.map((tx) => ['eth_sendTransaction', [{ from: ACTOR, to: tx.to, data: tx.data, gas: hex(tx.gas), gasPrice: '0x0', nonce: hex(nonce++) }]]),
          );
          await rpc.call('evm_mine');
          await readStates();
          qR = await quoteNext('latest');
          blockStats.trials++;
          if (HOOKED.some((n) => qR[n].t !== qA[n].t || qR[n].f !== qA[n].f)) blockStats.quoteChanged++;
          const ok = await rpc.call<boolean>('evm_revert', [snap]);
          if (!ok) throw new Error('evm_revert failed');
          nonce = n0;
        }
        const txR = routeRetail(orders, mid, qR);
        const rs = await sendAndMine([...arb.txs, ...txR, ...(rt?.txs ?? [])], s);
        accountSwaps(rs, mid, bIdx, arb.arbOf);
        for (const n of HOOKED) if (pools[n].pInForce !== undefined) pools[n].pAtBlock.set(S, pools[n].pInForce!);
        if (rt) afterKeeper(rs, rt.scores, rt.Mk, S);
        await readStates();
        markLp(mid, bIdx);
        if (b % 50 === 0 || b === nBlk - 1) progress(s, mid);
      }
    }
    jevScorer.save();
    // whole-window label diagnostics per model pool (same labelling as the settler, all labelled blocks)
    const labelDiag = {} as RunResultV4['labelDiag'];
    const tabOut = {} as NonNullable<RunResultV4['tabular']>;
    for (const n of MODEL_POOLS) {
      const p = pools[n];
      const labels = labelBlocks(
        p.receipts,
        (b) => (cfg.labelMid === 'attested' ? attMidAtBlock.get(b) : stepOfBlock.get(b) === undefined ? undefined : X96(mids[stepOfBlock.get(b)!]!)),
        (r) => p.pAtBlock.get(r.blockNumber),
        { labelFee: cfg.labelFee, baseFeePips: cfg.baseFee, deadbandUsd: cfg.deadbandUsd, deadbandBps: cfg.deadbandBps, usdPerRawToken1: (b) => usdPerRaw1(b) },
      );
      const ys = labels.map((l) => l.y);
      const ps = labels.map((l) => l.p);
      const nL = labels.length;
      const br = nL ? ps.reduce((a, x, i) => a + (x - ys[i]!) ** 2, 0) / nL : NaN;
      const arbL = labels.filter((l) => bBlocks.has(l.block));
      const tab = tabular[n];
      const td = tabDiag[n];
      if (tab && td) {
        const k = Math.max(1, td.decisions);
        tabOut[n] = {
          model: tab.model.name,
          path: tab.path,
          gate: tab.gate,
          threshold: tab.threshold,
          decisions: td.decisions,
          charged: td.charged,
          meanP: td.sumP / k,
          edgePosShare: td.edgePos / k,
          meanGapPips: td.sumGap / k,
          meanEdgeSigma: td.sumEdgeSigma / k,
          meanAbsRet12Bps: td.sumAbsRet12 / k,
          meanRealizedVolBps: td.sumVol / k,
          meanNSwaps: td.sumNSwaps / k,
          fallback: td.fallback,
          pairs: labels.map((l) => [Math.round(l.p * 1e4) / 1e4, l.y] as [number, number]),
        };
      }
      labelDiag[n] = {
        n: nL,
        baseRate: nL ? ys.reduce((a: number, b) => a + b, 0) / nL : NaN,
        meanP: nL ? ps.reduce((a, b) => a + b, 0) / nL : NaN,
        meanPwhenY1: ys.some((y) => y === 1) ? ps.filter((_, i) => ys[i] === 1).reduce((a, b) => a + b, 0) / ys.filter((y) => y === 1).length : NaN,
        meanPwhenY0: ys.some((y) => y === 0) ? ps.filter((_, i) => ys[i] === 0).reduce((a, b) => a + b, 0) / ys.filter((y) => y === 0).length : NaN,
        brier: br,
        nArbBlocks: arbL.length,
        baseRateArbBlocks: arbL.length ? arbL.reduce((a, l) => a + l.y, 0) / arbL.length : NaN,
      };
    }

    const totals = {} as Record<Pool, PoolTotals>;
    for (const n of POOLS) {
      const p = pools[n];
      p.tot.lpMinusHodl = p.prevLmh;
      p.tot.meanArbFeePips = p.tot.nArb ? Math.round(p.arbFeeSum / p.tot.nArb) : null;
      p.tot.meanRetailFeePips = p.tot.retailVol ? Math.round(p.retailFeeW / p.tot.retailVol) : null;
      p.tot.meanK = p.hooked && p.kN ? Math.round(p.kSum / p.kN) : null;
      totals[n] = p.tot;
    }
    const lat = [...jevScorer.latencies].sort((a, b) => a - b);
    const cnt = jevScorer.counts;
    const nScores = Object.values(cnt).reduce((a, b) => a + b, 0);
    const { path: _p, warmupMids: _w, ...rest } = cfg;
    // 1 s loop: demRecords.a = degradeAt and demRecords.b = T - degradeAt (unchanged); block mode: blocks per half
    const h1 = demRecords.a;
    const h2 = demRecords.b;
    return {
      label: cfg.label,
      windowId: path.window.id,
      asset: path.window.asset,
      regime: path.window.regime,
      vol1mBps: path.window.vol1mBps,
      variant: cfg.label.split(':')[1] ?? 'base',
      config: { ...rest, steps: T, startIso: path.window.startIso, initialMid: mids[0]!, finalMid: mids[T - 1]!, liquidity: liquidity.toString() },
      initialTvlUsd,
      degradeAtStep: degradeAt,
      totals,
      buckets: Object.fromEntries(POOLS.map((n) => [n, pools[n].bk])) as Record<Pool, PoolBuckets>,
      demoted: Object.fromEntries(
        MODEL_POOLS.map((n) => [n, { firstHalf: demCount[n].a / Math.max(1, h1), secondHalf: demCount[n].b / Math.max(1, h2), activeAtStep: demCount[n].active }]),
      ) as RunResultV4['demoted'],
      demotedDenom: 'records',
      kZero,
      scoreByEdge,
      arbAtBase,
      kBuckets: kBk,
      labelDiag,
      calibrations,
      missedPosts,
      arbWins,
      retailOrders,
      retailUsd,
      jev: {
        mode: cfg.jevMode,
        calls: jevScorer.calls,
        failures: jevScorer.failures,
        retries: jevScorer.retries,
        counts: cnt,
        fallbackShare: nScores ? (cnt.heuristic + cnt['heuristic-paced'] + cnt['heuristic-jev-failed']) / nScores : 0,
        p50LatencyMs: lat.length ? Math.round(lat[Math.floor(lat.length / 2)]!) : null,
      },
      reverts,
      txCount,
      runtimeSec: Math.round((Date.now() - t0) / 1000),
      ...(bm ? { blockMode: { placement: bm.placement, blockSec: bm.blockSec ?? 12, midAgeSec: bm.midAgeSec ?? (bm.placement === 'coop' ? 2 : 13), blocks: blockStats.blocks, retailAfterArbQuotes: blockStats.trials, retailQuoteChangedByArb: blockStats.quoteChanged } } : {}),
      ...(Object.keys(tabOut).length ? { tabular: tabOut } : {}),
      keeper: { policy, keeperEvery, gasGwei: cfg.keeperGasGwei ?? 1, ethUsd, decisions: keeperDecisions, turns: keeperTurns, pools: kp },
    };
  } finally {
    anvil.stop();
  }
}
