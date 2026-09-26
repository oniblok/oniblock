/**
 * Keeper: once per block, post (oracleMid, pToxic, confidence, pJit, modelNode, sig) to the hook.
 *
 *   new block -> CEX mid + pool price + recent Receipts + ModifyLiquidity/JitPenalty logs -> features
 *             -> model (Jev|heuristic) -> EIP-712 sign with attestor key -> setAttestation from quoter key
 *
 * v5 (docs/review/V5_JIT_HEAD_SPEC.md): the same Jev call answers a second typed question — will liquidity added in
 * the next block be opportunistic JIT? — and its probability (pJitBps) is attested next to pToxic. The hook turns it
 * into the JIT penalty window for liquidity added from then on (jitWindowMin..Max, jitWindowDefault while the JIT head
 * is unseasoned/demoted); the keeper logs pJitBps and the resulting window (AttestationPosted.jitWindow).
 *
 * Online calibration of the JIT head against the observed churn of recent liquidity (deliberate, see `blendPJit`):
 * the posted probability is NOT the raw model answer but
 *     pJitBps = round((1 - w) * pJitModel + w * churn * 10000),   w = JIT_CHURN_WEIGHT (default 0.5, clamped to [0,1])
 * where `churn` is the keeper's own liqChurn200 feature (share of positions added in the last 200 blocks that were
 * removed again within JIT_LABEL_BLOCKS — exactly the settler's label rule). With no adds in the last 200 blocks
 * there is no base rate to calibrate against and the model answer is posted unchanged. Why: the settler grades
 * pJit only on blocks WITH adds, so in a pool where recent adds have mostly been pulled again the graded base rate
 * is high; a zero-shot answer near 0.3-0.4 there is confidently wrong (Brier > brierDemoteBps) and the JIT head is
 * demoted the moment it is seasoned. The blend is a shrinkage toward the empirical base rate the label is built
 * from; the attested log line carries both inputs (`pJitModel`, `pJitChurn`) next to the posted `pJitBps`.
 * The same blend is applied to the heuristic fallback (which already uses churn). RULE_SCORE (rule-v1) is not blended.
 *
 * v6 (default prompt, docs/JEV_NOTES.md "v6 questions and mapping"): the model answers ONE malicious score plus ONE
 * attack type; `mapV6` (model/types.ts) allocates the score onto the same two attested numbers (price types ->
 * pToxicBps -> k, jit_liquidity -> pJitBps -> JIT window) BEFORE the churn blend above, which is unchanged. The attested
 * log line carries `pMalicious`, `attack`, `attackProbs`, `pPriceShare`, `pJitShare`, `jevPrompt`, and every posted
 * attestation is appended as one JSON line to the verdicts file (VerdictLog: VERDICTS_FILE, else
 * <DEMO_RUNTIME_DIR|.runtime>/verdicts.<chainId>.jsonl, capped to the last 5000 lines) for the app (/api/verdicts).
 *
 * CLI: tsx src/keeper.ts [--chain local|fork|sepolia] [--once] [--degraded] [--every N]
 *                        [--mode auto|jev|heuristic|kev|tabular] [--pool NAME]   (kev/tabular: set MODEL_MODE env so the default model node is kev-v1 / kev4b-v1 / tabular-v1 / tabular-v2)
 * Env: KEEPER_EVERY (default 1), ATTEST_BLOCK_OFFSET (default 1), MODEL_NAME,
 *      FALLBACK_MODEL_NAME, RULE_MODEL_NAME (default rule-v1.models.oniblock.eth),
 *      KEEPER_GATE (default 0 = v4: the model is asked EVERY block; 1 = the v3 rule-v1 gate, kept for comparison),
 *      KEEPER_HYSTERESIS_PIPS (default 100, gate only), JEV_PROMPT (default v6; v5 = two booleans, v4 = arb-only question, v1 = pre-v4 texts),
 *      VERDICTS_FILE (default <DEMO_RUNTIME_DIR|.runtime>/verdicts.<chainId>.jsonl: one JSON line per posted attestation for the app),
 *      JIT_LABEL_BLOCKS (default 100: "removed within N blocks" for the churn feature; keep = SETTLER_JIT_LABEL_BLOCKS),
 *      JIT_CHURN_WEIGHT (default 0.5: weight of the observed churn in the posted pJit, 0 = raw model answer, 1 = churn only),
 *      STALE_BLOCKS (fallback when poolConfig.staleBlocks is unreadable; decides whether the attested JIT window or the default is in force),
 *      KEEPER_STATS_EVERY (ticks between `jev_rate` summary lines, default 50),
 *      DEGRADED_FILE (touch file to toggle degraded mode live),
 *      KEEPER_FLAGS_FILE (default <root>/.runtime/keeper-flags.json), BACKUP_QUOTER_PK,
 *      CHARGE_THRESHOLD (model v2, 0..1; unset = off): after score()/degrade() the posted pToxic is unchanged and
 *        confidenceBps = p >= t ? 10000 : 0, so the hook's k = kMax * p * c is 0 below t (vanilla pool) and the premium is
 *        charged only on blocks the model calls toxic with p >= t. The settler grades pToxic only, so the posted
 *        probability stays honest. Logged as p / chargeThreshold / charged (+ modelConfidenceBps). Not applied to rule-v1.
 *        (c also scales the JIT window, so a gated block also posts the minimum JIT window.)
 *      KEEPER_READ_LEAD_MS (slot clock, ms >= 0; unset = off = tick on block arrival): after block N arrives, the tick
 *        (CEX read, features, model, sign, send) is scheduled for ts_N + KEEPER_BLOCK_TIME_MS - lead, so the tx still lands
 *        in block N+1 but with a fresh mid (~blockTime + lead old at N+2's first swap instead of ~2 * blockTime - lag). A
 *        block arriving before the timer cancels and re-arms from the new block (slot_rearmed); a block ticks at most once.
 *        KEEPER_BLOCK_TIME_MS: default 12000 on sepolia, the observed header block time on local/fork chains.
 *        In slot mode every attested line logs readLagMs (read - ts_N), expectedMidAgeMs (ts_N + 2 * blockTime - read);
 *        unset, no header is read (zero extra RPC calls) and both are null.
 *      KEV_STATE_FORMAT (auto = v1 adapter text, default | kev2 = + the 3 v2 lines), TABULAR_MODEL (v1 default | v2;
 *        v2 = node tabular-v2), TABULAR_MODEL_PATH. Kev and tabular inputs are canonicalised to the training orientation
 *        (USDC token0, WETH token1; features.ts canonicalFeatures); Jev's input is unchanged.
 *
 * v4 default ("the AI decides the fee", docs/review/V4_AI_DECIDES.md): no gate. Jev is asked every block and its
 * probability is the fee decision: with arbThresholdPips = 0 and kMin = kDefault = 0 the hook charges
 * base + kMax * p * c * gap on swaps toward the mid, so "no profitable arbitrage" (p near 0) = the base fee, exactly
 * like a vanilla pool, and "toxic arbitrage" = a high k. Every block with arb-direction flow is gradeable.
 *
 * v3 threshold gate (KEEPER_GATE=1 only; docs/review/V3_THRESHOLD_BUILD.md): the hook charges exactly baseFee while the gap is below
 * poolConfig.arbThresholdPips, so k (and hence the model) is irrelevant there. If
 *   gap(pool, CEX mid) < arbThresholdPips - KEEPER_HYSTERESIS_PIPS
 * the keeper skips Jev/heuristic and posts the mid with the deterministic RULE_SCORE (pToxic 10%, confidence 100%)
 * under the dedicated allowlisted node rule-v1.models.oniblock.eth. The settler never grades rule-v1 receipts, so
 * rule-v1 stays unseasoned => the hook sets k = kDefault for the next block; the next model attestation steps k
 * from kDefault (maxKStepBps). Above the threshold the model is called as before (Jev, heuristic fallback under
 * heuristic-v1). Jev call rate (model ticks / attested ticks) is logged on every line and summarised periodically.
 *
 * Live flags (demo controls; the app's dev panel writes this file, the keeper re-reads it each tick):
 *   { "degraded": boolean,        // deliberately wrong model (calibration-gate demo)
 *     "useBackupQuoter": boolean } // send setAttestation from the backup quoter key (kill-switch demo)
 * The backup quoter key is BACKUP_QUOTER_PK, or anvil key #6 on dev chains. Whether it may post is
 * decided on-chain by the role oracle (MockRoleOracle locally, ENSv2 roles on a fork) — not here.
 * Startup preflight (`checkConfig`): the quoter key must be allowed by hook.roleOracle().isQuoter and the attestor key
 * must equal hook.attestor(), else `fatal_config` (addresses only, never keys) and exit 1.
 * Logs JSON lines. Never crashes on per-block errors.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { namehash, parseEventLogs, type Address, type Hex, type PublicClient } from 'viem';
import { oniblockHookAbi, poolStateAbi, roleOracleAbi } from './abi/oniblockHook.js';
import { resolveAttestDomain, signAttestation, type DomainOpts } from './attest.js';
import { MidHistory } from './cex.js';
import { BlockTimeEstimator, blockTimeEnvMs, expectedMidAgeMs, MAINNET_BLOCK_TIME_MS, readLagMs, readLeadMs, SlotScheduler } from './slotclock.js';
import { lazyMidSource } from './pricesource.js';
import {
  env,
  envInt,
  loadDeployment,
  log,
  makePublicClient,
  makeWalletClient,
  oniblockPool,
  pairMeta,
  parseArgs,
  roleAccount,
  ROOT,
  selectChain,
  type ChainName,
  type Deployment,
  type PairMeta,
  type PoolEntry,
  rpcTransport,
} from './config.js';
import { getAttestations, getJitPenalties, getModifyLiquidity, getReceipts, keyTuple, readPool, receiptToSwapObs, TxSender, virtualDepth0 } from './chain.js';
import { computeFeatures, JIT_LABEL_BLOCKS_DEFAULT, type JitPenaltyObs, type LiquidityObs, type SwapObs } from './features.js';
import { defaultJevPrompt, kevStateFormat, score, tabularVersion, type AttackHead, type AttackType, type ModelMode, type ModelScore } from './model/index.js';
import { midToPriceX96, sqrtPriceX96ToPriceX96 } from './price.js';
import { createWalletClient, type Chain, type Transport, type Account, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export interface KeeperFlags {
  degraded?: boolean;
  useBackupQuoter?: boolean;
}

/** Startup misconfiguration: `details` are addresses / flags only (never keys), logged under `fatal_config`. */
export class ConfigError extends Error {
  constructor(message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function keeperFlagsPath(): string {
  return env('KEEPER_FLAGS_FILE', resolve(ROOT, '.runtime', 'keeper-flags.json'))!;
}

let flagsCache: { mtimeMs: number; flags: KeeperFlags } | undefined;
/** Read the live flags file (cheap: re-parsed only when mtime changes). Missing/invalid => {}. */
export function readKeeperFlags(path = keeperFlagsPath()): KeeperFlags {
  try {
    if (!existsSync(path)) return {};
    const m = statSync(path).mtimeMs;
    if (flagsCache?.mtimeMs === m) return flagsCache.flags;
    const j = JSON.parse(readFileSync(path, 'utf8')) as KeeperFlags;
    flagsCache = { mtimeMs: m, flags: j && typeof j === 'object' ? j : {} };
    return flagsCache.flags;
  } catch {
    return {};
  }
}

/** Anvil default account #6 (public dev key) = backup quoter on local/fork chains. */
const ANVIL_KEYS_BACKUP = '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e';

/** `poolState` view: defined in abi/oniblockHook.ts (shared with the JIT bot); re-exported for existing importers. */
export { poolStateAbi } from './abi/oniblockHook.js';

/** CEX mids feeding realizedVolBps (the pre-v2 MidHistory size; unchanged). */
const RECENT_MIDS = 120;

export const DEFAULT_MODEL_NAME = 'jev-v1.models.oniblock.eth';
/** Primary model node name per MODEL_MODE: kev -> kev-v1 (Kev-0.8B) / kev4b-v1 (KEV_MODEL=4b), tabular -> tabular-v1 / tabular-v2 (TABULAR_MODEL=v2), else jev-v1. */
export function defaultModelName(mode = env('MODEL_MODE', 'auto')): string {
  if (mode === 'kev') return env('KEV_MODEL', '0.8b') === '4b' ? 'kev4b-v1.models.oniblock.eth' : 'kev-v1.models.oniblock.eth';
  if (mode === 'tabular') return env('TABULAR_MODEL', 'v1') === 'v2' ? 'tabular-v2.models.oniblock.eth' : 'tabular-v1.models.oniblock.eth';
  return DEFAULT_MODEL_NAME;
}
export const DEFAULT_FALLBACK_MODEL_NAME = 'heuristic-v1.models.oniblock.eth';
export const DEFAULT_RULE_MODEL_NAME = 'rule-v1.models.oniblock.eth';
/** Deterministic below-threshold score (k is irrelevant there: the hook charges baseFee). Low pToxic, full confidence, no JIT signal. */
export const RULE_SCORE = { pToxicBps: 1_000, confidenceBps: 10_000, pJitBps: 0 } as const;

/** v4: the rule-v1 gate is OFF unless KEEPER_GATE=1 (the model decides every block). */
export function keeperGateOn(): boolean {
  return env('KEEPER_GATE', '0') === '1';
}

/**
 * Never combine the v3 gate with kDefault = 0 (the v4 default): rule-v1 is allowlisted but never graded, so every rule
 * post is "unseasoned" and resets k to kDefault — with kDefault = 0 the gate would silently switch the fee law off
 * and make the model's (step-limited) k start from 0 after every quiet stretch. Throws with an explanation.
 */
export function assertGateConfig(gateOn: boolean, kDefaultBps: number | undefined): void {
  if (gateOn && kDefaultBps === 0)
    throw new Error('KEEPER_GATE=1 (v3 rule-v1 gate) with poolConfig.kDefaultBps = 0 is not supported: unset KEEPER_GATE (v4: the model decides every block) or use a v3 pool config');
}

/** Keeper gate (KEEPER_GATE=1 only): 'rule' iff the pool has a threshold and the gap is below it by more than the hysteresis. */
export function gateDecision(gapPips: number, arbThresholdPips: number, hysteresisPips = 100): 'rule' | 'model' {
  if (!(arbThresholdPips > 0)) return 'model';
  return gapPips < arbThresholdPips - hysteresisPips ? 'rule' : 'model';
}

/** CHARGE_THRESHOLD env (header): undefined = unset/empty (gate off); anything outside a number in [0,1] is a ConfigError. */
export function chargeThreshold(raw = env('CHARGE_THRESHOLD')): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const t = Number(raw);
  if (!Number.isFinite(t) || t < 0 || t > 1) throw new ConfigError(`CHARGE_THRESHOLD must be a number in [0,1] (got ${JSON.stringify(raw)})`, { chargeThreshold: raw });
  return t;
}

/**
 * Model v2 charge gate: pToxic unchanged (the settler grades it), confidence = 10000 if p >= t else 0, so the hook's
 * k = kMax * p * c is 0 below t. t undefined = off: the score is returned unchanged (same object).
 */
export function applyChargeThreshold(s: ModelScore, t: number | undefined): ModelScore {
  if (t === undefined) return s;
  return { ...s, confidenceBps: s.pToxicBps / 10_000 >= t ? 10_000 : 0 };
}

export const JIT_CHURN_WEIGHT_DEFAULT = 0.5;
/** JIT_CHURN_WEIGHT env: weight of the observed churn in the posted pJit, clamped to [0,1] (unparseable => default). */
export function jitChurnWeight(raw = env('JIT_CHURN_WEIGHT')): number {
  const w = raw === undefined || raw === '' ? JIT_CHURN_WEIGHT_DEFAULT : Number(raw);
  return Number.isFinite(w) ? Math.max(0, Math.min(1, w)) : JIT_CHURN_WEIGHT_DEFAULT;
}

/**
 * Online calibration of the JIT head against the observed churn of recent liquidity (see the header):
 *   posted = round((1 - w) * pModelBps + w * churn * 10000)
 * `churn` = liqChurn200 in [0,1]; `undefined` = no adds in the last 200 blocks (no base rate) => pModelBps unchanged.
 * `w` is clamped to [0,1]. All values bps in, bps out (clamped to 0..10000).
 */
export function blendPJit(pModelBps: number, churn: number | undefined, w: number): number {
  if (churn === undefined || !Number.isFinite(churn)) return pModelBps;
  const ww = Number.isFinite(w) ? Math.max(0, Math.min(1, w)) : JIT_CHURN_WEIGHT_DEFAULT;
  const c = Math.max(0, Math.min(1, churn));
  return Math.max(0, Math.min(10_000, Math.round((1 - ww) * pModelBps + ww * c * 10_000)));
}

export interface KeeperStats {
  ticks: number; // attestations attempted (posted or not) after scoring
  ruleTicks: number; // below threshold: no model call
  modelTicks: number; // model called (Jev attempted unless mode=heuristic)
  jevAnswers: number; // model ticks answered by Jev (not the heuristic fallback)
  /** modelTicks / ticks */
  jevCallRate: number;
}

export interface KeeperOpts {
  chain: ChainName;
  degraded?: boolean | (() => boolean);
  every?: number;
  mode?: ModelMode;
  poolName?: string;
  /** Override the mid source (default: PRICE_SOURCE env, live Binance bookTicker or block-indexed
   *  replay — see pricesource.ts). Called with the observed block number. Returns human USDC/ETH. */
  midSource?: (block?: number) => Promise<number>;
  deployment?: Deployment;
}

export interface KeeperTickResult {
  block: number;
  posted: boolean;
  hash?: Hex;
  score?: ModelScore;
  mid?: number;
  gapPips?: number;
  reason?: string;
  /** true if the v3 gate posted the rule score (no model call). */
  rule?: boolean;
  arbThresholdPips?: number;
  /** v5: the JIT window (blocks) the hook set from this attestation (AttestationPosted.jitWindow), if the tx was mined. */
  jitWindow?: number;
  /** v5: pJit actually attested = blendPJit(score.pJitBps, observed churn, JIT_CHURN_WEIGHT); score.pJitBps is the raw model answer. */
  pJitBps?: number;
  /** v6: the model's attack-type head (choice + full distribution + confidence), if the model has one. */
  attack?: AttackHead;
}

// ---------------------------------------------------------------------------------------------- v6 verdicts file

/** One JSON line per posted attestation (the app's /api/verdicts reads the tail). Never carries keys or signatures. */
export interface Verdict {
  /** observed block (features) and the attested target block */
  block: number;
  target: number;
  /** P(next block contains LP-costly flow) in [0,1] (null for models without a v6 head) */
  pMalicious: number | null;
  /** most likely attack type (null for models without a v6 head) */
  attack: AttackType | null;
  /** full type distribution, 2 decimals (null for models without a v6 head) */
  attackProbs: Record<AttackType, number> | null;
  /** the two attested numbers (pJitBps after the churn blend) */
  pToxicBps: number;
  pJitBps: number;
  /** what the hook derived (AttestationPosted), when the event was decoded */
  k?: number;
  jitWindow?: number;
  model: ModelScore['model'];
  txHash: Hex;
}

/** Round every probability to 2 decimals (compact log / verdict form). */
export function compactProbs(p: Record<AttackType, number>): Record<AttackType, number> {
  const out = {} as Record<AttackType, number>;
  for (const k of Object.keys(p) as AttackType[]) out[k] = Math.round(p[k] * 100) / 100;
  return out;
}

/** VERDICTS_FILE, else <DEMO_RUNTIME_DIR | <root>/.runtime>/verdicts.<chainId>.jsonl. */
export function verdictsPath(chainId: number): string {
  return env('VERDICTS_FILE') ?? resolve(env('DEMO_RUNTIME_DIR', resolve(ROOT, '.runtime'))!, `verdicts.${chainId}.jsonl`);
}

export const VERDICTS_KEEP = 5000;
export const VERDICTS_REWRITE_AT = 6000;

/**
 * Append-only JSONL verdict log, capped: once the file holds more than `rewriteAt` lines it is rewritten with the last
 * `keep` lines (so steady state is one cheap append per block and a rewrite every keep-rewriteAt blocks). Never throws:
 * a write error is logged once per path and the keeper carries on.
 */
export class VerdictLog {
  private lines: number | undefined;
  private warned = false;
  constructor(readonly path: string, private readonly keep = VERDICTS_KEEP, private readonly rewriteAt = VERDICTS_REWRITE_AT) {}

