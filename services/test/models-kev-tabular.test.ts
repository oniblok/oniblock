import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeFeatures, featuresToState, type Features } from '../src/features.js';
import { kevState, score } from '../src/model/index.js';
import { KEV_QUESTIONS, kevModelName, parseKev, scoreWithKev } from '../src/model/kev.js';
import { loadTabularModel, predictTabular, scoreTabular, tabularInputs } from '../src/model/tabular.js';
import { defaultModelName } from '../src/keeper.js';

const base: Features = { gapPips: 0, gapSign: 0, imbalance: 0, sizeToDepth: 0, realizedVolBps: 0, attestationAge: 1, nSwaps: 5, arbShare: 0, baseFee: 500 };

describe('oniblock1 (LightGBM JSON, pure TS)', () => {
  const m = loadTabularModel()!;
  it('loads the exported model', () => {
    expect(m).not.toBeNull();
    expect(m.name).toBe('oniblock1');
    expect(m.features).toHaveLength(17);
    expect(m.trees.length).toBeGreaterThan(10);
  });
  it('matches the Python evaluator on real rows (ml/src/oniblock1_parity_fixture.py) to 1e-9', () => {
    const fx = JSON.parse(readFileSync(resolve(__dirname, 'fixtures', 'oniblock1-parity.json'), 'utf8')) as {
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
    // the fixture covers both sides of the charge threshold
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
    expect(hi.pJitBps).toBe(0); // v5: no JIT head yet
    expect(hi.pToxicBps).toBeGreaterThan(lo.pToxicBps);
  });
  it('score() dispatches MODEL_MODE=tabular and MODEL_MODE=oniblock1', async () => {
    expect((await score({ ...base, gapPips: 900 }, { mode: 'tabular' })).model).toBe('tabular');
    expect((await score({ ...base, gapPips: 900 }, { mode: 'oniblock1' })).model).toBe('tabular');
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
    const s = await score({ ...base, gapPips: 900 }, { mode: 'kev', timeoutMs: 300 });
    expect(s.model).toBe('heuristic');
    delete process.env.KEV_URL;
  });
  it('model node names', () => {
    expect(kevModelName('0.8b')).toBe('kev-v1.models.oniblock.eth');
    expect(kevModelName('4b')).toBe('kev4b-v1.models.oniblock.eth');
    expect(defaultModelName('tabular')).toBe('oniblock1.models.oniblock.eth');
    expect(defaultModelName('oniblock1')).toBe('oniblock1.models.oniblock.eth');
    expect(defaultModelName('auto')).toBe('jev-v1.models.oniblock.eth');
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
      for (const f of fs) expect((await score(f, { mode: 'kev', baseIsToken0: false })).model).toBe('kev');
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
