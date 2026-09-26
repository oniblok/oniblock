import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MidHistory } from '../src/cex.js';
import { canonicalFeatures, computeFeatures, computeMidFeatures, featuresToState, type Features, type MidObs } from '../src/features.js';
import { applyChargeThreshold, chargeThreshold, defaultModelName } from '../src/keeper.js';
import { kevState, score, type ModelScore } from '../src/model/index.js';
import { defaultTabularPath, loadTabularModel, predictTabular, scoreTabular, TABULAR_FEATURES, tabularInputs, TABULAR_V1_FEATURES } from '../src/model/tabular.js';
import { midToPriceX96 } from '../src/price.js';

const base: Features = { gapPips: 0, gapSign: 0, imbalance: 0, sizeToDepth: 0, realizedVolBps: 0, attestationAge: 1, nSwaps: 5, arbShare: 0, baseFee: 500 };
const T0 = 1_780_000_000_000; // t_obs (unix ms)
/** History of `mids` (oldest first) ending at T0, `stepS` seconds apart. */
const hist = (mids: number[], stepS = 12): MidObs[] => mids.map((mid, i) => ({ t: T0 - (mids.length - 1 - i) * stepS * 1000, mid }));
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const envSnap = { ...process.env };
afterEach(() => {
  for (const k of ['CHARGE_THRESHOLD', 'KEV_STATE_FORMAT', 'TABULAR_MODEL', 'TABULAR_MODEL_PATH', 'MODEL_MODE']) {
    if (envSnap[k] === undefined) delete process.env[k];
    else process.env[k] = envSnap[k];
  }
});

describe('kev2 state parity with ml/src/states.py features_to_state_kev2', () => {
  const path = resolve(__dirname, 'fixtures', 'kev2-state-parity.json');
  if (!existsSync(path)) {
    it.skip(`SKIPPED: ${path} not present yet (written by the Python side, ml/src/states.py)`, () => {});
    return;
  }
  const rows = JSON.parse(readFileSync(path, 'utf8')) as { features: Features; baseIsToken0: boolean; expected: string }[];
  it(`renders every fixture row byte-identically (${rows.length} rows)`, () => {
    expect(rows.length).toBeGreaterThanOrEqual(200);
    const bad = rows.map((r, i) => ({ i, got: featuresToState(r.features, { format: 'kev2', baseIsToken0: r.baseIsToken0 }), want: r.expected })).filter((x) => x.got !== x.want);
    expect(bad.slice(0, 3)).toEqual([]);
  });
});

describe('kev2 state format', () => {
  const f: Features = { ...base, gapPips: 812, gapSign: -1, imbalance: 0.25, realizedVolBps: 2.5, nSwaps: 7, arbShare: 0.5, sizeToDepth: 1e-4, edgePips: 312, edgeSigma: 1.248, vol5mBps: 3.14159, ret12Bps: 1.005, ret36Bps: -0.004, ret900Bps: 0 };
  it('= the 8 base-fee lines of format auto + exactly the 3 spec lines', () => {
    const st = featuresToState(f, { format: 'kev2', baseIsToken0: false });
    const lines = st.split('\n');
    expect(lines).toHaveLength(11);
    expect(lines.slice(0, 8).join('\n')).toBe(featuresToState(f, { baseIsToken0: false }));
    expect(lines.slice(8)).toEqual([
      'edge_in_volatility: arb edge at the base fee is +1.25 typical 12 s Binance moves.',
      'cex_volatility_5m: 3.14 bps per interval over the last 5 minutes.',
      'cex_trend: Binance moved +1.00 bps over 12 s, -0.00 bps over 36 s and +0.00 bps over 15 min in the arbitrage direction (positive = the gap is widening).',
    ]);
    expect(st.endsWith('\n')).toBe(false);
  });
  it('always uses the base-fee wording (k fields ignored)', () => {
    const withK = { ...f, kBps: 4000, arbFeePips: 900, arbThresholdPips: 300 };
    expect(featuresToState(withK, { format: 'kev2', baseIsToken0: false })).toBe(featuresToState(f, { format: 'kev2', baseIsToken0: false }));
    expect(featuresToState(withK, { baseIsToken0: false })).toContain('and swaps toward the Binance mid pay'); // auto unchanged
  });
  it('missing v2 fields read as 0 (edge from gap/baseFee/vol)', () => {
    const lines = featuresToState({ ...base, gapPips: 700, realizedVolBps: 0 }, { format: 'kev2' }).split('\n').slice(8);
    expect(lines[0]).toBe('edge_in_volatility: arb edge at the base fee is +200.00 typical 12 s Binance moves.');
    expect(lines[1]).toBe('cex_volatility_5m: 0.00 bps per interval over the last 5 minutes.');
    expect(lines[2]).toContain('moved +0.00 bps over 12 s, +0.00 bps over 36 s and +0.00 bps over 15 min');
  });
});