  /** Current line count (counted from the file on first use). */
  size(): number {
    if (this.lines === undefined) {
      try {
        this.lines = existsSync(this.path) ? readFileSync(this.path, 'utf8').split('\n').filter((l) => l.length > 0).length : 0;
      } catch {
        this.lines = 0;
      }
    }
    return this.lines;
  }

  append(v: Verdict): boolean {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const n = this.size();
      if (n + 1 > this.rewriteAt) {
        const kept = (existsSync(this.path) ? readFileSync(this.path, 'utf8').split('\n').filter((l) => l.length > 0) : []).slice(-(this.keep - 1));
        kept.push(JSON.stringify(v));
        writeFileSync(this.path, kept.join('\n') + '\n');
        this.lines = kept.length;
      } else {
        appendFileSync(this.path, JSON.stringify(v) + '\n');
        this.lines = n + 1;
      }
      return true;
    } catch (e) {
      if (!this.warned) {
        this.warned = true;
        log('keeper', 'verdict_write_error', { path: this.path, error: (e as Error).message.split('\n')[0] });
      }
      return false;
    }
  }
}

/** Pool fee/JIT config the keeper needs (hook.poolConfig subset; deployment JSON fallback). */
export interface PoolCfg {
  baseFee: number;
  feeMax: number;
  arbThresholdPips: number;
  kDefaultBps?: number;
  /** v5: window used for adds while the attestation is stale / the JIT head is unseasoned or demoted. */
  jitWindowDefault?: number;
  /** poolConfig.staleBlocks (attestation older than this => stale => jitWindowDefault in force). */
  staleBlocks?: number;
}

