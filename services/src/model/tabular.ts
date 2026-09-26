/**
 * oniblock1 (and the older tabular-v1 / tabular-v2): gradient-boosted trees (LightGBM, trained in ml/src/train_tabular.py on real mainnet blocks,
 * early-stopped on the validation split; see ml/RESULTS.md) evaluated in pure TypeScript from the exported JSON
 * (ml/src/export_tabular.py). No native deps, ~0.1 ms per prediction, deterministic.
 *
 * The JSON carries its own ordered feature list; every name must be one of TABULAR_FEATURES below (unknown names are a
 * load error). v1 inputs, all orientation-free functions of the keeper's Features:
 *   gapPips, edgePips = gap - baseFee, baseFee, imb_arb (imbalance signed so + = recent flow in the arb direction),
 *   abs_imbalance, sizeToDepth, realizedVolBps, nSwaps, arbShare, gap_over_fee = gap / baseFee, log_size = log10(sizeToDepth + 1e-9)
 * v2 adds (SPEC_v2 "Tabular v2"): edgeSigma, vol5mBps, ret12Bps, ret36Bps, ret900Bps and sgap = gapSign * gapPips
 * (orientation-dependent: the caller passes canonical features, features.ts canonicalFeatures; index.ts score() does).
 * The fee is always the BASE fee (what the training pools charged, and k-free: the hook's arb fee depends on the k that
 * this model's own answer sets, which would feed back into its input).
 * Confidence is 10000 (one calibrated probability, like Kev): k = kMax * p * c stays monotonic in p.
 * Env: MODEL_MODE=oniblock1 (= tabular with the oniblock1 model), TABULAR_MODEL (v1 default | oniblock1 | v2),
 * TABULAR_MODEL_PATH (explicit file; default services/models/<name>.json, else ml/models/<name>.json;
 * name = tabularModelName: tabular-v1, oniblock1, tabular-v2).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, SERVICES_DIR, env } from '../config.js';
import { edgeSigmaOf, type Features } from '../features.js';
import { clampBps, type ModelScore } from './types.js';

type Node = { v: number } | { f: number; t: number; l: Node; r: Node };
export interface TabularModel {
  version: number;
  name: string;
  features: string[];
  trees: Node[];
  /** Validation-chosen charge threshold (v2 export; informational — the keeper gate is CHARGE_THRESHOLD). */
  chargeThreshold?: number;
}

const baseFeeOf = (f: Features) => Math.max(1, f.baseFee);
const edgeOf = (f: Features) => f.gapPips - baseFeeOf(f);

/** Input name -> value. gapSign < 0: pool token1/token0 price below the oracle -> token0 is cheap in the pool -> arbitrage
 *  buys token0, and imbalance > 0 means recent swaps bought token0, i.e. pushed in the arbitrage direction. */
export const TABULAR_FEATURES: Record<string, (f: Features) => number> = {
  gapPips: (f) => f.gapPips,
  edgePips: edgeOf,
  baseFee: (f) => f.baseFee,
  imb_arb: (f) => (f.gapSign < 0 ? f.imbalance : -f.imbalance),
  abs_imbalance: (f) => Math.abs(f.imbalance),
  sizeToDepth: (f) => f.sizeToDepth,
  realizedVolBps: (f) => f.realizedVolBps,
  nSwaps: (f) => f.nSwaps,
  arbShare: (f) => f.arbShare,
  gap_over_fee: (f) => f.gapPips / baseFeeOf(f),
  log_size: (f) => Math.log10(f.sizeToDepth + 1e-9),
  // v2 (missing = no mid history: edge from the formula, the rest 0, as in the kev2 state)
  edgeSigma: (f) => f.edgeSigma ?? edgeSigmaOf(f.edgePips ?? f.gapPips - f.baseFee, f.realizedVolBps),
  vol5mBps: (f) => f.vol5mBps ?? 0,
  ret12Bps: (f) => f.ret12Bps ?? 0,
  ret36Bps: (f) => f.ret36Bps ?? 0,
  ret900Bps: (f) => f.ret900Bps ?? 0,
  sgap: (f) => f.gapSign * f.gapPips,
};

