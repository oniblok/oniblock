import { afterEach, describe, expect, it } from 'vitest';
import type { Kline } from '../src/cex.js';
import { computeFeatures, computeKlineMidFeatures, type MidObs } from '../src/features.js';
import { fetchKlineMids, KlineMids, KLINE_LOOKBACK_S, klineMidFeaturesNeeded } from '../src/klinemids.js';
import { midToPriceX96 } from '../src/price.js';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

/**
 * Synthetic series, identical to the numpy reference (common.py Mids.eth_usdt / usdc_usdt / mid / vol_bps and
 * build_v2.py keeper_features, copied verbatim) that produced the expected values below:
 *   ETHUSDT 1s opens t in [T-1452, T], close = 3000 + 5 sin(t/37) + 0.01 (t mod 7); holes at t mod 11 == 0 and a
 *   7 s hole [T-905, T-899] (so mid(T-900) is NaN at t_obs = T: > 5 s since the last kline).
 *   USDCUSDT 1m opens on minute boundaries in [T-1632, T], close = 1.0001 + 0.0002 sin(t/600).
 */
const T = 1_780_000_000;
const k = (tS: number, close: number): Kline => ({ openTime: tS * 1000, open: close, high: close, low: close, close, volume: 1, closeTime: tS * 1000 + 999 });
const eth: Kline[] = [];
for (let t = T - 1452; t <= T; t++) if (t % 11 !== 0 && !(t >= T - 905 && t <= T - 899)) eth.push(k(t, 3000 + 5 * Math.sin(t / 37) + 0.01 * (t % 7)));
const usdc: Kline[] = [];
for (let t = T - 1452 - 180; t <= T; t++) if (t % 60 === 0) usdc.push(k(t, 1.0001 + 0.0002 * Math.sin(t / 600)));
const km = new KlineMids(eth, usdc);
const pf = { gapPips: 3500, gapSign: 1, baseFee: 3000 };

describe('KlineMids = common.py Mids (numpy reference values)', () => {
  it('t_obs = T: realizedVolBps, vol5mBps, edgeSigma, ret12/36; ret900 = 0 (mid(T-900) NaN in the hole)', () => {
    expect(km.mid(T)).toBeCloseTo(3005.042803761354, 9);
    expect(km.mid(T - 900)).toBeNaN();
    const r = computeKlineMidFeatures(pf, km, T * 1000);
    expect(r.realizedVolBps).toBe(3.836);
    expect(r.mid).toEqual({ edgePips: 500, edgeSigma: 1.3034, vol5mBps: 3.917, ret12Bps: 2.148, ret36Bps: 10.6342, ret900Bps: 0 });
  });
  it('t_obs = T-3', () => {
    expect(km.mid(T - 3 - 900)).toBeCloseTo(3004.0908084852704, 9);
    const r = computeKlineMidFeatures(pf, km, (T - 3) * 1000);
    expect(r.realizedVolBps).toBe(3.83);
    expect(r.mid).toEqual({ edgePips: 500, edgeSigma: 1.3055, vol5mBps: 3.9467, ret12Bps: 2.7704, ret36Bps: 11.5235, ret900Bps: 2.899 });
  });
  it('at-or-before by open time, 5 s / 180 s tolerances, no-quote opt-out', () => {
    expect(km.ethUsdt(T - 1453)).toBeNaN(); // before the series
    const q = new KlineMids([k(100, 3000)], [k(0, 1.0005)]);
    expect(q.ethUsdt(105)).toBe(3000);
    expect(q.ethUsdt(106)).toBeNaN();
    expect(q.usdcUsdt(180)).toBe(1.0005);
    expect(q.usdcUsdt(181)).toBeNaN();
    expect(q.mid(100)).toBeCloseTo(3000 / 1.0005, 9);
    expect(new KlineMids([k(100, 3000)]).mid(100)).toBe(3000);
  });
  it('sign: dir = baseIsToken0 ? -gapSign : +gapSign; gapSign 0 => 0 (no -0)', () => {
    const up = computeKlineMidFeatures(pf, km, T * 1000).mid.ret36Bps;
    expect(computeKlineMidFeatures({ ...pf, gapSign: -1 }, km, T * 1000).mid.ret36Bps).toBe(-up);
    expect(computeKlineMidFeatures(pf, km, T * 1000, { baseIsToken0: true }).mid.ret36Bps).toBe(-up);
    expect(Object.is(computeKlineMidFeatures({ ...pf, gapSign: 0 }, km, T * 1000).mid.ret12Bps, 0)).toBe(true);
  });
  it('too few klines for realizedVolBps => throws (the tick fails, no silent fallback)', () => {
    expect(() => computeKlineMidFeatures(pf, new KlineMids([k(T, 3000)]), T * 1000)).toThrow(/realizedVolBps/);
  });
});

