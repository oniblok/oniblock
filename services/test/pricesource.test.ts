import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePriceSource, mostVolatileStart, pingPong, ReplayPriceSource, replayConfigFromEnv } from '../src/pricesource.js';

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
      Object.assign(process.env, { CEX_CACHE_DIR: dir, PRICE_SOURCE: 'replay', REPLAY_START_MS: String(start), REPLAY_STEP: String(step), REPLAY_BLOCKS: String(blocks), REPLAY_ORIGIN_BLOCK: '100' });
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
  it('rejects unknown PRICE_SOURCE', async () => {
    await expect(makePriceSource(0, 'nope' as never)).rejects.toThrow(/live\|replay/);
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
