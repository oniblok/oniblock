/**
 * Live dashboard data: current state (status strip) and history (LP vs HODL, regime map).
 *
 * All numbers come from chain + deployments:
 *  - CEX mid = the oracle mid the keeper attested on-chain (AttestationPosted.oracleMidX96)
 *  - pool state via StateView (historical reads at sampled blocks; cached, blocks are immutable)
 *  - swaps via PoolManager Swap events (both pools), Receipts via the hook
 * LP = the pool's whole (full-range) liquidity; HODL = the same tokens held since the baseline block.
 */
import 'server-only';
import type { Address, Hex } from 'viem';
import {
  LEGACY_JIT_WALL,
  type CalibrationJson,
  type FeeQuote,
  type HistoryJson,
  type HistoryPoint,
  type JitPenaltyJson,
  type PoolConfigJson,
  type PoolTotals,
  type RegimeCell,
  type StateJson,
} from '../types';
import { ctx, hasEvent, hasFn, jitCalibrationKey, jitHeadSupported, nameOf, tryRead, ensAvailable, ensReverse, type Ctx } from './chain';
import type { PoolInfo } from './deployment';
import { backupQuoterAddress } from './devkeys';
import { readFlags } from './flags';
import { priceX96ToMid, Q96, sqrtPriceX96ToMid, sqrtPriceX96ToPriceX96, type TokenOrder } from './shared';

const Q128 = 1n << 128n;

export function order(c: Ctx): TokenOrder {
  return { decimals0: c.d.token0.decimals, decimals1: c.d.token1.decimals, baseIsToken0: c.d.baseIsToken0 };
}

function num(x: unknown): number {
  return typeof x === 'bigint' ? Number(x) : Number(x ?? 0);
}
/** Like num, but a field the deployed ABI/hook does not have stays null (rendered as "—"). */
function optNum(x: unknown): number | null {
  return x == null ? null : num(x);
}

function jsonify<T>(o: T): T {
  return JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

export function modelKind(name: string | undefined): string | null {
  if (!name) return null;
  if (/jev/i.test(name)) return 'jev';
  if (/heuristic/i.test(name)) return 'heuristic';
  if (/^rule-/i.test(name)) return 'rule';
  return name.split('.')[0] ?? name;
}

export async function readConfig(c: Ctx): Promise<PoolConfigJson> {
  const cfg = await tryRead<Record<string, unknown>>(c, 'poolConfig', [c.d.oniblock.poolId]);
  const fromFile = ((c.d.raw.pools as Record<string, { config?: Record<string, unknown> }>)?.[c.d.oniblock.name]?.config ?? {}) as Record<string, unknown>;
  const src = cfg ?? fromFile;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) out[k] = typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : v;
  return out as PoolConfigJson;
}

/**
 * Pool config IN FORCE at `block`: the last PoolRegistered / PoolConfigUpdated event for our pool mined at or before
 * it (a queued change only applies once executed, which is when PoolConfigUpdated is emitted). Receipts of old
 * blocks must be re-derived with the config of their block, not today's (e.g. after an arbThresholdPips change).
 * Falls back to the current config when the events are unavailable.
 */
export async function readConfigAt(c: Ctx, block: number): Promise<{ cfg: PoolConfigJson; atBlock: number | null }> {
  try {
    const q = (eventName: 'PoolRegistered' | 'PoolConfigUpdated') =>
      c.pc.getContractEvents({ address: c.d.hook, abi: c.hookAbi, eventName, args: { id: c.d.oniblock.poolId }, fromBlock: BigInt(c.d.deployBlock ?? 0), toBlock: BigInt(block) });
    const [reg, upd] = await Promise.all([q('PoolRegistered'), q('PoolConfigUpdated')]);
    type E = { blockNumber: bigint; logIndex: number; args: { config?: Record<string, unknown> } };
    const all = ([...reg, ...upd] as unknown as E[]).sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
    const last = all.at(-1);
    if (last?.args.config) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(last.args.config)) out[k] = typeof v === 'bigint' ? Number(v) : v;
      return { cfg: out as PoolConfigJson, atBlock: Number(last.blockNumber) };
    }
  } catch {
    /* fall through */
  }
  return { cfg: await readConfig(c), atBlock: null };
}

