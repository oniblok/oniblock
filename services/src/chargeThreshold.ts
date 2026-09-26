/**
 * Rolling (walk-forward) charge threshold for the model v2 charge gate (keeper CHARGE_THRESHOLD).
 *
 * The keeper charges a block iff p >= t (confidence = 10000, else 0; pToxic unchanged). The target: FPR = benign
 * charged / all benign <= fmax (default 5%, a margin under a 7% cap). A threshold fixed on validation data drifts under
 * regime shift (measured on held-out mainnet data: 5.0% FPR on validation -> 7.4% on test); re-choosing it on the
 * trailing 7 days of labelled blocks held FPR at 5.5% [4.2, 6.8] (precision 95.4%, TPR 72.7%).
 *
 *   `chargeThresholdFor(pairs, { fmax, minBenign })`  pure: benign p sorted descending b_1 >= b_2 >= ... >= b_N,
 *        m = floor(fmax * N) allowed false positives, t = b_{m+1} + epsilon (the (m)-th, 0-indexed, largest benign p).
 *        Charging p >= t then charges only benign p > b_{m+1}, at most m of them, so FPR <= fmax on those pairs (ties
 *        at b_{m+1} are all left uncharged). m >= N (fmax = 1) -> t = 0. Null when N < minBenign.
 *   `ChargeThresholdPublisher`  settler side: per model node, the labelled (p, y) of the trailing CHARGE_WINDOW_BLOCKS
 *        -> the threshold -> CHARGE_THRESHOLD_FILE (atomic JSON, keyed by lowercase modelNode) and, when the ENS writer
 *        can, the text record calibration.chargeThreshold (bps: charged iff pToxicBps >= value; '' = no threshold).
 *   `readChargeThresholdFile`  keeper side (CHARGE_THRESHOLD=auto): re-parsed only when the file's mtime changes.
 *
 * Env: CHARGE_WINDOW_BLOCKS (default 50400 = 7 days of 12 s blocks; 0 = every labelled block), CHARGE_FPR_MAX
 * (default 0.05), CHARGE_MIN_BENIGN (default 200), CHARGE_THRESHOLD_FILE (default <ROOT>/.runtime/charge-threshold.json).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Hex } from 'viem';
import { env, envInt, log, ROOT } from './config.js';
import { CHARGE_THRESHOLD_KEY, type CalibrationRecordWriter } from './ens.js';

export const CHARGE_WINDOW_BLOCKS_DEFAULT = 50_400;
export const CHARGE_FPR_MAX_DEFAULT = 0.05;
export const CHARGE_MIN_BENIGN_DEFAULT = 200;
/** Added to the (m+1)-th largest benign p: well below the bps resolution of the posted pToxic. */
export const CHARGE_EPSILON_DEFAULT = 1e-6;

export interface LabelledP {
  p: number;
  y: 0 | 1;
}

export interface ChargeThresholdResult {
  /** Charge iff p >= threshold. */
  threshold: number;
  /** Benign charged / benign. */
  fpr: number;
  /** Toxic charged / charged (null: nothing charged). */
  precision: number | null;
  /** Toxic charged / toxic (null: no toxic labels). */
  tpr: number | null;
  /** Charged / all labels. */
  coverage: number;
  nBenign: number;
  nToxic: number;
}

/** Confusion stats of the rule "charge iff p >= t" on `pairs`. */
export function chargeStats(pairs: readonly LabelledP[], t: number): Omit<ChargeThresholdResult, 'threshold'> {
  let tp = 0;
  let fp = 0;
  let nToxic = 0;
  for (const { p, y } of pairs) {
    const charged = p >= t;
    if (y === 1) {
      nToxic++;
      if (charged) tp++;
    } else if (charged) fp++;
  }
  const nBenign = pairs.length - nToxic;
  return {
    fpr: nBenign ? fp / nBenign : 0,
    precision: tp + fp ? tp / (tp + fp) : null,
    tpr: nToxic ? tp / nToxic : null,
    coverage: pairs.length ? (tp + fp) / pairs.length : 0,
    nBenign,
    nToxic,
  };
}

