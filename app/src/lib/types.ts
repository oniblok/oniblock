/** JSON shapes returned by the API routes (shared by server and client code). */

export interface FeeQuote {
  feePips: number;
  arbDir: boolean;
  gapPips: number;
  stale: boolean;
}

export interface PoolConfigJson {
  baseFee: number;
  feeMax: number;
  conservativeFee: number;
  kMinBps: number;
  kMaxBps: number;
  kDefaultBps: number;
  maxKStepBps: number;
  staleBlocks: number;
  sanityBandBps: number;
  chainlinkFeed: string;
  brierDemoteBps: number;
  minSamples?: number;
  /** v3: gap (pips) below which the hook charges exactly baseFee (absent on pre-v3 hooks => 0) */
  arbThresholdPips?: number;
  /** v5 JIT head: window = jitWindowMin + (jitWindowMax − jitWindowMin)·p_jit·confidence; demoted/unseasoned/stale => jitWindowDefault (absent on pre-v5 hooks) */
  jitWindowMin?: number;
  jitWindowMax?: number;
  jitWindowDefault?: number;
  [k: string]: unknown;
}

/** The fixed LiquidityPenaltyHook wall the v5 adaptive window replaces (blocks). A remove at addedBlock + 10 or later escaped it. */
export const LEGACY_JIT_WALL = 10;

/** One JitPenalty event: liquidity removed inside the window in force when it was added forfeited its fees. */
export interface JitPenaltyJson {
  tx: string;
  /** block the liquidity was removed in (the penalty block) */
  block: number;
  addedBlock: number;
  /** blocks held = block − addedBlock */
  held: number;
  /** window in force for this position (stored at add time) */
  window: number;
  sender: string;
  positionKey: string;
  penalty0: string;
  penalty1: string;
  penalty0Human: number;
  penalty1Human: number;
  /** penalty valued in quote units at the attested CEX mid in force (null if no attestation yet) */
  penaltyQuote: number | null;
  /** held >= LEGACY_JIT_WALL: only the adaptive window caught this one */
  caughtByAdaptiveWindow: boolean;
}

export interface CalibrationJson {
  brierBps: number;
  hitRateBps: number;
  n: number;
  updatedBlock: number;
}

export interface PoolLive {
  name: string;
  poolId: string;
  hooked: boolean;
  /** pool price, quote per base (e.g. USDC per ETH) */
  poolMid: number;
  liquidity: string;
  /** static fee for vanilla pool, pips */
  staticFee?: number;
}

export interface StateJson {
  chain: { name: string; chainId: number; isDev: boolean; block: number; timestamp: number; ens: boolean };
  pair: { base: string; quote: string; baseIsToken0: boolean; token0: string; token1: string };
  hook: string;
  roleOracle?: string;
  roleOracleType?: string;
  config: PoolConfigJson;
  status: {
    lastAttestBlock: number;
    attestAge: number | null;
    pToxicBps: number;
    confidenceBps: number;
    kBps: number;
    /** CEX mid attested on-chain (quote per base) */
    oracleMid: number | null;
    modelNode: string;
    modelName?: string;
    demoted: boolean;
    unseasoned: boolean;
    /** model allowlisted on this pool (null if the hook has no allowlist) */
    allowed: boolean | null;
    stale: boolean;
    feeZeroForOne: FeeQuote;
    feeOneForZero: FeeQuote;
    /** which swap direction (true = zeroForOne) is the arb direction right now, null if none */
    arbZeroForOne: boolean | null;
    gapPips: number;
    /** v3 arb threshold (pips); 0 on pre-v3 hooks */
    arbThresholdPips: number;
    /** not stale and the live high-water gap is at/below the threshold => both directions pay exactly baseFee */
    belowThreshold: boolean;
    /** Model mix of the recent attestations (keeper v3 gate: rule-v1 below the threshold, Jev/heuristic above). */
    attestMix: { window: number; total: number; jev: number; heuristic: number; oniblock1: number; rule: number; other: number } | null;
    calibration?: CalibrationJson;
    lastQuoter?: string;
    lastQuoterName?: string;
    /** v5 second knob. null on pre-v5 hooks (or when poolState cannot be decoded). */
    jit: {
      /** the model's JIT probability in the attestation in force (bps) */
      pJitBps: number | null;
      /** window set by the last attestation (poolState.jitWindow), blocks */
      jitWindow: number | null;
      /** window applied to liquidity added now: jitWindow, or jitWindowDefault while the attestation is stale */
      jitWindowEffective: number | null;
      /** hook.isJitDemoted minus the unseasoned case (bad JIT calibration) */
      demoted: boolean;
      /** JIT head on probation: calibration(jitCalibrationKey).n < minSamples */
      unseasoned: boolean;
      /** derived calibration key of the JIT head (keccak(modelNode ‖ keccak("jit"))) */
      calibrationKey: string | null;
      calibration?: CalibrationJson;
      /** the deployed ABI exposes the JIT head views */
      supported: boolean;
    };
  };
  roles: {
    quoter?: string;
    quoterActive?: boolean;
    backupQuoter?: string;
    backupActive?: boolean;
    settler?: string;
    settlerActive?: boolean;
    /** ENSIP-19 primary names (UR.reverse, forward-verified); null when none or no ENS on this chain */
    quoterName?: string | null;
    settlerName?: string | null;
  };
  flags: { degraded: boolean; useBackupQuoter: boolean };
  pools: { oniblock: PoolLive; vanilla?: PoolLive };
}

