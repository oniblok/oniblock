/**
 * One benchmark run: one price path, five pools, fresh anvil.
 *
 * Every price step t (one real kline step) is replayed as two consecutive blocks:
 *   block A_t  keeper: setAttestation for pools 2..5 (oracle mid = kline close; pool 4/5 carry the model score;
 *              every M steps the settler posts calibration first, so a demotion applies to that block's k)
 *   block B_t  rational arb on EACH pool vs the kline mid (trade to the no-trade band edge given the hook's quoted
 *              per-block fee; only if profit at mid > fixed gas cost), optionally as N split sub-swaps in one tx;
 *              then the identical seeded retail orders on every pool.
 * Splitting the step lets the arb read the exact anchored fee (hook.quoteFee) after the attestation landed.
 * All txs come from one EOA in nonce order and blocks are mined manually => fully deterministic.
 */
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  maxUint256,
  createPublicClient,
  http,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { signAttestation, resolveAttestDomain } from '../../services/src/attest.js';
import { computeFeatures, type SwapObs } from '../../services/src/features.js';
import { labelBlocks, calibrate } from '../../services/src/settler.js';
import type { ReceiptLog } from '../../services/src/chain.js';
import { poolStateSlot } from '../../services/src/chain.js';
import { midToPriceX96, Q96 } from '../../services/src/price.js';
import { planArb } from '../../services/src/bots/arbMath.js';
import { ACTOR, ATTESTOR_PK, Anvil, MODEL_NODES, deployBench, type BenchDeployment } from './chain.js';
import type { PricePath } from './data.js';
import { Scorer, type Source } from './model.js';
import { loadAbi, lognormal, log, poisson, rng, type Rpc } from './util.js';

export const POOL_NAMES = ['fixed', 'detox', 'const', 'model', 'gated'] as const;
export type PoolName = (typeof POOL_NAMES)[number];
const HOOKED: PoolName[] = ['detox', 'const', 'model', 'gated'];

export interface RunConfig {
  label: string;
  path: PricePath;
  split: number;
  modelMode: 'jev' | 'heuristic';
  jevBudget: number;
  port: number;
  lambda: number;
  retailUsd: number;
  gasUsd: number;
  seed: number;
  degradeAtFrac: number;
  settleEvery: number;
  calibWindow: number;
  calibMinN: number;
  liquidity: bigint;
  /** PoolConfig.minSamples for the model pools (calibration samples before k may leave kDefault). */
  minSamples: number;
  /** Settler label horizon: 0 = mid in force at the swap block (default), 1 = next step's mid (pre-INTEGRATION_1). */
  markoutHorizon: 0 | 1;
  /** Pass the hook's k/feeMax into the model state (default true; false = pre-INTEGRATION_1). */
  feeAware: boolean;
}

export interface PoolSeries {
  lpMinusHodl: number[]; // level after block B_t (USD at mid_t)
  dLp: number[]; // per-step increment of lpMinusHodl
  arbProfit: number[]; // arb profit at mid (LVR proxy), USD, before gas
  arbFees: number[];
  retailFees: number[];
  lpFees: number[]; // fee growth accrued to the LP this step, USD at mid
  retailCost: number[]; // retail paid - received at mid (fees + price impact), USD
  arbVol: number[];
  retailVol: number[];
  nArb: number[];
  arbSubSwaps: number[]; // PoolManager Swap events inside arb txs (split=N => N per arb)
  k: number[]; // on-chain k after this step's attestation (bps); NaN for fixed
  pToxic: number[];
  arbFeePips: number[]; // fee paid by the arb (NaN if none)
  gapBps: number[]; // |pool - mid| before the arb, bps
  source: (Source | '')[];
}

export interface CalibPost {
  step: number;
  pool: PoolName;
  brierBps: number;
  hitRateBps: number;
  n: number;
  ok: boolean;
}

export interface RunResult {
  label: string;
  config: Omit<RunConfig, 'path' | 'liquidity'> & { liquidity: string; window: PricePath['window']; interval: string; stepSeconds: number; blocks: number };
  degradeAtStep: number;
  pools: Record<PoolName, PoolSeries>;
  mids: number[];
  initialTvlUsd: number;
  calibrations: CalibPost[];
  offchainCalibration: Record<string, { brierBps: number; hitRateBps: number; n: number } | null>;
  jev: { mode: string; calls: number; failures: number; counts: Record<Source, number>; p50LatencyMs: number | null; cacheSize: number };
  reverts: { label: string; pool?: string; step: number; hash: Hex }[];
  txCount: number;
  runtimeSec: number;
}

