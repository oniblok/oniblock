/**
 * Settler: scores the model against markouts and writes calibration on-chain.
 *
 * For every block b containing non-stale arb-direction swaps on our pool:
 *   markout_net(b) = Σ swaps [ amount0 * mid_h + amount1 ]   (token1 units; swapper deltas,
 *                    positive = received, so fees paid are already inside the amounts)
 *   feePaid(b)     = Σ |input leg| * feePips / 1e6
 *   y(b) = 1 ("informed") iff gross markout (net + fee) > the label fee (SETTLER_LABEL_FEE):
 *     base (v4 default) -> Σ |input leg| * poolConfig.baseFee / 1e6: "was there profitable arbitrage at the BASE fee?"
 *                          — exactly the v4 Jev question. Independent of the k the model chose, so a model that
 *                          protects LPs (high k makes the remaining arb-direction flow unprofitable net of the fee
 *                          it paid) is not graded as wrong for it.
 *     paid (pre-v4)     -> feePaid, i.e. net markout > 0.
 *   Dead band (v4, SETTLER_DEADBAND_USD=1, SETTLER_DEADBAND_BPS=1; 0/0 = old behaviour): 59% of real blocks have
 *   |markout| < $1, so a sign-only label is decided by mid noise most of the time and the gate grades coin flips.
 *   With m = markout net of the label fee and T = max(DEADBAND_USD, DEADBAND_BPS/1e4 * arb-direction USD volume of
 *   the block): y = 1 iff m > T, y = 0 iff m < -T, and |m| <= T is NOT graded (counted as skipped_ambiguous). The
 *   fine-tuning export (ml/src/kev_export_deadband.py) uses the same label, so the model and the gate agree.
 *   p(b) = pToxic of the attestation in force at b (the one referenced by the Receipt's modelNode)
 *   Only receipts whose modelNode is a REAL model are graded: receipts priced under the keeper's deterministic
 *   below-threshold rule (rule-v1.models.oniblock.eth, env RULE_MODEL_NAME; v3 gate) are skipped, so rule-v1
 *   never gets a calibration record (it stays unseasoned => kDefault, which is irrelevant below the threshold).
 *   mid_h (SETTLER_LABEL_MID, v3 default `cex`):
 *     cex      -> the CEX mid AT THE SWAP'S BLOCK TIME, fetched ex post: PRICE_SOURCE=replay -> the replay path's
 *                 mid at block b (the same series the keeper/arb use); otherwise the Binance 1s kline at block b's
 *                 timestamp (SettlerOpts.midSource overrides both). The LVR definition: profitable vs the
 *                 contemporaneous CEX price, net of fee. Fixes the pre-v3 mislabelling: the attested mid lags the
 *                 arbitrageur (keeper lag), so arbs measured against it look unprofitable and an honest model is
 *                 demoted (benchmark/results_v2, labelatt variant).
 *     attested -> the attested mid in force at b (pre-v3 behaviour, = old MARKOUT_HORIZON=0).
 *   MARKOUT_HORIZON=1 (overrides) -> first attested mid mined after b (the +1-block markout). Adds the next block's
 *          price move to every label; when that move is comparable to the fee (4-minute replay steps) the labels
 *          are mostly noise and an honest model fails the gate (docs/review/INTEGRATION_1.md, experiment).
 * Per modelNode over the last CALIB_WINDOW labelled blocks:
 *   Brier B = mean((p - y)^2), hitRate = mean(1[p >= 0.5] == y), n
 *   climatology  q = (Σy + 1) / (n + 2)              (Laplace-smoothed base rate of the same window)
 *                Bref = mean((q - y)^2)              (Brier of always predicting the base rate)
 *   skill        S = 1 - B / Bref                    (> 0: better than the base rate; 1 = perfect)
 * Posted to hook.setCalibration(modelNode, brierBps, ...) — the value the hook's Brier gate compares
 * with brierDemoteBps (2500):
 *   CALIB_GATE=raw (default): brierBps = round(B * 1e4). With the 2500 threshold: demoted iff the model is
 *                             worse than the constant p = 0.5 ("no information") forecaster, whose Brier is 0.25.
 *   CALIB_GATE=skill:         brierBps = min(10000, round(2500 * B / Bref)) = 2500 * (1 - S)
 *                             -> demoted iff no better than the in-window base-rate predictor. Measured to
 *                             separate honest from degraded WORSE than raw (it also demotes the honest model
 *                             whenever the base rate is extreme and climatology is hard to beat), so opt-in.
 * The raw Brier, the skill and the base rate are always written to ENS (calibration.brierRaw /
 * calibration.skill / calibration.baseRate) next to calibration.brier (= the posted gate value).
 *
 * The +1-block mid comes from the next posted attestation (the keeper's mid, auditable on-chain);
 * fallback: the shared replay path (PRICE_SOURCE=replay) or a Binance 1s kline at block b+1's timestamp.
 * If the CEX mid for a block cannot be fetched (SETTLER_LABEL_MID=cex), that block is not labelled.
 *
 * CLI: tsx src/settler.ts [--chain local] [--once] [--every M] [--from BLOCK]
 */