describe('v2 mid features (computeMidFeatures)', () => {
  const pf = { gapPips: 900, gapSign: 1, baseFee: 500, realizedVolBps: 2 };
  it('edgePips = gap - baseFee (integer), edgeSigma = edge / max(vol * 100, 1) at 4 dp', () => {
    const m = computeMidFeatures(pf, hist([3000]));
    expect(m.edgePips).toBe(400);
    expect(m.edgeSigma).toBe(2); // 400 / 200
    expect(computeMidFeatures({ ...pf, gapPips: 300, realizedVolBps: 0 }, []).edgeSigma).toBe(-200); // floor 1 pip
    expect(computeMidFeatures({ ...pf, gapPips: 500, realizedVolBps: 0.003 }, []).edgeSigma).toBe(0);
    expect(computeMidFeatures({ ...pf, gapPips: 601, realizedVolBps: 3 }, []).edgeSigma).toBe(0.3367); // 101/300 rounded
  });
  it('ret sign: + = Binance moved away from the pool price; dir = baseIsToken0 ? -gapSign : +gapSign; gapSign 0 -> 0', () => {
    const h = hist([3000, 3003]); // mid rose 10 bps over 12 s
    const up = r4(Math.log(3003 / 3000) * 1e4);
    expect(computeMidFeatures({ ...pf, gapSign: 1 }, h, { baseIsToken0: false }).ret12Bps).toBe(up);
    expect(computeMidFeatures({ ...pf, gapSign: -1 }, h, { baseIsToken0: false }).ret12Bps).toBe(-up);
    expect(computeMidFeatures({ ...pf, gapSign: -1 }, h, { baseIsToken0: true }).ret12Bps).toBe(up);
    expect(computeMidFeatures({ ...pf, gapSign: 1 }, h, { baseIsToken0: true }).ret12Bps).toBe(-up);
    expect(computeMidFeatures({ ...pf, gapSign: 0 }, h).ret12Bps).toBe(0);
    expect(computeMidFeatures({ ...pf, gapSign: 1 }, h).ret12Bps).toBe(up); // undefined orientation = training (false)
  });
  it('mid(t_obs - h) = nearest entry at-or-before (forward fill); entries after t_obs ignored', () => {
    // entries at T0-40s, -30s, -20s, -10s, T0 (10 s spacing) and one after T0
    const h: MidObs[] = [...hist([100, 101, 102, 103, 104], 10), { t: T0 + 5000, mid: 999 }];
    const m = computeMidFeatures(pf, h, { tObsMs: T0 });
    expect(m.ret12Bps).toBe(r4(Math.log(104 / 102) * 1e4)); // T0-12s -> the entry at T0-20s
    expect(m.ret36Bps).toBe(r4(Math.log(104 / 100) * 1e4)); // T0-36s -> T0-40s
    // exactly on an entry counts as at-or-before
    expect(computeMidFeatures(pf, hist([100, 101]), { tObsMs: T0 }).ret12Bps).toBe(r4(Math.log(101 / 100) * 1e4));
  });
  it('history too short -> 0 (per horizon); empty history -> all 0', () => {
    const h = hist(Array.from({ length: 10 }, (_, i) => 3000 + i)); // 108 s of history
    const m = computeMidFeatures(pf, h);
    expect(m.ret12Bps).not.toBe(0);
    expect(m.ret36Bps).not.toBe(0);
    expect(m.ret900Bps).toBe(0);
    expect(computeMidFeatures(pf, [])).toMatchObject({ vol5mBps: 0, ret12Bps: 0, ret36Bps: 0, ret900Bps: 0 });
    expect(computeMidFeatures(pf, hist([3000])).vol5mBps).toBe(0);
  });
  it('vol5mBps: 25 mids 12 s apart ending at t_obs, stdev ddof=1 of log returns x 1e4', () => {
    const mids = Array.from({ length: 40 }, (_, i) => 3000 * Math.exp(((i * 7919) % 13) * 1e-4 - 6e-4 + i * 1e-5));
    const used = mids.slice(-25);
    const r = used.slice(1).map((m, i) => Math.log(m / used[i]!));
    const mean = r.reduce((a, b) => a + b, 0) / r.length;
    const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1)) * 1e4;
    expect(computeMidFeatures(pf, hist(mids)).vol5mBps).toBe(r4(sd));
    // denser history (every 3 s, same values on the 12 s grid): only the grid points are sampled
    const dense: MidObs[] = [];
    for (const o of hist(mids)) dense.push({ t: o.t - 9000, mid: 1 }, { t: o.t - 6000, mid: 5000 }, { t: o.t - 3000, mid: 2 }, o);
    expect(computeMidFeatures(pf, dense).vol5mBps).toBe(r4(sd));
  });
  it('vol5mBps ddof=1 by hand: [100, 101, 100] -> ln(1.01) * sqrt(2) * 1e4 (samples before the history are dropped)', () => {
    expect(computeMidFeatures(pf, hist([100, 101, 100])).vol5mBps).toBe(r4(Math.log(1.01) * Math.SQRT2 * 1e4));
  });
  it('MidHistory.entries() is the time-stamped buffer (a copy)', () => {
    const h = new MidHistory(3);
    for (let i = 0; i < 5; i++) h.push(3000 + i, T0 + i * 12_000);
    expect(h.entries()).toEqual([{ t: T0 + 24_000, mid: 3002 }, { t: T0 + 36_000, mid: 3003 }, { t: T0 + 48_000, mid: 3004 }]);
    h.entries()[0]!.mid = 0;
    expect(h.mids()).toEqual([3002, 3003, 3004]);
  });
});