/** See the header. Null when there are fewer than `minBenign` benign labels. */
export function chargeThresholdFor(
  pairs: readonly LabelledP[],
  opts: { fmax?: number; minBenign?: number; epsilon?: number } = {},
): ChargeThresholdResult | null {
  const fmax = opts.fmax ?? CHARGE_FPR_MAX_DEFAULT;
  const minBenign = opts.minBenign ?? CHARGE_MIN_BENIGN_DEFAULT;
  const eps = opts.epsilon ?? CHARGE_EPSILON_DEFAULT;
  if (!(fmax >= 0 && fmax <= 1)) throw new Error(`fmax must be in [0,1] (got ${fmax})`);
  const benign = pairs.filter((x) => x.y === 0).map((x) => x.p).sort((a, b) => b - a);
  const n = benign.length;
  if (n === 0 || n < minBenign) return null;
  const m = Math.floor(fmax * n + 1e-9); // allowed false positives (1e-9: 0.05 * 200 must be 10, not 9.999...)
  let t = m >= n ? 0 : Math.round((benign[m]! + eps) * 1e7) / 1e7;
  // Guarantee under float rounding: never let t fall onto a benign value that must stay uncharged.
  if (m < n && t <= benign[m]!) t = benign[m]! + eps;
  return { threshold: t, ...chargeStats(pairs, t) };
}

export interface ChargeThresholdEntry {
  threshold: number | null;
  fpr: number | null;
  precision: number | null;
  tpr: number | null;
  coverage: number | null;
  nBenign: number;
  nToxic: number;
  /** Block range of the labels in the window (null: none). */
  fromBlock: number | null;
  toBlock: number | null;
  /** ISO time of the settle that wrote the entry. */
  updatedAt: string;
}

export type ChargeThresholdFile = Record<string, ChargeThresholdEntry>;

export function chargeThresholdPath(): string {
  return env('CHARGE_THRESHOLD_FILE', resolve(ROOT, '.runtime', 'charge-threshold.json'))!;
}

function readJson(path: string): ChargeThresholdFile {
  try {
    if (!existsSync(path)) return {};
    const j = JSON.parse(readFileSync(path, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as ChargeThresholdFile) : {};
  } catch {
    return {};
  }
}

/** Merge `entries` (keys lowercased) into the file and write it atomically (tmp + rename). */
export function writeChargeThresholdFile(path: string, entries: ChargeThresholdFile): void {
  const cur = readJson(path);
  for (const [k, v] of Object.entries(entries)) cur[k.toLowerCase()] = v;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cur, null, 2) + '\n');
  renameSync(tmp, path);
}

const fileCache = new Map<string, { mtimeMs: number; data: ChargeThresholdFile }>();
/** Keeper side: the whole file, re-parsed only when its mtime changes. Missing/invalid => {}. */
export function readChargeThresholdFile(path = chargeThresholdPath()): ChargeThresholdFile {
  try {
    if (!existsSync(path)) return {};
    const m = statSync(path).mtimeMs;
    const c = fileCache.get(path);
    if (c?.mtimeMs === m) return c.data;
    const data = readJson(path);
    fileCache.set(path, { mtimeMs: m, data });
    return data;
  } catch {
    return {};
  }
}

/** The published threshold for `modelNode` (case-insensitive), or undefined if absent / null / not a number >= 0. */
export function rollingThresholdFor(modelNode: Hex | string, path = chargeThresholdPath()): { threshold: number; entry: ChargeThresholdEntry } | undefined {
  const e = readChargeThresholdFile(path)[modelNode.toLowerCase()];
  const t = e?.threshold;
  return typeof t === 'number' && Number.isFinite(t) && t >= 0 ? { threshold: t, entry: e! } : undefined;
}

/** ENS value of calibration.chargeThreshold: bps, charged iff pToxicBps >= value ('' = no threshold). */
export function chargeThresholdTextValue(t: number | null): string {
  return t === null ? '' : String(Math.ceil(t * 10_000 - 1e-9));
}

export interface ChargeWindowOpts {
  windowBlocks: number;
  fmax: number;
  minBenign: number;
  path: string;
}

export function chargeWindowOpts(): ChargeWindowOpts {
  const fmax = Number(env('CHARGE_FPR_MAX', String(CHARGE_FPR_MAX_DEFAULT)));
  if (!(fmax >= 0 && fmax <= 1)) throw new Error(`CHARGE_FPR_MAX must be a number in [0,1] (got ${env('CHARGE_FPR_MAX')})`);
  return {
    windowBlocks: envInt('CHARGE_WINDOW_BLOCKS', CHARGE_WINDOW_BLOCKS_DEFAULT),
    fmax,
    minBenign: envInt('CHARGE_MIN_BENIGN', CHARGE_MIN_BENIGN_DEFAULT),
    path: chargeThresholdPath(),
  };
}

