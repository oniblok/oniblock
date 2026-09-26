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
  [k: string]: unknown;
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
    attestMix: { window: number; total: number; jev: number; heuristic: number; rule: number; other: number } | null;
    calibration?: CalibrationJson;
    lastQuoter?: string;
    lastQuoterName?: string;
  };
  roles: { quoter?: string; quoterActive?: boolean; backupQuoter?: string; backupActive?: boolean; settler?: string; settlerActive?: boolean };
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
  quote: string;
}
