/**
 * Binance public REST client (no API key needed).
 *  - live mid from /api/v3/ticker/bookTicker  (mid = (bid+ask)/2)
 *  - historical klines (1s / 1m / ...) with pagination (1000 per page)
 *  - retry with exponential backoff; host fallback api.binance.com -> api.binance.us ->
 *    data-api.binance.vision (binance.us has no 1s interval; we skip to the next host)
 *  - disk cache for kline windows (immutable history) as JSON
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SERVICES_DIR, env, sleep } from './config.js';

export const BINANCE_HOSTS = ['https://api.binance.com', 'https://api.binance.us', 'https://data-api.binance.vision'];

export interface BookMid {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  /** Raw strings for exact conversion. */
  bidStr: string;
  askStr: string;
  host: string;
  fetchedAt: number;
}

export interface Kline {
  openTime: number; // ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number; // ms
}

export interface FetchOpts {
  hosts?: string[];
  retries?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const INTERVAL_MS: Record<string, number> = {
  '1s': 1_000,
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
};

export function intervalMs(interval: string): number {
  const v = INTERVAL_MS[interval];
  if (!v) throw new Error(`unsupported interval ${interval}`);
  return v;
}

class HttpError extends Error {
  constructor(
    public status: number,
    public body: string,
    public url: string,
  ) {
    super(`HTTP ${status} ${url}: ${body.slice(0, 200)}`);
  }
}

async function getJson(url: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    const text = await r.text();
    if (!r.ok) throw new HttpError(r.status, text, url);
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

/**
 * GET `path` trying each host; per host retry transient errors (429/5xx/network) with backoff.
 * Non-retryable 4xx (e.g. invalid interval on binance.us, 451 geo-block) jump to the next host.
 */
export async function binanceGet(path: string, opts: FetchOpts = {}): Promise<{ data: unknown; host: string }> {
  const hosts = opts.hosts ?? (env('BINANCE_HOSTS')?.split(',') || BINANCE_HOSTS);
  const retries = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const errors: string[] = [];
  for (const host of hosts) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const data = await getJson(host + path, timeoutMs, fetchImpl);
        return { data, host };
      } catch (e) {
        const err = e as Error;
        errors.push(`${host} #${attempt}: ${err.message}`);
        const status = e instanceof HttpError ? e.status : 0;
        const retryable = status === 0 || status === 429 || status === 418 || status >= 500;
        if (!retryable) break; // next host
        if (attempt < retries) await sleep(Math.min(200 * 2 ** attempt, 3_000) + Math.random() * 100);
      }
    }
  }
  throw new Error(`binance request failed on all hosts for ${path}:\n  ${errors.join('\n  ')}`);
}

/** Live mid from the order book top. */
export async function fetchMid(symbol = 'ETHUSDT', opts: FetchOpts = {}): Promise<BookMid> {
  const { data, host } = await binanceGet(`/api/v3/ticker/bookTicker?symbol=${symbol}`, opts);
  const d = data as { bidPrice: string; askPrice: string };
  const bid = Number(d.bidPrice);
  const ask = Number(d.askPrice);
  if (!(bid > 0 && ask > 0)) throw new Error(`bad bookTicker from ${host}: ${JSON.stringify(data)}`);
  return { symbol, bid, ask, mid: (bid + ask) / 2, bidStr: d.bidPrice, askStr: d.askPrice, host, fetchedAt: Date.now() };
}

function parseKline(row: unknown[]): Kline {
  return {
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
  };
}

export interface KlineQuery {
  symbol?: string;
  interval: '1s' | '1m' | '3m' | '5m' | '15m' | '1h';
  startMs: number;
  endMs: number; // exclusive
  /** Directory for the disk cache; `false` disables caching. */
  cacheDir?: string | false;
}

export function defaultCacheDir(): string {
  return env('CEX_CACHE_DIR', resolve(SERVICES_DIR, '.cache', 'klines'))!;
}

/**
 * Fetch klines in [startMs, endMs) with pagination (1000/page). Cached on disk by
 * (symbol, interval, start, end) — only windows fully in the past are cached.
 */