export function modelNodes(d?: Deployment) {
  const name = env('MODEL_NAME', defaultModelName())!;
  const fb = env('FALLBACK_MODEL_NAME', DEFAULT_FALLBACK_MODEL_NAME)!;
  return {
    primary: (env('MODEL_NODE') as Hex | undefined) ?? d?.modelNode ?? namehash(name),
    primaryName: name,
    fallback: namehash(fb),
    fallbackName: fb,
    rule: namehash(env('RULE_MODEL_NAME', DEFAULT_RULE_MODEL_NAME)!),
    ruleName: env('RULE_MODEL_NAME', DEFAULT_RULE_MODEL_NAME)!,
  };
}

export class Keeper {
  readonly pc: PublicClient;
  readonly d: Deployment;
  readonly pool: PoolEntry;
  readonly meta: PairMeta;
  private readonly sender: TxSender;
  private readonly backupSender: TxSender | undefined;
  private readonly attestor;
  /** Time-stamped CEX mids: the last RECENT_MIDS feed realizedVolBps (unchanged), the whole buffer the v2 features (ret900Bps
   *  needs >= 900 s of history: 75 ticks at 12 s blocks; the extra room covers fast local chains). */
  private readonly mids = new MidHistory(1_000);
  private swaps: SwapObs[] = [];
  /** v5: recent ModifyLiquidity (PoolManager) and JitPenalty (hook) logs of our pool (last ~400 blocks). */
  private liquidity: LiquidityObs[] = [];
  private jitPenalties: JitPenaltyObs[] = [];
  private scannedTo = -1;
  private lastAttestBlock = 0;
  private busy = false;
  private gen = 0;
  /** Observed block time (local/fork chains without KEEPER_BLOCK_TIME_MS). */
  private readonly blockTimes = new BlockTimeEstimator();
  private readonly nodes;
  private domain: Required<DomainOpts> | undefined;
  private readonly midSource: (block?: number) => Promise<number>;
  private chainCfg: PoolCfg | undefined;
  private cfgReadAt = -1;
  /** v6: per-block verdicts for the app (verdictsPath(chainId)). */
  readonly verdicts: VerdictLog;
  readonly stats: KeeperStats = { ticks: 0, ruleTicks: 0, modelTicks: 0, jevAnswers: 0, jevCallRate: 0 };

