/**
 * Benchmark v2: one price window, six MARKETS (vanilla 0.30% pool + competitor pool each, equal liquidity), fresh anvil.
 *
 * Every price step t (one 1s kline) is three blocks:
 *   A_t keeper: settler calibration every M steps, then setAttestation on the 5 hooked pools. The attested oracle mid
 *       is what the keeper could know BEFORE the block: mid[t - keeperLag] (default lag 1 step). With probability
 *       missProb the keeper misses the step (no attestation on any pool; the previous one stays in force and ages).
 *   B_t arbitrage vs the TRUE mid[t]: two competing arbitrageurs with their own CEX taker fee and gas cost; per step
 *       a random priority order and an independent "late" draw per arb (shared by all pools = common random numbers).
 *       On each pool the first on-time arb whose profit (net of CEX fee and gas) exceeds minProfit trades to ITS
 *       no-trade band edge at the hook-quoted fee (quoteFee on the pending block); only one arb per pool per step.
 *   C_t retail: seeded orders (Poisson count, lognormal heavy-tailed USD size, autocorrelated direction, a small
 *       informed fraction that trades the sign of the mid move over the next H steps). The SAME orders hit every
 *       market; in each market an order is routed between the two pools by the best execution (quoted fee + price
 *       impact): optimal split, or the single better pool when the smaller leg would be < minSplitFrac.
 * All txs come from one EOA in nonce order, blocks are mined manually => deterministic.
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
import { HOOKED, MARKETS, NODES, POOLS, deployV2, type DeploymentV2, type Hooked, type Pool } from './chain2.js';
import type { PathV2 } from './windows.js';
import { ScorerV2, type SourceV2 } from './scorer.js';

export interface ArbSpec {
  cexBps: number;
  gasUsd: number;
}

export interface RunConfigV2 {
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
  minSamples: number;
  staleSteps: number;
  labelMid: 'attested' | 'true';
  bucketSteps: number;
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

export interface RunResultV2 {
  label: string;
  windowId: string;
  asset: string;
  regime: string;
  vol1mBps: number;
  variant: string;
  config: Omit<RunConfigV2, 'path'> & { steps: number; startIso: string; initialMid: number; finalMid: number; liquidity: string };
  initialTvlUsd: number;
  degradeAtStep: number;
  totals: Record<Pool, PoolTotals>;
  buckets: Record<Pool, PoolBuckets>;
  /** Model pools: share of steps with k forced to kDefault by demotion/probation, by half. */
  demoted: Record<'mjev' | 'mheur' | 'gated', { firstHalf: number; secondHalf: number; seasonedAtStep: number | null }>;
  kBuckets: Record<Hooked, number[]>;
  labelDiag: Record<'mjev' | 'mheur' | 'gated', { n: number; baseRate: number; meanP: number; meanPwhenY1: number; meanPwhenY0: number; brier: number; nArbBlocks: number; baseRateArbBlocks: number }>;
  calibrations: CalibPost[];
  missedPosts: number;
  arbWins: number[];
  retailOrders: number;
  retailUsd: number;
  jev: { mode: string; calls: number; failures: number; counts: Record<SourceV2, number>; fallbackShare: number; p50LatencyMs: number | null };
  reverts: { label: string; pool?: string; step: number }[];
  txCount: number;
  runtimeSec: number;
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
const MODEL_POOLS = ['mjev', 'mheur', 'gated'] as const;
const nodeOf = (n: Hooked): Hex => (n === 'mjev' ? NODES.jev : n === 'mheur' ? NODES.heur : n === 'gated' ? NODES.gated : NODES.const);
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