async function readCalibration(c: Ctx, node: Hex): Promise<CalibrationJson | undefined> {
  const r = await tryRead<Record<string, bigint | number>>(c, 'calibration', [node]);
  if (!r) return undefined;
  return { brierBps: num(r.brierBps), hitRateBps: num(r.hitRateBps), n: num(r.n), updatedBlock: num(r.updatedBlock) };
}

async function isQuoter(c: Ctx, a?: Address, fn = 'isQuoter'): Promise<boolean | undefined> {
  const oracle = (await tryRead<Address>(c, 'roleOracle', [])) ?? c.d.roleOracle;
  if (!oracle || !a) return undefined;
  try {
    return (await c.pc.readContract({
      address: oracle,
      abi: [{ type: 'function', name: fn, stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'bool' }] }],
      functionName: fn,
      args: [a],
    })) as boolean;
  } catch {
    return undefined;
  }
}

async function slot0(c: Ctx, poolId: Hex, blockNumber?: bigint): Promise<{ sqrtP: bigint; liquidity: bigint; fg0: bigint; fg1: bigint; lpFee: number }> {
  if (!c.d.stateView) throw new Error('deployment has no stateView');
  const sv = { address: c.d.stateView, abi: c.stateViewAbi } as const;
  const [s0, liq, fg] = await Promise.all([
    c.pc.readContract({ ...sv, functionName: 'getSlot0', args: [poolId], blockNumber }) as Promise<readonly [bigint, number, number, number]>,
    c.pc.readContract({ ...sv, functionName: 'getLiquidity', args: [poolId], blockNumber }) as Promise<bigint>,
    c.pc.readContract({ ...sv, functionName: 'getFeeGrowthGlobals', args: [poolId], blockNumber }) as Promise<readonly [bigint, bigint]>,
  ]);
  return { sqrtP: s0[0], liquidity: liq, fg0: fg[0], fg1: fg[1], lpFee: Number(s0[3]) };
}

// ============================================================================================ state