  constructor(private readonly o: KeeperOpts) {
    const sel = selectChain(o.chain);
    this.pc = makePublicClient(sel);
    this.d = o.deployment ?? loadDeployment(sel.chain.id);
    this.pool = oniblockPool(this.d, o.poolName);
    this.meta = pairMeta(this.d, this.pool);
    this.sender = new TxSender(this.pc, makeWalletClient(sel, 'quoter'), 'keeper');
    const backupPk = env('BACKUP_QUOTER_PK') ?? (sel.isDev ? ANVIL_KEYS_BACKUP : undefined);
    if (backupPk) {
      const wc: WalletClient<Transport, Chain, Account> = createWalletClient({
        chain: sel.chain,
        account: privateKeyToAccount((backupPk.startsWith('0x') ? backupPk : `0x${backupPk}`) as `0x${string}`),
        transport: rpcTransport(sel),
      });
      this.backupSender = new TxSender(this.pc, wc, 'keeper-backup');
    }
    this.attestor = roleAccount('attestor', sel);
    this.nodes = modelNodes(this.d);
    this.midSource = o.midSource ?? lazyMidSource(this.d.startBlock ?? 0, 'keeper');
    this.verdicts = new VerdictLog(verdictsPath(this.d.chainId));
  }

  private isDegraded(): boolean {
    const d = this.o.degraded;
    if (typeof d === 'function') return d();
    if (d) return true;
    const f = env('DEGRADED_FILE');
    if (f && existsSync(f)) return true;
    return readKeeperFlags().degraded === true;
  }

