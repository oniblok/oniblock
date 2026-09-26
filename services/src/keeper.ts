/**
 * Keeper: once per block, post (oracleMid, pToxic, confidence, modelNode, sig) to the hook.
 *
 *   new block -> CEX mid + pool price + recent Receipts -> features -> model (Jev|heuristic)
 *             -> EIP-712 sign with attestor key -> setAttestation from quoter key
 *
 * CLI: tsx src/keeper.ts [--chain local|fork|sepolia] [--once] [--degraded] [--every N]
 *                        [--mode auto|jev|heuristic|kev|tabular] [--pool NAME]   (kev/tabular: set MODEL_MODE env so the default model node is kev-v1 / kev4b-v1 / tabular-v1)
 * Env: KEEPER_EVERY (default 1), ATTEST_BLOCK_OFFSET (default 1), MODEL_NAME,
 *      FALLBACK_MODEL_NAME, RULE_MODEL_NAME (default rule-v1.models.oniblock.eth),
 *      KEEPER_GATE (default 0 = v4: the model is asked EVERY block; 1 = the v3 rule-v1 gate, kept for comparison),
 *      KEEPER_HYSTERESIS_PIPS (default 100, gate only), JEV_PROMPT (default v4; v1 = pre-v4 question + state),
 *      KEEPER_STATS_EVERY (ticks between `jev_rate` summary lines, default 50),
 *      DEGRADED_FILE (touch file to toggle degraded mode live),
 *      KEEPER_FLAGS_FILE (default <root>/.runtime/keeper-flags.json), BACKUP_QUOTER_PK.
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
 * Logs JSON lines. Never crashes on per-block errors.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { namehash, parseAbi, type Hex, type PublicClient } from 'viem';
import { oniblockHookAbi } from './abi/oniblockHook.js';
import { resolveAttestDomain, signAttestation, type DomainOpts } from './attest.js';
import { MidHistory } from './cex.js';
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
} from './config.js';
import { getAttestations, getReceipts, keyTuple, readPool, receiptToSwapObs, TxSender, virtualDepth0 } from './chain.js';
import { computeFeatures, type SwapObs } from './features.js';
import { score, type ModelMode, type ModelScore } from './model/index.js';
import { midToPriceX96, sqrtPriceX96ToPriceX96 } from './price.js';
import { createWalletClient, http, type Chain, type Transport, type Account, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export interface KeeperFlags {
  degraded?: boolean;
  useBackupQuoter?: boolean;
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

/** Minimal poolState view (nested tuples; not in the hand-written ABI). Only state.kBps is used. */
const poolStateAbi = parseAbi([
  'function poolState(bytes32 id) view returns ((bool registered,bool initialized,uint8 decimals0,uint8 decimals1,uint32 kBps,uint64 lastAttestBlock,uint64 lastPostBlock,uint32 pToxicBps,uint32 confidenceBps,uint256 oracleMidX96,bytes32 modelNode) state, (uint64 blockNumber,bool stale,uint32 kBps,uint32 gapZeroForOne,uint32 gapOneForZero,uint64 attestBlock,bytes32 modelNode) anchor, bool staleNow)',
]);

