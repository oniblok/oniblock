/** Re-render chart.svg / chart-gate.svg from an existing results.json: tsx src/render.ts [resultsDir] */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderCharts } from './report.js';
import { RESULTS_DIR } from './util.js';

const dir = resolve(process.argv[2] ?? RESULTS_DIR);
const summary = JSON.parse(readFileSync(resolve(dir, 'results.json'), 'utf8'));
renderCharts(summary.runs, dir);
console.log(`charts written to ${dir}`);
