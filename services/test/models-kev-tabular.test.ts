import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { featuresToState, type Features } from '../src/features.js';
import { score } from '../src/model/index.js';
import { KEV_QUESTIONS, kevModelName, parseKev, scoreWithKev } from '../src/model/kev.js';
import { loadTabularModel, predictTabular, scoreTabular, tabularInputs } from '../src/model/tabular.js';
import { defaultModelName } from '../src/keeper.js';

const base: Features = { gapPips: 0, gapSign: 0, imbalance: 0, sizeToDepth: 0, realizedVolBps: 0, attestationAge: 1, nSwaps: 5, arbShare: 0, baseFee: 500 };

describe('tabular-v1 (LightGBM JSON, pure TS)', () => {
  const m = loadTabularModel()!;
  it('loads the exported model', () => {
    expect(m).not.toBeNull();
    expect(m.trees.length).toBeGreaterThan(10);
  });
  it('matches LightGBM predictions on real test rows (ml/src/export_tabular.py fixtures)', () => {
    const fx = JSON.parse(readFileSync(resolve(__dirname, 'fixtures', 'tabular-v1-parity.json'), 'utf8')) as { features: Features; p: number }[];
    expect(fx.length).toBe(50);
    for (const { features, p } of fx) expect(predictTabular(m, features)).toBeCloseTo(p, 6);
  });
  it('is orientation-free: flipping gapSign and imbalance together leaves p unchanged', () => {
    const f = { ...base, gapPips: 700, gapSign: 1, imbalance: -0.4, nSwaps: 12, arbShare: 0.6, realizedVolBps: 2, sizeToDepth: 3e-5 };
    expect(tabularInputs(f)).toEqual(tabularInputs({ ...f, gapSign: -1, imbalance: 0.4 }));
  });
  it('uses the hook arb fee as the cost when present, and rises with the edge', () => {
    const f = { ...base, gapPips: 900, gapSign: 1, nSwaps: 15, arbShare: 0.7, realizedVolBps: 2, sizeToDepth: 3e-5 };
    expect(tabularInputs({ ...f, arbFeePips: 800 })[1]).toBe(100);
    const lo = scoreTabular({ ...f, gapPips: 50 })!;
    const hi = scoreTabular({ ...f, gapPips: 2500 })!;
    expect(hi.model).toBe('tabular');
    expect(hi.pJitBps).toBe(0); // v5: no JIT head yet
    expect(hi.pToxicBps).toBeGreaterThan(lo.pToxicBps);
  });
  it('score() dispatches MODEL_MODE=tabular', async () => {
    expect((await score({ ...base, gapPips: 900 }, { mode: 'tabular' })).model).toBe('tabular');
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
    expect(defaultModelName('tabular')).toBe('tabular-v1.models.oniblock.eth');
    expect(defaultModelName('auto')).toBe('jev-v1.models.oniblock.eth');
  });
});
