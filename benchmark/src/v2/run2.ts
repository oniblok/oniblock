/**
 * Benchmark v2 entry point (markets with routing competition, keeper lag, competing arbs, 12 windows).
 *
 *   pnpm bench:v2          all 12 frozen windows (data/windows_v2.json) x 3600 1s steps, Jev arm (<= 400 calls/window)
 *                          + heuristic arm + gate arm, plus variants on ETH-vol1 and BTC-vol1: split=5, keeper-lag-0,
 *                          settler labels vs the attested (lagged) mid
 *   pnpm bench:v2:quick    2 windows (ETH-vol1, BTC-calm1) x 300 steps, heuristic scorer for the Jev arm, no variants
 *
 * Flags (defaults = realistic):
 *   --windows ETH-vol1,..  --steps N (3600)  --jev jev|heuristic (jev)  --budget N (400 Jev calls per window)
 *   --keeper-lag S (1 step)  --miss-prob P (0.05)  --stale-steps S (5)
 *   --cex-bps a,b (1.5,2.5 per arb)  --gas-usd a,b (0.6,0.3 per arb tx)  --arb-late P (0.1)  --min-profit U (0.5)
 *   --lambda L (0.1 retail orders/step/market)  --retail-usd U (400 median)  --retail-sigma S (1.3)  --retail-cap U (200000)
 *   --dir-autocorr P (0.6)  --informed F (0.05)  --informed-horizon H (30 steps)  --routing split|best (split)
 *   --min-split F (0.1)  --tvl U (20000000 per pool)  --label-mid true|attested (true: settler marks out vs the CEX mid at the swap's block time, fetched ex post)  --variants true|false
 *   --report-only (re-render from <out>/runs.raw.json)  --settle-every M (20)  --calib-window W (50)  --calib-min-n N (1)  --seed S (7)  --port P (8700)  --out DIR
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BENCH_DIR, log } from '../util.js';
import { loadPathV2, selectWindowsV2 } from './windows.js';
import { runOneV2, type RunConfigV2, type RunResultV2 } from './sim2.js';
import { writeReportV2 } from './report2.js';

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
const num = (k: string, dflt: number) => (a[k] !== undefined ? Number(a[k]) : dflt);
const list = (k: string, dflt: number[]) => (a[k] !== undefined ? String(a[k]).split(',').map(Number) : dflt);
const outDir = resolve(String(a.out ?? resolve(BENCH_DIR, quick ? 'results_v2/quick' : 'results_v2')));
let port = num('port', 8700);
const steps = num('steps', quick ? 300 : 3600);
const variants = a.variants !== undefined ? a.variants !== 'false' : !quick;
const cex = list('cex-bps', [1.5, 2.5]);
const gas = list('gas-usd', [0.6, 0.3]);

const base: Omit<RunConfigV2, 'label' | 'path' | 'port'> = {
  split: 1,
  jevMode: (a.jev as 'jev' | 'heuristic') ?? (quick ? 'heuristic' : 'jev'),
  jevBudget: num('budget', 400),
  seed: num('seed', 7),
  tvlUsd: num('tvl', 20_000_000),
  keeperLag: num('keeper-lag', 1),
  missProb: num('miss-prob', 0.05),
  arbs: cex.map((c, i) => ({ cexBps: c, gasUsd: gas[i] ?? gas[0]! })),
  arbLateProb: num('arb-late', 0.1),
  minProfitUsd: num('min-profit', 0.5),
  lambda: num('lambda', 0.1),
  retailMedianUsd: num('retail-usd', 400),
  retailSigma: num('retail-sigma', 1.3),
  retailCapUsd: num('retail-cap', 200_000),
  dirAutocorr: num('dir-autocorr', 0.6),
  informedFrac: num('informed', 0.05),
  informedHorizon: num('informed-horizon', 30),
  routing: (a.routing as 'split' | 'best') ?? 'split',
  minSplitFrac: num('min-split', 0.1),
  degradeAtFrac: 0.5,
  settleEvery: num('settle-every', quick ? 10 : 20),
  calibWindow: num('calib-window', quick ? 20 : 50),
  calibMinN: num('calib-min-n', 1), // settler posting floor; the hook has no sample minimum
  staleSteps: num('stale-steps', 5),
  labelMid: (a['label-mid'] as 'attested' | 'true') ?? 'true',
  bucketSteps: 60,
};

const t0 = Date.now();
if (a['report-only']) {
  // re-render results.md / charts / results.json from the raw dump of a previous run (no simulation)
  const raw = JSON.parse(readFileSync(resolve(outDir, 'runs.raw.json'), 'utf8'));
  const summary = writeReportV2(raw.results, outDir, { quick: raw.quick, totalSec: raw.totalSec, cfg: raw.cfg, steps: raw.steps });
  writeFileSync(resolve(outDir, 'results.json'), JSON.stringify(summary, (_k, v) => (typeof v === 'number' ? (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null) : v)));
  log('report_only', { outDir });
  process.exit(0);
}
const all = await selectWindowsV2();
const wanted = a.windows ? String(a.windows).split(',') : quick ? ['ETH-vol1', 'BTC-calm1'] : all.map((w) => w.id);
const windows = all.filter((w) => wanted.includes(w.id));
const VARIANT_WINDOWS = ['ETH-vol1', 'BTC-vol1'];
log('v2_start', { windows: windows.map((w) => w.id), steps, variants, cfg: base });
const results: RunResultV2[] = [];
for (const w of windows) {
  const full = await loadPathV2(w, 1);
  const path = { ...full, mids: full.mids.slice(0, steps), times: full.times.slice(0, steps) };
  const vs: { name: string; over: Partial<RunConfigV2> }[] = [{ name: 'base', over: {} }];
  if (variants && VARIANT_WINDOWS.includes(w.id)) {
    vs.push({ name: 'split5', over: { split: 5 } });
    vs.push({ name: 'lag0', over: { keeperLag: 0, missProb: 0 } });
    vs.push({ name: 'labelatt', over: { labelMid: 'attested' } });
  }
  let jevUsed = 0;
  for (const v of vs) {
    const cfg: RunConfigV2 = { ...base, ...v.over, label: `${w.id}:${v.name}`, path, port: port++, jevBudget: Math.max(0, base.jevBudget - jevUsed) };
    const r = await runOneV2(cfg);
    jevUsed += r.jev.calls;
    log('run_done', { label: r.label, sec: r.runtimeSec, txs: r.txCount, reverts: r.reverts.length, jev: r.jev.counts, fallback: r.jev.fallbackShare });
    results.push(r);
  }
}
mkdirSync(outDir, { recursive: true });
const totalSec = Math.round((Date.now() - t0) / 1000);
writeFileSync(resolve(outDir, 'runs.raw.json'), JSON.stringify({ quick, totalSec, cfg: base, steps, results }));
const summary = writeReportV2(results, outDir, { quick, totalSec, cfg: base, steps });
writeFileSync(resolve(outDir, 'results.json'), JSON.stringify(summary, (_k, v) => (typeof v === 'number' ? (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null) : v)));
log('done', { outDir, sec: Math.round((Date.now() - t0) / 1000) });
process.exit(0);