/** tabular-v1's input order (ml/models/tabular-v1.json). */
export const TABULAR_V1_FEATURES = ['gapPips', 'edgePips', 'baseFee', 'imb_arb', 'abs_imbalance', 'sizeToDepth', 'realizedVolBps', 'nSwaps', 'arbShare', 'gap_over_fee', 'log_size'];

/** oniblock1 = the production model (trained on a Binance read ~2 s before the block: for a keeper whose post lands first in the block). */
export type TabularVersion = 'v1' | 'v2' | 'oniblock1';
export const TABULAR_VERSIONS: readonly TabularVersion[] = ['v1', 'v2', 'oniblock1'];
/** Model name = file stem = ENS label (<name>.models.oniblock.eth). */
export const tabularModelName = (v: TabularVersion): string => (v === 'oniblock1' ? v : `tabular-${v}`);
export const parseTabularVersion = (v: string | undefined): TabularVersion | undefined =>
  TABULAR_VERSIONS.find((x) => x === v || tabularModelName(x) === v);
/** MODEL_MODE=oniblock1 selects oniblock1; otherwise TABULAR_MODEL (default v1). */
export const tabularVersion = (mode = env('MODEL_MODE', 'auto')): TabularVersion =>
  mode === 'oniblock1' ? 'oniblock1' : (parseTabularVersion(env('TABULAR_MODEL', 'v1')) ?? 'v1');

export function defaultTabularPath(v: TabularVersion = tabularVersion()): string {
  const svc = resolve(SERVICES_DIR, 'models', `${tabularModelName(v)}.json`);
  if (v === 'v1' || existsSync(svc)) return svc;
  return resolve(ROOT, 'ml', 'models', `${tabularModelName(v)}.json`);
}

let cached: { path: string; model: TabularModel } | undefined;

export function loadTabularModel(path = env('TABULAR_MODEL_PATH') ?? defaultTabularPath()): TabularModel | null {
  if (cached?.path === path) return cached.model;
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as TabularModel & { charge_threshold?: number; threshold?: number };
  if (!Array.isArray(raw.features) || !raw.features.length || !Array.isArray(raw.trees)) throw new Error(`tabular model ${path}: missing features/trees`);
  const unknown = raw.features.filter((n) => !(n in TABULAR_FEATURES));
  if (unknown.length) throw new Error(`tabular model ${path}: unknown features ${unknown.join(', ')}`);
  const thr = raw.chargeThreshold ?? raw.charge_threshold ?? raw.threshold;
  const m: TabularModel = { ...raw, ...(typeof thr === 'number' ? { chargeThreshold: thr } : {}) };
  cached = { path, model: m };
  return m;
}

/** Model input vector in the order of `names` (default: tabular-v1's). */
export function tabularInputs(f: Features, names: readonly string[] = TABULAR_V1_FEATURES): number[] {
  return names.map((n) => TABULAR_FEATURES[n]!(f));
}

function leaf(n: Node, x: number[]): number {
  while (!('v' in n)) n = x[n.f]! <= n.t ? n.l : n.r;
  return n.v;
}

export function predictTabular(m: TabularModel, f: Features): number {
  const x = tabularInputs(f, m.features);
  let z = 0;
  for (const t of m.trees) z += leaf(t, x);
  return 1 / (1 + Math.exp(-z));
}

/**
 * Never throws; null if the model file is missing/invalid (caller falls back to the heuristic). `f` must be canonical.
 * `version` picks the model file when no `model` is given (default: TABULAR_MODEL_PATH, else tabularVersion()).
 */
export function scoreTabular(f: Features, model?: TabularModel | null, version?: TabularVersion): ModelScore | null {
  const t0 = performance.now();
  try {
    const m = model ?? loadTabularModel(env('TABULAR_MODEL_PATH') ?? defaultTabularPath(version));
    if (!m) return null;
    const p = predictTabular(m, f);
    if (!Number.isFinite(p)) return null;
    return {
      pToxicBps: clampBps(p * 10_000),
      // One calibrated probability, no confidence head (like Kev): full confidence keeps k = kMax * p monotonic in p.
      confidenceBps: 10_000,
      pJitBps: 0, // no JIT head yet (trees trained on swap features only) => the hook uses jitWindowDefault
      cls: p >= 0.6 ? 'informed' : 'unknown',
      latencyMs: Math.round((performance.now() - t0) * 1000) / 1000,
      model: 'tabular',
    };
  } catch {
    return null;
  }
}
