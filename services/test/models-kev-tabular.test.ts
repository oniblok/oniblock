import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeFeatures, featuresToState, type Features } from '../src/features.js';
import { kevState, kevStateFormat, score } from '../src/model/index.js';
import { KEV_MODEL_NAME, KEV_QUESTIONS, kevThresholdPath, loadKevThreshold, parseKev, scoreWithKev } from '../src/model/kev.js';
import { defaultTabularPath, loadTabularModel, predictTabular, scoreTabular, tabularInputs } from '../src/model/tabular.js';
import { assertModelMode, ConfigError, defaultModelName, kevFallbackThreshold, resolveChargeThreshold } from '../src/keeper.js';

const base: Features = { gapPips: 0, gapSign: 0, imbalance: 0, sizeToDepth: 0, realizedVolBps: 0, attestationAge: 1, nSwaps: 5, arbShare: 0, baseFee: 500 };
const REPO = resolve(__dirname, '..', '..');
const KEV_ENV = ['KEV_URL', 'KEV_STATE_FORMAT', 'KEV_THRESHOLD_FILE', 'MODEL_MODE', 'KEV_MODEL'];
const envSnap = Object.fromEntries(KEV_ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEV_ENV) {
    if (envSnap[k] === undefined) delete process.env[k];
    else process.env[k] = envSnap[k];
  }
});

/** Stub fetch recording every request's URL and body; answers noul = p. */
function stubKev(p = 0.7) {
  const calls: { url: string; body: any }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: string, init: RequestInit) => {
    calls.push({ url: String(u), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ answers: { informed: { type: 'noul', noul: p } } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = realFetch) };
}

describe('teacher-lightgbm (benchmark/teacher only; LightGBM JSON, pure TS)', () => {
  const m = loadTabularModel(defaultTabularPath())!;
  it('loads the exported teacher', () => {
    expect(m).not.toBeNull();
    expect(m.name).toBe('teacher-lightgbm');
    expect(m.features).toHaveLength(17);
    expect(m.trees.length).toBeGreaterThan(10);
  });
  it('matches the Python evaluator on real rows (ml/src/teacher_lightgbm_parity_fixture.py) to 1e-9', () => {
    const fx = JSON.parse(readFileSync(resolve(__dirname, 'fixtures', 'teacher-lightgbm-parity.json'), 'utf8')) as {
      model: string; inputs: string[]; rows: { features: Features; x: number[]; p: number }[];
    };
    expect(fx.model).toBe(m.name);
    expect(fx.inputs).toEqual(m.features);
    expect(fx.rows.length).toBe(100);
    for (const { features, x, p } of fx.rows) {
      const tx = tabularInputs(features, m.features);
      tx.forEach((v, i) => expect(Math.abs(v - x[i]!)).toBeLessThanOrEqual(1e-9));
      expect(Math.abs(predictTabular(m, features) - p)).toBeLessThanOrEqual(1e-9);
    }
    // the fixture covers both sides of the teacher's charge threshold
    expect(fx.rows.some((r) => r.p >= m.chargeThreshold!)).toBe(true);
    expect(fx.rows.some((r) => r.p < m.chargeThreshold!)).toBe(true);
  });
  it('the orientation-free inputs are unchanged when gapSign and imbalance flip together (sgap and the returns are not)', () => {
    const f = { ...base, gapPips: 700, gapSign: 1, imbalance: -0.4, nSwaps: 12, arbShare: 0.6, realizedVolBps: 2, sizeToDepth: 3e-5 };
    const free = m.features.filter((n) => n !== 'sgap');
    expect(tabularInputs(f, free)).toEqual(tabularInputs({ ...f, gapSign: -1, imbalance: 0.4 }, free));
  });
  it('is k-free (the base fee is the cost, as in training), has confidence 1, and rises with the edge', () => {
    const f = { ...base, gapPips: 900, gapSign: 1, nSwaps: 15, arbShare: 0.7, realizedVolBps: 2, sizeToDepth: 3e-5 };
    expect(tabularInputs({ ...f, arbFeePips: 800, kBps: 4000 }, m.features)).toEqual(tabularInputs(f, m.features));
    expect(tabularInputs(f, ['edgePips'])[0]).toBe(400);
    expect(scoreTabular({ ...f, arbFeePips: 800, kBps: 4000 })).toMatchObject({ pToxicBps: scoreTabular(f)!.pToxicBps, confidenceBps: 10_000 });
    const lo = scoreTabular({ ...f, gapPips: 50 })!;
    const hi = scoreTabular({ ...f, gapPips: 2500 })!;
    expect(hi.model).toBe('tabular');
    expect(hi.pJitBps).toBe(0);
    expect(hi.pToxicBps).toBeGreaterThan(lo.pToxicBps);
  });
});