type TxMeta = { label: 'attest' | 'calib' | 'arb' | 'retail' | 'approve'; pool?: PoolName };

interface PoolRt {
  name: PoolName;
  id: Hex;
  key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
  hooked: boolean;
  sqrtP: bigint;
  L: bigint;
  fg0: bigint;
  fg1: bigint;
  sqrtLo: number;
  sqrtHi: number;
  x0: number; // initial LP amounts (human base / quote)
  y0: number;
  hist: SwapObs[];
  receipts: ReceiptLog[];
  lastAttestBlock: number;
  kBps: number; // on-chain k after the last accepted attestation (fed to the fee-aware model state)
  pAtBlock: Map<number, number>; // B-block -> pToxic (0..1) in force
  s: PoolSeries;
}

const newSeries = (): PoolSeries => ({
  lpMinusHodl: [],
  dLp: [],
  arbProfit: [],
  arbFees: [],
  retailFees: [],
  lpFees: [],
  retailCost: [],
  arbVol: [],
  retailVol: [],
  nArb: [],
  arbSubSwaps: [],
  k: [],
  pToxic: [],
  arbFeePips: [],
  gapBps: [],
  source: [],
});

const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;

export async function runOne(cfg: RunConfig): Promise<RunResult> {
  const t0 = Date.now();
  const { path } = cfg;
  const T = path.mids.length;
  const anvil = new Anvil(cfg.port);
  const hookAbi = loadAbi('OniblockHook');
  const pmAbi = loadAbi('PoolManager');
  const routerAbi = loadAbi('SplitSwapRouter');
  const erc20Abi = loadAbi('ERC20');
  const reverts: RunResult['reverts'] = [];
  const calibrations: CalibPost[] = [];
  let txCount = 0;

  await anvil.start();
  try {
    const d: BenchDeployment = await deployBench(anvil, path.mids[0]!, cfg.liquidity, cfg.minSamples);
    const rpc: Rpc = anvil.rpc;
    const baseIsToken0 = d.wethIsToken0;
    const meta = { baseIsToken0, decimals0: baseIsToken0 ? 18 : 6, decimals1: baseIsToken0 ? 6 : 18 };
    const toHuman = (a0: bigint, a1: bigint) =>
      baseIsToken0 ? { base: Number(a0) / 1e18, quote: Number(a1) / 1e6 } : { base: Number(a1) / 1e18, quote: Number(a0) / 1e6 };
    const attestor = privateKeyToAccount(ATTESTOR_PK);
    const pc = createPublicClient({ transport: http(anvil.url) });
    const domain = await resolveAttestDomain(pc as never, d.hook, { name: 'Oniblock' });
    const scorer = new Scorer(cfg.modelMode, cfg.jevBudget, T, baseIsToken0);
    const degradeAt = Math.floor(T * cfg.degradeAtFrac);

    // ---- pool runtime state
    const pools = {} as Record<PoolName, PoolRt>;
    for (const name of POOL_NAMES) {
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
        pAtBlock: new Map(),
        s: newSeries(),
      };
    }

    // ---- tx plumbing (single actor, local nonce, manual mining)
    let nonce = Number(await rpc.call<string>('eth_getTransactionCount', [ACTOR, 'pending']));
    let head = Number(await rpc.call<string>('eth_blockNumber'));
    const sendAndMine = async (txs: { to: Address; data: Hex; gas: number; meta: TxMeta }[], step: number) => {
      const res = await rpc.batchSettled<Hex>(
        txs.map((tx) => ['eth_sendTransaction', [{ from: ACTOR, to: tx.to, data: tx.data, gas: hex(tx.gas), gasPrice: '0x0', nonce: hex(nonce++) }]]),
      );
      const byHash = new Map<string, TxMeta>();
      res.forEach((r, i) => {
        if ('error' in r) {
          reverts.push({ label: `send:${txs[i]!.meta.label}`, pool: txs[i]!.meta.pool, step, hash: '0x' });
          log('send_error', { step, label: txs[i]!.meta.label, pool: txs[i]!.meta.pool, error: r.error });
          nonce = -1; // resync below
        } else byHash.set(r.result.toLowerCase(), txs[i]!.meta);
      });
      await rpc.call('evm_mine');
      head++;
      if (nonce < 0) nonce = Number(await rpc.call<string>('eth_getTransactionCount', [ACTOR, 'pending']));
      txCount += txs.length;
      const rcs = txs.length ? await rpc.call<any[]>('eth_getBlockReceipts', [hex(head)]) : [];
      if (rcs.length !== byHash.size) log('warn_receipt_count', { step, expected: byHash.size, got: rcs.length });
      for (const rc of rcs) {
        if (rc.status !== '0x1') {
          const m = byHash.get(rc.transactionHash.toLowerCase());
          reverts.push({ label: m?.label ?? '?', pool: m?.pool, step, hash: rc.transactionHash });
          if (reverts.length <= 20) log('tx_reverted', { step, label: m?.label, pool: m?.pool, hash: rc.transactionHash });
        }
      }
      return { rcs, byHash };
    };

    const readStates = async () => {
      const names = POOL_NAMES;
      const res = await rpc.batch<Hex>(
        names.map((n) => [
          'eth_call',
          [{ to: d.poolManager, data: encodeFunctionData({ abi: pmAbi, functionName: 'extsload', args: [poolStateSlot(pools[n].id), 4n] }) }, 'latest'],
        ]),
      );
      names.forEach((n, i) => {
        const w = decodeFunctionResult({ abi: pmAbi, functionName: 'extsload', data: res[i]!, args: [poolStateSlot(pools[n].id), 4n] } as never) as unknown as Hex[];
        const p = pools[n];
        p.sqrtP = BigInt(w[0]!) & ((1n << 160n) - 1n);
        p.fg0 = BigInt(w[1]!);
        p.fg1 = BigInt(w[2]!);
        p.L = BigInt(w[3]!) & ((1n << 128n) - 1n);
      });
    };

    /** LP position amounts (human) incl. uncollected fees, from pool state (single full-range LP). */
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

    // ---- setup: approvals, initial state
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
    const prevFeesUsd: Record<string, { base: number; quote: number }> = {};
    for (const n of POOL_NAMES) {
      const { pos } = lpAmounts(pools[n]);
      pools[n].x0 = pos.base;
      pools[n].y0 = pos.quote;
      prevFeesUsd[n] = { base: 0, quote: 0 };
      if (n === 'fixed') initialTvlUsd = pos.base * path.mids[0]! + pos.quote;
    }
    const prevLp: Record<string, number> = Object.fromEntries(POOL_NAMES.map((n) => [n, 0]));
    const stepOfBBlock = new Map<number, number>();

    const keyTuple = (p: PoolRt) => p.key;
    const X96 = (mid: number) => midToPriceX96(mid.toFixed(8), meta);

    // ---- settler (honest, off our own recorded receipts; same labelling as services/src/settler.ts)
    const calibFor = (p: PoolRt, uptoBlock: number) => {
      const rs = p.receipts.filter((r) => r.blockNumber < uptoBlock);
      const labels = labelBlocks(
        rs,
        (b) => {
          const s = stepOfBBlock.get(b);
          if (s === undefined) return undefined;
          // horizon 0 (INTEGRATION_1 fix a): the attested mid in force at the swap block = kline mid of step s
          // (identical to services attestationIndex(atts).midInForce(b), since A_s attests mids[s] right before B_s);
          // horizon 1 (old): the next step's mid.
          if (cfg.markoutHorizon === 0) return X96(path.mids[s]!);
          return s + 1 < T ? X96(path.mids[s + 1]!) : undefined;
        },
        (r) => p.pAtBlock.get(r.blockNumber),
      );
      return calibrate(labels, cfg.calibWindow)[0];
    };

    log('run_start', { label: cfg.label, steps: T, split: cfg.split, mode: cfg.modelMode, degradeAt, tvlUsd: Math.round(initialTvlUsd) });

    for (let t = 0; t < T; t++) {
      const mid = path.mids[t]!;
      const M = X96(mid);
      const recentMids = path.mids.slice(Math.max(0, t - 29), t + 1);
      const A = head + 1;
      const txA: { to: Address; data: Hex; gas: number; meta: TxMeta }[] = [];

      // settler: calibration for the two model nodes every M steps (before this block's attestations)
      if (t > 0 && t % cfg.settleEvery === 0) {
        for (const n of ['model', 'gated'] as PoolName[]) {
          const c = calibFor(pools[n], head + 1);
          if (!c || c.n < cfg.calibMinN) continue;
          const node = n === 'model' ? MODEL_NODES.model : MODEL_NODES.gated;
          txA.push({
            to: d.hook,
            data: encodeFunctionData({ abi: hookAbi, functionName: 'setCalibration', args: [node, c.brierBps, c.hitRateBps, c.n] }),
            gas: 200_000,
            meta: { label: 'calib', pool: n },
          });
          calibrations.push({ step: t, pool: n, brierBps: c.brierBps, hitRateBps: c.hitRateBps, n: c.n, ok: true });
        }
      }

      // keeper: scores + attestations
      const scores: Partial<Record<PoolName, { p: number; c: number; node: Hex; source: Source | '' }>> = {};
      for (const n of HOOKED) {
        const p = pools[n];
        if (n === 'detox' || n === 'const') {
          scores[n] = { p: 10_000, c: 10_000, node: MODEL_NODES.const, source: '' }; // kMin = kMax: score irrelevant
          continue;
        }
        const P = (p.sqrtP * p.sqrtP) / Q96;
        const f = computeFeatures({
          swaps: p.hist,
          oracleX96: M,
          poolX96: P,
          depth0: p.sqrtP > 0n ? (p.L * Q96) / p.sqrtP : 0n,
          recentMids,
          currentBlock: A,
          lastAttestBlock: p.lastAttestBlock || A - 2,
          baseFee: 3000,
          windowBlocks: 40,
          baseIsToken0,
          // fee-aware state (INTEGRATION_1 fix b): the model sees the regime fee min(base + k*gap, feeMax)
          ...(cfg.feeAware ? { kBps: p.kBps, feeMax: Number(d.pools[n].feeMax ?? 10000) } : {}),
        });
        const { s, source } = await scorer.score(f, t, n === 'gated' && t >= degradeAt);
        scores[n] = { p: s.pToxicBps, c: s.confidenceBps, node: n === 'model' ? MODEL_NODES.model : MODEL_NODES.gated, source };
      }
      for (const n of HOOKED) {
        const sc = scores[n]!;
        const att = await signAttestation(
          attestor,
          31337,
          d.hook,
          { poolId: pools[n].id, blockNumber: BigInt(A), oracleMidX96: M, pToxicBps: sc.p, confidenceBps: sc.c, modelNode: sc.node },
          domain,
        );
        txA.push({
          to: d.hook,
          data: encodeFunctionData({ abi: hookAbi, functionName: 'setAttestation', args: [keyTuple(pools[n]), att] }),
          gas: 400_000,
          meta: { label: 'attest', pool: n },
        });
      }
      const ra = await sendAndMine(txA, t);
      for (const c of calibrations) if (c.step === t && reverts.some((x) => x.step === t && x.label === 'calib' && x.pool === c.pool)) c.ok = false;
      const kNow: Partial<Record<PoolName, number>> = {};
      for (const rc of ra.rcs) {
        for (const lg of rc.logs as { address: string; topics: Hex[]; data: Hex }[]) {
          if (lg.address.toLowerCase() !== d.hook.toLowerCase()) continue;
          try {
            const ev = decodeEventLog({ abi: hookAbi, data: lg.data, topics: lg.topics as [Hex, ...Hex[]] }) as { eventName: string; args: any };
            if (ev.eventName === 'AttestationPosted') {
              const n = HOOKED.find((x) => pools[x].id.toLowerCase() === String(ev.args.id).toLowerCase());
              if (n) {
                kNow[n] = Number(ev.args.kBps);
                pools[n].kBps = kNow[n]!;
                pools[n].lastAttestBlock = A;
              }
            }
          } catch {
            /* other events */
          }
        }
      }

      // ---- block B: arbs then retail
      const B = head + 1;
      stepOfBBlock.set(B, t);
      const quoteReqs: [string, unknown[]][] = [];
      for (const n of HOOKED)
        for (const zfo of [true, false])
          quoteReqs.push(['eth_call', [{ to: d.hook, data: encodeFunctionData({ abi: hookAbi, functionName: 'quoteFee', args: [keyTuple(pools[n]), zfo] }) }, 'latest']]);
      const qres = await rpc.batch<Hex>(quoteReqs);
      const quoted: Partial<Record<PoolName, { t: number; f: number }>> = {};
      HOOKED.forEach((n, i) => {
        const dec = (h: Hex) => Number((decodeFunctionResult({ abi: hookAbi, functionName: 'quoteFee', data: h }) as unknown as [bigint])[0]);
        quoted[n] = { t: dec(qres[2 * i]!), f: dec(qres[2 * i + 1]!) };
      });

      const txB: { to: Address; data: Hex; gas: number; meta: TxMeta }[] = [];
      const gapBefore: Partial<Record<PoolName, number>> = {};
      for (const n of POOL_NAMES) {
        const p = pools[n];
        const P = (p.sqrtP * p.sqrtP) / Q96;
        const zfo = P > M;
        gapBefore[n] = (Math.abs(Number(P - M)) / Number(M)) * 1e4;
        const fee = p.hooked ? (zfo ? quoted[n]!.t : quoted[n]!.f) : p.key.fee;
        const plan = planArb({ sqrtPriceX96: p.sqrtP, liquidity: p.L, oracleX96: M, feePips: fee });
        if (!plan) continue;
        const profitUsd = baseIsToken0 ? plan.profitToken1 / 1e6 : (plan.profitToken1 / 1e18) * mid;
        if (profitUsd <= cfg.gasUsd) continue;
        const amt = -((plan.amountIn * 1005n) / 1000n);
        const data =
          cfg.split > 1
            ? encodeFunctionData({ abi: routerAbi, functionName: 'swapSplit', args: [keyTuple(p), plan.zeroForOne, amt, BigInt(cfg.split), plan.sqrtTargetX96, ACTOR] })
            : encodeFunctionData({ abi: routerAbi, functionName: 'swap', args: [keyTuple(p), plan.zeroForOne, amt, plan.sqrtTargetX96, ACTOR] });
        txB.push({ to: d.splitSwapRouter, data, gas: 600_000 * Math.max(1, cfg.split), meta: { label: 'arb', pool: n } });
      }
      // identical retail orders on every pool: seeded per step, independent of run length / split / pool
      const u = rng((cfg.seed * 1_000_003 + t * 2_654_435_761) >>> 0);
      const k = poisson(cfg.lambda, u);
      for (let i = 0; i < k; i++) {
        const usd = lognormal(cfg.retailUsd, u);
        const buyBase = u() < 0.5;
        for (const n of POOL_NAMES) {
          const p = pools[n];
          const payToken0 = buyBase ? !baseIsToken0 : baseIsToken0;
          const payIsBase = !buyBase;
          const amountIn = payIsBase ? BigInt(Math.floor((usd / mid) * 1e12)) * 10n ** 6n : BigInt(Math.floor(usd * 1e6));
          txB.push({
            to: d.splitSwapRouter,
            data: encodeFunctionData({ abi: routerAbi, functionName: 'swap', args: [keyTuple(p), payToken0, -amountIn, payToken0 ? MIN_SQRT : MAX_SQRT, ACTOR] }),
            gas: 600_000,
            meta: { label: 'retail', pool: n },
          });
        }
      }
      const rb = await sendAndMine(txB, t);

      // ---- per-step accounting from PoolManager Swap events (swapper-signed deltas) + hook Receipts
      const acc = Object.fromEntries(
        POOL_NAMES.map((n) => [n, { arb: 0, arbFees: 0, retailFees: 0, retailCost: 0, arbVol: 0, retailVol: 0, nArb: 0, sub: 0, arbFee: NaN }]),
      ) as Record<PoolName, { arb: number; arbFees: number; retailFees: number; retailCost: number; arbVol: number; retailVol: number; nArb: number; sub: number; arbFee: number }>;
      const byId = new Map(POOL_NAMES.map((n) => [pools[n].id.toLowerCase(), n]));
      for (const rc of rb.rcs) {
        const m = rb.byHash.get(rc.transactionHash.toLowerCase());
        let arbCounted = false;
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
            const h = toHuman(ev.args.amount0 as bigint, ev.args.amount1 as bigint);
            const value = h.base * mid + h.quote; // to swapper, at mid
            const feeFrac = Number(ev.args.fee) / 1e6;
            const inUsd = h.base < 0 ? -h.base * mid : h.quote < 0 ? -h.quote : 0;
            const a = acc[n];
            if (m?.label === 'arb') {
              a.arb += value;
              a.arbFees += inUsd * feeFrac;
              a.arbVol += Math.abs(h.quote);
              a.arbFee = Number(ev.args.fee);
              a.sub += 1;
              if (!arbCounted) (a.nArb += 1), (arbCounted = true);
            } else if (m?.label === 'retail') {
              a.retailCost -= value;
              a.retailFees += inUsd * feeFrac;
              a.retailVol += Math.abs(h.quote);
            }
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
              logIndex: Number(lg.topics.length),
            };
            const p = pools[n];
            p.receipts.push(r);
            p.hist.push({ block: r.blockNumber, zeroForOne: r.zeroForOne, amount0: r.amount0, amount1: r.amount1, fee: r.feePips, arbDir: r.arbDir });
          }
        }
      }

      await readStates();
      for (const n of POOL_NAMES) {
        const p = pools[n];
        if (p.hist.length > 400) p.hist.splice(0, p.hist.length - 400);
        const { pos, fees } = lpAmounts(p);
        const lp = (pos.base + fees.base) * mid + pos.quote + fees.quote;
        const hodl = p.x0 * mid + p.y0;
        const lmh = lp - hodl;
        const pf = prevFeesUsd[n]!;
        const s = p.s;
        s.lpFees.push((fees.base - pf.base) * mid + (fees.quote - pf.quote));
        prevFeesUsd[n] = { base: fees.base, quote: fees.quote };
        s.lpMinusHodl.push(lmh);
        s.dLp.push(lmh - prevLp[n]!);
        prevLp[n] = lmh;
        const a = acc[n];
        s.arbProfit.push(a.arb);
        s.arbFees.push(a.arbFees);
        s.retailFees.push(a.retailFees);
        s.retailCost.push(a.retailCost);
        s.arbVol.push(a.arbVol);
        s.retailVol.push(a.retailVol);
        s.nArb.push(a.nArb);
        s.arbSubSwaps.push(a.sub);
        s.arbFeePips.push(a.arbFee);
        s.gapBps.push(gapBefore[n]!);
        s.k.push(p.hooked ? (kNow[n] ?? NaN) : NaN);
        const sc = scores[n];
        s.pToxic.push(sc ? sc.p : NaN);
        s.source.push(sc?.source ?? '');
        if (sc && p.hooked) p.pAtBlock.set(B, sc.p / 10_000);
      }

      if (t % 500 === 0 || t === T - 1) {
        log('progress', {
          label: cfg.label,
          step: t,
          of: T,
          mid,
          sec: Math.round((Date.now() - t0) / 1000),
          lpMinusHodl: Object.fromEntries(POOL_NAMES.map((n) => [n, Math.round(pools[n].s.lpMinusHodl[t]!)])),
          k: Object.fromEntries(HOOKED.map((n) => [n, kNow[n]])),
          jev: scorer.counts,
        });
      }
    }
    scorer.save();

    const offchainCalibration: RunResult['offchainCalibration'] = {};
    for (const n of ['model', 'gated'] as PoolName[]) {
      const c = calibFor(pools[n], head + 1);
      offchainCalibration[n] = c ? { brierBps: c.brierBps, hitRateBps: c.hitRateBps, n: c.n } : null;
    }
    const lat = [...scorer.latencies].sort((a, b) => a - b);
    const { path: _p, liquidity, ...rest } = cfg;
    return {
      label: cfg.label,
      config: { ...rest, liquidity: liquidity.toString(), window: path.window, interval: path.interval, stepSeconds: path.stepSeconds, blocks: T },
      degradeAtStep: degradeAt,
      pools: Object.fromEntries(POOL_NAMES.map((n) => [n, pools[n].s])) as Record<PoolName, PoolSeries>,
      mids: path.mids,
      initialTvlUsd,
      calibrations,
      offchainCalibration,
      jev: {
        mode: cfg.modelMode,
        calls: scorer.calls,
        failures: scorer.failures,
        counts: scorer.counts,
        p50LatencyMs: lat.length ? Math.round(lat[Math.floor(lat.length / 2)]!) : null,
        cacheSize: scorer.cache.size,
      },
      reverts,
      txCount,
      runtimeSec: Math.round((Date.now() - t0) / 1000),
    };
  } finally {
    anvil.stop();
  }
}