import { namehash, type Hex, type PublicClient } from 'viem';
import { oniblockHookAbi } from './abi/oniblockHook.js';
import { fetchKlines, midAt } from './cex.js';
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
  selectChain,
  type ChainName,
  type Deployment,
  type PairMeta,
  type PoolEntry,
} from './config.js';
import { getAttestations, getReceipts, TxSender, type AttestationLog, type ReceiptLog } from './chain.js';
import { EnsV2CalibrationWriter, loadEnsDeployment, NoopCalibrationWriter, type CalibrationRecordWriter } from './ens.js';
import { midToPriceX96, Q96 } from './price.js';
import { lazyMidSource } from './pricesource.js';

export interface LabelledBlock {
  block: number;
  modelNode: Hex;
  p: number; // 0..1
  y: 0 | 1;
  markoutNet: number; // token1 raw units
  feePaid: number; // token1 raw units
  nSwaps: number;
}

export interface Calibration {
  modelNode: Hex;
  /** Value posted to hook.setCalibration (gate units: demoted iff > brierDemoteBps). See CALIB_GATE. */
  brierBps: number;
  hitRateBps: number;
  n: number;
  /** Absolute Brier score, bps. */
  rawBrierBps: number;
  /** Brier of the climatology (Laplace-smoothed base-rate) predictor over the same window, bps. */
  refBrierBps: number;
  /** Brier skill vs climatology, bps (10000 = perfect, 0 = base rate, negative = worse). */
  skillBps: number;
  /** Share of informed labels in the window, bps. */
  baseRateBps: number;
}

export type CalibGate = 'skill' | 'raw';

/** Brier skill vs a Laplace-smoothed climatology over the same labels. */
export function brierStats(ps: number[], ys: (0 | 1)[]) {
  const n = ys.length;
  const b = ps.reduce((s, p, i) => s + (p - ys[i]!) ** 2, 0) / n;
  let pos = 0;
  for (const y of ys) pos += y;
  const q = (pos + 1) / (n + 2);
  let ref = 0;
  for (const y of ys) ref += (q - y) ** 2;
  ref /= n;
  return { brier: b, ref, skill: 1 - b / ref, baseRate: pos / n };
}

/** Gate value posted on-chain: skill mode maps skill 0 to 2500 (the hook's default brierDemoteBps). */
export function gateBps(brier: number, ref: number, gate: CalibGate): number {
  if (gate === 'raw') return Math.round(brier * 10_000);
  return Math.min(10_000, Math.round((2_500 * brier) / ref));
}

/** Sign convention of Receipt amounts: +1 = swapper perspective (v4 BalanceDelta). */
const AMOUNT_SIGN = BigInt(envInt('RECEIPT_AMOUNT_SIGN', 1));

/**
 * Label blocks. `midNext(b)` returns priceX96 of the CEX mid at block b+1 (or undefined -> skip).
 * `pOf(receipt)` returns the pToxic (0..1) in force for that receipt's block/model, or undefined.
 */
