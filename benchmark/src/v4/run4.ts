/**
 * Benchmark v4 entry point ("the AI decides the fee"): v2/v3's markets with routing competition, the same 12 frozen
 * windows (data/windows_v2.json) x 3600 1s steps, at base fee 0.30% AND the b500 tier (0.05% on every pool).
 *
 *   pnpm bench:v4          full run (24 runs)
 *   pnpm bench:v4:quick    2 windows (ETH-vol1, BTC-calm1) x 300 steps, heuristic scorer for the Jev arms
 *
 * Flags: all v2/v3 flags (see src/v3/run3.ts) except the v3 gate flags, plus
 *   --base-fee P (3000) --thr P (base + 300; arm b only) --b500 true|false (true) --ai-kmax BPS (8000)
 *   --ai-kstep BPS (8000) --ai-kdefault BPS (0) --dz BPS (500; arm f) --budget N (250 live Jev calls per run, hard cap)
 *   --steps N (1200) --jev jev|heuristic --deadband-usd USD (0) --deadband-bps BPS (0) --out DIR (results_v4)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BENCH_DIR, log } from '../util.js';
import { loadPathV2, selectWindowsV2 } from '../v2/windows.js';
import { runOneV4, type RunConfigV4, type RunResultV4 } from './sim4.js';
import { writeReportV4 } from './report4.js';

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
const bool = (k: string, dflt: boolean) => (a[k] !== undefined ? a[k] !== 'false' : dflt);
const list = (k: string, dflt: number[]) => (a[k] !== undefined ? String(a[k]).split(',').map(Number) : dflt);
const outDir = resolve(String(a.out ?? resolve(BENCH_DIR, quick ? 'results_v4/quick' : 'results_v4')));
let port = num('port', 8760);
// v4 default 1200 steps (20 min) per window: Jev is asked on every step of three pools and the gateway here is slow
// and flaky (v3 ran 3600 steps with Jev on ~11% of steps). --steps 3600 restores the full hour (used for the
// heuristic-only full-length run).
const steps = num('steps', quick ? 300 : 1200);
const variants = bool('variants', false);
const b500 = bool('b500', !quick);
const cex = list('cex-bps', [1.5, 2.5]);
const gas = list('gas-usd', [0.6, 0.3]);
const baseFee = num('base-fee', 3000);

const base: Omit<RunConfigV4, 'label' | 'path' | 'port'> = {
  split: 1,
  jevMode: (a.jev as 'jev' | 'heuristic') ?? (quick ? 'heuristic' : 'jev'),
  jevBudget: num('budget', 250),
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
  baseFee,
  thrPips: num('thr', baseFee + 300),
  aiKMax: num('ai-kmax', 8000),
  aiKStep: num('ai-kstep', 8000),
  aiKDefault: num('ai-kdefault', 0),
  dzBps: num('dz', 500),
  labelFee: (a['label-fee'] as 'base' | 'paid') ?? 'base',
  // 0/0 reproduces results_v4 (sign-only labels); the live settler defaults to $1 / 1 bp (DESIGN §12)
  deadbandUsd: num('deadband-usd', 0),
  deadbandBps: num('deadband-bps', 0),
};

const t0 = Date.now();
const round = (_k: string, v: unknown) => (typeof v === 'number' ? (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null) : v);
if (a['report-only']) {
  const raw = JSON.parse(readFileSync(resolve(outDir, 'runs.raw.json'), 'utf8'));
  const summary = writeReportV4(raw.results, outDir, { quick: raw.quick, totalSec: raw.totalSec, cfg: raw.cfg, steps: raw.steps });
  writeFileSync(resolve(outDir, 'results.json'), JSON.stringify(summary, round));
  log('report_only', { outDir });
  process.exit(0);
}
const all = await selectWindowsV2();
const wanted = a.windows ? String(a.windows).split(',') : quick ? ['ETH-vol1', 'BTC-calm1'] : all.map((w) => w.id);
const windows = all.filter((w) => wanted.includes(w.id));
const VARIANT_WINDOWS = ['ETH-vol1', 'BTC-vol1'];
log('v4_start', { windows: windows.map((w) => w.id), steps, variants, b500, cfg: base });
const results: RunResultV4[] = [];
mkdirSync(outDir, { recursive: true });
for (const w of windows) {
  const full = await loadPathV2(w, 1);
  const path = { ...full, mids: full.mids.slice(0, steps), times: full.times.slice(0, steps) };
  const vs: { name: string; over: Partial<RunConfigV4> }[] = [{ name: 'base', over: {} }];
  if (b500) vs.push({ name: 'b500', over: { baseFee: 500, thrPips: num('thr500', 800) } });
  if (variants && VARIANT_WINDOWS.includes(w.id)) vs.push({ name: 'split5', over: { split: 5 } });
  for (const v of vs) {
    const cfg: RunConfigV4 = { ...base, ...v.over, label: `${w.id}:${v.name}`, path, port: port++ };
    const r = await runOneV4(cfg);
    log('run_done', { label: r.label, sec: r.runtimeSec, txs: r.txCount, reverts: r.reverts.length, jev: r.jev.counts, kZero: r.kZero });
    results.push(r);
    // checkpoint after every run so a crash does not lose finished windows
    writeFileSync(resolve(outDir, 'runs.partial.json'), JSON.stringify({ quick, cfg: base, steps, results }));
  }
}
const totalSec = Math.round((Date.now() - t0) / 1000);
writeFileSync(resolve(outDir, 'runs.raw.json'), JSON.stringify({ quick, totalSec, cfg: base, steps, results }));
const summary = writeReportV4(results, outDir, { quick, totalSec, cfg: base, steps });
writeFileSync(resolve(outDir, 'results.json'), JSON.stringify(summary, round));
log('done', { outDir, sec: totalSec });
process.exit(0);
