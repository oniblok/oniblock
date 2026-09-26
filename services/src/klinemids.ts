/**
 * Training-exact CEX mids for the v2 mid features (realizedVolBps, vol5mBps, ret12/36/900Bps).
 *
 * oniblock1 / kev2 were trained (ml/src/build_v2.py) on ml/src/common.py `Mids`, which reads Binance
 * klines at EXACT offsets from t_obs (unix seconds):
 *   eth_usdt(t)  = close of the latest ETHUSDT 1s kline with openTime <= t, NaN if it opened > 5 s before t
 *   usdc_usdt(t) = close of the latest USDCUSDT 1m kline with openTime <= t, NaN if it opened > 180 s before t
 *   mid(t)       = eth_usdt(t) / usdc_usdt(t)                          (USDC per ETH; ret*Bps)
 *   vol_bps(t, n, step) = nanstd(diff(log(eth_usdt(t - step*(n-1 .. 0)))), ddof=1) * 1e4   (ETHUSDT only; NaN
 *                  returns dropped; fewer than 2 returns => NaN)
 * The keeper's per-tick MidHistory is ~12 s apart with jitter, so "at-or-before t - 12 s" often lands one tick further
 * back (ret12 over 24 s, vol5m skipping / duplicating samples). This module fetches the klines and applies the same
 * semantics. The Coinbase USDT-USD fallback of usdc_usdt only covers the 2022-09 .. 2023-03 USDCUSDT delisting and is
 * not reproduced (a live USDCUSDT gap => NaN => the mid features read 0, like training's missing data).
 */
import { cexQuoteSymbol, fetchKlines, type FetchOpts, type Kline } from './cex.js';
import { env } from './config.js';
import { REALIZED_VOL_SAMPLES as VOL_SAMPLES, VOL5M_STEP_S as VOL_STEP_S } from './features.js';
import { defaultTabularPath } from './model/tabular.js';
import { kevStateFormat, loadTabularModel, tabularVersion, type ModelMode } from './model/index.js';

/** common.py: 1s ETHUSDT holes tolerated up to 5 s; 1m USDCUSDT up to 180 s. */
export const ETH_KLINE_MAX_AGE_S = 5;
export const QUOTE_KLINE_MAX_AGE_S = 180;
/** Oldest second any feature reads: t - 12 * 119 (vol grid) minus the 5 s hole tolerance, with margin. */
export const KLINE_LOOKBACK_S = VOL_STEP_S * (VOL_SAMPLES - 1) + 24;

/** Index of the latest entry with ts <= t in ascending `ts`, -1 if none (np.searchsorted(ts, t, 'right') - 1). */
function searchRight(ts: readonly number[], t: number): number {
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (ts[m]! <= t) lo = m + 1;
    else hi = m;
  }
  return lo - 1;
}

/** A kline series reduced to (openTime in unix seconds, close), ascending and de-duplicated. */
function series(ks: readonly Kline[]): { ts: number[]; px: number[] } {
  const rows = ks.map((k) => [Math.floor(k.openTime / 1000), k.close] as const).sort((a, b) => a[0] - b[0]);
  const ts: number[] = [];
  const px: number[] = [];
  for (const [t, c] of rows) {
    if (ts.length && ts[ts.length - 1] === t) continue; // drop_duplicates("ts") keeps the first
    ts.push(t);
    px.push(c);
  }
  return { ts, px };
}

/** common.py `Mids` over fetched klines. All times are unix SECONDS (integers), like training. */
export class KlineMids {
  private readonly e: { ts: number[]; px: number[] };
  private readonly u: { ts: number[]; px: number[] } | undefined;
  /** `quote` undefined = no USDC/USDT correction (CEX_QUOTE_SYMBOL=''), usdc_usdt = 1. */
  constructor(eth: readonly Kline[], quote?: readonly Kline[]) {
    this.e = series(eth);
    this.u = quote ? series(quote) : undefined;
  }

  ethUsdt(t: number): number {
    const i = searchRight(this.e.ts, t);
    return i >= 0 && Math.abs(t - this.e.ts[i]!) <= ETH_KLINE_MAX_AGE_S ? this.e.px[i]! : NaN;
  }

