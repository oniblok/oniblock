/**
 * Real Binance ETHUSDT price paths for the replay (no synthetic data).
 *
 * Window selection (done once, then frozen in data/windows.json so every later run replays exactly the same
 * held-out path): scan the last 30 days of 1m klines, compute the realized volatility of every `hours`-long
 * window (step 15 min), pick the most volatile ("volatile") and the least volatile ("calm") non-overlapping
 * windows. Then fetch that window at 1s resolution (fallback 1m) and cache it in data/.
 *
 * The scorer (heuristic weights / Jev prompt) was never fitted on these windows: they are held out.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchKlines, realizedVolBps, type Kline } from '../../services/src/cex.js';
import { DATA_DIR } from './util.js';

export interface WindowSpec {
  name: 'volatile' | 'calm';
  startMs: number;
  endMs: number;
  /** Realized vol of 1m log returns (bps) and high/low range (%) used for selection. */
  vol1mBps: number;
  rangePct: number;
  startIso: string;
}

const WINDOWS_FILE = resolve(DATA_DIR, 'windows.json');

export async function selectWindows(hours: number): Promise<WindowSpec[]> {
  if (existsSync(WINDOWS_FILE)) {
    const w = JSON.parse(readFileSync(WINDOWS_FILE, 'utf8')) as { hours: number; windows: WindowSpec[] };
    if (w.hours === hours) return w.windows;
  }
  // Last 30 full days, aligned to the day (so the scan itself is cacheable).
  const DAY = 86_400_000;
  const end = Math.floor(Date.now() / DAY) * DAY;
  const start = end - 30 * DAY;
  const ks = await fetchKlines({ interval: '1m', startMs: start, endMs: end, cacheDir: DATA_DIR });
  const n = hours * 60;
  const cands: WindowSpec[] = [];
  for (let i = 0; i + n <= ks.length; i += 15) {
    const w = ks.slice(i, i + n);
    if (w[w.length - 1]!.openTime - w[0]!.openTime !== (n - 1) * 60_000) continue; // skip windows with data holes
    const closes = w.map((k) => k.close);
    const hi = Math.max(...w.map((k) => k.high));
    const lo = Math.min(...w.map((k) => k.low));
    cands.push({
      name: 'volatile',
      startMs: w[0]!.openTime,
      endMs: w[0]!.openTime + n * 60_000,
      vol1mBps: realizedVolBps(closes),
      rangePct: (hi / lo - 1) * 100,
      startIso: new Date(w[0]!.openTime).toISOString(),
    });
  }
  cands.sort((a, b) => b.vol1mBps - a.vol1mBps);
  const vol = { ...cands[0]!, name: 'volatile' as const };
  const calm = cands
    .slice()
    .reverse()
    .find((c) => c.endMs <= vol.startMs || c.startMs >= vol.endMs)!;
  const windows = [vol, { ...calm, name: 'calm' as const }];
  writeFileSync(WINDOWS_FILE, JSON.stringify({ hours, selectedAt: new Date().toISOString(), scanStart: start, scanEnd: end, windows }, null, 2));
  return windows;
}

export interface PricePath {
  window: WindowSpec;
  interval: '1s' | '1m';
  /** One entry per block: close of the last kline at or before the block time (forward-filled). */
  mids: number[];
  times: number[];
  stepSeconds: number;
}

/** Fetch the window at 1s (fallback 1m) and sample one mid per `stepSeconds`. */
export async function loadPath(w: WindowSpec, stepSeconds: number, maxBlocks?: number): Promise<PricePath> {
  let interval: '1s' | '1m' = '1s';
  let ks: Kline[];
  try {
    ks = await fetchKlines({ interval: '1s', startMs: w.startMs, endMs: w.endMs, cacheDir: DATA_DIR });
    if (ks.length < 100) throw new Error('too few 1s klines');
  } catch (e) {
    console.error(`[data] 1s klines unavailable (${(e as Error).message.split('\n')[0]}); falling back to 1m`);
    interval = '1m';
    ks = await fetchKlines({ interval: '1m', startMs: w.startMs, endMs: w.endMs, cacheDir: DATA_DIR });
    stepSeconds = Math.max(60, stepSeconds);
  }
  const mids: number[] = [];
  const times: number[] = [];
  let j = 0;
  let last = ks[0]!.open;
  for (let t = w.startMs; t < w.endMs; t += stepSeconds * 1000) {
    // close of the last kline that closed by time t + step (i.e. the price at the end of this block interval)
    const tEnd = t + stepSeconds * 1000;
    while (j < ks.length && ks[j]!.openTime < tEnd) last = ks[j++]!.close;
    mids.push(last);
    times.push(tEnd);
    if (maxBlocks && mids.length >= maxBlocks) break;
  }
  return { window: w, interval, mids, times, stepSeconds };
}