describe('computeFeatures with a mid history', () => {
  const X96 = 2n ** 96n;
  const input = { swaps: [], oracleX96: X96, poolX96: (X96 * 10_080n) / 10_000n, depth0: 10n ** 18n, recentMids: [3000, 3001, 2999], currentBlock: 100, lastAttestBlock: 99, baseFee: 500 };
  it('old callers (no midHistory) get exactly the old keys', () => {
    expect(Object.keys(computeFeatures(input)).sort()).toEqual(['arbShare', 'attestationAge', 'baseFee', 'gapPips', 'gapSign', 'imbalance', 'nSwaps', 'realizedVolBps', 'sizeToDepth']);
  });
  it('adds the v2 fields from the same rounded realizedVolBps', () => {
    const f = computeFeatures({ ...input, midHistory: hist([3000, 3001, 2999]), tObsMs: T0 });
    expect(f.edgePips).toBe(f.gapPips - 500);
    expect(f.edgeSigma).toBe(r4(f.edgePips! / Math.max(f.realizedVolBps * 100, 1)));
    expect(f.gapSign).toBe(1);
    expect(f.ret12Bps).toBe(r4(Math.log(2999 / 3001) * 1e4)); // baseIsToken0 undefined = training orientation: dir = +gapSign
  });
  it('ret > 0 when Binance moves away from the pool, in both token orders', () => {
    for (const baseIsToken0 of [true, false]) {
      const meta = baseIsToken0 ? { decimals0: 18, decimals1: 6, baseIsToken0 } : { decimals0: 6, decimals1: 18, baseIsToken0 };
      // pool prices ETH at 3000, Binance went 3010 -> 3020: the pool is ever cheaper, the gap widens
      const f = computeFeatures({
        ...input, baseIsToken0, poolX96: midToPriceX96(3000, meta), oracleX96: midToPriceX96(3020, meta),
        midHistory: hist([3010, 3020]), tObsMs: T0,
      });
      expect(f.gapSign).toBe(baseIsToken0 ? -1 : 1);
      expect(f.ret12Bps).toBe(r4(Math.log(3020 / 3010) * 1e4));
      expect(f.ret12Bps).toBeGreaterThan(0);
      // and < 0 when Binance moves back toward the pool
      expect(computeFeatures({ ...input, baseIsToken0, poolX96: midToPriceX96(3000, meta), oracleX96: midToPriceX96(3020, meta), midHistory: hist([3030, 3020]) }).ret12Bps).toBeLessThan(0);
    }
  });
});