describe('oniblock1 = the Kev System One model (MODEL_MODE=oniblock1, alias kev)', () => {
  it('score() routes MODEL_MODE=oniblock1 (opts or env) and kev to the Kev client at the default KEV_URL', async () => {
    delete process.env.KEV_URL;
    const k = stubKev(0.7);
    try {
      const f = { ...base, gapPips: 900, gapSign: 1 };
      expect(await score(f, { mode: 'oniblock1', baseIsToken0: false })).toMatchObject({ model: 'kev', pToxicBps: 7000, confidenceBps: 10_000 });
      expect(await score(f, { mode: 'kev', baseIsToken0: false })).toMatchObject({ model: 'kev', pToxicBps: 7000 });
      process.env.MODEL_MODE = 'oniblock1';
      expect((await score(f, { baseIsToken0: false })).model).toBe('kev');
      expect(k.calls).toHaveLength(3);
      for (const c of k.calls) {
        expect(c.url).toBe('http://127.0.0.1:8008/v1/systemone');
        expect(c.body).toMatchObject({ model: 'kev-latest', questions: KEV_QUESTIONS });
        expect(c.body.state).toBe(kevState(f, false));
      }
      process.env.KEV_URL = 'http://kev.example:9000/v1/systemone';
      await score(f, { mode: 'oniblock1' });
      expect(k.calls.at(-1)!.url).toBe('http://kev.example:9000/v1/systemone');
    } finally {
      k.restore();
    }
  });
  it('KEV_STATE_FORMAT defaults to auto (the v1 adapter: 8 base-fee lines); kev2 sends the 11-line v2 text', async () => {
    const f = { ...base, gapPips: 812, gapSign: 1, realizedVolBps: 2.5, edgePips: 312, edgeSigma: 1.2, vol5mBps: 3, ret12Bps: 1, ret36Bps: -0.4, ret900Bps: 7 };
    const k = stubKev(0.4);
    try {
      for (const v of [undefined, '', 'auto', 'v1']) {
        if (v === undefined) delete process.env.KEV_STATE_FORMAT;
        else process.env.KEV_STATE_FORMAT = v;
        expect(kevStateFormat()).toBe('auto');
      }
      delete process.env.KEV_STATE_FORMAT;
      await score(f, { mode: 'oniblock1', baseIsToken0: false });
      expect(k.calls.at(-1)!.body.state.split('\n')).toHaveLength(8);
      process.env.KEV_STATE_FORMAT = 'kev2';
      expect(kevStateFormat()).toBe('kev2');
      await score(f, { mode: 'oniblock1', baseIsToken0: false });
      expect(k.calls.at(-1)!.body.state).toBe(featuresToState(f, { format: 'kev2', baseIsToken0: false }));
      expect(k.calls.at(-1)!.body.state.split('\n')).toHaveLength(11);
    } finally {
      k.restore();
    }
  });
  it('posts under oniblock1.models.oniblock.eth (kev too; kev-v1 / kev4b-v1 are gone); auto stays jev-v1', () => {
    expect(KEV_MODEL_NAME).toBe('oniblock1.models.oniblock.eth');
    expect(defaultModelName('oniblock1')).toBe('oniblock1.models.oniblock.eth');
    expect(defaultModelName('kev')).toBe('oniblock1.models.oniblock.eth');
    process.env.KEV_MODEL = '4b';
    expect(defaultModelName('kev')).toBe('oniblock1.models.oniblock.eth');
    expect(defaultModelName('auto')).toBe('jev-v1.models.oniblock.eth');
  });
  it('MODEL_MODE=tabular (LightGBM) is a startup ConfigError; the Kev modes, Jev and heuristic are accepted', () => {
    expect(() => assertModelMode('tabular')).toThrow(ConfigError);
    expect(() => assertModelMode('tabular')).toThrow(/no longer a production model/);
    expect(() => assertModelMode('lightgbm')).toThrow(ConfigError);
    for (const m of ['oniblock1', 'kev', 'auto', 'jev', 'heuristic']) expect(assertModelMode(m)).toBe(m);
    expect(assertModelMode(undefined)).toBe('auto');
    expect(assertModelMode('')).toBe('auto');
  });
  it('the served adapter is the one ENS names: sha256 of ml/models/kev08b-v1/SHA256 = the EnsSetup default model-hash', () => {
    const h = createHash('sha256').update(readFileSync(join(REPO, 'ml', 'models', 'kev08b-v1', 'SHA256'))).digest('hex');
    expect(`0x${h}`).toBe('0x24f0793d55e0fde516ebe4da1d187e0468a5f7c830ba9a9f4d48e43f007c88be');
    expect(readFileSync(join(REPO, 'contracts', 'script', 'EnsSetup.s.sol'), 'utf8')).toContain(`0x${h}`);
    expect(readFileSync(join(REPO, 'ml', 'serve', 'start-kev.sh'), 'utf8')).toContain('models/kev08b-v1/adapter');
  });
});

