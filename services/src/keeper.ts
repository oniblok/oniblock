/**
 * Keeper: once per block, post (oracleMid, pToxic, confidence, modelNode, sig) to the hook.
 *
 *   new block -> CEX mid + pool price + recent Receipts -> features -> model (Jev|heuristic)
 *             -> EIP-712 sign with attestor key -> setAttestation from quoter key
 *
 * CLI: tsx src/keeper.ts [--chain local|fork|sepolia] [--once] [--degraded] [--every N]
 *                        [--mode auto|jev|heuristic] [--pool NAME]
 * Env: KEEPER_EVERY (default 1), ATTEST_BLOCK_OFFSET (default 1), MODEL_NAME,
 *      FALLBACK_MODEL_NAME, DEGRADED_FILE (touch file to toggle degraded mode live),
 *      KEEPER_FLAGS_FILE (default <root>/.runtime/keeper-flags.json), BACKUP_QUOTER_PK.
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
export const DEFAULT_FALLBACK_MODEL_NAME = 'heuristic-v1.models.oniblock.eth';

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
}

export function modelNodes(d?: Deployment) {
  const name = env('MODEL_NAME', DEFAULT_MODEL_NAME)!;
  const fb = env('FALLBACK_MODEL_NAME', DEFAULT_FALLBACK_MODEL_NAME)!;
  return {
    primary: (env('MODEL_NODE') as Hex | undefined) ?? d?.modelNode ?? namehash(name),
    primaryName: name,
    fallback: namehash(fb),
    fallbackName: fb,
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

  /** Pool fee config from the deployment (the model is told the real arb-direction fee law). */
  private get cfg(): { baseFee: number; feeMax: number } {
    const c = (this.d.raw.pools as Record<string, { config?: { baseFee?: number; feeMax?: number } }> | undefined)?.[this.pool.name]?.config;
    return { baseFee: Number(c?.baseFee ?? envInt('BASE_FEE_PIPS', 3000)), feeMax: Number(c?.feeMax ?? 10_000) };
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
    const rs = await getReceipts(this.pc, this.d.hook, this.pool.poolId, BigInt(from), BigInt(block));
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
      const [mid, pool, kBps] = await Promise.all([
        this.mid(block),
        readPool(this.pc, this.d.poolManager, this.pool.poolId),
        this.currentK(),
        this.refreshSwaps(block),
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
        baseFee: this.cfg.baseFee,
        feeMax: this.cfg.feeMax,
        kBps,
        baseIsToken0: this.meta.baseIsToken0,
      });
      const s = await score(f, { mode: this.o.mode, degraded: this.isDegraded(), baseIsToken0: this.meta.baseIsToken0 });
      const node = s.model === 'jev' || env('FALLBACK_SAME_NODE') === '1' ? this.nodes.primary : this.nodes.fallback;
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
        arbFeePips: f.arbFeePips,
        model: s.model,
        degraded: !!s.degraded,
        pToxicBps: s.pToxicBps,
        confidenceBps: s.confidenceBps,
        cls: s.cls,
        modelLatencyMs: s.latencyMs,
        tickMs: Math.round(performance.now() - t0),
        quoter: sender.address,
        tx: rc?.hash,
      });
      return { block, posted: ok, hash: rc?.hash, score: s, mid, gapPips: f.gapPips, reason: ok ? undefined : 'tx' };
    } catch (e) {
      log('keeper', 'tick_error', { block, error: (e as Error).message.split('\n')[0] });
      return { block, posted: false, reason: (e as Error).message };
    } finally {
      if (this.gen === gen) this.busy = false;
    }
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
  if (a.once) {
    const bn = Number(await k.pc.getBlockNumber());
    const r = await k.tick(bn);
    process.exit(r.posted ? 0 : 1);
  } else {
    k.run();
  }
}
