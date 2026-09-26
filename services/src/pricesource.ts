/**
 * Shared CEX price source for the standalone keeper, arb bot, retail bot and settler.
 *
 *   PRICE_SOURCE=live    (default) Binance bookTicker mid, fetched when asked.
 *   PRICE_SOURCE=replay  REAL cached Binance klines, replayed on block time: block b maps to kline
 *                        index (b - REPLAY_ORIGIN_BLOCK) * REPLAY_STEP of a fixed window. Every
 *                        process that computes midAt(b) for the same block gets the same price, so
 *                        the keeper's attested mid and the arb bot's "CEX" agree on the time index
 *                        without any IPC. The window is walked forward then backward (ping-pong) when
 *                        exhausted, so the path never jumps.
 *
 * Replay env (all optional):
 *   REPLAY_INTERVAL=1m          kline interval (1s | 1m | ...)
 *   REPLAY_STEP=4               klines advanced per block (1m x 4 = 4 minutes of history per block)
 *   REPLAY_BLOCKS=150           window length in blocks (window = REPLAY_BLOCKS * REPLAY_STEP klines)
 *   REPLAY_START_MS             window start (ms). If unset: the most volatile window (sum |log return|
 *                               per block step) of the REPLAY_LOOKBACK_H hours ending at the last full
 *                               hour. demo scripts resolve this ONCE (`tsx src/pricesource.ts --resolve`)
 *                               and export it, so processes started across an hour boundary still agree.
 *   REPLAY_LOOKBACK_H=168       search range for the volatile window
 *   REPLAY_ORIGIN_BLOCK         block that maps to index 0 (default: deployment deployBlock, else 0)
 *   CEX_SYMBOL=ETHUSDT
 *   CEX_QUOTE_SYMBOL=USDCUSDT   divisor: mid = CEX_SYMBOL / CEX_QUOTE_SYMBOL = USDC per ETH, exactly what
 *                               oniblock1 was trained on (ml/src/common.py Mids.mid). Empty string = no correction.
 *   CEX_QUOTE_MAX_AGE_S=120     live: reuse the last good quote mid this long when its fetch fails; beyond, throw
 *                               (the keeper skips the tick => stale pool => conservativeFee; never an uncorrected mid).
 * Replay divides by the latest USDCUSDT 1m kline at-or-before each sample time (at most 180 s old).
 * Klines come from services/.cache/klines (fetchKlines disk cache; immutable history).
 */
import { cexQuoteSymbol, fetchKlines, fetchMid, intervalMs, midAt as klineMidAt, QUOTE_KLINE_MAX_AGE_MS, type FetchOpts, type KlineQuery } from './cex.js';
import { env, envInt, log, parseArgs } from './config.js';

export type PriceSourceKind = 'live' | 'replay';

export interface PriceSource {
  readonly kind: PriceSourceKind;
  /** Human mid (USDC per ETH) in force at `block`. Live ignores the block. */
  midAt(block: number): Promise<number>;
  describe(): Record<string, unknown>;
}

export interface LiveOpts {
  symbol?: string;
  /** '' = no correction. */
  quoteSymbol?: string;
  quoteMaxAgeS?: number;
  fetch?: FetchOpts;
  now?: () => number;
}

export class LivePriceSource implements PriceSource {
  readonly kind = 'live' as const;
  readonly symbol: string;
  readonly quoteSymbol: string;
  readonly quoteMaxAgeS: number;
  private readonly fetchOpts: FetchOpts | undefined;
  private readonly now: () => number;
  /** Last good quote mid (USDCUSDT) and when it was fetched. */
  private quote: { mid: number; at: number } | undefined;

  constructor(o: LiveOpts = {}) {
    this.symbol = o.symbol ?? env('CEX_SYMBOL', 'ETHUSDT')!;
    this.quoteSymbol = o.quoteSymbol ?? cexQuoteSymbol();
    this.quoteMaxAgeS = o.quoteMaxAgeS ?? envInt('CEX_QUOTE_MAX_AGE_S', 120);
    this.fetchOpts = o.fetch;
    this.now = o.now ?? Date.now;
  }

  /** USDC per ETH = base book mid / quote book mid (both bookTickers fetched in parallel). */
  async midAt(_block: number): Promise<number> {
    const [base, q] = await Promise.all([fetchMid(this.symbol, this.fetchOpts), this.quoteSymbol ? this.quoteMid() : 1]);
    return base.mid / q;
  }