  /** Quoter used for this tick: backup key if the live flag asks for it (and one is configured). */
  private quoterSender(): TxSender {
    return readKeeperFlags().useBackupQuoter && this.backupSender ? this.backupSender : this.sender;
  }

  /** Pool fee config from the deployment JSON (fallback when hook.poolConfig is unreadable). */
  private get fileCfg(): PoolCfg {
    const c = (this.d.raw.pools as Record<string, { config?: { baseFee?: number; feeMax?: number; arbThresholdPips?: number; kDefaultBps?: number; jitWindowDefault?: number; staleBlocks?: number } }> | undefined)?.[this.pool.name]?.config;
    return {
      baseFee: Number(c?.baseFee ?? envInt('BASE_FEE_PIPS', 3000)),
      feeMax: Number(c?.feeMax ?? 10_000),
      arbThresholdPips: Number(c?.arbThresholdPips ?? 0),
      kDefaultBps: c?.kDefaultBps === undefined ? undefined : Number(c.kDefaultBps),
      jitWindowDefault: c?.jitWindowDefault === undefined ? undefined : Number(c.jitWindowDefault),
      staleBlocks: c?.staleBlocks === undefined ? undefined : Number(c.staleBlocks),
    };
  }

  /** Live pool fee config (hook.poolConfig; re-read every 100 blocks and immediately after a PoolConfigUpdated). */
  private async poolCfg(block: number): Promise<PoolCfg> {
    if (this.chainCfg && block - this.cfgReadAt < 100) return this.chainCfg;
    try {
      const c = await this.pc.readContract({ address: this.d.hook, abi: oniblockHookAbi, functionName: 'poolConfig', args: [this.pool.poolId] });
      this.chainCfg = { baseFee: Number(c.baseFee), feeMax: Number(c.feeMax), arbThresholdPips: Number(c.arbThresholdPips), kDefaultBps: Number(c.kDefaultBps), jitWindowDefault: Number(c.jitWindowDefault), staleBlocks: Number(c.staleBlocks) };
      this.cfgReadAt = block;
      return this.chainCfg;
    } catch {
      return this.chainCfg ?? this.fileCfg;
    }
  }

  /** Stored pool state: k (what an arbitrageur faces this block) and the v5 JIT window/pJit. undefined if unreadable -> base-fee wording. */
  private async currentState(): Promise<{ kBps: number; jitWindow: number; pJitBps: number } | undefined> {
    try {
      const [st] = await this.pc.readContract({ address: this.d.hook, abi: poolStateAbi, functionName: 'poolState', args: [this.pool.poolId] });
      return { kBps: Number(st.kBps), jitWindow: Number(st.jitWindow), pJitBps: Number(st.pJitBps) };
    } catch {
      return undefined;
    }
  }

  /** CEX mid for the observed block (same time index as the arb bot when PRICE_SOURCE=replay). */
  private mid(block: number): Promise<number> {
    return this.midSource(block);
  }

  /** Incrementally pull Receipt (+ v5 ModifyLiquidity / JitPenalty) logs for our pool (keeps last ~200 / ~400 blocks). */
  private async refreshSwaps(block: number) {
    const first = this.scannedTo < 0;
    const from = first ? Math.max(0, block - 50) : this.scannedTo + 1;
    if (from > block) return;
    // Liquidity events are sparse: on the first scan look further back so churn / lifetime features have history.
    const liqFrom = first ? Math.max(0, block - 400) : from;
    const [rs, cfgEvents, liq, pen] = await Promise.all([
      getReceipts(this.pc, this.d.hook, this.pool.poolId, BigInt(from), BigInt(block)),
      this.pc
        .getContractEvents({ address: this.d.hook, abi: oniblockHookAbi, eventName: 'PoolConfigUpdated', args: { id: this.pool.poolId }, fromBlock: BigInt(from), toBlock: BigInt(block) })
        .catch(() => []),
      getModifyLiquidity(this.pc, this.d.poolManager, this.pool.poolId, BigInt(liqFrom), BigInt(block)).catch((e) => {
        log('keeper', 'liquidity_logs_error', { block, error: (e as Error).message.split('\n')[0] });
        return [];
      }),
      getJitPenalties(this.pc, this.d.hook, this.pool.poolId, BigInt(liqFrom), BigInt(block)).catch(() => []),
    ]);
    if (cfgEvents.length) {
      this.chainCfg = undefined; // a timelocked config change executed: re-read poolConfig on this tick
      log('keeper', 'pool_config_updated', { block, events: cfgEvents.length });
    }
    this.swaps.push(...rs.map(receiptToSwapObs));
    this.swaps = this.swaps.filter((s) => s.block > block - 200);
    this.liquidity.push(...liq);
    this.liquidity = this.liquidity.filter((o) => o.block > block - 400);
    this.jitPenalties.push(...pen);
    this.jitPenalties = this.jitPenalties.filter((o) => o.block > block - 400);
    if (this.scannedTo < 0) {
      const at = await getAttestations(this.pc, this.d.hook, this.pool.poolId, BigInt(from), BigInt(block));
      if (at.length) this.lastAttestBlock = at[at.length - 1]!.blockNumber;
    }
    this.scannedTo = block;
  }

