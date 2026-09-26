/**
 * tabular-v1: gradient-boosted trees (LightGBM, trained in ml/src/train_tabular.py on 87k real mainnet blocks, early-stopped
 * on the validation split; see ml/RESULTS.md) evaluated in pure TypeScript from services/models/tabular-v1.json
 * (exported by ml/src/export_tabular.py). No native deps, ~0.1 ms per prediction, deterministic.
 *
 * Model inputs are orientation-free functions of the keeper's Features (works whether ETH is token0 or token1):
 *   gapPips, edgePips = gap - fee, baseFee, imb_arb (imbalance signed so + = recent flow in the arb direction),
 *   |imbalance|, sizeToDepth, realizedVolBps, nSwaps, arbShare, gap/fee, log10(sizeToDepth + 1e-9)
 * `fee` is the fee an arbitrageur pays on this pool: the hook's arb-direction fee (arbFeePips) when known, else baseFee.
 * (Training pools are plain v3 pools, where the two coincide.)
 * Env: TABULAR_MODEL_PATH (default services/models/tabular-v1.json).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SERVICES_DIR, env } from '../config.js';
import type { Features } from '../features.js';
import { clampBps, type ModelScore } from './types.js';

type Node = { v: number } | { f: number; t: number; l: Node; r: Node };
export interface TabularModel {
  version: number;
  name: string;
  features: string[];
  trees: Node[];
}

const EXPECTED = ['gapPips', 'edgePips', 'baseFee', 'imb_arb', 'abs_imbalance', 'sizeToDepth', 'realizedVolBps', 'nSwaps', 'arbShare', 'gap_over_fee', 'log_size'];

let cached: { path: string; model: TabularModel } | undefined;

export function loadTabularModel(path = env('TABULAR_MODEL_PATH') ?? resolve(SERVICES_DIR, 'models', 'tabular-v1.json')): TabularModel | null {
  if (cached?.path === path) return cached.model;
  if (!existsSync(path)) return null;
  const m = JSON.parse(readFileSync(path, 'utf8')) as TabularModel;
  if (JSON.stringify(m.features) !== JSON.stringify(EXPECTED)) throw new Error(`tabular model ${path}: unexpected feature list`);
  cached = { path, model: m };
  return m;
}

/** Model input vector (order = EXPECTED). */
export function tabularInputs(f: Features): number[] {
  const fee = Math.max(1, f.arbFeePips ?? f.baseFee);
  // gapSign < 0: pool token1/token0 price below the oracle -> token0 is cheap in the pool -> arbitrage buys token0,
  // and imbalance > 0 means recent swaps bought token0, i.e. pushed in the arbitrage direction.
  const imbArb = f.gapSign < 0 ? f.imbalance : -f.imbalance;
  return [f.gapPips, f.gapPips - fee, f.baseFee, imbArb, Math.abs(f.imbalance), f.sizeToDepth, f.realizedVolBps, f.nSwaps, f.arbShare, f.gapPips / fee, Math.log10(f.sizeToDepth + 1e-9)];
}

function leaf(n: Node, x: number[]): number {
  while (!('v' in n)) n = x[n.f]! <= n.t ? n.l : n.r;
  return n.v;
}

export function predictTabular(m: TabularModel, f: Features): number {
  const x = tabularInputs(f);
  let z = 0;
  for (const t of m.trees) z += leaf(t, x);
  return 1 / (1 + Math.exp(-z));
}

/** Never throws; null if the model file is missing/invalid (caller falls back to the heuristic). */
export function scoreTabular(f: Features, model?: TabularModel | null): ModelScore | null {
  const t0 = performance.now();
  try {
    const m = model ?? loadTabularModel();
    if (!m) return null;
    const p = predictTabular(m, f);
    if (!Number.isFinite(p)) return null;
    return {
      pToxicBps: clampBps(p * 10_000),
      confidenceBps: clampBps(Math.abs(2 * p - 1) * 10_000),
      cls: p >= 0.6 ? 'informed' : 'unknown',
      latencyMs: Math.round((performance.now() - t0) * 1000) / 1000,
      model: 'tabular',
    };
  } catch {
    return null;
  }
}