  /** Fresh quote mid, else the cached one if at most quoteMaxAgeS old, else throw. */
  private async quoteMid(): Promise<number> {
    try {
      const m = (await fetchMid(this.quoteSymbol, this.fetchOpts)).mid;
      this.quote = { mid: m, at: this.now() };
      return m;
    } catch (e) {
      const c = this.quote;
      const ageS = c ? (this.now() - c.at) / 1000 : undefined;
      if (c && ageS! <= this.quoteMaxAgeS) return c.mid;
      const last = ageS === undefined ? 'no cached value' : `cached value ${ageS.toFixed(0)}s old`;
      throw new Error(`${this.quoteSymbol} quote unavailable (${last}, max ${this.quoteMaxAgeS}s): ${(e as Error).message.split('\n')[0]}`);
    }
  }

  describe() {
    return {
      kind: this.kind,
      symbol: this.symbol,
      quoteSymbol: this.quoteSymbol || null,
      mid: this.quoteSymbol ? `${this.symbol} / ${this.quoteSymbol}` : `${this.symbol} (uncorrected)`,
      quoteMaxAgeS: this.quoteSymbol ? this.quoteMaxAgeS : undefined,
    };
  }
}

export interface ReplayConfig {
  interval: KlineQuery['interval'];
  step: number;
  blocks: number;
  startMs?: number;
  lookbackH: number;
  originBlock: number;
  symbol: string;
  /** Divisor symbol (1m klines); '' = no correction. */
  quoteSymbol: string;
}

export function replayConfigFromEnv(defaultOrigin = 0): ReplayConfig {
  const start = env('REPLAY_START_MS');
  return {
    interval: env('REPLAY_INTERVAL', '1m') as KlineQuery['interval'],
    step: Math.max(1, envInt('REPLAY_STEP', 4)),
    blocks: Math.max(10, envInt('REPLAY_BLOCKS', 150)),
    startMs: start ? Number(start) : undefined,
    lookbackH: envInt('REPLAY_LOOKBACK_H', 168),
    originBlock: envInt('REPLAY_ORIGIN_BLOCK', defaultOrigin),
    symbol: env('CEX_SYMBOL', 'ETHUSDT')!,
    quoteSymbol: cexQuoteSymbol(),
  };
}

/** Index of the most volatile window (sum of |log return| at `step` spacing over `blocks` steps). */
export function mostVolatileStart(closes: number[], step: number, blocks: number): number {
  const need = blocks * step + 1;
  if (closes.length <= need) return 0;
  let best = -1;
  let bestI = 0;
  for (let i = 0; i + need <= closes.length; i++) {
    let acc = 0;
    for (let j = 0; j < blocks; j++) acc += Math.abs(Math.log(closes[i + (j + 1) * step]! / closes[i + j * step]!));
    if (acc > best) {
      best = acc;
      bestI = i;
    }
  }
  return bestI;
}

/** Ping-pong index into a path of length n: 0..n-1, n-2..0, 1.. (no jumps). */
export function pingPong(i: number, n: number): number {
  if (n <= 1) return 0;
  const period = 2 * (n - 1);
  const m = ((i % period) + period) % period;
  return m < n ? m : period - m;
}

export class ReplayPriceSource implements PriceSource {
  readonly kind = 'replay' as const;
  private constructor(
    readonly cfg: ReplayConfig & { startMs: number },
    /** One price per block step (already sampled at `step`). */
    readonly path: number[],
    readonly stats: Record<string, unknown>,
  ) {}

