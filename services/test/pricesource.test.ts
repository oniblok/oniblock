import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LivePriceSource, makePriceSource, mostVolatileStart, pingPong, ReplayPriceSource, replayConfigFromEnv } from '../src/pricesource.js';

const live = process.env.OFFLINE === '1' ? describe.skip : describe;
const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe('pricesource helpers', () => {
  it('pingPong walks forward then back without jumps', () => {
    expect([...Array(9).keys()].map((i) => pingPong(i, 4))).toEqual([0, 1, 2, 3, 2, 1, 0, 1, 2]);
    expect(pingPong(-1, 4)).toBe(1);
    expect(pingPong(5, 1)).toBe(0);
  });
  it('mostVolatileStart finds the busy stretch', () => {
    const flat = Array(50).fill(100);
    const busy = [100, 102, 99, 103, 98, 104, 97];
    expect(mostVolatileStart([...flat, ...busy, ...flat], 1, 6)).toBeGreaterThanOrEqual(46);
    expect(mostVolatileStart([...flat, ...busy, ...flat], 1, 6)).toBeLessThanOrEqual(51);
  });
});

describe('replay source (offline, cached window)', () => {
  it('two instances agree on the price for every block (shared time index)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oni-replay-'));
    try {
      const start = 1_700_000_000_000;
      const step = 2;
      const blocks = 10;
      const end = start + (blocks * step + 1) * 60_000;
      const ks = [...Array(blocks * step + 1).keys()].map((i) => ({ openTime: start + i * 60_000, open: 0, high: 0, low: 0, close: 3000 + i, volume: 1, closeTime: 0 }));
      writeFileSync(join(dir, `ETHUSDT_1m_${start}_${end}.json`), JSON.stringify(ks));
      Object.assign(process.env, { CEX_QUOTE_SYMBOL: '', CEX_CACHE_DIR: dir, PRICE_SOURCE: 'replay', REPLAY_START_MS: String(start), REPLAY_STEP: String(step), REPLAY_BLOCKS: String(blocks), REPLAY_ORIGIN_BLOCK: '100' });
      const a = await makePriceSource();
      const b = (await ReplayPriceSource.create(replayConfigFromEnv())) as ReplayPriceSource;
      expect(a.kind).toBe('replay');
      for (const bn of [100, 101, 105, 110, 111, 130]) expect(await a.midAt(bn)).toBe(await b.midAt(bn));
      expect(await a.midAt(100)).toBe(3000);
      expect(await a.midAt(101)).toBe(3002); // one block = `step` klines
      expect(await a.midAt(110)).toBe(3020);
      expect(await a.midAt(111)).toBe(3018); // ping-pong back
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('divides by the latest USDCUSDT 1m kline at-or-before each sample time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oni-replay-q-'));
    try {
      const start = 1_700_000_040_000; // not minute-aligned relative to the quote klines below
      const step = 1;
      const blocks = 10;
      const ivl = 1_000; // 1s base klines: one block = 1 s
      const end = start + (blocks * step + 1) * ivl;
      const ks = [...Array(blocks * step + 1).keys()].map((i) => ({ openTime: start + i * ivl, open: 0, high: 0, low: 0, close: 3000 + i, volume: 1, closeTime: 0 }));
      writeFileSync(join(dir, `ETHUSDT_1s_${start}_${end}.json`), JSON.stringify(ks));
      // quote 1m klines: 1.0002 opened 30 s before start, 1.0010 opened 5 s into the window
      const q = [
        { openTime: start - 30_000, open: 0, high: 0, low: 0, close: 1.0002, volume: 1, closeTime: 0 },
        { openTime: start + 5_000, open: 0, high: 0, low: 0, close: 1.001, volume: 1, closeTime: 0 },
      ];
      writeFileSync(join(dir, `USDCUSDT_1m_${start - 180_000}_${end}.json`), JSON.stringify(q));
      Object.assign(process.env, { CEX_CACHE_DIR: dir, REPLAY_INTERVAL: '1s', REPLAY_START_MS: String(start), REPLAY_STEP: String(step), REPLAY_BLOCKS: String(blocks), REPLAY_ORIGIN_BLOCK: '0' });
      delete process.env.CEX_QUOTE_SYMBOL;
      const s = await ReplayPriceSource.create(replayConfigFromEnv());
      expect(await s.midAt(0)).toBeCloseTo(3000 / 1.0002, 9);
      expect(await s.midAt(4)).toBeCloseTo(3004 / 1.0002, 9); // t = start+4 s: the +5 s quote kline is not yet open
      expect(await s.midAt(5)).toBeCloseTo(3005 / 1.001, 9); // at-or-before: opened exactly at t
      expect(await s.midAt(10)).toBeCloseTo(3010 / 1.001, 9);
      expect(s.describe()).toMatchObject({ symbol: 'ETHUSDT', quoteSymbol: 'USDCUSDT', mid: 'ETHUSDT 1s / USDCUSDT 1m' });
      // quote kline more than 180 s old at t (common.py usdc_usdt => NaN) => refuse to build an uncorrected path
      writeFileSync(join(dir, `USDCUSDT_1m_${start - 180_000}_${end}.json`), JSON.stringify([{ ...q[0], openTime: start - 181_000 }]));
      await expect(ReplayPriceSource.create(replayConfigFromEnv())).rejects.toThrow(/no USDCUSDT 1m kline/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('rejects unknown PRICE_SOURCE', async () => {
    await expect(makePriceSource(0, 'nope' as never)).rejects.toThrow(/live\|replay/);
  });
});

/** Fake Binance: bookTicker per symbol; a symbol mapped to an Error (or missing) returns HTTP 400. */
function fakeBinance(book: Record<string, [number, number] | Error>) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    const sym = new URL(url).searchParams.get('symbol')!;
    const v = book[sym];
    if (!v || v instanceof Error) return new Response('{"code":-1,"msg":"down"}', { status: 400 });
    return new Response(JSON.stringify({ bidPrice: String(v[0]), askPrice: String(v[1]) }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetch: { hosts: ['https://fake'], retries: 0, fetchImpl } };
}

describe('live source: USDC per ETH = ETHUSDT / USDCUSDT (offline, mocked bookTicker)', () => {
  it('mid = ETHUSDT book mid / USDCUSDT book mid, both fetched', async () => {
    const f = fakeBinance({ ETHUSDT: [2999, 3001], USDCUSDT: [1.0001, 1.0003] });
    const s = new LivePriceSource({ quoteSymbol: 'USDCUSDT', fetch: f.fetch });
    expect(await s.midAt(0)).toBeCloseTo(3000 / 1.0002, 9);
    expect(f.calls.map((u) => new URL(u).searchParams.get('symbol')).sort()).toEqual(['ETHUSDT', 'USDCUSDT']);
    expect(s.describe()).toMatchObject({ symbol: 'ETHUSDT', quoteSymbol: 'USDCUSDT', mid: 'ETHUSDT / USDCUSDT', quoteMaxAgeS: 120 });
  });
  it('defaults: CEX_QUOTE_SYMBOL unset => USDCUSDT, CEX_QUOTE_MAX_AGE_S from env', () => {
    delete process.env.CEX_QUOTE_SYMBOL;
    process.env.CEX_QUOTE_MAX_AGE_S = '45';
    const s = new LivePriceSource();
    expect(s.quoteSymbol).toBe('USDCUSDT');
    expect(s.quoteMaxAgeS).toBe(45);
  });
  it('reuses the last good USDCUSDT within CEX_QUOTE_MAX_AGE_S, throws beyond it', async () => {
    const book: Record<string, [number, number] | Error> = { ETHUSDT: [3000, 3000], USDCUSDT: [1.001, 1.001] };
    const f = fakeBinance(book);
    let now = 1_000_000;
    const s = new LivePriceSource({ quoteSymbol: 'USDCUSDT', quoteMaxAgeS: 120, fetch: f.fetch, now: () => now });
    expect(await s.midAt(0)).toBeCloseTo(3000 / 1.001, 9);
    book.USDCUSDT = new Error('down');
    book.ETHUSDT = [3030, 3030];
    now += 120_000; // exactly at max age: still reused
    expect(await s.midAt(0)).toBeCloseTo(3030 / 1.001, 9);
    now += 1_000; // beyond: never post an uncorrected mid
    await expect(s.midAt(0)).rejects.toThrow(/USDCUSDT quote unavailable \(cached value 121s old, max 120s\)/);
    book.USDCUSDT = [1.0, 1.0]; // recovers
    expect(await s.midAt(0)).toBe(3030);
  });
  it('throws when USDCUSDT has never been fetched', async () => {
    const f = fakeBinance({ ETHUSDT: [3000, 3000] });
    const s = new LivePriceSource({ quoteSymbol: 'USDCUSDT', fetch: f.fetch });
    await expect(s.midAt(0)).rejects.toThrow(/USDCUSDT quote unavailable \(no cached value/);
  });
  it('CEX_QUOTE_SYMBOL="" opts out: ETHUSDT only, no quote fetch', async () => {
    process.env.CEX_QUOTE_SYMBOL = '';
    const f = fakeBinance({ ETHUSDT: [2999, 3001] });
    const s = new LivePriceSource({ fetch: f.fetch });
    expect(await s.midAt(0)).toBe(3000);
    expect(f.calls).toHaveLength(1);
    expect(s.describe()).toMatchObject({ quoteSymbol: null, mid: 'ETHUSDT (uncorrected)' });
  });
});

live('replay source (live Binance)', () => {
  it('resolves a volatile recent window', async () => {
    Object.assign(process.env, { REPLAY_BLOCKS: '30', REPLAY_STEP: '2', REPLAY_LOOKBACK_H: '6' });
    const s = (await ReplayPriceSource.create(replayConfigFromEnv())) as ReplayPriceSource;
    expect(s.path.length).toBe(31);
    expect(s.path.every((p) => p > 100)).toBe(true);
  });
});