export async function getState(): Promise<StateJson> {
  const c = await ctx();
  const o = order(c);
  const id = c.d.oniblock.poolId;
  const key = c.d.oniblock.key;
  const blk = await c.pc.getBlock();
  const head = Number(blk.number);
  const [cfg, ps, q0, q1, oni, van, ens] = await Promise.all([
    readConfig(c),
    tryRead<readonly [Record<string, unknown>, Record<string, unknown>, boolean]>(c, 'poolState', [id]),
    tryRead<readonly [number, boolean, number, boolean]>(c, 'quoteFee', [key, true]),
    tryRead<readonly [number, boolean, number, boolean]>(c, 'quoteFee', [key, false]),
    slot0(c, id),
    c.d.vanilla ? slot0(c, c.d.vanilla.poolId) : Promise.resolve(undefined),
    ensAvailable(c),
  ]);
  const st = ps?.[0] ?? {};
  const anchor = ps?.[1] ?? {};
  const modelNode = (st.modelNode as Hex) ?? ('0x' + '0'.repeat(64)) as Hex;
  const lastAttestBlock = num(st.lastAttestBlock);
  const oracleX96 = BigInt((st.oracleMidX96 as bigint | undefined) ?? 0n);
  const MIX_WINDOW = 100;
  // v5 JIT head: its own calibration record (under the derived key) and its own demotion, same parent allowlist.
  const jitSupported = jitHeadSupported(c);
  const jitKey = jitSupported ? jitCalibrationKey(modelNode) : null;
  const [demoted, calibration, quoterActive, backupActive, settlerActive, recentAtts, jitDemoted, jitCalibration, quoterName, settlerName] = await Promise.all([
    tryRead<boolean>(c, 'isDemoted', [id, modelNode]),
    readCalibration(c, modelNode),
    isQuoter(c, c.d.quoter),
    c.sel.isDev ? isQuoter(c, backupQuoterAddress()) : Promise.resolve(undefined),
    isQuoter(c, c.d.settler, 'isSettler'),
    c.pc
      .getContractEvents({ address: c.d.hook, abi: c.hookAbi, eventName: 'AttestationPosted', args: { id }, fromBlock: BigInt(Math.max(0, head - MIX_WINDOW)), toBlock: BigInt(head) })
      .catch(() => []),
    jitSupported ? tryRead<boolean>(c, 'isJitDemoted', [id, modelNode]) : Promise.resolve(undefined),
    jitKey ? readCalibration(c, jitKey) : Promise.resolve(undefined),
    // ENSIP-19 primary names of the role keys (UR.reverse; null without ENS or before ens:primary ran)
    ens ? ensReverse(c, c.d.quoter) : Promise.resolve(null),
    ens ? ensReverse(c, c.d.settler) : Promise.resolve(null),
  ]);
  const lastAtt = recentAtts.at(-1);
  const lastAttArgs = (lastAtt as { args?: Record<string, unknown> } | undefined)?.args;
  let attestMix: StateJson['status']['attestMix'] = null;
  if (recentAtts.length) {
    const m = { window: MIX_WINDOW, total: recentAtts.length, jev: 0, heuristic: 0, rule: 0, other: 0 };
    for (const l of recentAtts as unknown as { args: { modelNode?: Hex } }[]) {
      const k = modelKind(nameOf(c, l.args.modelNode));
      if (k === 'jev' || k === 'heuristic' || k === 'rule') m[k]++;
      else m.other++;
    }
    attestMix = m;
  }
  const fq = (q?: readonly [number, boolean, number, boolean]): FeeQuote => ({
    feePips: num(q?.[0]),
    arbDir: !!q?.[1],
    gapPips: num(q?.[2]),
    stale: !!q?.[3],
  });
  const f0 = fq(q0);
  const f1 = fq(q1);
  // "Unseasoned": has no (or too few) calibration records yet — k capped at kDefault by newer hook versions.
  // Newer hooks: isDemoted also covers "unseasoned" (calibration.n < minSamples) and non-allowlisted nodes.
  const minSamples = Number(cfg.minSamples ?? 0);
  const allowed = await tryRead<boolean>(c, 'modelAllowed', [id, modelNode]);
  const nCal = calibration?.n ?? 0;
  const unseasoned = !!demoted && allowed !== false && nCal < minSamples;
  const badCalibration = !!demoted && !unseasoned;
  const lastQuoter = lastAttArgs?.quoter as Address | undefined;
  const lastQuoterName = ens && lastQuoter ? ((await ensReverse(c, lastQuoter)) ?? undefined) : undefined;
  const stale = !!ps?.[2];
  // Second knob: poolState.jitWindow / pJitBps, falling back to the last AttestationPosted (same values, event stream).
  const pJitBps = optNum(st.pJitBps) ?? optNum(lastAttArgs?.pJitBps);
  const jitWindow = optNum(st.jitWindow) ?? optNum(lastAttArgs?.jitWindow);
  const jitWindowDefault = optNum(cfg.jitWindowDefault);
  const jitUnseasoned = !!jitDemoted && allowed !== false && (jitCalibration?.n ?? 0) < minSamples;
  const jitBad = !!jitDemoted && !jitUnseasoned;
  const flags = readFlags();
  const res: StateJson = {
    chain: { name: c.sel.name, chainId: c.d.chainId, isDev: c.sel.isDev, block: head, timestamp: Number(blk.timestamp), ens },
    pair: {
      base: c.d.baseIsToken0 ? c.d.token0.symbol : c.d.token1.symbol,
      quote: c.d.baseIsToken0 ? c.d.token1.symbol : c.d.token0.symbol,
      baseIsToken0: c.d.baseIsToken0,
      token0: c.d.token0.symbol,
      token1: c.d.token1.symbol,
    },
    hook: c.d.hook,
    roleOracle: (await tryRead<Address>(c, 'roleOracle', [])) ?? c.d.roleOracle,
    roleOracleType: c.d.roleOracleType ?? (c.ens ? 'ensv2' : undefined),
    config: cfg,
    status: {
      lastAttestBlock,
      attestAge: lastAttestBlock ? head - lastAttestBlock : null,
      pToxicBps: num(st.pToxicBps),
      confidenceBps: num(st.confidenceBps),
      kBps: num(st.kBps),
      oracleMid: oracleX96 > 0n ? priceX96ToMid(oracleX96, o) : null,
      modelNode,
      modelName: nameOf(c, modelNode),
      demoted: badCalibration,
      unseasoned,
      allowed: allowed ?? null,
      stale,
      feeZeroForOne: f0,
      feeOneForZero: f1,
      arbZeroForOne: f0.arbDir ? true : f1.arbDir ? false : num(anchor.gapZeroForOne) > 0 ? true : num(anchor.gapOneForZero) > 0 ? false : null,
      gapPips: Math.max(f0.gapPips, f1.gapPips),
      arbThresholdPips: Number(cfg.arbThresholdPips ?? 0),
      belowThreshold: !stale && Number(cfg.arbThresholdPips ?? 0) > 0 && Math.max(f0.gapPips, f1.gapPips) <= Number(cfg.arbThresholdPips ?? 0),
      attestMix,
      calibration,
      lastQuoter,
      lastQuoterName,
      jit: {
        pJitBps,
        jitWindow,
        // adds while the attestation is stale get jitWindowDefault (contract: _windowFor / effective window now)
        jitWindowEffective: stale ? jitWindowDefault : (jitWindow ?? jitWindowDefault),
        demoted: jitBad,
        unseasoned: jitUnseasoned,
        calibrationKey: jitKey,
        calibration: jitCalibration,
        supported: jitSupported,
      },
    },
    roles: {
      quoter: c.d.quoter,
      quoterActive,
      backupQuoter: c.sel.isDev ? backupQuoterAddress() : undefined,
      backupActive,
      settler: c.d.settler,
      settlerActive,
      quoterName,
      settlerName,
    },
    flags: { degraded: !!flags.degraded, useBackupQuoter: !!flags.useBackupQuoter },
    pools: {
      oniblock: { name: c.d.oniblock.name, poolId: id, hooked: true, poolMid: sqrtPriceX96ToMid(oni.sqrtP, o), liquidity: oni.liquidity.toString() },
      vanilla:
        van && c.d.vanilla
          ? {
              name: c.d.vanilla.name,
              poolId: c.d.vanilla.poolId,
              hooked: false,
              poolMid: sqrtPriceX96ToMid(van.sqrtP, o),
              liquidity: van.liquidity.toString(),
              staticFee: c.d.vanilla.key.fee,
            }
          : undefined,
    },
  };
  return jsonify(res);
}

