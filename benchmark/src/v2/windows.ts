/**
 * Benchmark v2 windows: ETHUSDT and BTCUSDT, 3 volatile + 3 calm 1-hour windows each, from the last 60 days.
 *
 * Selection rule (run once, then frozen in data/windows_v2.json; every later run replays exactly these):
 *   - scan = the 60 full UTC days before the selection date, Binance 1m klines (not cached to disk);
 *   - candidates = every 60-minute window starting on a 15-minute boundary with no missing 1m kline;
 *   - score = realized volatility of the window's 1m log returns (stdev, bps);
 *   - volatile = the 3 highest-scoring candidates, greedily, each at least 12 h away from every window already
 *     chosen for that asset (stress windows);
 *   - calm = the 3 candidates closest to the 10th percentile of the score, same separation rule (a typical quiet
 *     hour). The absolute minimum was NOT used: it selects frozen-feed hours (BTC: 4 distinct 1s closes in an hour),
 *     where nothing but retail happens and every pool is trivially equal.
 * The 1s klines of each chosen window are cached compactly (openTime, close) in data/v2/.
 * No parameter of the scorer (heuristic weights / Jev prompt) was fitted on these windows.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchKlines, realizedVolBps } from '../../../services/src/cex.js';
import { DATA_DIR } from '../util.js';

export type Asset = 'ETHUSDT' | 'BTCUSDT';
export interface WindowV2 {
  id: string; // e.g. ETH-vol1
  asset: Asset;
  regime: 'volatile' | 'calm';
  rank: number;
  startMs: number;
  endMs: number;
  startIso: string;
  vol1mBps: number;
  rangePct: number;
}

export const WINDOWS_V2_FILE = resolve(DATA_DIR, 'windows_v2.json');
const V2_DATA = resolve(DATA_DIR, 'v2');
const HOUR = 3_600_000;
const DAY = 86_400_000;

export async function selectWindowsV2(opts: { days?: number; perRegime?: number; minutes?: number; sepHours?: number } = {}): Promise<WindowV2[]> {
  if (existsSync(WINDOWS_V2_FILE)) return (JSON.parse(readFileSync(WINDOWS_V2_FILE, 'utf8')) as { windows: WindowV2[] }).windows;
  const days = opts.days ?? 60;
  const per = opts.perRegime ?? 3;
  const minutes = opts.minutes ?? 60;
  const sep = (opts.sepHours ?? 12) * HOUR;
  const end = Math.floor(Date.now() / DAY) * DAY;
  const start = end - days * DAY;
  const out: WindowV2[] = [];
  for (const asset of ['ETHUSDT', 'BTCUSDT'] as Asset[]) {
    const ks = await fetchKlines({ symbol: asset, interval: '1m', startMs: start, endMs: end, cacheDir: false });
    const cands: WindowV2[] = [];
    for (let i = 0; i + minutes <= ks.length; i++) {
      if (ks[i]!.openTime % (15 * 60_000) !== 0) continue;
      const w = ks.slice(i, i + minutes);
      if (w[w.length - 1]!.openTime - w[0]!.openTime !== (minutes - 1) * 60_000) continue;
      const hi = Math.max(...w.map((k) => k.high));
      const lo = Math.min(...w.map((k) => k.low));
      cands.push({
        id: '',
        asset,
        regime: 'volatile',
        rank: 0,
        startMs: w[0]!.openTime,
        endMs: w[0]!.openTime + minutes * 60_000,
        startIso: new Date(w[0]!.openTime).toISOString(),
        vol1mBps: Math.round(realizedVolBps(w.map((k) => k.close)) * 100) / 100,
        rangePct: Math.round((hi / lo - 1) * 1e5) / 1e3,
      });
    }
    const chosen: WindowV2[] = [];
    const pick = (sorted: WindowV2[], regime: 'volatile' | 'calm') => {
      let rank = 0;
      for (const c of sorted) {
        if (rank >= per) break;
        if (chosen.some((x) => Math.abs(x.startMs - c.startMs) < sep)) continue;
        rank++;
        const tag = asset.slice(0, 3);
        chosen.push({ ...c, regime, rank, id: `${tag}-${regime === 'volatile' ? 'vol' : 'calm'}${rank}` });
      }
    };
    const byVol = [...cands].sort((a, b) => b.vol1mBps - a.vol1mBps);
    pick(byVol, 'volatile');
    const q10 = byVol[Math.floor(byVol.length * 0.9)]!.vol1mBps;
    pick([...cands].sort((a, b) => Math.abs(a.vol1mBps - q10) - Math.abs(b.vol1mBps - q10)), 'calm');
    out.push(...chosen);
  }
  writeFileSync(
    WINDOWS_V2_FILE,
    JSON.stringify(
      {
        selectedAt: new Date().toISOString(),
        scanStart: new Date(start).toISOString(),
        scanEnd: new Date(end).toISOString(),
        rule: `per asset: 60-min windows on 15-min boundaries without 1m gaps, scored by realized vol of 1m log returns; top ${per} (volatile) and the ${per} closest to the 10th percentile (calm), greedy, >= ${sep / HOUR} h apart`,
        windows: out,
      },
      null,
      2,
    ),
  );
  return out;
}

export interface PathV2 {
  window: WindowV2;
  mids: number[];
  times: number[];
  stepSeconds: number;
}

/** 1s closes of the window (forward-filled), one mid per `stepSeconds`. Cached compactly in data/v2/. */
export async function loadPathV2(w: WindowV2, stepSeconds = 1): Promise<PathV2> {
  mkdirSync(V2_DATA, { recursive: true });
  const f = resolve(V2_DATA, `${w.asset}_1s_${w.startMs}.json`);
  let rows: [number, number][];
  if (existsSync(f)) rows = JSON.parse(readFileSync(f, 'utf8'));
  else {
    const ks = await fetchKlines({ symbol: w.asset, interval: '1s', startMs: w.startMs, endMs: w.endMs, cacheDir: false });
    if (ks.length < 100) throw new Error(`too few 1s klines for ${w.id}`);
    rows = ks.map((k) => [k.openTime, k.close]);
    writeFileSync(f, JSON.stringify(rows));
  }
  const mids: number[] = [];
  const times: number[] = [];
  let j = 0;
  let last = rows[0]![1];
  for (let t = w.startMs; t < w.endMs; t += stepSeconds * 1000) {
    const tEnd = t + stepSeconds * 1000;
    while (j < rows.length && rows[j]![0] < tEnd) last = rows[j++]![1];
    mids.push(last);
    times.push(tEnd);
  }
  return { window: w, mids, times, stepSeconds };
}

// CLI: tsx src/v2/windows.ts  -> select + fetch all windows
if (import.meta.url === `file://${process.argv[1]}`) {
  const ws = await selectWindowsV2();
  for (const w of ws) {
    const p = await loadPathV2(w);
    console.log(JSON.stringify({ id: w.id, start: w.startIso, vol1mBps: w.vol1mBps, rangePct: w.rangePct, steps: p.mids.length, first: p.mids[0], last: p.mids[p.mids.length - 1] }));
  }
}