  /** KEEPER_EVERY filter (shared by tick and the slot scheduler, so a skipped block never cancels a pending tick). */
  private skipsBlock(block: number): boolean {
    const every = this.o.every ?? envInt('KEEPER_EVERY', 1);
    return every > 1 && block % every !== 0;
  }

  /** Block time for the slot clock / mid-age log: KEEPER_BLOCK_TIME_MS, else 12 s on sepolia, else observed (local/fork). */
  blockTimeMs(): number {
    return blockTimeEnvMs() ?? (this.o.chain === 'sepolia' ? MAINNET_BLOCK_TIME_MS : this.blockTimes.value());
  }

  /** Block header timestamp (ms), slot mode only; undefined if unreadable (the scheduler then uses the arrival time). */
  private async blockTsMs(block: number): Promise<number | undefined> {
    try {
      return Number((await this.pc.getBlock({ blockNumber: BigInt(block) })).timestamp) * 1000;
    } catch {
      return undefined;
    }
  }

  /** `slot.blockTsMs`: ts_N from the slot scheduler (slot mode only; without it no header is read and the lag fields are null). */
  async tick(block: number, slot?: { blockTsMs?: number }): Promise<KeeperTickResult> {
    if (this.skipsBlock(block)) return { block, posted: false, reason: 'every' };
    if (this.busy) return { block, posted: false, reason: 'busy' };
    this.busy = true;
    const gen = ++this.gen;
    const t0 = performance.now();
    try {
      let tObs = Date.now();
      const [mid, pool, state, cfg] = await Promise.all([
        this.mid(block).then((m) => ((tObs = Date.now()), m)), // t_obs = CEX read time (v2 features)
        readPool(this.pc, this.d.poolManager, this.pool.poolId),
        this.currentState(),
        this.refreshSwaps(block).then(() => this.poolCfg(block)), // a PoolConfigUpdated in range invalidates the cache first
      ]);
      const kBps = state?.kBps;
      // Window in force for adds now: the attested one unless stale (then the pool's default), else unknown.
      const stale = this.lastAttestBlock > 0 && block - this.lastAttestBlock > (cfg.staleBlocks ?? envInt('STALE_BLOCKS', 5));
      const jitWindowNow = state && !stale ? state.jitWindow : (cfg.jitWindowDefault ?? state?.jitWindow);
      this.mids.push(mid, tObs);
      const oracleX96 = midToPriceX96(mid.toFixed(8), this.meta);
      const poolX96 = sqrtPriceX96ToPriceX96(pool.sqrtPriceX96);
      const target = block + envInt('ATTEST_BLOCK_OFFSET', 1);
      const f = computeFeatures({
        swaps: this.swaps,
        oracleX96,
        poolX96,
        depth0: virtualDepth0(pool),
        recentMids: this.mids.mids().slice(-RECENT_MIDS),
        midHistory: this.mids.entries(),
        tObsMs: tObs,
        currentBlock: block,
        lastAttestBlock: this.lastAttestBlock || block,
        baseFee: cfg.baseFee,
        feeMax: cfg.feeMax,
        kBps,
        arbThresholdPips: cfg.arbThresholdPips,
        baseIsToken0: this.meta.baseIsToken0,
        liquidity: this.liquidity,
        jitPenalties: this.jitPenalties,
        currentTick: pool.tick,
        jitWindowNow,
        jitLabelBlocks: envInt('JIT_LABEL_BLOCKS', JIT_LABEL_BLOCKS_DEFAULT),
      });
      const gated = keeperGateOn();
      assertGateConfig(gated, cfg.kDefaultBps);
      const rule = gated && gateDecision(f.gapPips, cfg.arbThresholdPips, envInt('KEEPER_HYSTERESIS_PIPS', 100)) === 'rule';
      const scored: ModelScore = rule
        ? { ...RULE_SCORE, cls: 'unknown', latencyMs: 0, model: 'rule' }
        : await score(f, { mode: this.o.mode, degraded: this.isDegraded(), baseIsToken0: this.meta.baseIsToken0 });
      // Model v2 charge gate (header CHARGE_THRESHOLD): after score()/degrade(), before signing. Unset = unchanged.
      const chargeT = rule ? undefined : chargeThreshold();
      const s = applyChargeThreshold(scored, chargeT);
      const st = this.stats;
      st.ticks++;
      if (rule) st.ruleTicks++;
      else {
        st.modelTicks++;
        if (s.model === 'jev') st.jevAnswers++;
      }
      st.jevCallRate = st.modelTicks / st.ticks;
      const node = rule
        ? this.nodes.rule
        : s.model === 'jev' || s.model === 'kev' || s.model === 'tabular' || env('FALLBACK_SAME_NODE') === '1'
          ? this.nodes.primary
          : this.nodes.fallback;
      // v5 online calibration of the JIT head (header): shrink the model's pJit toward the observed churn of recent
      // liquidity. The churn is only a base rate when there were adds in the last 200 blocks (same window as the feature).
      const adds200 = this.liquidity.filter((o) => o.liquidityDelta > 0n && o.block > block - 200 && o.block <= block).length;
      const pJitChurn = adds200 > 0 ? (f.liqChurn200 ?? 0) : undefined;
      const churnWeight = jitChurnWeight();
      const pJitPosted = rule ? s.pJitBps : blendPJit(s.pJitBps, pJitChurn, churnWeight);
      this.domain ??= await resolveAttestDomain(this.pc, this.d.hook, (this.d.raw.eip712 ?? {}) as DomainOpts);
      const att = await signAttestation(this.attestor, this.d.chainId, this.d.hook, {
        poolId: this.pool.poolId,
        blockNumber: BigInt(target),
        oracleMidX96: oracleX96,
        pToxicBps: s.pToxicBps,
        confidenceBps: s.confidenceBps,
        pJitBps: pJitPosted,
        modelNode: node,
      }, this.domain);
      const sender = this.quoterSender();
      const rc = await sender.send({
        address: this.d.hook,
        abi: oniblockHookAbi,
        functionName: 'setAttestation',
        args: [keyTuple(this.pool.key), att],
        label: `attest@${target}`,
        onBroadcast: () => (this.busy = false), // next block may start while we wait for the receipt
      });
      const ok = rc?.status === 'success';
      if (ok) this.lastAttestBlock = target;
      // v5: the window the hook derived from (pJit, confidence, JIT calibration) — from the mined AttestationPosted;
      // v6 verdicts also record the k it derived.
      let jitWindow: number | undefined;
      let kPosted: number | undefined;
      if (ok && rc?.logs) {
        try {
          const ev = parseEventLogs({ abi: oniblockHookAbi, eventName: 'AttestationPosted', logs: rc.logs, strict: false }).find((l) => l.address.toLowerCase() === this.d.hook.toLowerCase());
          if (ev?.args.jitWindow !== undefined) jitWindow = Number(ev.args.jitWindow);
          if (ev?.args.kBps !== undefined) kPosted = Number(ev.args.kBps);
        } catch {
          /* old hook without the v5 event fields: window unknown */
        }
      }
      // Slot clock (header KEEPER_READ_LEAD_MS): how late after ts_N the mid was read, and how old it will be at the first
      // swap of block N+2 (the first block this attestation fully prices, tx included at the end of N+1).
      // Slot mode only: ts_N comes from the scheduler; on-arrival mode makes no extra RPC call and logs null.
      const blockTs = slot?.blockTsMs;
      const bt = this.blockTimeMs();
      const lagMs = blockTs === undefined ? null : readLagMs(tObs, blockTs);
      const midAgeMs = blockTs === undefined ? null : expectedMidAgeMs(tObs, blockTs, bt);
      // v6: the one score + the type that allocated it (null for models without the head: rule / kev / tabular)
      const pMalicious = s.pMaliciousBps === undefined ? null : Math.round(s.pMaliciousBps) / 10_000;
      const attackProbs = s.attack ? compactProbs(s.attack.probabilities) : null;
      const round4 = (x: number | undefined) => (x === undefined ? null : Math.round(x * 10_000) / 10_000);
      log('keeper', ok ? 'attested' : 'attest_failed', {
        block,
        target,
        mined: rc?.blockNumber,
        mid,
        gapPips: f.gapPips,
        arbThresholdPips: cfg.arbThresholdPips,
        arbFeePips: f.arbFeePips,
        model: s.model,
        rule,
        jevCallRate: +st.jevCallRate.toFixed(3),
        ruleTicks: st.ruleTicks,
        modelTicks: st.modelTicks,
        degraded: !!s.degraded,
        pToxicBps: s.pToxicBps,
        confidenceBps: s.confidenceBps,
        // v2 charge gate: p = posted pToxic, charged = p >= chargeThreshold (null = gate off); modelConfidenceBps = pre-gate
        p: s.pToxicBps / 10_000,
        chargeThreshold: chargeT ?? null,
        charged: chargeT === undefined ? null : s.confidenceBps > 0,
        modelConfidenceBps: scored.confidenceBps,
        // JIT head: pJitBps = posted = blend(pJitModel, pJitChurn, jitChurnWeight); pJitChurn null = no adds in 200 blocks (model unchanged)
        pJitModel: s.pJitBps,
        pJitChurn: pJitChurn ?? null,
        jitChurnWeight: churnWeight,
        pJitBps: pJitPosted,
        jitWindow,
        jitWindowBefore: jitWindowNow,
        liqAdds20: f.liqAdds20,
        liqAdds200: adds200,
        liqChurn200: f.liqChurn200,
        cls: s.cls,
        // v6 head: pMalicious is the one score, attack the type that allocated it (pPriceShare -> k, pJitShare -> JIT window)
        pMalicious,
        attack: s.attack?.choice ?? null,
        attackProbs,
        attackConfidence: round4(s.attack?.confidence),
        pPriceShare: round4(s.pPriceShare),
        pJitShare: round4(s.pJitShare),
        jevPrompt: defaultJevPrompt(),
        modelLatencyMs: s.latencyMs,
        // slot clock: readLagMs = CEX read - ts_N; expectedMidAgeMs = ts_N + 2 * blockTimeMs - read (age at N+2's first swap)
        readLagMs: lagMs,
        expectedMidAgeMs: midAgeMs,
        blockTimeMs: bt,
        readLeadMs: readLeadMs() ?? null,
        tickMs: Math.round(performance.now() - t0),
        quoter: sender.address,
        tx: rc?.hash,
      });
      const statsEvery = envInt('KEEPER_STATS_EVERY', 50);
      if (statsEvery > 0 && st.ticks % statsEvery === 0) log('keeper', 'jev_rate', { ...st, jevCallRate: +st.jevCallRate.toFixed(3) });
      if (ok && rc?.hash) {
        this.verdicts.append({
          block,
          target,
          pMalicious,
          attack: s.attack?.choice ?? null,
          attackProbs,
          pToxicBps: s.pToxicBps,
          pJitBps: pJitPosted,
          ...(kPosted !== undefined ? { k: kPosted } : {}),
          ...(jitWindow !== undefined ? { jitWindow } : {}),
          model: s.model,
          txHash: rc.hash,
        });
      }
      return { block, posted: ok, hash: rc?.hash, score: s, mid, gapPips: f.gapPips, reason: ok ? undefined : 'tx', rule, arbThresholdPips: cfg.arbThresholdPips, jitWindow, pJitBps: pJitPosted, attack: s.attack };
    } catch (e) {
      log('keeper', 'tick_error', { block, error: (e as Error).message.split('\n')[0] });
      return { block, posted: false, reason: (e as Error).message };
    } finally {
      if (this.gen === gen) this.busy = false;
    }
  }

