/**
 * benchmark/teacher only, not a production model. The keeper never loads it: production oniblock1 is the Kev System One
 * LLM (model/kev.ts). This is the pure-TypeScript evaluator of teacher-lightgbm (ml/models/teacher-lightgbm.json):
 * gradient-boosted trees (LightGBM, trained in ml/src/train_tabular_v2.py on real mainnet blocks with a Binance read
 * ~2 s before the block) whose p are Kev v2's soft targets. Kept as a library for the benchmark (benchmark/src/v4/sim4.ts)
 * and its TS/Python parity test. No native deps, ~0.1 ms per prediction, deterministic.
 *
 * The JSON carries its own ordered feature list; every name must be one of TABULAR_FEATURES below (unknown names are a
 * load error). Pool inputs, all orientation-free functions of the keeper's Features:
 *   gapPips, edgePips = gap - baseFee, baseFee, imb_arb (imbalance signed so + = recent flow in the arb direction),
 *   abs_imbalance, sizeToDepth, realizedVolBps, nSwaps, arbShare, gap_over_fee = gap / baseFee, log_size = log10(sizeToDepth + 1e-9)
 * Mid inputs (SPEC_v2 "Tabular v2"): edgeSigma, vol5mBps, ret12Bps, ret36Bps, ret900Bps and sgap = gapSign * gapPips
 * (orientation-dependent: the caller passes canonical features, features.ts canonicalFeatures).
 * The fee is always the BASE fee (what the training pools charged, and k-free).
 * Confidence is 10000 (one calibrated probability, like Kev): k = kMax * p * c stays monotonic in p.
 * Env: TABULAR_MODEL_PATH (explicit file; default ml/models/teacher-lightgbm.json).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, env } from '../config.js';
import { edgeSigmaOf, type Features } from '../features.js';
import { clampBps, type ModelScore } from './types.js';

type Node = { v: number } | { f: number; t: number; l: Node; r: Node };
export interface TabularModel {
  version: number;
  name: string;
  features: string[];
  trees: Node[];
  /** Validation-chosen charge threshold (v2 export; JSON key `chargeThreshold` or `charge_threshold`; the benchmark's gate). */
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

/** The teacher model file (ml/models/teacher-lightgbm.json). */
export const TEACHER_MODEL_NAME = 'teacher-lightgbm';
export function defaultTabularPath(): string {
  return resolve(ROOT, 'ml', 'models', `${TEACHER_MODEL_NAME}.json`);
}

let cached: { path: string; model: TabularModel } | undefined;

export function loadTabularModel(path = env('TABULAR_MODEL_PATH') ?? defaultTabularPath()): TabularModel | null {
  if (cached?.path === path) return cached.model;
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as TabularModel & { charge_threshold?: number };
  if (!Array.isArray(raw.features) || !raw.features.length || !Array.isArray(raw.trees)) throw new Error(`tabular model ${path}: missing features/trees`);
  const unknown = raw.features.filter((n) => !(n in TABULAR_FEATURES));
  if (unknown.length) throw new Error(`tabular model ${path}: unknown features ${unknown.join(', ')}`);
  // Only the explicit keys: a generic `threshold` is ambiguous (e.g. a tree split) and must never gate charging.
  const thr = raw.chargeThreshold ?? raw.charge_threshold;
  const m: TabularModel = { ...raw, ...(typeof thr === 'number' ? { chargeThreshold: thr } : {}) };
  cached = { path, model: m };
  return m;
}

/** Model input vector in the order of `names` (a model's `features`). */
export function tabularInputs(f: Features, names: readonly string[]): number[] {
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
 * Without `model`: TABULAR_MODEL_PATH, else the teacher file.
 */
export function scoreTabular(f: Features, model?: TabularModel | null): ModelScore | null {
  const t0 = performance.now();
  try {
    const m = model ?? loadTabularModel(env('TABULAR_MODEL_PATH') ?? defaultTabularPath());
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