export const DEFAULT_MODEL_NAME = 'jev-v1.models.oniblock.eth';
/** Primary model node name per MODEL_MODE: kev -> kev-v1 (Kev-0.8B) / kev4b-v1 (KEV_MODEL=4b), tabular -> tabular-v1, else jev-v1. */
export function defaultModelName(mode = env('MODEL_MODE', 'auto')): string {
  if (mode === 'kev') return env('KEV_MODEL', '0.8b') === '4b' ? 'kev4b-v1.models.oniblock.eth' : 'kev-v1.models.oniblock.eth';
  if (mode === 'tabular') return 'tabular-v1.models.oniblock.eth';
  return DEFAULT_MODEL_NAME;
}
export const DEFAULT_FALLBACK_MODEL_NAME = 'heuristic-v1.models.oniblock.eth';
export const DEFAULT_RULE_MODEL_NAME = 'rule-v1.models.oniblock.eth';
/** Deterministic below-threshold score (k is irrelevant there: the hook charges baseFee). Low pToxic, full confidence. */
export const RULE_SCORE = { pToxicBps: 1_000, confidenceBps: 10_000 } as const;

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
  private readonly mids = new MidHistory(120);
  private swaps: SwapObs[] = [];
  private scannedTo = -1;
  private lastAttestBlock = 0;
  private busy = false;
  private gen = 0;
  private readonly nodes;
  private domain: Required<DomainOpts> | undefined;
  private readonly midSource: (block?: number) => Promise<number>;
  private chainCfg: { baseFee: number; feeMax: number; arbThresholdPips: number; kDefaultBps?: number } | undefined;
  private cfgReadAt = -1;
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
        transport: http(sel.rpcUrl, { retryCount: 3, retryDelay: 250 }),
      });
      this.backupSender = new TxSender(this.pc, wc, 'keeper-backup');
    }
    this.attestor = roleAccount('attestor', sel);
    this.nodes = modelNodes(this.d);
    this.midSource = o.midSource ?? lazyMidSource(this.d.startBlock ?? 0, 'keeper');
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
  private get fileCfg(): { baseFee: number; feeMax: number; arbThresholdPips: number; kDefaultBps?: number } {
    const c = (this.d.raw.pools as Record<string, { config?: { baseFee?: number; feeMax?: number; arbThresholdPips?: number; kDefaultBps?: number } }> | undefined)?.[this.pool.name]?.config;
    return {
      baseFee: Number(c?.baseFee ?? envInt('BASE_FEE_PIPS', 3000)),
      feeMax: Number(c?.feeMax ?? 10_000),
      arbThresholdPips: Number(c?.arbThresholdPips ?? 0),
      kDefaultBps: c?.kDefaultBps === undefined ? undefined : Number(c.kDefaultBps),
    };
  }

  /** Live pool fee config (hook.poolConfig; re-read every 100 blocks and immediately after a PoolConfigUpdated). */
  private async poolCfg(block: number): Promise<{ baseFee: number; feeMax: number; arbThresholdPips: number; kDefaultBps?: number }> {
    if (this.chainCfg && block - this.cfgReadAt < 100) return this.chainCfg;
    try {
      const c = await this.pc.readContract({ address: this.d.hook, abi: oniblockHookAbi, functionName: 'poolConfig', args: [this.pool.poolId] });
      this.chainCfg = { baseFee: Number(c.baseFee), feeMax: Number(c.feeMax), arbThresholdPips: Number(c.arbThresholdPips), kDefaultBps: Number(c.kDefaultBps) };
      this.cfgReadAt = block;
      return this.chainCfg;
    } catch {
      return this.chainCfg ?? this.fileCfg;
    }
  }

  /** Stored k of the pool (the k an arbitrageur faces this block). undefined if unreadable -> base-fee wording. */
  private async currentK(): Promise<number | undefined> {
    try {
      const [st] = await this.pc.readContract({ address: this.d.hook, abi: poolStateAbi, functionName: 'poolState', args: [this.pool.poolId] });
      return Number(st.kBps);
    } catch {
      return undefined;
    }
  }

  /** CEX mid for the observed block (same time index as the arb bot when PRICE_SOURCE=replay). */
  private mid(block: number): Promise<number> {
    return this.midSource(block);
  }

  /** Incrementally pull Receipt logs for our pool (keeps last ~200 blocks). */
  private async refreshSwaps(block: number) {
    const from = this.scannedTo < 0 ? Math.max(0, block - 50) : this.scannedTo + 1;
    if (from > block) return;
    const [rs, cfgEvents] = await Promise.all([
      getReceipts(this.pc, this.d.hook, this.pool.poolId, BigInt(from), BigInt(block)),
      this.pc
        .getContractEvents({ address: this.d.hook, abi: oniblockHookAbi, eventName: 'PoolConfigUpdated', args: { id: this.pool.poolId }, fromBlock: BigInt(from), toBlock: BigInt(block) })
        .catch(() => []),
    ]);
    if (cfgEvents.length) {
      this.chainCfg = undefined; // a timelocked config change executed: re-read poolConfig on this tick
      log('keeper', 'pool_config_updated', { block, events: cfgEvents.length });
    }
    this.swaps.push(...rs.map(receiptToSwapObs));
    this.swaps = this.swaps.filter((s) => s.block > block - 200);
    if (this.scannedTo < 0) {
      const at = await getAttestations(this.pc, this.d.hook, this.pool.poolId, BigInt(from), BigInt(block));
      if (at.length) this.lastAttestBlock = at[at.length - 1]!.blockNumber;
    }
    this.scannedTo = block;
  }

  async tick(block: number): Promise<KeeperTickResult> {
    const every = this.o.every ?? envInt('KEEPER_EVERY', 1);
    if (every > 1 && block % every !== 0) return { block, posted: false, reason: 'every' };
    if (this.busy) return { block, posted: false, reason: 'busy' };
    this.busy = true;
    const gen = ++this.gen;
    const t0 = performance.now();
    try {
      const [mid, pool, kBps, cfg] = await Promise.all([
        this.mid(block),
        readPool(this.pc, this.d.poolManager, this.pool.poolId),
        this.currentK(),
        this.refreshSwaps(block).then(() => this.poolCfg(block)), // a PoolConfigUpdated in range invalidates the cache first
      ]);
      this.mids.push(mid);
      const oracleX96 = midToPriceX96(mid.toFixed(8), this.meta);
      const poolX96 = sqrtPriceX96ToPriceX96(pool.sqrtPriceX96);
      const target = block + envInt('ATTEST_BLOCK_OFFSET', 1);
      const f = computeFeatures({
        swaps: this.swaps,
        oracleX96,
        poolX96,
        depth0: virtualDepth0(pool),
        recentMids: this.mids.mids(),
        currentBlock: block,
        lastAttestBlock: this.lastAttestBlock || block,
        baseFee: cfg.baseFee,
        feeMax: cfg.feeMax,
        kBps,
        arbThresholdPips: cfg.arbThresholdPips,
        baseIsToken0: this.meta.baseIsToken0,
      });
      const gated = keeperGateOn();
      assertGateConfig(gated, cfg.kDefaultBps);
      const rule = gated && gateDecision(f.gapPips, cfg.arbThresholdPips, envInt('KEEPER_HYSTERESIS_PIPS', 100)) === 'rule';
      const s: ModelScore = rule
        ? { ...RULE_SCORE, cls: 'unknown', latencyMs: 0, model: 'rule' }
        : await score(f, { mode: this.o.mode, degraded: this.isDegraded(), baseIsToken0: this.meta.baseIsToken0 });
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
      this.domain ??= await resolveAttestDomain(this.pc, this.d.hook, (this.d.raw.eip712 ?? {}) as DomainOpts);
      const att = await signAttestation(this.attestor, this.d.chainId, this.d.hook, {
        poolId: this.pool.poolId,
        blockNumber: BigInt(target),
        oracleMidX96: oracleX96,
        pToxicBps: s.pToxicBps,
        confidenceBps: s.confidenceBps,
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
        cls: s.cls,
        modelLatencyMs: s.latencyMs,
        tickMs: Math.round(performance.now() - t0),
        quoter: sender.address,
        tx: rc?.hash,
      });
      const statsEvery = envInt('KEEPER_STATS_EVERY', 50);
      if (statsEvery > 0 && st.ticks % statsEvery === 0) log('keeper', 'jev_rate', { ...st, jevCallRate: +st.jevCallRate.toFixed(3) });
      return { block, posted: ok, hash: rc?.hash, score: s, mid, gapPips: f.gapPips, reason: ok ? undefined : 'tx', rule, arbThresholdPips: cfg.arbThresholdPips };
    } catch (e) {
      log('keeper', 'tick_error', { block, error: (e as Error).message.split('\n')[0] });
      return { block, posted: false, reason: (e as Error).message };
    } finally {
      if (this.gen === gen) this.busy = false;
    }
  }

  /** Startup check (CLI): refuse KEEPER_GATE=1 on a kDefault = 0 pool (see assertGateConfig). */
  async checkConfig(): Promise<void> {
    const cfg = await this.poolCfg(Number(await this.pc.getBlockNumber()));
    assertGateConfig(keeperGateOn(), cfg.kDefaultBps);
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
      jevPrompt: env('JEV_PROMPT', 'v4'),
      priceSource: env('PRICE_SOURCE', 'live'),
    });
    return this.pc.watchBlockNumber({
      emitOnBegin: true,
      emitMissed: false,
      onBlockNumber: (bn) => void this.tick(Number(bn)),
      onError: (e) => log('keeper', 'watch_error', { error: e.message.split('\n')[0] }),
    });
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
    log('keeper', 'fatal_config', { error: (e as Error).message });
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