  /**
   * Startup check (CLI): refuse KEEPER_GATE=1 on a kDefault = 0 pool (see assertGateConfig), and verify the roles
   * on-chain: hook.roleOracle().isQuoter(quoter key) and hook.attestor() == attestor key. A mismatch throws a
   * ConfigError carrying the addresses (the CLI logs `fatal_config` and exits 1); an unreadable view is logged as
   * `preflight_unverified` and does not stop the keeper (transient RPC trouble is not a configuration error).
   */
  async checkConfig(): Promise<void> {
    const cfg = await this.poolCfg(Number(await this.pc.getBlockNumber()));
    assertGateConfig(keeperGateOn(), cfg.kDefaultBps);
    chargeThreshold(); // throws ConfigError on an invalid CHARGE_THRESHOLD
    try {
      readLeadMs();
      blockTimeEnvMs();
    } catch (e) {
      throw new ConfigError((e as Error).message);
    }
    await this.checkRoles();
  }

  /** Quoter / attestor preflight (see checkConfig). Exposed for --once too; never logs keys. */
  async checkRoles(): Promise<void> {
    const quoter = this.sender.address;
    const attestor = this.attestor.address;
    let roleOracle: Address | undefined;
    let hookAttestor: Address | undefined;
    let isQuoter: boolean | undefined;
    try {
      [roleOracle, hookAttestor] = await Promise.all([
        this.pc.readContract({ address: this.d.hook, abi: oniblockHookAbi, functionName: 'roleOracle' }),
        this.pc.readContract({ address: this.d.hook, abi: oniblockHookAbi, functionName: 'attestor' }),
      ]);
      isQuoter = await this.pc.readContract({ address: roleOracle, abi: roleOracleAbi, functionName: 'isQuoter', args: [quoter] });
    } catch (e) {
      log('keeper', 'preflight_unverified', { hook: this.d.hook, roleOracle, quoter, attestor, error: (e as Error).message.split('\n')[0] });
      return;
    }
    const details = { hook: this.d.hook, roleOracle, quoter, isQuoter, attestor, hookAttestor };
    if (!isQuoter) throw new ConfigError(`quoter ${quoter} is not allowed by roleOracle ${roleOracle} (isQuoter = false)`, details);
    if (hookAttestor.toLowerCase() !== attestor.toLowerCase()) throw new ConfigError(`attestor key ${attestor} != hook.attestor() ${hookAttestor}`, details);
    log('keeper', 'preflight_ok', details);
  }