  /** Resolve the window (fetch or read cache) and build the per-block path. */
  static async create(cfg: ReplayConfig): Promise<ReplayPriceSource> {
    const ivl = intervalMs(cfg.interval);
    const span = (cfg.blocks * cfg.step + 1) * ivl;
    let startMs = cfg.startMs;
    if (startMs === undefined) {
      const end = Math.floor(Date.now() / 3_600_000) * 3_600_000;
      const all = await fetchKlines({ symbol: cfg.symbol, interval: cfg.interval, startMs: end - cfg.lookbackH * 3_600_000, endMs: end });
      const i = mostVolatileStart(all.map((k) => k.close), cfg.step, cfg.blocks);
      startMs = all[i]?.openTime ?? end - span;
    }
    const ks = await fetchKlines({ symbol: cfg.symbol, interval: cfg.interval, startMs, endMs: startMs + span });
    if (ks.length < 2) throw new Error(`replay window ${startMs} has ${ks.length} klines`);
    // USDC per ETH: divide by the latest quote 1m kline at-or-before each sample time (common.py usdc_usdt).
    const qs = cfg.quoteSymbol
      ? await fetchKlines({ symbol: cfg.quoteSymbol, interval: '1m', startMs: startMs - QUOTE_KLINE_MAX_AGE_MS, endMs: startMs + span })
      : undefined;
    // Sample one price per block step by time (forward-fill across empty 1s buckets).
    const path: number[] = [];
    let j = 0;
    for (let b = 0; b <= cfg.blocks; b++) {
      const t = startMs + b * cfg.step * ivl;
      while (j + 1 < ks.length && ks[j + 1]!.openTime <= t) j++;
      let q = 1;
      if (qs) {
        const v = klineMidAt(qs, t, QUOTE_KLINE_MAX_AGE_MS);
        if (!v) throw new Error(`replay window ${startMs}: no ${cfg.quoteSymbol} 1m kline within ${QUOTE_KLINE_MAX_AGE_MS / 1000}s before ${t}`);
        q = v;
      }
      path.push(ks[j]!.close / q);
    }
    const absRet = path.slice(1).map((p, i) => Math.abs(Math.log(p / path[i]!)) * 1e4);
    const stats = {
      firstMid: path[0],
      minMid: Math.min(...path),
      maxMid: Math.max(...path),
      meanAbsStepBps: +(absRet.reduce((a, b) => a + b, 0) / absRet.length).toFixed(2),
      stepsOver30Bps: absRet.filter((r) => r > 30).length,
      windowStart: new Date(startMs).toISOString(),
    };
    return new ReplayPriceSource({ ...cfg, startMs }, path, stats);
  }

  indexAt(block: number): number {
    return pingPong(block - this.cfg.originBlock, this.path.length);
  }

  async midAt(block: number): Promise<number> {
    return this.path[this.indexAt(block)]!;
  }

  describe() {
    const { interval, step, blocks, startMs, originBlock, symbol, quoteSymbol } = this.cfg;
    const mid = quoteSymbol ? `${symbol} ${interval} / ${quoteSymbol} 1m` : `${symbol} (uncorrected)`;
    return { kind: this.kind, symbol, quoteSymbol: quoteSymbol || null, mid, interval, step, blocks, startMs, originBlock, ...this.stats };
  }
}

/** PRICE_SOURCE=live|replay (default live). `defaultOrigin` = the deployment's deployBlock. */
export async function makePriceSource(defaultOrigin = 0, kind = env('PRICE_SOURCE', 'live') as PriceSourceKind): Promise<PriceSource> {
  if (kind === 'replay') return ReplayPriceSource.create(replayConfigFromEnv(defaultOrigin));
  if (kind !== 'live') throw new Error(`PRICE_SOURCE must be live|replay, got "${kind}"`);
  return new LivePriceSource();
}

/**
 * Lazily-created shared source for a service. `midSource(block)` is what Keeper/ArbBot/RetailBot take.
 * Creation errors are retried on the next call (never crash a service loop).
 */
export function lazyMidSource(defaultOrigin: number, component: string): (block?: number) => Promise<number> {
  let p: Promise<PriceSource> | undefined;
  return async (block?: number) => {
    p ??= makePriceSource(defaultOrigin).then(
      (s) => {
        log(component, 'price_source', s.describe());
        return s;
      },
      (e) => {
        p = undefined;
        throw e;
      },
    );
    const s = await p;
    if (block === undefined && s.kind === 'replay') throw new Error('replay price source needs a block number');
    return s.midAt(block ?? 0);
  };
}

// CLI: `tsx src/pricesource.ts --resolve` prints the resolved window as shell exports (used by the demo
// scripts so every process shares one window). `--at N` prints the mid at block N.
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = parseArgs();
  const s = await makePriceSource(0, (a.kind as PriceSourceKind) ?? (env('PRICE_SOURCE', 'replay') as PriceSourceKind));
  if (a.resolve && s instanceof ReplayPriceSource) {
    const first = s.path[s.indexAt(s.cfg.originBlock)]!;
    process.stdout.write(`REPLAY_START_MS=${s.cfg.startMs}\nREPLAY_FIRST_MID_E8=${Math.round(first * 1e8)}\n`);
    process.stderr.write(JSON.stringify(s.describe()) + '\n');
  } else if (a.at !== undefined) {
    console.log(await s.midAt(Number(a.at)));
  } else {
    console.log(JSON.stringify(s.describe()));
  }
}
