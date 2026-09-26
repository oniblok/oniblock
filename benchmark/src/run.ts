/**
 * Benchmark entry point.
 *
 *   pnpm run:quick   ~150 steps of the volatile window, heuristic model only, split=1 and split=5 (< 3 min)
 *   pnpm bench       full: volatile + calm windows (2h at 1s klines), Jev model (cached, bounded budget),
 *                    plus the split-swap (x5) variant on the volatile window
 *
 * Flags: --hours H (2) --step S seconds per step (1) --blocks N (cap steps) --windows volatile,calm
 *        --mode jev|heuristic --budget N (600 Jev calls per window) --split-variant 5 (0 disables)
 *        --lambda L (0.05 retail orders/step) --usd U (500 median retail USD) --gas G (0.5 USD per arb tx)
 *        --sensitivity true|false (full: extra volatile run with 2x retail rate and 2x size)
 *        --min-samples N (10; quick 3) --horizon 0|1 (settler label horizon, 0) --fee-aware true|false (true)
 *        (--horizon 1 --fee-aware false reproduces the pre-INTEGRATION_1 results in results/before/)
 *        --liquidity L (2e17) --port P (8600) --seed S (7) --settle-every M (20) --out DIR
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPath, selectWindows, type PricePath } from './data.js';
import { runOne, type RunConfig, type RunResult } from './sim.js';
import { writeReport } from './report.js';
import { RESULTS_DIR, log } from './util.js';

function args(argv = process.argv.slice(2)) {
  const o: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) o[k] = true;
    else (o[k] = v), i++;
  }
  return o;
}

const a = args();
const quick = a.quick === true;
const hours = Number(a.hours ?? 2);
const step = Number(a.step ?? 1);
const blocks = a.blocks ? Number(a.blocks) : quick ? 150 : undefined;
const mode = (a.mode as 'jev' | 'heuristic') ?? (quick ? 'heuristic' : 'jev');
const windowsWanted = String(a.windows ?? (quick ? 'volatile' : 'volatile,calm')).split(',');
const splitVariant = Number(a['split-variant'] ?? 5);
const outDir = resolve(String(a.out ?? (quick ? resolve(RESULTS_DIR, 'quick') : RESULTS_DIR)));
let port = Number(a.port ?? 8600);
const lambda = Number(a.lambda ?? 0.05);
const usd = Number(a.usd ?? 500);
const budget = Number(a.budget ?? 600);
// quick demo: 150 steps is too short to collect 10 labelled blocks, so the model pools would never leave kDefault
const horizon = (Number(a.horizon ?? 0) === 1 ? 1 : 0) as 0 | 1;
const feeAware = a['fee-aware'] !== 'false';
const minSamples = Number(a['min-samples'] ?? (quick ? 3 : 10));
const sensitivity = a.sensitivity !== undefined ? a.sensitivity !== 'false' : !quick;

/** Deterministic busiest sub-window (max sum of |log returns|) of length n. */
function mostActive(p: PricePath, n: number): PricePath {
  if (p.mids.length <= n) return p;
  const r = p.mids.map((m, i) => (i ? Math.abs(Math.log(m / p.mids[i - 1]!)) : 0));
  let acc = r.slice(0, n).reduce((x, y) => x + y, 0);
  let best = acc;
  let bi = 0;
  for (let i = 1; i + n <= r.length; i++) {
    acc += r[i + n - 1]! - r[i]!;
    if (acc > best) (best = acc), (bi = i);
  }
  return { ...p, mids: p.mids.slice(bi, bi + n), times: p.times.slice(bi, bi + n), window: { ...p.window, startMs: p.times[bi]! - p.stepSeconds * 1000, startIso: new Date(p.times[bi]! - p.stepSeconds * 1000).toISOString() } };
}

const t0 = Date.now();
const windows = (await selectWindows(hours)).filter((w) => windowsWanted.includes(w.name));
log('windows', { windows });
const results: RunResult[] = [];
for (const w of windows) {
  let path = await loadPath(w, step, quick ? undefined : blocks);
  if (quick && blocks) path = mostActive(path, blocks); // demo: the busiest `blocks`-step stretch of the window
  log('path', { window: w.name, interval: path.interval, steps: path.mids.length, first: path.mids[0], last: path.mids[path.mids.length - 1] });
  // variants: base, split-swap arb (volatile only), high-retail sensitivity (full run, volatile only)
  const variants: { suffix: string; split: number; lambda: number; usd: number }[] = [{ suffix: '', split: 1, lambda, usd }];
  if (splitVariant > 1 && w.name === 'volatile') variants.push({ suffix: `-split${splitVariant}`, split: splitVariant, lambda, usd });
  if (sensitivity && w.name === 'volatile') variants.push({ suffix: '-highretail', split: 1, lambda: lambda * 2, usd: usd * 2 });
  let jevUsed = 0; // Jev call budget is per window, shared by its variants (they mostly hit the cache)
  for (const v of variants) {
    const split = v.split;
    const cfg: RunConfig = {
      label: `${w.name}${v.suffix}`,
      path,
      split,
      modelMode: mode,
      jevBudget: Math.max(0, budget - jevUsed),
      port: port++,
      lambda: v.lambda,
      retailUsd: v.usd,
      gasUsd: Number(a.gas ?? 0.5),
      seed: Number(a.seed ?? 7),
      degradeAtFrac: 0.5,
      settleEvery: Number(a['settle-every'] ?? (quick ? 10 : 20)),
      calibWindow: quick ? 20 : 50,
      calibMinN: minSamples,
      minSamples,
      markoutHorizon: horizon,
      feeAware,
      liquidity: BigInt(Number(a.liquidity ?? 2e17)),
    };
    const r = await runOne(cfg);
    jevUsed += r.jev.calls;
    log('run_done', { label: r.label, sec: r.runtimeSec, txs: r.txCount, reverts: r.reverts.length, jev: r.jev });
    results.push(r);
  }
}
mkdirSync(outDir, { recursive: true });
const summary = writeReport(results, outDir, { quick, totalSec: Math.round((Date.now() - t0) / 1000) });
writeFileSync(resolve(outDir, 'results.json'), JSON.stringify(summary, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v)));
log('done', { outDir, sec: Math.round((Date.now() - t0) / 1000) });
process.exit(0);