export function labelBlocks(
  receipts: ReceiptLog[],
  midNext: (block: number) => bigint | undefined,
  pOf: (r: ReceiptLog) => number | undefined,
  opts: {
    skipModelNodes?: readonly Hex[];
    labelFee?: 'paid' | 'base';
    baseFeePips?: number;
    /** dead band: USD floor and bps of the block's arb-direction USD volume (0/0 = sign-only label) */
    deadbandUsd?: number;
    deadbandBps?: number;
    /** USD value of one raw token1 unit at block b (needed for the dead band; undefined => no dead band for b) */
    usdPerRawToken1?: (block: number) => number | undefined;
    /** counters filled in by the call */
    stats?: { skippedAmbiguous: number; graded: number };
  } = {},
): LabelledBlock[] {
  const atBase = opts.labelFee === 'base' && opts.baseFeePips !== undefined;
  const dbUsd = opts.deadbandUsd ?? 0;
  const dbBps = opts.deadbandBps ?? 0;
  const skip = new Set((opts.skipModelNodes ?? []).map((n) => n.toLowerCase()));
  const byBlock = new Map<string, ReceiptLog[]>();
  for (const r of receipts) {
    if (!r.arbDir || r.stale) continue;
    if (skip.size && skip.has(String(r.modelNode).toLowerCase())) continue; // e.g. rule-v1: not a model
    const k = `${r.blockNumber}:${r.modelNode}`;
    (byBlock.get(k) ?? byBlock.set(k, []).get(k)!).push(r);
  }
  const out: LabelledBlock[] = [];
  for (const rs of byBlock.values()) {
    const b = rs[0]!.blockNumber;
    const m = midNext(b);
    const p = pOf(rs[0]!);
    if (m === undefined || p === undefined) continue;
    const px = Number(m) / Number(Q96); // raw token1 per raw token0
    let net = 0;
    let fee = 0;
    let baseCost = 0;
    let volume = 0; // arb-direction input value, token1 raw units
    for (const r of rs) {
      const a0 = Number(r.amount0 * AMOUNT_SIGN);
      const a1 = Number(r.amount1 * AMOUNT_SIGN);
      net += a0 * px + a1;
      // input leg = the negative one (paid by swapper)
      const inVal = a0 < 0 ? -a0 * px : a1 < 0 ? -a1 : 0;
      fee += (inVal * r.feePips) / 1e6;
      volume += inVal;
      if (atBase) baseCost += (inVal * opts.baseFeePips!) / 1e6;
    }
    const gross = net + fee;
    const mk = gross - (atBase ? baseCost : fee); // markout net of the label fee, token1 raw units
    let y: 0 | 1;
    if (dbUsd > 0 || dbBps > 0) {
      const usd1 = opts.usdPerRawToken1?.(b);
      if (usd1 === undefined || !(usd1 > 0)) {
        continue; // cannot express the dead band in USD for this block: not graded
      }
      const T = Math.max(dbUsd, (dbBps / 1e4) * volume * usd1);
      const mUsd = mk * usd1;
      if (mUsd > T) y = 1;
      else if (mUsd < -T) y = 0;
      else {
        if (opts.stats) opts.stats.skippedAmbiguous++;
        continue;
      }
    } else y = mk > 0 ? 1 : 0;
    if (opts.stats) opts.stats.graded++;
    out.push({ block: b, modelNode: rs[0]!.modelNode, p, y, markoutNet: net, feePaid: fee, nSwaps: rs.length });
  }
  return out.sort((a, b) => a.block - b.block);
}

/** Brier (+ skill) + hit rate per modelNode over the last `window` labelled blocks (0 = all). */
export function calibrate(labels: LabelledBlock[], window = 0, gate: CalibGate = env('CALIB_GATE', 'raw') as CalibGate): Calibration[] {
  const by = new Map<Hex, LabelledBlock[]>();
  for (const l of labels) (by.get(l.modelNode) ?? by.set(l.modelNode, []).get(l.modelNode)!).push(l);
  const out: Calibration[] = [];
  for (const [node, ls0] of by) {
    const ls = window > 0 ? ls0.slice(-window) : ls0;
    if (!ls.length) continue;
    const st = brierStats(ls.map((l) => l.p), ls.map((l) => l.y));
    const hit = ls.reduce((s, l) => s + ((l.p >= 0.5 ? 1 : 0) === l.y ? 1 : 0), 0) / ls.length;
    out.push({
      modelNode: node,
      brierBps: gateBps(st.brier, st.ref, gate),
      hitRateBps: Math.round(hit * 10_000),
      n: ls.length,
      rawBrierBps: Math.round(st.brier * 10_000),
      refBrierBps: Math.round(st.ref * 10_000),
      skillBps: Math.max(-99_999, Math.round(st.skill * 10_000)),
      baseRateBps: Math.round(st.baseRate * 10_000),
    });
  }
  return out;
}

