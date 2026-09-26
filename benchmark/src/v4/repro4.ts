/**
 * Determinism check: re-run keepercost4 arm a (the v4 default config, 1 s loop, post every, lag 1) for the 6 ETH windows
 * and compare with the committed results_v4/keeper-cost/raw-a.json — every PoolTotals field of all 14 pools must be
 * exactly equal (84 pool totals, no tolerance).
 *
 * This used to compare against results_v4/heuristic-full, main's historical artifact. That artifact predates PR #5
 * (the hook's sample-minimum probation, minSamples 10, since removed): its model pools sat at kDefault for the first
 * 200-240 steps of every window (demoted.*.seasonedAtStep), while the current hook makes an allowlisted node active from
 * its first attestation, so the current contract cannot reproduce it. It is kept unchanged as a record; what can still
 * be checked on the current contract is that the benchmark is deterministic.
 *
 *   tsx src/v4/repro4.ts [--windows ETH-vol1,...] [--port 8900] [--ref results_v4/keeper-cost/raw-a.json]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BENCH_DIR, log } from '../util.js';
import { loadPathV2, selectWindowsV2 } from '../v2/windows.js';
import { POOLS } from './chain4.js';
import { BASE } from './base4.js';
import { runOneV4, type RunResultV4 } from './sim4.js';

const argv = process.argv.slice(2);
const arg = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const refPath = resolve(BENCH_DIR, arg('ref') ?? 'results_v4/keeper-cost/raw-a.json');
const ref = JSON.parse(readFileSync(refPath, 'utf8')) as { steps: number; results: RunResultV4[] };
const wanted = (arg('windows') ?? 'ETH-vol1,ETH-vol2,ETH-vol3,ETH-calm1,ETH-calm2,ETH-calm3').split(',');
const windows = (await selectWindowsV2()).filter((w) => wanted.includes(w.id));
let port = Number(arg('port') ?? 8900);
let same = 0;
let total = 0;
const diffs: string[] = [];
for (const w of windows) {
  const full = await loadPathV2(w, 1);
  const path = { ...full, mids: full.mids.slice(0, ref.steps), times: full.times.slice(0, ref.steps) };
  const r = await runOneV4({ ...BASE, postMode: 'every', keeperLag: 1, label: `${w.id}:base`, path, port: port++ });
  const o = ref.results.find((x) => x.label === `${w.id}:base`);
  if (!o) throw new Error(`no reference run for ${w.id}`);
  for (const n of POOLS) {
    total++;
    const a = r.totals[n] as unknown as Record<string, number | null>;
    const b = o.totals[n] as unknown as Record<string, number | null>;
    // exact: JSON round-trips a double exactly, so a deterministic re-run matches the saved totals bit for bit
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const bad = [...keys].filter((k) => a[k] !== b[k]);
    if (bad.length) diffs.push(`${w.id} ${n}: ${bad.map((k) => `${k} ${a[k]} vs ${b[k]}`).join(', ')}`);
    else same++;
  }
  log('repro_window', { window: w.id, same, total });
}
console.log(JSON.stringify({ ref: refPath, identicalPoolTotals: same, of: total, diffs: diffs.slice(0, 20) }));
process.exit(same === total ? 0 : 1);