  /** Watch new blocks forever; returns an unwatch fn. */
  run(): () => void {
    log('keeper', 'start', {
      chain: this.o.chain,
      hook: this.d.hook,
      poolId: this.pool.poolId,
      quoter: this.sender.address,
      backupQuoter: this.backupSender?.address,
      flagsFile: keeperFlagsPath(),
      attestor: this.attestor.address,
      modelNode: this.nodes.primary,
      modelName: this.nodes.primaryName,
      fallbackNode: this.nodes.fallback,
      ruleNode: this.nodes.rule,
      gate: keeperGateOn(),
      chargeThreshold: chargeThreshold() ?? null,
      readLeadMs: readLeadMs() ?? null,
      kevStateFormat: kevStateFormat(),
      tabularModel: tabularVersion(),
      jevPrompt: defaultJevPrompt(),
      jitLabelBlocks: envInt('JIT_LABEL_BLOCKS', JIT_LABEL_BLOCKS_DEFAULT),
      priceSource: env('PRICE_SOURCE', 'live'),
      verdictsFile: this.verdicts.path,
    });
    const lead = readLeadMs();
    if (lead === undefined) {
      return this.pc.watchBlockNumber({
        emitOnBegin: true,
        emitMissed: false,
        onBlockNumber: (bn) => void this.tick(Number(bn)),
        onError: (e) => log('keeper', 'watch_error', { error: e.message.split('\n')[0] }),
      });
    }
    // Slot clock: tick block N at ts_N + blockTime - lead; a newer block cancels and re-arms (each block ticks at most once).
    const sched = new SlotScheduler({ leadMs: lead, blockTimeMs: () => this.blockTimeMs(), fire: (b, ts) => void this.tick(b, { blockTsMs: ts }) });
    const unwatch = this.pc.watchBlockNumber({
      emitOnBegin: true,
      emitMissed: false,
      onBlockNumber: async (bn) => {
        const block = Number(bn);
        if (this.skipsBlock(block)) return;
        const arrived = Date.now();
        const ts = await this.blockTsMs(block);
        if (ts !== undefined) this.blockTimes.observe(block, ts);
        else log('keeper', 'slot_header_error', { block }); // arrival time as an upper bound of ts_N: schedules late, never early
        const r = sched.arm(block, ts ?? arrived);
        if (r.armed && r.replaced !== undefined) log('keeper', 'slot_rearmed', { block, cancelled: r.replaced, delayMs: r.delayMs });
      },
      onError: (e) => log('keeper', 'watch_error', { error: e.message.split('\n')[0] }),
    });
    return () => {
      unwatch();
      sched.cancel();
    };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = parseArgs();
  const k = new Keeper({
    chain: (a.chain as ChainName) ?? (env('CHAIN', 'local') as ChainName),
    degraded: a.degraded === true,
    every: a.every ? Number(a.every) : undefined,
    mode: a.mode as ModelMode | undefined,
    poolName: a.pool as string | undefined,
  });
  try {
    await k.checkConfig();
  } catch (e) {
    log('keeper', 'fatal_config', { ...(e instanceof ConfigError ? e.details : {}), error: (e as Error).message });
    process.exit(1);
  }
  if (a.once) {
    const bn = Number(await k.pc.getBlockNumber());
    const r = await k.tick(bn);
    process.exit(r.posted ? 0 : 1);
  } else {
    k.run();
  }
}