/** Attestation in force for block b and model: latest one mined at or before b. */
export function attestationIndex(atts: AttestationLog[]) {
  const sorted = [...atts].sort((a, b) => a.minedBlock - b.minedBlock);
  return {
    pAt(block: number, node: Hex): number | undefined {
      let best: AttestationLog | undefined;
      for (const a of sorted) {
        if (a.minedBlock > block) break;
        if (a.modelNode === node) best = a;
      }
      return best ? best.pToxicBps / 10_000 : undefined;
    },
    /** Mid of the latest attestation mined at or before block b (any model): the mid in force at b. */
    midInForce(block: number): bigint | undefined {
      let best: bigint | undefined;
      for (const a of sorted) {
        if (a.minedBlock > block) break;
        best = a.oracleMidX96;
      }
      return best;
    },
    /** First attestation mid mined strictly after block b (any model — mid is model-independent). */
    midAfter(block: number): bigint | undefined {
      for (const a of sorted) if (a.minedBlock > block) return a.oracleMidX96;
      return undefined;
    },
  };
}

/** Model node of the keeper's deterministic below-threshold rule (never graded). */
/**
 * USD value of one raw token1 unit given the mid (priceX96 = raw token1 per raw token0) and the pair: the quote
 * token is USD-denominated (mUSDC). Quote = token1 => 10^-dec1; quote = token0 => 10^-dec0 / px.
 */
export function usdPerRawToken1(meta: PairMeta, midX96: bigint | undefined): number | undefined {
  if (meta.baseIsToken0) return 10 ** -meta.decimals1;
  if (midX96 === undefined || midX96 === 0n) return undefined;
  return 10 ** -meta.decimals0 / (Number(midX96) / Number(Q96));
}

export function ruleModelNode(): Hex {
  return namehash(env('RULE_MODEL_NAME', 'rule-v1.models.oniblock.eth')!);
}

export type LabelMid = 'cex' | 'attested';

export interface SettlerOpts {
  chain: ChainName;
  /** CEX mid (human quote per base) at a block, for SETTLER_LABEL_MID=cex (default: replay path / Binance). */
  midSource?: (block: number) => Promise<number>;
  every?: number;
  fromBlock?: number;
  window?: number;
  minN?: number;
  ens?: CalibrationRecordWriter;
  deployment?: Deployment;
  poolName?: string;
}

export class Settler {
  readonly pc: PublicClient;
  readonly d: Deployment;
  readonly pool: PoolEntry;
  readonly meta: PairMeta;
  private readonly sender: TxSender;
  private readonly ens: CalibrationRecordWriter;
  private lastSettled = -1;
  private busy = false;
  private tsCache = new Map<number, number>();
  private cexCache = new Map<number, bigint>();
  /** PRICE_SOURCE=replay: the fallback mid at b+1 comes from the same replay path the keeper/arb use. */
  private readonly replayMid: ((block?: number) => Promise<number>) | undefined;

  constructor(private readonly o: SettlerOpts) {
    const sel = selectChain(o.chain);
    this.pc = makePublicClient(sel);
    this.d = o.deployment ?? loadDeployment(sel.chain.id);
    this.pool = oniblockPool(this.d, o.poolName);
    this.meta = pairMeta(this.d, this.pool);
    this.sender = new TxSender(this.pc, makeWalletClient(sel, 'settler'), 'settler');
    this.replayMid = env('PRICE_SOURCE') === 'replay' ? lazyMidSource(this.d.startBlock ?? 0, 'settler') : undefined;
    const ensDep = env('ENS_WRITE', '1') === '1' ? loadEnsDeployment(sel.chain.id) : undefined;
    this.ens = o.ens ?? (ensDep ? new EnsV2CalibrationWriter(this.sender, ensDep) : new NoopCalibrationWriter());
  }

  /** Binance fallback for mid at block b+1 (by block timestamp). */
  private async binanceMidX96(block: number): Promise<bigint | undefined> {
    try {
      if (this.replayMid) return midToPriceX96((await this.replayMid(block + 1)).toFixed(8), this.meta);
      let ts = this.tsCache.get(block + 1);
      if (ts === undefined) {
        const blk = await this.pc.getBlock({ blockNumber: BigInt(block + 1) });
        ts = Number(blk.timestamp) * 1000;
        this.tsCache.set(block + 1, ts);
      }
      const ks = await fetchKlines({ interval: '1s', startMs: ts - 30_000, endMs: ts + 1_000, cacheDir: false });
      const m = midAt(ks, ts);
      return m ? midToPriceX96(m.toFixed(8), this.meta) : undefined;
    } catch {
      return undefined;
    }
  }