export interface HistoryPoint {
  block: number;
  mid: number;
  oni: { lp: number; hodl: number; fees: number; lossToArb: number; poolMid: number };
  van?: { lp: number; hodl: number; fees: number; lossToArb: number; poolMid: number };
}

export interface RegimeCell {
  block: number;
  /** an AttestationPosted was mined in this block */
  posted: boolean;
  /** attestation in force (latest mined at or before this block) */
  attBlock: number | null;
  age: number | null;
  stale: boolean;
  pToxicBps: number | null;
  confidenceBps: number | null;
  kBps: number | null;
  /** v5: the attestation's JIT head (null on pre-v5 events) */
  pJitBps: number | null;
  jitWindow: number | null;
  model: string | null;
  modelName: string | null;
  demoted: boolean;
  /** model on probation (calibration n < minSamples) -> kDefault */
  unseasoned: boolean;
  /** regime fee for the arb direction (pips): exact from Receipts when swaps happened, else quoted */
  feePips: number | null;
  feeSource: 'receipt' | 'quoted' | null;
  gapPips: number | null;
  swaps: number;
  txs: string[];
}

export interface PoolTotals {
  fees: number;
  lossToArb: number;
  lpMinusHodl: number;
  swaps: number;
  volume: number;
}

export interface RecentReceipt {
  tx: string;
  block: number;
  arbDir: boolean;
  feePips: number;
  gapPips: number;
  kBps: number;
  stale: boolean;
  zeroForOne: boolean;
}

export interface HistoryJson {
  head: number;
  from: number;
  baselineBlock: number | null;
  points: HistoryPoint[];
  regime: RegimeCell[];
  totals: { oni: PoolTotals; van?: PoolTotals };
  receipts: RecentReceipt[];
  /** latest JitPenalty events on the Oniblock pool (newest first) */
  jitPenalties: JitPenaltyJson[];
  jitTotals: { count: number; caughtByAdaptiveWindow: number; penaltyQuote: number };
  quote: string;
}

// ============================================================================================ ENS namespace (/api/ens)

/** One ENSIP-10 wildcard name under live.<root>: records null when the UR cannot resolve it (resolver not deployed). */
export interface EnsLiveName {
  name: string;
  kind: 'model' | 'current' | 'pool';
  keys: string[];
  records: Record<string, string> | null;
}

/** ENSIP-19 primary name of a service key, next to the forward addr(<role>.<root>) record. */
export interface EnsPrimary {
  role: 'quoter' | 'settler';
  address: string | null;
  /** <role>.<root>: the name ens:primary sets */
  expected: string;
  /** UR.reverse(addr, 60), forward-verified; null = none / mismatch / no ENS */
  name: string | null;
  forward: string | null;
  /** addr(expected) == address (null when unresolvable) */
  matches: boolean | null;
}

export interface EnsNamespaceJson {
  chain: { name: string; chainId: number; ens: boolean; ensName: string | null; universalResolver: string | null; liveResolver: string | null; liveNode: string | null };
  root: string;
  coinType: number;
  live: EnsLiveName[];
  primary: EnsPrimary[];
}