describe('orientation: Kev and tabular inputs are canonicalised to the training pools (USDC token0, WETH token1)', () => {
  const f: Features = { ...base, gapPips: 812, gapSign: 1, imbalance: -0.375, realizedVolBps: 2.5, nSwaps: 7, arbShare: 0.5, sizeToDepth: 1e-4, edgePips: 312, edgeSigma: 1.248, vol5mBps: 3.1, ret12Bps: 1.2, ret36Bps: -0.4, ret900Bps: 7 };
  const mirrored: Features = { ...f, gapSign: -1, imbalance: 0.375 };
  it('an ETH = token0 pool renders the same Kev state as the mirrored ETH = token1 pool (auto and kev2)', () => {
    for (const fmt of ['auto', 'kev2'] as const) {
      expect(kevState(f, true, fmt)).toBe(kevState(mirrored, false, fmt));
      expect(kevState(f, true, fmt)).toBe(featuresToState(mirrored, { baseIsToken0: false, ...(fmt === 'kev2' ? { format: 'kev2' as const } : {}) }));
      expect(kevState(f, true, fmt)).toContain('token1 (ETH)');
    }
    expect(kevState(f, true)).not.toBe(featuresToState(f, { baseIsToken0: true })); // Jev's own text is untouched
  });
  it('KEV_STATE_FORMAT selects the Kev text (auto default, kev2)', () => {
    delete process.env.KEV_STATE_FORMAT;
    expect(kevState(f, false).split('\n')).toHaveLength(8);
    process.env.KEV_STATE_FORMAT = 'kev2';
    expect(kevState(f, false).split('\n')).toHaveLength(11);
    expect(kevState(f, false)).toBe(featuresToState(f, { format: 'kev2', baseIsToken0: false }));
  });
  it('tabular inputs (v1 and v2 names) equal those of the mirrored pool; sgap = canonical gapSign * gapPips', () => {
    const v2 = [...TABULAR_V1_FEATURES, 'edgeSigma', 'vol5mBps', 'ret12Bps', 'ret36Bps', 'ret900Bps', 'sgap'];
    expect(tabularInputs(canonicalFeatures(f, true), v2)).toEqual(tabularInputs(mirrored, v2));
    expect(tabularInputs(canonicalFeatures(f, true), v2).at(-1)).toBe(-812);
    expect(tabularInputs(canonicalFeatures(f, false), v2).at(-1)).toBe(812);
    expect(canonicalFeatures(f, false)).toBe(f);
    expect(canonicalFeatures({ ...f, gapSign: 0, imbalance: 0 }, true)).toMatchObject({ gapSign: 0, imbalance: 0 });
  });
});

