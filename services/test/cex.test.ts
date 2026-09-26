import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { binanceGet, fetchKlines, fetchMid, midAt, realizedVolBps, type Kline } from '../src/cex.js';

const live = process.env.OFFLINE === '1' ? describe.skip : describe;

describe('cex helpers (offline)', () => {
  it('midAt forward-fills', () => {
    const ks = [0, 1000, 3000].map((t, i) => ({ openTime: t, close: 100 + i }) as Kline);
    expect(midAt(ks, -1)).toBeUndefined();
    expect(midAt(ks, 0)).toBe(100);
    expect(midAt(ks, 2500)).toBe(101);
    expect(midAt(ks, 99999)).toBe(102);
  });
  it('realized vol', () => {
    expect(realizedVolBps([100, 100, 100])).toBe(0);
    expect(realizedVolBps([100, 101, 100, 101])).toBeGreaterThan(50);
  });
  it('falls back to next host on non-retryable error', async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      if (url.startsWith('https://a')) return new Response('{"code":-1120,"msg":"Invalid interval."}', { status: 400 });
      return new Response('{"ok":1}', { status: 200 });
    }) as unknown as typeof fetch;
    const r = await binanceGet('/x', { hosts: ['https://a', 'https://b'], fetchImpl: fake, retries: 2 });
    expect(r.host).toBe('https://b');
    expect(calls).toEqual(['https://a/x', 'https://b/x']);
  });
  it('retries transient 5xx then succeeds', async () => {
    let n = 0;
    const fake = (async () => (++n < 3 ? new Response('busy', { status: 503 }) : new Response('[]', { status: 200 }))) as unknown as typeof fetch;
    const r = await binanceGet('/x', { hosts: ['https://a'], fetchImpl: fake, retries: 3 });
    expect(n).toBe(3);
    expect(r.data).toEqual([]);
  });
});

live('cex live (Binance public API; OFFLINE=1 to skip)', () => {
  it('fetches current ETHUSDT mid', async () => {
    const m = await fetchMid('ETHUSDT');
    expect(m.mid).toBeGreaterThan(100);
    expect(m.ask).toBeGreaterThanOrEqual(m.bid);
    console.log(`live mid ${m.mid} from ${m.host}`);
  });

  it('fetches a 10-minute 1s kline window with pagination + disk cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'klines-'));
    const end = Math.floor(Date.now() / 60_000) * 60_000 - 120_000;
    const start = end - 600_000;
    const ks = await fetchKlines({ interval: '1s', startMs: start, endMs: end, cacheDir: dir });
    expect(ks.length).toBeGreaterThan(300); // 600 buckets; empty seconds are skipped by Binance
    expect(ks.length).toBeLessThanOrEqual(600);
    expect(ks[0]!.openTime).toBeGreaterThanOrEqual(start);
    expect(ks[ks.length - 1]!.openTime).toBeLessThan(end);
    for (let i = 1; i < ks.length; i++) expect(ks[i]!.openTime).toBeGreaterThan(ks[i - 1]!.openTime);
    expect(readdirSync(dir).length).toBe(1);
    const again = await fetchKlines({ interval: '1s', startMs: start, endMs: end, cacheDir: dir });
    expect(again).toEqual(ks);
    console.log(`1s klines: ${ks.length}, vol ${realizedVolBps(ks.map((k) => k.close)).toFixed(3)} bps`);
  }, 60_000);

  it('fetches 1m klines across multiple pages', async () => {
    const end = Math.floor(Date.now() / 60_000) * 60_000 - 3_600_000;
    const start = end - 1500 * 60_000; // 1500 minutes -> 2 pages
    const ks = await fetchKlines({ interval: '1m', startMs: start, endMs: end, cacheDir: false });
    expect(ks.length).toBe(1500);
  }, 60_000);
});