// ============================================================================================ history

export interface Att {
  attBlock: number;
  mined: number;
  /** log index within the mined block (orders attestations and swaps inside one block) */
  logIndex: number;
  midX96: bigint;
  p: number;
  conf: number;
  k: number;
  node: Hex;
  quoter: Address;
  tx: Hex;
  /** v5 (null on pre-v5 events) */
  pJit: number | null;
  jitWindow: number | null;
}
/** JitPenalty event: fees forfeited by liquidity removed inside its window (block = removal block). */
interface Jit {
  block: number;
  addedBlock: number;
  window: number;
  sender: Address;
  positionKey: Hex;
  p0: bigint;
  p1: bigint;
  tx: Hex;
}
export interface Rcpt {
  block: number;
  arbDir: boolean;
  fee: number;
  gap: number;
  k: number;
  stale: boolean;
  zeroForOne: boolean;
  tx: Hex;
  logIndex: number;
  /** swapper deltas (positive = received by the swapper), raw units */
  a0: bigint;
  a1: bigint;
  node: Hex;
}
export interface Swp {
  block: number;
  logIndex: number;
  a0: bigint;
  a1: bigint;
  tx: Hex;
  fee: number;
}
interface Cal {
  mined: number;
  node: Hex;
  brier: number;
  n: number;
}
type Snap = Awaited<ReturnType<typeof slot0>>;

export interface Store {
  key: string;
  scannedTo: number;
  atts: Att[];
  rcpts: Rcpt[];
  swaps: Record<string, Swp[]>;
  cals: Cal[];
  jits: Jit[];
  snaps: Map<string, Snap>;
}
let store: Store | undefined;
let inflight: Promise<Store> | undefined;

function storeKey(c: Ctx) {
  return `${c.sel.rpcUrl}|${c.d.file}|${c.d.mtime}|${c.d.hook}`;
}