describe('tabular v2 (generic JSON feature list)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tabv2-'));
  const write = (name: string, m: object) => {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(m));
    return p;
  };
  it('loads any feature order from the JSON and evaluates by name; reads the charge threshold', () => {
    const p = write('m.json', {
      version: 2, name: 'tabular-v2', model: 'lightgbm', features: ['sgap', 'ret900Bps', 'gapPips'], chargeThreshold: 0.61,
      trees: [{ f: 0, t: 0, l: { v: -1 }, r: { f: 1, t: 5, l: { v: 0.5 }, r: { v: 2 } } }],
    });
    const m = loadTabularModel(p)!;
    expect(m.chargeThreshold).toBe(0.61);
    const f = { ...base, gapPips: 900, gapSign: 1 };
    expect(predictTabular(m, { ...f, gapSign: -1 })).toBeCloseTo(1 / (1 + Math.exp(1)), 12);
    expect(predictTabular(m, { ...f, ret900Bps: 3 })).toBeCloseTo(1 / (1 + Math.exp(-0.5)), 12);
    expect(predictTabular(m, { ...f, ret900Bps: 6 })).toBeCloseTo(1 / (1 + Math.exp(-2)), 12);
    expect(scoreTabular(f, m)).toMatchObject({ confidenceBps: 10_000, model: 'tabular' });
  });
  it('charge threshold keys: chargeThreshold and charge_threshold only (a generic `threshold` is ignored)', () => {
    const tree = { features: ['gapPips'], trees: [{ v: 0 }], version: 2 };
    expect(loadTabularModel(write('ct1.json', { ...tree, name: 'a', charge_threshold: 0.7 }))!.chargeThreshold).toBe(0.7);
    expect(loadTabularModel(write('ct2.json', { ...tree, name: 'b', threshold: 0.7 }))!.chargeThreshold).toBeUndefined();
  });
  it('rejects unknown feature names', () => {
    const p = write('bad.json', { version: 2, name: 'x', features: ['gapPips', 'mystery'], trees: [] });
    expect(() => loadTabularModel(p)).toThrow(/unknown features mystery/);
  });
  it('every v2 name from the spec is known', () => {
    for (const n of ['edgeSigma', 'vol5mBps', 'ret12Bps', 'ret36Bps', 'ret900Bps', 'sgap', ...TABULAR_V1_FEATURES]) expect(n in TABULAR_FEATURES).toBe(true);
  });
  it('TABULAR_MODEL=v2 selects the v2 file and the tabular-v2 node; default v1', () => {
    delete process.env.TABULAR_MODEL;
    expect(defaultModelName('tabular')).toBe('tabular-v1.models.oniblock.eth');
    expect(defaultTabularPath()).toMatch(/services\/models\/tabular-v1\.json$/);
    process.env.TABULAR_MODEL = 'v2';
    expect(defaultModelName('tabular')).toBe('tabular-v2.models.oniblock.eth');
    expect(defaultTabularPath()).toMatch(/models\/tabular-v2\.json$/);
  });
  const v2 = defaultTabularPath('v2');
  it.skipIf(!existsSync(v2))(`the exported tabular-v2 model loads and scores (${existsSync(v2) ? v2 : 'SKIPPED: ml/models/tabular-v2.json not present yet'})`, async () => {
    const m = loadTabularModel(v2)!;
    expect(m.trees.length).toBeGreaterThan(0);
    const p = predictTabular(m, { ...base, gapPips: 900, gapSign: 1, edgePips: 400, edgeSigma: 2, vol5mBps: 2, ret12Bps: 1, ret36Bps: 2, ret900Bps: 3 });
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
    process.env.TABULAR_MODEL = 'v2';
    expect((await score({ ...base, gapPips: 900 }, { mode: 'tabular' })).model).toBe('tabular');
  });
});