export async function fetchKlines(q: KlineQuery, opts: FetchOpts = {}): Promise<Kline[]> {
  const symbol = q.symbol ?? 'ETHUSDT';
  const step = intervalMs(q.interval);
  const cacheDir = q.cacheDir === undefined ? defaultCacheDir() : q.cacheDir;
  const cacheFile = cacheDir ? resolve(cacheDir, `${symbol}_${q.interval}_${q.startMs}_${q.endMs}.json`) : null;
  if (cacheFile && existsSync(cacheFile)) {
    return JSON.parse(readFileSync(cacheFile, 'utf8')) as Kline[];
  }
  const out: Kline[] = [];
  let cursor = q.startMs;
  while (cursor < q.endMs) {
    const pageEnd = Math.min(q.endMs - 1, cursor + step * 1000 - 1);
    const path = `/api/v3/klines?symbol=${symbol}&interval=${q.interval}&startTime=${cursor}&endTime=${pageEnd}&limit=1000`;
    const { data } = await binanceGet(path, opts);
    const rows = (data as unknown[][]).map(parseKline).filter((k) => k.openTime >= q.startMs && k.openTime < q.endMs);
    for (const k of rows) if (!out.length || k.openTime > out[out.length - 1]!.openTime) out.push(k);
    // 1s klines skip seconds with no trades, so advance by the window, not by rows.
    cursor = pageEnd + 1;
  }
  if (cacheFile && q.endMs < Date.now() - 5_000) {
    mkdirSync(cacheDir as string, { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(out));
  }
  return out;
}

/**
 * Mid at a timestamp from a sorted kline series: the close of the last kline whose
 * openTime <= ts (forward-fill across empty 1s buckets). Returns undefined if before series,
 * or if that kline opened more than `maxAgeMs` before ts.
 */
export function midAt(klines: Kline[], tsMs: number, maxAgeMs = Infinity): number | undefined {
  let lo = 0;
  let hi = klines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (klines[m]!.openTime <= tsMs) {
      ans = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return ans >= 0 && tsMs - klines[ans]!.openTime <= maxAgeMs ? klines[ans]!.close : undefined;
}

/**
 * The pools are USDC/WETH, and oniblock1 was trained on mid = USDC per ETH = ETHUSDT / USDCUSDT
 * (ml/src/common.py Mids.mid). Every CEX mid the services post or label with must carry the same correction.
 *   CEX_QUOTE_SYMBOL=USDCUSDT (default)   divisor symbol; set to the empty string to disable the correction
 *                                          (non-USDC pools, tests).
 */
export const DEFAULT_QUOTE_SYMBOL = 'USDCUSDT';
/** A 1m quote kline opened more than this before t is unusable (common.py usdc_usdt: 180 s). */
export const QUOTE_KLINE_MAX_AGE_MS = 180_000;

/** CEX_QUOTE_SYMBOL; unset => USDCUSDT, empty string => '' (no correction). Read raw: env() maps '' to the fallback. */
export function cexQuoteSymbol(): string {
  const v = process.env.CEX_QUOTE_SYMBOL;
  return v === undefined ? DEFAULT_QUOTE_SYMBOL : v.trim();
}

export interface HistoricalMidOpts {
  /** Base symbol (default CEX_SYMBOL or ETHUSDT). */
  symbol?: string;
  /** Divisor symbol (default cexQuoteSymbol()); '' = no correction. */
  quoteSymbol?: string;
  /** Base kline interval (default 1s). The quote always uses 1m klines, like common.py. */
  interval?: KlineQuery['interval'];
  /** Base klines fetched from min(t) - baseLookbackMs (default 30 s). */
  baseLookbackMs?: number;
  cacheDir?: string | false;
  fetch?: FetchOpts;
}

/**
 * Historical CEX mid at each timestamp (ms): base close at-or-before t / quote 1m close at-or-before t
 * (the quote kline at most 180 s old). Timestamps where either side is missing are absent from the map.
 * Both kline windows are fetched in parallel; a fetch error rejects (caller decides: never an uncorrected mid).
 */
export async function historicalMids(times: number[], o: HistoricalMidOpts = {}): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!times.length) return out;
  const symbol = o.symbol ?? env('CEX_SYMBOL', 'ETHUSDT')!;
  const quoteSymbol = o.quoteSymbol ?? cexQuoteSymbol();
  const lo = Math.min(...times);
  const hi = Math.max(...times);
  const [base, quote] = await Promise.all([
    fetchKlines({ symbol, interval: o.interval ?? '1s', startMs: lo - (o.baseLookbackMs ?? 30_000), endMs: hi + 1_000, cacheDir: o.cacheDir }, o.fetch),
    quoteSymbol
      ? fetchKlines({ symbol: quoteSymbol, interval: '1m', startMs: lo - QUOTE_KLINE_MAX_AGE_MS, endMs: hi + 1_000, cacheDir: o.cacheDir }, o.fetch)
      : undefined,
  ]);
  for (const t of times) {
    const b = midAt(base, t);
    const q = quote ? midAt(quote, t, QUOTE_KLINE_MAX_AGE_MS) : 1;
    if (b && q) out.set(t, b / q);
  }
  return out;
}

/** Realized volatility of a price series in bps (stdev of log returns * 1e4). */
export function realizedVolBps(prices: number[]): number {
  if (prices.length < 3) return 0;
  const r: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1]! > 0 && prices[i]! > 0) r.push(Math.log(prices[i]! / prices[i - 1]!));
  }
  if (r.length < 2) return 0;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v) * 1e4;
}

/** Small rolling buffer of live mids (for realized vol in the keeper). */
export class MidHistory {
  private xs: { t: number; mid: number }[] = [];
  constructor(private readonly max = 120) {}
  push(mid: number, t = Date.now()) {
    this.xs.push({ t, mid });
    if (this.xs.length > this.max) this.xs.shift();
  }
  mids(): number[] {
    return this.xs.map((x) => x.mid);
  }
  /** Time-stamped mids (t = unix ms, oldest first; a copy) for the v2 past-only features (features.ts computeMidFeatures). */
  entries(): { t: number; mid: number }[] {
    return this.xs.map((x) => ({ t: x.t, mid: x.mid }));
  }
  last(): number | undefined {
    return this.xs[this.xs.length - 1]?.mid;
  }
}

// CLI: `tsx src/cex.ts` prints live mid + a short 1s window summary.
if (import.meta.url === `file://${process.argv[1]}`) {
  const m = await fetchMid();
  console.log(JSON.stringify(m));
  const end = Math.floor(Date.now() / 1000) * 1000 - 60_000;
  const ks = await fetchKlines({ interval: '1s', startMs: end - 600_000, endMs: end });
  console.log(JSON.stringify({ n: ks.length, first: ks[0], last: ks[ks.length - 1], volBps: realizedVolBps(ks.map((k) => k.close)) }));
}