describe('CHARGE_THRESHOLD=auto fallback: the Kev adapter charge_threshold.json', () => {
  it('default KEV_THRESHOLD_FILE = ml/models/kev08b-v1/charge_threshold.json (0.8175, auto state format)', () => {
    delete process.env.KEV_THRESHOLD_FILE;
    expect(kevThresholdPath()).toBe(join(REPO, 'ml', 'models', 'kev08b-v1', 'charge_threshold.json'));
    expect(loadKevThreshold()).toMatchObject({ chargeThreshold: 0.8175, stateFormat: 'auto' });
    expect(kevFallbackThreshold('kev')).toBe(0.8175);
    // only a Kev answer uses it: other models have no threshold on Kev's p scale
    for (const m of ['jev', 'heuristic', 'rule', 'tabular'] as const) expect(kevFallbackThreshold(m)).toBeUndefined();
  });
  it('the keeper falls back to it after the rolling file and CHARGE_THRESHOLD_FALLBACK', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kevthr-'));
    const r = resolveChargeThreshold({
      modelNode: '0x' + '11'.repeat(32), raw: 'auto', file: join(dir, 'missing.json'), fallbackRaw: '', modelThreshold: () => kevFallbackThreshold('kev'),
    });
    expect(r).toEqual({ threshold: 0.8175, source: 'fallback' });
    const fixed = resolveChargeThreshold({ modelNode: '0x' + '11'.repeat(32), raw: 'auto', file: join(dir, 'missing.json'), fallbackRaw: '0.9', modelThreshold: () => kevFallbackThreshold('kev') });
    expect(fixed).toEqual({ threshold: 0.9, source: 'fallback' }); // CHARGE_THRESHOLD_FALLBACK comes first
  });
  it('KEV_THRESHOLD_FILE overrides the path; a missing / invalid file gives no threshold (charge nothing)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kevthr-'));
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify({ chargeThreshold: 0.66, stateFormat: 'kev2' }));
    process.env.KEV_THRESHOLD_FILE = good;
    expect(kevThresholdPath()).toBe(good);
    expect(kevFallbackThreshold('kev')).toBe(0.66);
    for (const [name, body] of [['bad.json', '{not json'], ['range.json', '{"chargeThreshold": 1.5}'], ['none.json', '{"threshold": 0.5}']] as const) {
      const p = join(dir, name);
      writeFileSync(p, body);
      expect(loadKevThreshold(p)).toBeNull();
      expect(kevFallbackThreshold('kev', p)).toBeUndefined();
    }
    expect(kevFallbackThreshold('kev', join(dir, 'nope.json'))).toBeUndefined();
    const none = resolveChargeThreshold({ modelNode: '0x' + '11'.repeat(32), raw: 'auto', file: join(dir, 'missing.json'), fallbackRaw: '', modelThreshold: () => kevFallbackThreshold('kev', join(dir, 'nope.json')) });
    expect(none.source).toBe('none');
  });
});