/** Serialised refresh: concurrent API calls share one scan instead of racing on the module-level store. */
export async function loadStore(c: Ctx, head: number): Promise<Store> {
  while (inflight) await inflight.catch(() => undefined);
  inflight = refresh(c, head);
  try {
    return await inflight;
  } finally {
    inflight = undefined;
  }
}

async function refresh(c: Ctx, head: number): Promise<Store> {
  const key = storeKey(c);
  if (!store || store.key !== key || head < store.scannedTo) {
    store = { key, scannedTo: c.d.deployBlock - 1, atts: [], rcpts: [], swaps: {}, cals: [], jits: [], snaps: new Map() };
  }
  const s = store;
  if (head <= s.scannedTo) return s;
  const id = c.d.oniblock.poolId;
  const step = 2_000;
  const jitEvents = hasEvent(c.hookAbi, 'JitPenalty');
  for (let a = s.scannedTo + 1; a <= head; a += step) {
    const b = Math.min(head, a + step - 1);
    const range = { fromBlock: BigInt(a), toBlock: BigInt(b) };
    const pools = [c.d.oniblock, c.d.vanilla].filter(Boolean) as PoolInfo[];
    const [atts, rcpts, cals, jits, ...swaps] = await Promise.all([
      c.pc.getContractEvents({ address: c.d.hook, abi: c.hookAbi, eventName: 'AttestationPosted', args: { id }, ...range }),
      c.pc.getContractEvents({ address: c.d.hook, abi: c.hookAbi, eventName: 'Receipt', args: { id }, ...range }),
      c.pc.getContractEvents({ address: c.d.hook, abi: c.hookAbi, eventName: 'CalibrationUpdated', ...range }),
      jitEvents ? c.pc.getContractEvents({ address: c.d.hook, abi: c.hookAbi, eventName: 'JitPenalty', args: { id }, ...range }).catch(() => []) : Promise.resolve([]),
      ...pools.map((p) => c.pc.getContractEvents({ address: c.d.poolManager, abi: c.poolManagerAbi, eventName: 'Swap', args: { id: p.poolId }, ...range })),
    ]);
    type L = { args: Record<string, unknown>; blockNumber: bigint; transactionHash: Hex; logIndex: number };
    for (const l of atts as unknown as L[]) {
      s.atts.push({
        attBlock: num(l.args.blockNumber),
        mined: Number(l.blockNumber),
        logIndex: l.logIndex,
        midX96: l.args.oracleMidX96 as bigint,
        p: num(l.args.pToxicBps),
        conf: num(l.args.confidenceBps),
        k: num(l.args.kBps),
        node: l.args.modelNode as Hex,
        quoter: l.args.quoter as Address,
        tx: l.transactionHash,
        pJit: optNum(l.args.pJitBps),
        jitWindow: optNum(l.args.jitWindow),
      });
    }
    for (const l of jits as unknown as L[]) {
      s.jits.push({
        block: Number(l.blockNumber),
        addedBlock: num(l.args.addedBlock),
        window: num(l.args.window),
        sender: l.args.sender as Address,
        positionKey: l.args.positionKey as Hex,
        p0: BigInt((l.args.penalty0 as bigint | undefined) ?? 0n),
        p1: BigInt((l.args.penalty1 as bigint | undefined) ?? 0n),
        tx: l.transactionHash,
      });
    }
    for (const l of rcpts as unknown as L[]) {
      s.rcpts.push({
        block: num(l.args.blockNumber),
        arbDir: !!l.args.arbDir,
        fee: num(l.args.feePips),
        gap: num(l.args.gapPips),
        k: num(l.args.kBps),
        stale: !!l.args.stale,
        zeroForOne: !!l.args.zeroForOne,
        tx: l.transactionHash,
        logIndex: l.logIndex,
        a0: BigInt((l.args.amount0 as bigint | undefined) ?? 0n),
        a1: BigInt((l.args.amount1 as bigint | undefined) ?? 0n),
        node: l.args.modelNode as Hex,
      });
    }
    for (const l of cals as unknown as L[]) {
      s.cals.push({ mined: Number(l.blockNumber), node: l.args.modelNode as Hex, brier: num(l.args.brierBps), n: num(l.args.n) });
    }
    pools.forEach((p, i) => {
      const arr = (s.swaps[p.poolId] ??= []);
      for (const l of swaps[i] as unknown as L[]) arr.push({ block: Number(l.blockNumber), logIndex: l.logIndex, a0: l.args.amount0 as bigint, a1: l.args.amount1 as bigint, tx: l.transactionHash, fee: num(l.args.fee) });
    });
  }
  s.scannedTo = head;
  return s;
}