export async function runOneV2(cfg: RunConfigV2): Promise<RunResultV2> {
  const t0 = Date.now();
  const { path } = cfg;
  const mids = path.mids;
  const T = mids.length;
  const anvil = new Anvil(cfg.port);
  const hookAbi = loadAbi('OniblockHook');
  const pmAbi = loadAbi('PoolManager');
  const routerAbi = loadAbi('SplitSwapRouter');
  const erc20Abi = loadAbi('ERC20');
  const reverts: RunResultV2['reverts'] = [];
  const calibrations: CalibPost[] = [];
  let txCount = 0;
  const liquidity = BigInt(Math.round(cfg.tvlUsd / (2e-12 * Math.sqrt(mids[0]!))));
  const assetTag = path.window.asset.startsWith('BTC') ? 'BTC' : 'ETH';

  await anvil.start();
  try {
    const d: DeploymentV2 = await deployV2(anvil, { initMid: mids[0]!, liquidity, minSamples: cfg.minSamples, staleBlocks: cfg.staleSteps * 3 });
    const rpc: Rpc = anvil.rpc;
    const baseIsToken0 = d.wethIsToken0;
    const meta = { baseIsToken0, decimals0: baseIsToken0 ? 18 : 6, decimals1: baseIsToken0 ? 6 : 18 };
    const toHuman = (a0: bigint, a1: bigint) =>
      baseIsToken0 ? { base: Number(a0) / 1e18, quote: Number(a1) / 1e6 } : { base: Number(a1) / 1e18, quote: Number(a0) / 1e6 };
    const X96 = (mid: number) => midToPriceX96(mid.toFixed(8), meta);
    const attestor = privateKeyToAccount(ATTESTOR_PK);
    const pc = createPublicClient({ transport: http(anvil.url) });
    const domain = await resolveAttestDomain(pc as never, d.hook, { name: 'Oniblock' });
    const jevScorer = new ScorerV2(cfg.jevMode, cfg.jevBudget, T, baseIsToken0, assetTag);
    const heurScorer = new ScorerV2('heuristic', 0, T, baseIsToken0, assetTag);
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
    const quoteNext = async () => {
      const reqs: [string, unknown[]][] = [];
      for (const n of HOOKED)
        for (const zfo of [true, false])
          reqs.push(['eth_call', [{ to: d.hook, data: encodeFunctionData({ abi: hookAbi, functionName: 'quoteFee', args: [pools[n].key, zfo] }) }, 'pending']]);
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
    const demoteBps = Number(d.pools.mjev.brierDemoteBps ?? 2500);
    const isDemoted = (n: Hooked) => {
      const c = nodeCalib[nodeOf(n)];
      return !c || c.n < cfg.minSamples || (demoteBps > 0 && c.brier > demoteBps);
    };
    const demCount = Object.fromEntries(MODEL_POOLS.map((n) => [n, { a: 0, b: 0, seasoned: null as number | null }])) as Record<(typeof MODEL_POOLS)[number], { a: number; b: number; seasoned: number | null }>;
    const kBk = Object.fromEntries(HOOKED.map((n) => [n, new Array(nB).fill(0)])) as Record<Hooked, number[]>;
    let missedPosts = 0;
    const arbWins = new Array(cfg.arbs.length).fill(0);
    let retailOrders = 0;
    let retailUsd = 0;
    let lastBuy = true;

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
      const txA: Tx[] = [];
      if (t > 0 && t % cfg.settleEvery === 0) {
        for (const n of MODEL_POOLS) {
          const c = calibFor(pools[n], A);
          if (!c || c.n < cfg.calibMinN) continue;
          txA.push({
            to: d.hook,
            data: encodeFunctionData({ abi: hookAbi, functionName: 'setCalibration', args: [nodeOf(n), c.brierBps, c.hitRateBps, c.n] }),
            gas: 200_000,
            meta: { label: 'calib', pool: n },
          });
          calibrations.push({ step: t, pool: n, brierBps: c.brierBps, n: c.n, ok: true });
          nodeCalib[nodeOf(n)] = { brier: c.brierBps, n: c.n };
        }
      }
      const scores: Partial<Record<Hooked, { p: number; c: number; source: SourceV2 | '' }>> = {};
      if (missed) missedPosts++;
      else {
        for (const n of HOOKED) {
          const p = pools[n];
          if (n === 'detox' || n === 'const') {
            scores[n] = { p: 10_000, c: 10_000, source: '' };
            continue;
          }
          const f = computeFeatures({
            swaps: p.hist,
            oracleX96: Mk,
            poolX96: (p.sqrtP * p.sqrtP) / Q96,
            depth0: p.sqrtP > 0n ? (p.L * Q96) / p.sqrtP : 0n,
            recentMids,
            currentBlock: A,
            lastAttestBlock: p.lastAttestBlock || A - 3,
            baseFee: 3000,
            windowBlocks: 120,
            baseIsToken0,
            kBps: p.kBps,
            feeMax: Number(d.pools[n].feeMax ?? 10000),
          });
          const sc = n === 'mheur' ? heurScorer : jevScorer;
          const { s, source } = await sc.score(f, t, n === 'gated' && t >= degradeAt);
          scores[n] = { p: s.pToxicBps, c: s.confidenceBps, source };
        }
        for (const n of HOOKED) {
          const sc = scores[n]!;
          const att = await signAttestation(
            attestor,
            31337,
            d.hook,
            { poolId: pools[n].id, blockNumber: BigInt(A), oracleMidX96: Mk, pToxicBps: sc.p, confidenceBps: sc.c, modelNode: nodeOf(n) },
            domain,
          );
          txA.push({
            to: d.hook,
            data: encodeFunctionData({ abi: hookAbi, functionName: 'setAttestation', args: [pools[n].key, att] }),
            gas: 400_000,
            meta: { label: 'attest', pool: n },
          });
        }
      }
      const ra = await sendAndMine(txA, t);
      for (const c of calibrations) if (c.step === t && reverts.some((x) => x.step === t && x.label === 'calib' && x.pool === c.pool)) c.ok = false;
      for (const rc of ra.rcs) {
        for (const lg of rc.logs as { address: string; topics: Hex[]; data: Hex }[]) {
          if (lg.address.toLowerCase() !== d.hook.toLowerCase()) continue;
          try {
            const ev = decodeEventLog({ abi: hookAbi, data: lg.data, topics: lg.topics as [Hex, ...Hex[]] }) as { eventName: string; args: any };
            if (ev.eventName !== 'AttestationPosted') continue;
            const n = byId.get(String(ev.args.id).toLowerCase()) as Hooked | undefined;
            if (!n) continue;
            pools[n].kBps = Number(ev.args.kBps);
            pools[n].lastAttestBlock = A;
            pools[n].pInForce = scores[n]!.p / 10_000;
            attMidInForce = Mk;
          } catch {
            /* other events */
          }
        }
      }
      for (const n of MODEL_POOLS) {
        const dm = isDemoted(n);
        if (t < degradeAt) demCount[n].a += dm ? 1 : 0;
        else demCount[n].b += dm ? 1 : 0;
        if (!dm && demCount[n].seasoned === null) demCount[n].seasoned = t;
      }
      for (const n of HOOKED) {
        kBk[n][bIdx] += pools[n].kBps / cfg.bucketSteps;
        pools[n].kSum += pools[n].kBps;
        pools[n].kN++;
      }

      // ================= block B: competing arbitrageurs vs the TRUE mid
      const B = head + 1;
      stepOfBlock.set(B, t);
      bBlocks.add(B);
      if (attMidInForce !== undefined) attMidAtBlock.set(B, attMidInForce);
      const qB = await quoteNext();
      const M = X96(mid);
      const uA = stream(cfg.seed, t, 2);
      const order = cfg.arbs.map((_, i) => ({ i, r: uA() })).sort((a, b) => a.r - b.r).map((x) => x.i);
      const late = cfg.arbs.map(() => uA() < cfg.arbLateProb);
      const txB: Tx[] = [];
      const arbOf = new Map<Pool, number>();
      for (const n of POOLS) {
        const p = pools[n];
        if (p.hooked && qB[n as Hooked].stale) p.tot.staleSteps++;
        const P = (p.sqrtP * p.sqrtP) / Q96;
        const zfo = P > M;
        const fee = feeFor(n, zfo, qB);
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
          txB.push({ to: d.splitSwapRouter, data, gas: 600_000 * Math.max(1, cfg.split), meta: { label: 'arb', pool: n } });
          arbOf.set(n, ai);
          arbWins[ai]++;
          break;
        }
      }
      const rb = await sendAndMine(txB, t);
      const arbCounted = new Set<Pool>();
      const arbFeeSeen = new Map<Pool, number>();
      parseBlock(rb, mid, (n, label, h, feePips) => {
        if (label !== 'arb') return;
        const p = pools[n];
        const value = h.base * mid + h.quote;
        const inUsd = h.base < 0 ? -h.base * mid : h.quote < 0 ? -h.quote : 0;
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
          p.tot.arbNet -= a.gasUsd;
          arbFeeSeen.set(n, feePips);
        }
      });
      for (const [n, f] of arbFeeSeen) pools[n].arbFeeSum += f;
      for (const n of HOOKED) if (pools[n].pInForce !== undefined) pools[n].pAtBlock.set(B, pools[n].pInForce!);
      await readStates();

      // ================= block C: retail, routed per market by best execution
      const C = head + 1;
      stepOfBlock.set(C, t);
      if (attMidInForce !== undefined) attMidAtBlock.set(C, attMidInForce);
      const qC = await quoteNext();
      const uR = stream(cfg.seed, t, 3);
      const k = poisson(cfg.lambda, uR);
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
      const txC: Tx[] = [];
      if (orders.length) {
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
              f: feeFor(n, payToken0, qC) / 1e6,
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
      }
      const rc = await sendAndMine(txC, t);
      parseBlock(rc, mid, (n, label, h, feePips) => {
        if (label !== 'retail') return;
        const p = pools[n];
        const value = h.base * mid + h.quote;
        const inUsd = h.base < 0 ? -h.base * mid : h.quote < 0 ? -h.quote : 0;
        p.tot.retailCost -= value;
        p.bk.retailCost[bIdx] -= value;
        p.tot.retailFees += (inUsd * feePips) / 1e6;
        p.tot.retailVol += Math.abs(h.quote);
        p.bk.retailVol[bIdx] += Math.abs(h.quote);
        p.retailFeeW += Math.abs(h.quote) * feePips;
      });
      for (const n of HOOKED) if (pools[n].pInForce !== undefined) pools[n].pAtBlock.set(C, pools[n].pInForce!);
      if (txC.length) await readStates();

      // ---- per-step LP accounting (marked at the true mid)
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

      if (t % 600 === 0 || t === T - 1) {
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
      }
    }
    jevScorer.save();
    // whole-window label diagnostics per model pool (same labelling as the settler, all labelled blocks)
    const labelDiag = {} as RunResultV2['labelDiag'];
    for (const n of MODEL_POOLS) {
      const p = pools[n];
      const labels = labelBlocks(
        p.receipts,
        (b) => (cfg.labelMid === 'attested' ? attMidAtBlock.get(b) : stepOfBlock.get(b) === undefined ? undefined : X96(mids[stepOfBlock.get(b)!]!)),
        (r) => p.pAtBlock.get(r.blockNumber),
      );
      const ys = labels.map((l) => l.y);
      const ps = labels.map((l) => l.p);
      const nL = labels.length;
      const br = nL ? ps.reduce((a, x, i) => a + (x - ys[i]!) ** 2, 0) / nL : NaN;
      const arbL = labels.filter((l) => bBlocks.has(l.block));
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
    const { path: _p, ...rest } = cfg;
    const h1 = degradeAt;
    const h2 = T - degradeAt;
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
        MODEL_POOLS.map((n) => [n, { firstHalf: demCount[n].a / Math.max(1, h1), secondHalf: demCount[n].b / Math.max(1, h2), seasonedAtStep: demCount[n].seasoned }]),
      ) as RunResultV2['demoted'],
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
        counts: cnt,
        fallbackShare: nScores ? (cnt.heuristic + cnt['heuristic-paced'] + cnt['heuristic-jev-failed']) / nScores : 0,
        p50LatencyMs: lat.length ? Math.round(lat[Math.floor(lat.length / 2)]!) : null,
      },
      reverts,
      txCount,
      runtimeSec: Math.round((Date.now() - t0) / 1000),
    };
  } finally {
    anvil.stop();
  }
}