describe('kev client (System One noul)', () => {
  it('parses a Kev answer', () => {
    const s = parseKev({ answers: { informed: { type: 'noul', noul: 0.8 } } }, 12.3)!;
    expect(s).toMatchObject({ pToxicBps: 8000, model: 'kev', cls: 'informed', latencyMs: 12, pJitBps: 0 }); // v5: no JIT head yet
    expect(parseKev({ answers: {} }, 1)).toBeNull();
    expect(parseKev({ answers: { informed: { noul: 1.2 } } }, 1)).toBeNull();
  });
  it('sends the plain state and the training question; falls back to null on errors', async () => {
    let body: any;
    const ok = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ answers: { informed: { type: 'noul', noul: 0.25 } } }), { status: 200 });
    }) as unknown as typeof fetch;
    const f = { ...base, gapPips: 300, gapSign: -1 };
    const st = featuresToState(f, { baseIsToken0: false });
    expect((await scoreWithKev(st, { fetchImpl: ok }))!.pToxicBps).toBe(2500);
    expect(body.state).toBe(st);
    expect(body.questions).toEqual(KEV_QUESTIONS);
    const bad = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    expect(await scoreWithKev(st, { fetchImpl: bad })).toBeNull();
    const thrower = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    expect(await scoreWithKev(st, { fetchImpl: thrower })).toBeNull();
  });
  it('score() falls back to the heuristic when the Kev server is unreachable', async () => {
    process.env.KEV_URL = 'http://127.0.0.1:9/v1/systemone';
    expect((await score({ ...base, gapPips: 900 }, { mode: 'oniblock1', timeoutMs: 300 })).model).toBe('heuristic');
    expect((await score({ ...base, gapPips: 900 }, { mode: 'kev', timeoutMs: 300 })).model).toBe('heuristic');
    delete process.env.KEV_URL;
  });

  // Kev state: base-fee training wording, independent of the on-chain k (keeper passes kBps/feeMax/arbThresholdPips).
  const X96 = 2n ** 96n;
  const atK = (kBps: number, arbThresholdPips = 0) =>
    computeFeatures({
      swaps: [], oracleX96: X96, poolX96: (X96 * 10_080n) / 10_000n, depth0: 10n ** 18n, recentMids: [3000, 3001, 2999],
      currentBlock: 100, lastAttestBlock: 99, baseFee: 500, kBps, feeMax: 50_000, arbThresholdPips,
    });
  it('Kev state is identical for k = 0, 0.3, 0.6 and uses the base-fee training wording', async () => {
    const fs = [atK(0), atK(3000), atK(6000), atK(6000, 300)];
    expect(new Set(fs.map((f) => f.arbFeePips)).size).toBeGreaterThan(1); // the features really differ in k
    const states = fs.map((f) => kevState(f, false));
    for (const st of states) {
      expect(st).toBe(states[0]);
      expect(st).toContain('arb_edge: gap minus base fee =');
      expect(st).not.toContain('and swaps toward the Binance mid pay');
    }
    // score() sends exactly this state to the Kev server.
    const sent: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)).state);
      return new Response(JSON.stringify({ answers: { informed: { type: 'noul', noul: 0.7 } } }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      for (const f of fs) expect((await score(f, { mode: 'oniblock1', baseIsToken0: false })).model).toBe('kev');
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(sent).toEqual(states);
  });
  it('Kev state price_gap / arb_edge lines match the training-set wording', () => {
    const PG = /^price_gap: pool price is (above|below|equal to) the Binance mid by -?[0-9.]+% \([0-9]+ pips\); base swap fee [0-9.]+%\.$/;
    const AE = /^arb_edge: gap minus base fee = -?[0-9.]+% \(positive means arbitrage is profitable\)\.$/;
    for (const f of [atK(0), atK(6000), atK(6000, 300), { ...base, gapPips: 300, gapSign: -1, kBps: 4000, arbFeePips: 620 }, base]) {
      const lines = kevState(f, true).split('\n');
      expect(lines.filter((l) => PG.test(l))).toHaveLength(1);
      expect(lines.filter((l) => AE.test(l))).toHaveLength(1);
    }
  });
  it('Kev p -> k is monotonic: k = kMax * p (confidence 1)', () => {
    const ks: number[] = [];
    for (let i = 0; i <= 20; i++) {
      const s = parseKev({ answers: { informed: { type: 'noul', noul: i * 0.05 } } }, 1)!;
      expect(s.confidenceBps).toBe(10_000);
      ks.push((8000 * s.pToxicBps * s.confidenceBps) / 1e8);
    }
    for (let i = 1; i < ks.length; i++) expect(ks[i]).toBeGreaterThanOrEqual(ks[i - 1]);
    expect(ks[0]).toBe(0);
    expect(ks[20]).toBe(8000);
  });
  it('Jev (auto format) state is unchanged: still fee-aware at k > 0', () => {
    const f = atK(6000);
    const st = featuresToState(f, { baseIsToken0: false });
    expect(st).toContain('and swaps toward the Binance mid pay');
    expect(st).toContain('arb_edge: gap minus the fee for swaps toward the mid =');
    expect(st).not.toBe(kevState(f, false));
    expect(featuresToState(atK(0), { baseIsToken0: false })).not.toBe(st);
  });
});