  private async blockTs(block: number): Promise<number> {
    let ts = this.tsCache.get(block);
    if (ts === undefined) {
      const blk = await this.pc.getBlock({ blockNumber: BigInt(block) });
      ts = Number(blk.timestamp) * 1000;
      this.tsCache.set(block, ts);
    }
    return ts;
  }

  /** CEX mid (priceX96) at each block's time, fetched ex post; blocks that cannot be resolved are absent. */
  async cexMidsX96(blocks: number[]): Promise<Map<number, bigint>> {
    const need = [...new Set(blocks)].filter((b) => !this.cexCache.has(b)).sort((a, b) => a - b);
    const src = this.o.midSource ?? this.replayMid;
    const failed: number[] = [];
    let lastErr = '';
    if (src) {
      for (const b of need) {
        try {
          this.cexCache.set(b, midToPriceX96((await src(b)).toFixed(8), this.meta));
        } catch (e) {
          failed.push(b); // unresolved => not labelled (logged below)
          lastErr = (e as Error).message.split('\n')[0];
        }
      }
    } else if (need.length) {
      try {
        const ts = new Map<number, number>();
        for (const b of need) ts.set(b, await this.blockTs(b));
        const lo = Math.min(...ts.values());
        const hi = Math.max(...ts.values());
        const ks = await fetchKlines({ interval: '1s', startMs: lo - 30_000, endMs: hi + 1_000, cacheDir: false });
        for (const [b, t] of ts) {
          const m = midAt(ks, t);
          if (m) this.cexCache.set(b, midToPriceX96(m.toFixed(8), this.meta));
        }
        for (const b of ts.keys()) if (!this.cexCache.has(b)) failed.push(b);
      } catch (e) {
        // Binance unreachable => those blocks are not labelled this round (retried next settle)
        failed.push(...need);
        lastErr = (e as Error).message.split('\n')[0];
      }
    }
    if (failed.length) {
      // loud, not silent: without CEX mids the settler grades nothing and every model stays at its current record
      log('settler', 'cex_mid_unavailable', { blocks: failed.length, first: failed[0], last: failed[failed.length - 1], error: lastErr || 'no kline at block time' });
    }
    const out = new Map<number, bigint>();
    for (const b of blocks) {
      const m = this.cexCache.get(b);
      if (m !== undefined) out.set(b, m);
    }
    return out;
  }

  private baseFeeCache: number | undefined;
  /** label stats of the last computeUpTo (dead band) */
  lastStats = { skippedAmbiguous: 0, graded: 0 };
  /** Pool base fee (hook.poolConfig; deployment JSON / 3000 fallback) for the v4 base-fee label. */
  private async baseFee(): Promise<number> {
    if (this.baseFeeCache !== undefined) return this.baseFeeCache;
    try {
      const c = await this.pc.readContract({ address: this.d.hook, abi: oniblockHookAbi, functionName: 'poolConfig', args: [this.pool.poolId] });
      this.baseFeeCache = Number(c.baseFee);
    } catch {
      const c = (this.d.raw.pools as Record<string, { config?: { baseFee?: number } }> | undefined)?.[this.pool.name]?.config;
      return Number(c?.baseFee ?? 3000);
    }
    return this.baseFeeCache;
  }