// ============================================================================================ live feed (/api/feed)

export type Trader = 'arb' | 'retail' | 'demo' | null;

export interface FeedRow {
  tx: string;
  logIndex: number;
  block: number;
  /** unix seconds */
  ts: number;
  /** swapper bought or sold the base token (ETH) */
  side: 'buy' | 'sell';
  baseAmount: number;
  quoteAmount: number;
  /** trade size in quote units (USD) at the attested CEX mid */
  usd: number;
  feePips: number;
  baseFeePips: number;
  feeUsd: number;
  /** fee paid above the base fee, i.e. what a plain Uniswap pool would not have charged */
  extraUsd: number;
  arbDir: boolean;
  stale: boolean;
  gapPips: number;
  kBps: number;
  pToxicBps: number | null;
  confidenceBps: number | null;
  /** Oniblock score used for colour: p·c for arb-direction swaps, 0 for counter-trend swaps */
  score: number;
  model: string | null;
  trader: Trader;
  from: string;
  /** swapper P&L vs the next attested CEX mid (quote units); null until the next attestation lands */
  markoutUsd: number | null;
}

export interface FeedBucket {
  fromBlock: number;
  toBlock: number;
  /** LP P&L vs CEX in this bucket (quote units) */
  oni: number;
  van: number;
  /** cumulative since the window start */
  oniCum: number;
  vanCum: number;
  swaps: number;
}

export interface FeedDirQuote {
  feePips: number;
  arbDir: boolean;
}

export interface FeedJson {
  chain: { name: string; chainId: number; block: number; ts: number; explorer: string | null; ensName: string | null };
  pair: { base: string; quote: string; baseIsToken0: boolean };
  baseFeePips: number;
  vanillaFeePips: number | null;
  model: { name: string | null; pToxicBps: number; confidenceBps: number; kBps: number; stale: boolean; lastAttestBlock: number };
  market: {
    oracleMid: number | null;
    poolMid: number;
    /** virtual full-range reserves (human units) for a constant-product output estimate */
    reserveBase: number;
    reserveQuote: number;
    /** fee a swap would pay right now, per direction (sell base = zeroForOne when base is token0) */
    sellBase: FeedDirQuote;
    buyBase: FeedDirQuote;
  };
  chart: { buckets: FeedBucket[]; oniTotal: number; vanTotal: number; windowBlocks: number };
  rows: FeedRow[];
  swapEnabled: boolean;
  swapLimits: { maxBase: number; maxQuote: number };
}

// ============================================================================================ v6 verdicts (/api/verdicts)

/** The 7 attack types of the keeper's v6 head (services/src/model/types.ts ATTACK_TYPES), in order. */
export const ATTACK_TYPES = ['none', 'cex_dex_arbitrage', 'split_arbitrage', 'backrun', 'jit_liquidity', 'sandwich', 'unknown'] as const;
export type AttackType = (typeof ATTACK_TYPES)[number];

/** Human labels for the status strip / tooltips. */
export const ATTACK_LABELS: Record<AttackType, string> = {
  none: 'none',
  cex_dex_arbitrage: 'CEX-DEX arbitrage',
  split_arbitrage: 'split arbitrage',
  backrun: 'backrun',
  jit_liquidity: 'JIT liquidity',
  sandwich: 'sandwich (label only)',
  unknown: 'unknown',
};
export const attackLabel = (t: string | null | undefined) => (t == null ? '—' : ((ATTACK_LABELS as Record<string, string>)[t] ?? t));

/**
 * One line of the keeper's verdicts file (services/src/keeper.ts VerdictLog): the v6 model answer behind a posted
 * attestation. pMalicious / attack / attackProbs are null for models without the v6 head (rule-v1, kev, tabular).
 */
export interface VerdictJson {
  /** observed block (features) and the attested target block */
  block: number;
  target: number;
  pMalicious: number | null;
  attack: AttackType | null;
  attackProbs: Record<AttackType, number> | null;
  /** the two attested numbers (bps; pJitBps after the keeper's churn blend) */
  pToxicBps: number;
  pJitBps: number;
  /** what the hook derived from them (AttestationPosted), when decoded */
  k?: number;
  jitWindow?: number;
  model: string;
  txHash: string;
}