describe('oniblock1 (the production tree model)', () => {
  const path = defaultTabularPath('oniblock1');
  const f = { ...base, gapPips: 900, gapSign: 1, nSwaps: 15, arbShare: 0.7, realizedVolBps: 2, sizeToDepth: 3e-5, edgeSigma: 2, vol5mBps: 2, ret12Bps: 1, ret36Bps: 2, ret900Bps: 3 };
  it('MODEL_MODE=oniblock1 or TABULAR_MODEL=oniblock1 selects the oniblock1 file and node', () => {
    delete process.env.TABULAR_MODEL;
    expect(path).toMatch(/ml\/models\/oniblock1\.json$/);
    expect(defaultModelName('oniblock1')).toBe('oniblock1.models.oniblock.eth');
    process.env.MODEL_MODE = 'oniblock1';
    expect(defaultTabularPath()).toBe(path);
    delete process.env.MODEL_MODE;
    process.env.TABULAR_MODEL = 'oniblock1';
    expect(defaultModelName('tabular')).toBe('oniblock1.models.oniblock.eth');
    expect(defaultTabularPath()).toBe(path);
  });
  it('the file names itself oniblock1 and carries the charge threshold', () => {
    const m = loadTabularModel(path)! as ReturnType<typeof loadTabularModel> & { name: string; node: string };
    expect(m.name).toBe('oniblock1');
    expect(m.node).toBe('oniblock1.models.oniblock.eth');
    expect(m.chargeThreshold).toBeCloseTo(0.8224, 4);
    expect(m.trees.length).toBeGreaterThan(0);
  });
  it('score() with mode oniblock1 uses the oniblock1 trees (TABULAR_MODEL unset)', async () => {
    delete process.env.TABULAR_MODEL;
    const want = Math.round(predictTabular(loadTabularModel(path)!, f) * 10_000);
    const s = await score(f, { mode: 'oniblock1', baseIsToken0: false });
    expect(s.model).toBe('tabular');
    expect(s.pToxicBps).toBe(want);
    expect(want).not.toBe((await score(f, { mode: 'tabular', baseIsToken0: false })).pToxicBps); // default tabular = v1
  });
});

describe('CHARGE_THRESHOLD gate (keeper)', () => {
  const s = (pToxicBps: number, confidenceBps = 3000): ModelScore => ({ pToxicBps, confidenceBps, pJitBps: 0, cls: 'unknown', latencyMs: 1, model: 'tabular' });
  it('unset / empty = off: the score is returned unchanged', () => {
    delete process.env.CHARGE_THRESHOLD;
    expect(chargeThreshold()).toBeUndefined();
    expect(chargeThreshold('')).toBeUndefined();
    const x = s(7000);
    expect(applyChargeThreshold(x, chargeThreshold())).toBe(x);
  });
  it('below t -> confidence 0, at/above t -> 10000; pToxic unchanged', () => {
    process.env.CHARGE_THRESHOLD = '0.07';
    const t = chargeThreshold()!;
    expect(t).toBe(0.07);
    expect(applyChargeThreshold(s(699), t)).toMatchObject({ pToxicBps: 699, confidenceBps: 0 });
    expect(applyChargeThreshold(s(700), t)).toMatchObject({ pToxicBps: 700, confidenceBps: 10_000 }); // p == t charges
    expect(applyChargeThreshold(s(9500, 9500), t)).toMatchObject({ pToxicBps: 9500, confidenceBps: 10_000 });
    expect(applyChargeThreshold(s(0), 0)).toMatchObject({ confidenceBps: 10_000 });
    expect(applyChargeThreshold(s(10_000), 1)).toMatchObject({ confidenceBps: 10_000 });
    expect(applyChargeThreshold(s(9999), 1)).toMatchObject({ confidenceBps: 0 });
    // the hook's k = kMax * p * c: 0 below t, kMax * p at/above (monotonic above the threshold)
    const k = (x: ModelScore) => (8000 * x.pToxicBps * x.confidenceBps) / 1e8;
    expect(k(applyChargeThreshold(s(6000), 0.6))).toBe(4800);
    expect(k(applyChargeThreshold(s(5999), 0.6))).toBe(0);
  });
  it('invalid values are a config error', () => {
    for (const bad of ['x', '-0.1', '1.5', 'NaN']) expect(() => chargeThreshold(bad)).toThrow(/CHARGE_THRESHOLD/);
  });
});
