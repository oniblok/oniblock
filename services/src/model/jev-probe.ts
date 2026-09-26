/**
 * Jev probe: measures latency (p50/p95) and sanity of answers over a sweep of states.
 * Usage: tsx src/model/jev-probe.ts [--n 10]
 * Prints JSON lines; never prints the API key.
 */
import { parseArgs } from '../config.js';
import { computeFeatures, featuresToState, type SwapObs } from '../features.js';
import { Q96 } from '../price.js';
import { scoreWithJev } from './jev.js';

const a = parseArgs();
const N = Number(a.n ?? 10);
const o = 2600n * Q96;
const E18 = 10n ** 18n;

const scenarios = Array.from({ length: N }, (_, i) => {
  const gapBps = [0, 5, 10, 20, 30, 50, 80, 120, 200, 400][i % 10]!; // 0..4%
  const sign = i % 2 ? 1n : -1n;
  const swaps: SwapObs[] = Array.from({ length: i % 6 }, (_, j) => ({
    block: 100 - j,
    zeroForOne: sign > 0n,
    amount0: (sign > 0n ? -1n : 1n) * BigInt(j + 1) * E18,
    amount1: 0n,
    fee: 3000,
    arbDir: gapBps > 30,
  }));
  const vol = gapBps > 50 ? [2600, 2615, 2590, 2625, 2605] : [2600, 2600.2, 2600.1, 2600.3, 2600.2];
  const f = computeFeatures({
    swaps,
    oracleX96: o,
    poolX96: o + (sign * o * BigInt(gapBps)) / 10_000n,
    depth0: 500n * E18,
    recentMids: vol,
    currentBlock: 100,
    lastAttestBlock: 99,
    baseFee: 3000,
  });
  return { gapBps, f, state: featuresToState(f) };
});

const lat: number[] = [];
let fails = 0;
for (const s of scenarios) {
  let status = 0;
  let wallMs = 0;
  const t0 = performance.now();
  const r = await scoreWithJev(s.state, { timeoutMs: 5000, onRaw: (_raw, ms, st) => ((status = st), (wallMs = ms)) });
  const total = performance.now() - t0;
  if (!r) fails++;
  else lat.push(wallMs || total);
  console.log(JSON.stringify({ gapBps: s.gapBps, status, latencyMs: Math.round(wallMs || total), score: r }));
}
lat.sort((x, y) => x - y);
const q = (p: number) => (lat.length ? Math.round(lat[Math.min(lat.length - 1, Math.floor(p * lat.length))]!) : null);
console.log(JSON.stringify({ n: N, ok: lat.length, fails, p50: q(0.5), p95: q(0.95), min: Math.round(lat[0] ?? 0), max: Math.round(lat[lat.length - 1] ?? 0) }));