/** Pool state at a block, or undefined if unavailable (e.g. before the pool/StateView existed). */
async function snap(c: Ctx, s: Store, pool: PoolInfo, block: number): Promise<Snap | undefined> {
  const k = `${pool.poolId}:${block}`;
  const hit = s.snaps.get(k);
  if (hit) return hit;
  try {
    const v = await slot0(c, pool.poolId, BigInt(block));
    if (v.sqrtP === 0n) return undefined; // not initialized yet
    s.snaps.set(k, v);
    return v;
  } catch {
    return undefined;
  }
}

/** Sort attestations by chain position (mined block, then log index): the order inForce/firstAfter expect. */
export function sortAtts(atts: Att[]): Att[] {
  return [...atts].sort((a, b) => a.mined - b.mined || a.logIndex - b.logIndex);
}

/** Index of the attestation in force at position (b, logIndex): the latest with (mined, logIndex) < (b, logIndex); -1 if none. */
function inForceIdx(atts: Att[], b: number, logIndex: number): number {
  let lo = 0;
  let hi = atts.length - 1;
  let best = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const x = atts[m]!;
    if (x.mined < b || (x.mined === b && x.logIndex < logIndex)) {
      best = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return best;
}

/**
 * Attestation in force at a chain position. For a swap pass its log index: an attestation mined later in the same
 * block is not in force for it. Without a log index (block-level questions) = latest mined at or before b.
 * `atts` sorted by sortAtts.
 */
export function inForce(atts: Att[], b: number, logIndex = Infinity): Att | undefined {
  const i = inForceIdx(atts, b, logIndex);
  return i >= 0 ? atts[i] : undefined;
}
/** First attestation posted after position (b, logIndex) (the markout mid for a swap there). */
export function firstAfter(atts: Att[], b: number, logIndex = Infinity): Att | undefined {
  return atts[inForceIdx(atts, b, logIndex) + 1];
}

export async function getHistory(opts: { blocks?: number; regimeBlocks?: number; points?: number } = {}): Promise<HistoryJson> {
  const c = await ctx();
  const o = order(c);
  const head = Number(await c.pc.getBlockNumber());
  const s = await loadStore(c, head);
  const cfg = await readConfig(c);
  const atts = sortAtts(s.atts);
  const d0 = 10 ** c.d.token0.decimals;
  const d1 = 10 ** c.d.token1.decimals;
  const quote = c.d.baseIsToken0 ? c.d.token1.symbol : c.d.token0.symbol;

  /** value of raw token amounts in quote units at a priceX96 (raw token1 per raw token0 * 2^96) */
  const valueAt = (a0: bigint, a1: bigint, midX96: bigint): number => {
    const mid = priceX96ToMid(midX96, o);
    const h0 = Number(a0) / d0;
    const h1 = Number(a1) / d1;
    return c.d.baseIsToken0 ? h0 * mid + h1 : h1 * mid + h0;
  };

  // ---------------- LP vs HODL (sampled) ----------------
  const firstMid = atts[0]?.mined;
  const windowBlocks = opts.blocks ?? Number(process.env.APP_HISTORY_BLOCKS ?? 900);
  const from = Math.max(c.d.deployBlock + 1, firstMid ?? head, head - windowBlocks);
  const nPts = opts.points ?? 150;
  const stepB = Math.max(1, Math.ceil((head - from) / nPts));
  const sample: number[] = [];
  for (let b = Math.ceil(from / stepB) * stepB; b < head; b += stepB) if (b >= from) sample.push(b);
  if (!sample.includes(from) && from <= head) sample.unshift(from);
  sample.push(head);

  const pools = [
    { tag: 'oni' as const, p: c.d.oniblock },
    ...(c.d.vanilla ? [{ tag: 'van' as const, p: c.d.vanilla }] : []),
  ];
  const snapsByPool = await Promise.all(pools.map(({ p }) => Promise.all(sample.map((b) => snap(c, s, p, b)))));

  // markout of every swap at the next attested CEX mid (settler convention: mid at b+1)
  const markouts = pools.map(({ p }) =>
    (s.swaps[p.poolId] ?? [])
      .filter((w) => w.block >= from)
      .map((w) => {
        const a = firstAfter(atts, w.block, w.logIndex) ?? inForce(atts, w.block, w.logIndex);
        const v = a ? valueAt(w.a0, w.a1, a.midX96) : 0;
        const inRaw = w.a0 < 0n ? -w.a0 : 0n;
        const inRaw1 = w.a1 < 0n ? -w.a1 : 0n;
        const vol = a ? valueAt(inRaw, inRaw1, a.midX96) : 0;
        return { block: w.block, v, vol };
      }),
  );

  const points: HistoryPoint[] = [];
  let baselineBlock: number | null = null;
  const base: { a0: bigint; a1: bigint; fg0: bigint; fg1: bigint }[] = [];
  sample.forEach((b, i) => {
    const a = inForce(atts, b);
    if (!a || snapsByPool.some((sp) => !sp[i])) return;
    const pt: Partial<HistoryPoint> = { block: b, mid: priceX96ToMid(a.midX96, o) };
    pools.forEach(({ tag }, j) => {
      const sn = snapsByPool[j]![i]!;
      const a0 = sn.sqrtP > 0n ? (sn.liquidity * Q96) / sn.sqrtP : 0n;
      const a1 = (sn.liquidity * sn.sqrtP) / Q96;
      if (!base[j]) {
        base[j] = { a0, a1, fg0: sn.fg0, fg1: sn.fg1 };
        baselineBlock ??= b;
      }
      const bs = base[j]!;
      const f0 = ((sn.fg0 - bs.fg0) * sn.liquidity) / Q128;
      const f1 = ((sn.fg1 - bs.fg1) * sn.liquidity) / Q128;
      const fees = valueAt(f0, f1, a.midX96);
      const lp = valueAt(a0, a1, a.midX96) + fees;
      const hodl = valueAt(bs.a0, bs.a1, a.midX96);
      const lossToArb = markouts[j]!.filter((m) => m.block <= b && m.v > 0).reduce((x, m) => x + m.v, 0);
      (pt as Record<string, unknown>)[tag] = { lp, hodl, fees, lossToArb, poolMid: sqrtPriceX96ToMid(sn.sqrtP, o) };
    });
    points.push(pt as HistoryPoint);
  });

  const totals = Object.fromEntries(
    pools.map(({ tag }, j) => {
      const last = points.at(-1)?.[tag];
      const ms = markouts[j]!;
      const t: PoolTotals = {
        fees: last?.fees ?? 0,
        lossToArb: last?.lossToArb ?? 0,
        lpMinusHodl: last ? last.lp - last.hodl : 0,
        swaps: ms.length,
        volume: ms.reduce((x, m) => x + m.vol, 0),
      };
      return [tag, t];
    }),
  ) as HistoryJson['totals'];

  // ---------------- regime map (one cell per block) ----------------
  const R = opts.regimeBlocks ?? Number(process.env.APP_REGIME_BLOCKS ?? 120);
  const rFrom = Math.max(c.d.deployBlock + 1, head - R + 1);
  const rBlocks: number[] = [];
  for (let b = rFrom; b <= head; b++) rBlocks.push(b);
  const oniSnaps = await Promise.all(rBlocks.map((b) => snap(c, s, c.d.oniblock, b)));
  const cals = [...s.cals].sort((a, b) => a.mined - b.mined);
  const minedIn = new Set(atts.map((a) => a.mined));
  const rByBlock = new Map<number, Rcpt[]>();
  for (const r of s.rcpts) (rByBlock.get(r.block) ?? rByBlock.set(r.block, []).get(r.block)!).push(r);
  const regime: RegimeCell[] = rBlocks.map((b, i) => {
    const a = inForce(atts, b);
    const age = a ? b - a.attBlock : null;
    const stale = !a || (age ?? 0) > cfg.staleBlocks;
    const name = a ? nameOf(c, a.node) : undefined;
    let cal: Cal | undefined;
    if (a) for (const x of cals) if (x.mined <= b && x.node === a.node) cal = x;
    const demoted = !!(cal && cal.n > 0 && cfg.brierDemoteBps > 0 && cal.brier > cfg.brierDemoteBps);
    const unseasoned = !!a && !demoted && (cal?.n ?? 0) < Number(cfg.minSamples ?? 0);
    const rs = rByBlock.get(b) ?? [];
    const arbR = rs.find((r) => r.arbDir) ?? rs.find((r) => r.stale);
    let feePips: number | null = null;
    let gap: number | null = null;
    let src: RegimeCell['feeSource'] = null;
    if (arbR) {
      feePips = arbR.fee;
      gap = arbR.gap;
      src = 'receipt';
    } else if (a) {
      if (stale) feePips = cfg.conservativeFee;
      else if (oniSnaps[i]) {
        const px = sqrtPriceX96ToPriceX96(oniSnaps[i]!.sqrtP);
        const diff = px > a.midX96 ? px - a.midX96 : a.midX96 - px;
        gap = Number((diff * 1_000_000n) / a.midX96);
        feePips = Math.min(cfg.baseFee + Math.floor((Math.max(0, gap - Number(cfg.arbThresholdPips ?? 0)) * a.k) / 10_000), cfg.feeMax);
      }
      src = 'quoted';
    }
    return {
      block: b,
      posted: minedIn.has(b),
      attBlock: a?.attBlock ?? null,
      age,
      stale,
      pToxicBps: a?.p ?? null,
      confidenceBps: a?.conf ?? null,
      kBps: stale ? cfg.kDefaultBps : (a?.k ?? null),
      pJitBps: a?.pJit ?? null,
      jitWindow: a?.jitWindow ?? null,
      model: modelKind(name) ?? (a ? a.node.slice(0, 10) : null),
      modelName: name ?? null,
      demoted,
      unseasoned,
      feePips,
      feeSource: src,
      gapPips: gap,
      swaps: rs.length,
      txs: [...new Set(rs.map((r) => r.tx))],
    };
  });

  const receipts = s.rcpts.slice(-12).reverse().map((r) => ({
    tx: r.tx,
    block: r.block,
    arbDir: r.arbDir,
    feePips: r.fee,
    gapPips: r.gap,
    kBps: r.k,
    stale: r.stale,
    zeroForOne: r.zeroForOne,
  }));

  // ---------------- JIT penalties (v5) ----------------
  // Valued at the attested CEX mid in force at the removal block. "caught by adaptive window" = the position was held
  // for at least LEGACY_JIT_WALL blocks, i.e. it would have escaped the fixed 10-block LiquidityPenaltyHook wall.
  const jitAll: JitPenaltyJson[] = [...s.jits]
    .sort((a, b) => a.block - b.block)
    .map((j) => {
      const a = inForce(atts, j.block);
      const held = j.block - j.addedBlock;
      return {
        tx: j.tx,
        block: j.block,
        addedBlock: j.addedBlock,
        held,
        window: j.window,
        sender: j.sender,
        positionKey: j.positionKey,
        penalty0: j.p0.toString(),
        penalty1: j.p1.toString(),
        penalty0Human: Number(j.p0) / d0,
        penalty1Human: Number(j.p1) / d1,
        penaltyQuote: a ? valueAt(j.p0, j.p1, a.midX96) : null,
        caughtByAdaptiveWindow: held >= LEGACY_JIT_WALL,
      };
    });
  const jitTotals: HistoryJson['jitTotals'] = {
    count: jitAll.length,
    caughtByAdaptiveWindow: jitAll.filter((j) => j.caughtByAdaptiveWindow).length,
    penaltyQuote: jitAll.reduce((x, j) => x + (j.penaltyQuote ?? 0), 0),
  };
  const jitPenalties = jitAll.slice(-12).reverse();

  return jsonify({ head, from, baselineBlock, points, regime, totals, receipts, jitPenalties, jitTotals, quote });
}

export { hasFn };