describe('computeFeatures with klineMids', () => {
  const pool = midToPriceX96('3000', { baseIsToken0: false, decimals0: 6, decimals1: 18 });
  const oracle = midToPriceX96('3001.05', { baseIsToken0: false, decimals0: 6, decimals1: 18 });
  /** Per-tick history ~12 s apart ending at T; `jitterMs(i)` shifts each tick's read time. */
  const ticks = (jitterMs: (i: number) => number): MidObs[] =>
    [...Array(120).keys()].map((i) => {
      const t = (T - (119 - i) * 12) * 1000 + jitterMs(i);
      return { t, mid: 3000 + i };
    });
  const input = (h: MidObs[], tObsMs: number) => ({
    swaps: [],
    oracleX96: oracle,
    poolX96: pool,
    depth0: 10n ** 21n,
    recentMids: h.map((x) => x.mid),
    midHistory: h,
    tObsMs,
    currentBlock: 10,
    lastAttestBlock: 9,
    baseFee: 3000,
    klineMids: km,
  });
  it('jittered tick times give exactly the features of exact tick times (klines, not the history)', () => {
    const exact = computeFeatures(input(ticks(() => 0), T * 1000));
    const jitter = computeFeatures(input(ticks((i) => (i % 2 ? 300 : -300)), T * 1000 + 250));
    expect(jitter).toEqual(exact);
    const want = computeKlineMidFeatures({ gapPips: exact.gapPips, gapSign: exact.gapSign, baseFee: 3000 }, km, T * 1000);
    expect(exact.realizedVolBps).toBe(want.realizedVolBps);
    expect({ edgePips: exact.edgePips, edgeSigma: exact.edgeSigma, vol5mBps: exact.vol5mBps, ret12Bps: exact.ret12Bps, ret36Bps: exact.ret36Bps, ret900Bps: exact.ret900Bps }).toEqual(want.mid);
  });
  it('without klineMids the per-tick path is unchanged (v1 / Jev), and jitter does move it', () => {
    const { klineMids: _k, ...noKline } = input(ticks(() => 0), T * 1000);
    const exact = computeFeatures(noKline);
    const { klineMids: _k2, ...noKlineJ } = input(ticks((i) => (i % 2 ? 300 : -300)), T * 1000 - 300);
    expect(computeFeatures(noKlineJ).ret12Bps).not.toBe(exact.ret12Bps); // the bug the kline path fixes
    expect(exact.realizedVolBps).not.toBe(computeFeatures(input(ticks(() => 0), T * 1000)).realizedVolBps);
  });
});

describe('fetchKlineMids (offline, mocked Binance)', () => {
  it('fetches ETHUSDT 1s over [t - 1452, t] in two parallel pages + USDCUSDT 1m, and rebuilds the same mids', async () => {
    const calls: URL[] = [];
    const fetchImpl = (async (url: string) => {
      const u = new URL(url);
      calls.push(u);
      const src = u.searchParams.get('symbol') === 'USDCUSDT' ? usdc : eth;
      const lo = Number(u.searchParams.get('startTime'));
      const hi = Number(u.searchParams.get('endTime'));
      const rows = src.filter((x) => x.openTime >= lo && x.openTime <= hi).map((x) => [x.openTime, '0', '0', '0', String(x.close), '1', x.closeTime]);
      return new Response(JSON.stringify(rows), { status: 200 });
    }) as unknown as typeof fetch;
    const got = await fetchKlineMids(T, { symbol: 'ETHUSDT', quoteSymbol: 'USDCUSDT', fetch: { hosts: ['https://fake'], retries: 0, fetchImpl } });
    const eths = calls.filter((u) => u.searchParams.get('symbol') === 'ETHUSDT');
    expect(eths).toHaveLength(2);
    expect(Math.min(...eths.map((u) => Number(u.searchParams.get('startTime'))))).toBe((T - KLINE_LOOKBACK_S) * 1000);
    expect(Math.max(...eths.map((u) => Number(u.searchParams.get('endTime'))))).toBe(T * 1000 + 999); // endTime inclusive: the kline opening at t
    expect(calls.filter((u) => u.searchParams.get('symbol') === 'USDCUSDT' && u.searchParams.get('interval') === '1m')).toHaveLength(1);
    expect(computeKlineMidFeatures(pf, got, T * 1000)).toEqual(computeKlineMidFeatures(pf, km, T * 1000));
  });
  it('a fetch error rejects', async () => {
    const fetchImpl = (async () => new Response('down', { status: 400 })) as unknown as typeof fetch;
    await expect(fetchKlineMids(T, { fetch: { hosts: ['https://fake'], retries: 0, fetchImpl } })).rejects.toThrow(/binance request failed/);
  });
});

describe('klineMidFeaturesNeeded', () => {
  it('only a Kev v2 state (KEV_STATE_FORMAT=kev2) with a live mid', () => {
    delete process.env.KEV_STATE_FORMAT; // default auto = the v1 adapter (today's oniblock1 weights): per-tick path
    expect(klineMidFeaturesNeeded('oniblock1', true)).toBe(false);
    expect(klineMidFeaturesNeeded('kev', true)).toBe(false);
    process.env.KEV_STATE_FORMAT = 'kev2';
    expect(klineMidFeaturesNeeded('oniblock1', true)).toBe(true);
    expect(klineMidFeaturesNeeded('kev', true)).toBe(true); // alias
    expect(klineMidFeaturesNeeded('oniblock1', false)).toBe(false); // replay / injected mids
    expect(klineMidFeaturesNeeded('auto', true)).toBe(false); // Jev never reads the kev2 lines
    delete process.env.KEV_STATE_FORMAT;
    expect(klineMidFeaturesNeeded('auto', true)).toBe(false);
    expect(klineMidFeaturesNeeded('jev', true)).toBe(false);
    expect(klineMidFeaturesNeeded('heuristic', true)).toBe(false);
  });
});