  async computeUpTo(head: number): Promise<{ labels: LabelledBlock[]; cal: Calibration[] }> {
    const from = BigInt(this.o.fromBlock ?? this.d.startBlock ?? 0);
    const to = BigInt(head);
    const [receipts, atts] = await Promise.all([
      getReceipts(this.pc, this.d.hook, this.pool.poolId, from, to),
      getAttestations(this.pc, this.d.hook, this.pool.poolId, from, to),
    ]);
    const idx = attestationIndex(atts);
    const rule = ruleModelNode();
    const graded = receipts.filter((r) => r.blockNumber < head && r.arbDir && !r.stale && r.modelNode.toLowerCase() !== rule.toLowerCase());
    const horizon = envInt('MARKOUT_HORIZON', 0);
    const labelMid = env('SETTLER_LABEL_MID', 'cex') as LabelMid;
    let midOf: (b: number) => bigint | undefined;
    if (horizon === 1) {
      // Pre-resolve fallback mids only for blocks that lack a following attestation.
      const need = new Set<number>();
      for (const r of graded) if (idx.midAfter(r.blockNumber) === undefined) need.add(r.blockNumber);
      const fallback = new Map<number, bigint>();
      if (env('SETTLER_BINANCE_FALLBACK', '1') === '1') {
        for (const b of need) {
          const m = await this.binanceMidX96(b);
          if (m) fallback.set(b, m);
        }
      }
      midOf = (b) => idx.midAfter(b) ?? fallback.get(b);
    } else if (labelMid === 'attested') {
      midOf = (b) => idx.midInForce(b);
    } else {
      const cex = await this.cexMidsX96(graded.map((r) => r.blockNumber));
      midOf = (b) => cex.get(b);
    }
    const labelFee = env('SETTLER_LABEL_FEE', 'base') === 'paid' ? 'paid' : 'base';
    const stats = { skippedAmbiguous: 0, graded: 0 };
    const labels = labelBlocks(graded, midOf, (r) => idx.pAt(r.blockNumber, r.modelNode), {
      skipModelNodes: [rule],
      labelFee,
      baseFeePips: await this.baseFee(),
      deadbandUsd: Number(env('SETTLER_DEADBAND_USD', '1')),
      deadbandBps: Number(env('SETTLER_DEADBAND_BPS', '1')),
      usdPerRawToken1: (b) => usdPerRawToken1(this.meta, midOf(b)),
      stats,
    });
    this.lastStats = stats;
    if (graded.length && !labels.length)
      log('settler', 'nothing_labelled', { graded: graded.length, labelMid, skippedAmbiguous: stats.skippedAmbiguous, hint: stats.skippedAmbiguous ? 'every graded block fell inside the dead band' : 'CEX mids unavailable for every graded block?' });
    return { labels, cal: calibrate(labels, this.o.window ?? envInt('CALIB_WINDOW', 30)) };
  }

  async settle(head: number): Promise<Calibration[]> {
    if (this.busy) return [];
    this.busy = true;
    try {
      const { labels, cal } = await this.computeUpTo(head);
      const minN = this.o.minN ?? envInt('CALIB_MIN_N', 3);
      for (const c of cal) {
        if (c.n < minN) {
          log('settler', 'skip_low_n', { ...c });
          continue;
        }
        const rc = await this.sender.send({
          address: this.d.hook,
          abi: oniblockHookAbi,
          functionName: 'setCalibration',
          args: [c.modelNode, c.brierBps, c.hitRateBps, c.n],
          label: 'setCalibration',
        });
        log('settler', rc?.status === 'success' ? 'calibration_set' : 'calibration_failed', { head, ...c, labelled: labels.length, skippedAmbiguous: this.lastStats.skippedAmbiguous, tx: rc?.hash });
        if (rc?.status === 'success')
          await this.ens.write(c.modelNode, { brierBps: c.brierBps, hitRateBps: c.hitRateBps, n: c.n, epoch: head, rawBrierBps: c.rawBrierBps, skillBps: c.skillBps, baseRateBps: c.baseRateBps });
      }
      this.lastSettled = head;
      return cal;
    } catch (e) {
      log('settler', 'settle_error', { head, error: (e as Error).message.split('\n')[0] });
      return [];
    } finally {
      this.busy = false;
    }
  }

  run(): () => void {
    const every = this.o.every ?? envInt('SETTLE_EVERY', 10);
    log('settler', 'start', {
      hook: this.d.hook,
      poolId: this.pool.poolId,
      settler: this.sender.address,
      every,
      ens: this.ens.kind,
      labelMid: envInt('MARKOUT_HORIZON', 0) === 1 ? 'next-attestation' : env('SETTLER_LABEL_MID', 'cex'),
      labelFee: env('SETTLER_LABEL_FEE', 'base'),
      deadband: { usd: Number(env('SETTLER_DEADBAND_USD', '1')), bps: Number(env('SETTLER_DEADBAND_BPS', '1')) },
      skip: ruleModelNode(),
    });
    return this.pc.watchBlockNumber({
      emitOnBegin: true,
      onBlockNumber: (bn) => {
        const b = Number(bn);
        if (this.lastSettled < 0 || b - this.lastSettled >= every) void this.settle(b);
      },
      onError: (e) => log('settler', 'watch_error', { error: e.message.split('\n')[0] }),
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = parseArgs();
  const s = new Settler({
    chain: (a.chain as ChainName) ?? (env('CHAIN', 'local') as ChainName),
    every: a.every ? Number(a.every) : undefined,
    fromBlock: a.from ? Number(a.from) : undefined,
    poolName: a.pool as string | undefined,
  });
  if (a.once) {
    const cal = await s.settle(Number(await s.pc.getBlockNumber()));
    console.log(JSON.stringify(cal));
    process.exit(0);
  } else s.run();
}