/**
 * Settler side (see the header). `publish(head, labels)` takes the arb head's labelled blocks (any range; only those in
 * (head - windowBlocks, head] count), writes one entry per model node seen in `labels` (a node whose window is empty gets
 * threshold null, so the keeper falls back), logs `charge_threshold` per node, and mirrors the value to ENS: only when it
 * changed since the last write, never '' before a first value, and not at all for a node once the resolver refused it (logged
 * once per node as `charge_threshold_ens_unauthorized`; EnsSetup grants the settler per key).
 */
export class ChargeThresholdPublisher {
  private readonly lastEns = new Map<string, string>();
  /** nodes whose calibration.chargeThreshold write was refused (unknown name / no per-key grant): file only from then on */
  private readonly ensOff = new Set<string>();
  constructor(
    private readonly opts: ChargeWindowOpts = chargeWindowOpts(),
    private readonly ens?: CalibrationRecordWriter,
  ) {}

  get path(): string {
    return this.opts.path;
  }

  compute(head: number, labels: readonly { block: number; modelNode: Hex; p: number; y: 0 | 1 }[], now = new Date()): ChargeThresholdFile {
    const w = this.opts.windowBlocks;
    const by = new Map<string, { block: number; p: number; y: 0 | 1 }[]>();
    for (const l of labels) {
      const k = l.modelNode.toLowerCase();
      const arr = by.get(k) ?? by.set(k, []).get(k)!;
      if (l.block <= head && (w <= 0 || l.block > head - w)) arr.push(l);
    }
    const out: ChargeThresholdFile = {};
    for (const [node, ls] of by) {
      const r = chargeThresholdFor(ls, { fmax: this.opts.fmax, minBenign: this.opts.minBenign });
      const counts = r ?? chargeStats(ls, Number.POSITIVE_INFINITY);
      let lo: number | null = null;
      let hi: number | null = null;
      for (const l of ls) {
        lo = lo === null ? l.block : Math.min(lo, l.block);
        hi = hi === null ? l.block : Math.max(hi, l.block);
      }
      out[node] = {
        threshold: r?.threshold ?? null,
        fpr: r?.fpr ?? null,
        precision: r?.precision ?? null,
        tpr: r?.tpr ?? null,
        coverage: r?.coverage ?? null,
        nBenign: counts.nBenign,
        nToxic: counts.nToxic,
        fromBlock: lo,
        toBlock: hi,
        updatedAt: now.toISOString(),
      };
    }
    return out;
  }

  async publish(head: number, labels: readonly { block: number; modelNode: Hex; p: number; y: 0 | 1 }[]): Promise<ChargeThresholdFile> {
    const entries = this.compute(head, labels);
    if (!Object.keys(entries).length) return entries;
    try {
      writeChargeThresholdFile(this.opts.path, entries);
    } catch (e) {
      log('settler', 'charge_threshold_write_error', { path: this.opts.path, error: (e as Error).message.split('\n')[0] });
    }
    for (const [node, e] of Object.entries(entries)) {
      log('settler', 'charge_threshold', { head, modelNode: node, ...e, windowBlocks: this.opts.windowBlocks, fmax: this.opts.fmax, minBenign: this.opts.minBenign, file: this.opts.path });
      await this.mirrorToEns(node as Hex, e.threshold);
    }
    return entries;
  }

  private async mirrorToEns(node: Hex, t: number | null): Promise<void> {
    if (this.ensOff.has(node) || !this.ens?.writeText) return;
    const v = chargeThresholdTextValue(t);
    const prev = this.lastEns.get(node);
    if (v === prev || (v === '' && prev === undefined)) return;
    let ok = false;
    try {
      ok = await this.ens.writeText(node, [[CHARGE_THRESHOLD_KEY, v]]);
    } catch {
      ok = false;
    }
    if (ok || this.ens.kind === 'noop') {
      this.lastEns.set(node, v); // noop (no ENS deployment): logged once per change by the writer
      return;
    }
    this.ensOff.add(node);
    log('settler', 'charge_threshold_ens_unauthorized', { modelNode: node, key: CHARGE_THRESHOLD_KEY, hint: 'resolver refused the key (EnsSetup grants the settler per key); publishing to the file only from now on' });
  }
}