  usdcUsdt(t: number): number {
    if (!this.u) return 1;
    const i = searchRight(this.u.ts, t);
    return i >= 0 && Math.abs(t - this.u.ts[i]!) <= QUOTE_KLINE_MAX_AGE_S ? this.u.px[i]! : NaN;
  }

  /** USDC per ETH. */
  mid(t: number): number {
    return this.ethUsdt(t) / this.usdcUsdt(t);
  }

  /** nanstd(diff(log(eth_usdt(grid))), ddof=1) * 1e4 on grid t - step*(n-1 .. 0); NaN if fewer than 2 returns. */
  volBps(t: number, n = VOL_SAMPLES, step = VOL_STEP_S): number {
    const m: number[] = [];
    for (let k = n - 1; k >= 0; k--) m.push(this.ethUsdt(t - step * k));
    const r: number[] = [];
    for (let k = 1; k < m.length; k++) {
      const x = Math.log(m[k]!) - Math.log(m[k - 1]!);
      if (Number.isFinite(x)) r.push(x);
    }
    if (r.length < 2) return NaN;
    const mean = r.reduce((a, b) => a + b, 0) / r.length;
    return Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1)) * 1e4;
  }
}

export interface KlineMidsFetchOpts {
  symbol?: string;
  /** '' = no correction (default CEX_QUOTE_SYMBOL, else USDCUSDT). */
  quoteSymbol?: string;
  fetch?: FetchOpts;
}

/**
 * Klines covering every second the v2 features read for snapshot second `tObsS`: ETHUSDT 1s over
 * [tObsS - KLINE_LOOKBACK_S, tObsS] (two 1000-kline pages, fetched in parallel) and USDCUSDT 1m over the same span
 * minus 180 s. Never cached (the window ends now). Rejects on any fetch error.
 */
export async function fetchKlineMids(tObsS: number, o: KlineMidsFetchOpts = {}): Promise<KlineMids> {
  const symbol = o.symbol ?? env('CEX_SYMBOL', 'ETHUSDT')!;
  const quoteSymbol = o.quoteSymbol ?? cexQuoteSymbol();
  const start = (tObsS - KLINE_LOOKBACK_S) * 1000;
  const end = (tObsS + 1) * 1000;
  const mid = Math.min(end, start + 1000 * 1000);
  const [a, b, q] = await Promise.all([
    fetchKlines({ symbol, interval: '1s', startMs: start, endMs: mid, cacheDir: false }, o.fetch),
    mid < end ? fetchKlines({ symbol, interval: '1s', startMs: mid, endMs: end, cacheDir: false }, o.fetch) : [],
    quoteSymbol ? fetchKlines({ symbol: quoteSymbol, interval: '1m', startMs: start - QUOTE_KLINE_MAX_AGE_S * 1000, endMs: end, cacheDir: false }, o.fetch) : undefined,
  ]);
  return new KlineMids([...a, ...b], q);
}

/** Mid-feature names that only exist in the v2 models (a tabular model reading any of them needs the kline path). */
const V2_MID_INPUTS = ['edgeSigma', 'vol5mBps', 'ret12Bps', 'ret36Bps', 'ret900Bps'];

/**
 * Whether this keeper's model reads the v2 mid features and so must get them from klines: MODEL_MODE=kev with
 * KEV_STATE_FORMAT=kev2, or tabular / oniblock1 whose model file has a v2 mid input (oniblock1, or TABULAR_MODEL_PATH
 * to such a file). The v1 Kev text / Jev / heuristic keep the per-tick path. A replay or injected mid source
 * (`liveMid` false) has no Binance history to match, so it keeps the per-tick path too.
 */
export function klineMidFeaturesNeeded(mode: ModelMode, liveMid: boolean): boolean {
  if (!liveMid) return false;
  if (mode === 'kev') return kevStateFormat() === 'kev2';
  if (mode !== 'tabular' && mode !== 'oniblock1') return false;
  try {
    const m = loadTabularModel(env('TABULAR_MODEL_PATH') ?? defaultTabularPath(tabularVersion(mode)));
    return !!m?.features.some((n) => V2_MID_INPUTS.includes(n));
  } catch {
    return false; // invalid model file: scoreTabular falls back to the heuristic, which reads no v2 mid feature
  }
}
