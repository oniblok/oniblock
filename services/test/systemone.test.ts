import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Features } from '../src/features.js';
import { KEV_QUESTIONS, parseKev } from '../src/model/kev.js';
import { defaultTabularPath, invalidTabularFields, loadTabularModel, predictTabular, TABULAR_FEATURE_INPUTS, TABULAR_FEATURES, tabularModelName, type TabularVersion } from '../src/model/tabular.js';
import { handleSystemOne, startSystemOne, systemOneHealth } from '../src/systemone.js';

const fixture = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/kev2-state-parity.json'), 'utf8')) as { features: Features }[];
const rows = fixture.map((r) => r.features).filter((f) => Number.isFinite(f.gapPips) && Number.isFinite(f.realizedVolBps)).slice(0, 200);
const versions: TabularVersion[] = ['oniblock1'];
const ask = (state: unknown, model?: string) => handleSystemOne({ model, state, questions: KEV_QUESTIONS });

describe('System One endpoint for the tree model (oniblock1)', () => {
  it.each(versions)('%s: noul equals the in-process prediction exactly', (v) => {
    const m = loadTabularModel(defaultTabularPath(v))!;
    for (const f of rows) {
      const r = ask(f, tabularModelName(v));
      expect(r.status).toBe(200);
      const b = r.body as { model: string; answers: { informed: { type: string; noul: number } } };
      expect(b.model).toBe(tabularModelName(v));
      expect(b.answers.informed.type).toBe('noul');
      expect(b.answers.informed.noul).toBe(predictTabular(m, f));
    }
  });

  it('defaults to oniblock1 (TABULAR_MODEL unset); tabular-latest = the default', () => {
    const prev = process.env.TABULAR_MODEL;
    delete process.env.TABULAR_MODEL;
    try {
      expect((ask(rows[0]).body as { model: string }).model).toBe('oniblock1');
      expect(ask(rows[0], 'tabular-latest').body).toMatchObject({ model: 'oniblock1', answers: (ask(rows[0], 'oniblock1').body as any).answers });
    } finally {
      if (prev !== undefined) process.env.TABULAR_MODEL = prev;
    }
  });

  it('drop-in for the Kev client: parseKev reads the answer', () => {
    const r = ask(rows[0], 'oniblock1');
    const s = parseKev(r.body, 1)!;
    expect(s.pToxicBps).toBe(Math.round((r.body as { answers: { informed: { noul: number } } }).answers.informed.noul * 10_000));
  });

  it('canonicalises the orientation like the keeper (baseIsToken0 flips gapSign and imbalance)', () => {
    const f = rows.find((x) => x.gapSign !== 0 && x.imbalance !== 0)!;
    const mirrored = { ...f, gapSign: -f.gapSign, imbalance: -f.imbalance, baseIsToken0: true };
    expect(ask(mirrored, 'oniblock1').body).toMatchObject({ answers: { informed: { noul: (ask(f, 'oniblock1').body as any).answers.informed.noul } } });
  });

  it('rejects what tree models cannot answer', () => {
    expect(ask('price_gap: ...', 'oniblock1').status).toBe(400); // text state
    expect(ask(rows[0], 'kev-latest').status).toBe(400); // unknown model
    for (const gone of ['tabular-v1', 'tabular-v2', 'v1', 'v2']) {
      const r = ask(rows[0], gone); // removed models: unknown, not a silent oniblock1 answer
      expect(r.status).toBe(400);
      expect((r.body as { error: string }).error).toBe(`unknown model ${gone}`);
    }
    expect(ask({ gapSign: 1 }, 'oniblock1').status).toBe(400); // missing fields
    expect(handleSystemOne({ state: rows[0], questions: { regime: { type: 'choice' } } }).status).toBe(400);
    expect(handleSystemOne({ state: rows[0], questions: { informed: { type: 'boolean' } } }).status).toBe(400);
    expect(handleSystemOne('nope').status).toBe(400);
  });

  it('every tabular input has its Features dependencies listed (TABULAR_FEATURE_INPUTS covers TABULAR_FEATURES)', () => {
    expect(Object.keys(TABULAR_FEATURE_INPUTS).sort()).toEqual(Object.keys(TABULAR_FEATURES).sort());
    // each listed dependency really feeds the input: a NaN there NaNs it, or (a sign branch) moving it changes it
    // (optional overrides removed: edgeSigma / edgePips, when given, replace the formula)
    const f = { ...rows.find((x) => x.imbalance !== 0 && x.gapPips > 0)!, edgeSigma: undefined, edgePips: undefined };
    for (const [name, d] of Object.entries(TABULAR_FEATURE_INPUTS))
      for (const k of d.required) {
        const fn = TABULAR_FEATURES[name]!;
        const used = Number.isNaN(fn({ ...f, [k]: Number.NaN })) || fn({ ...f, [k]: 5 }) !== fn({ ...f, [k]: -5 });
        expect(used, `${name} <- ${k}`).toBe(true);
      }
  });

  it('400 listing every missing / non-finite field the requested model needs (derived from its inputs)', () => {
    const m = loadTabularModel(defaultTabularPath('oniblock1'))!;
    const f = rows[0]! as unknown as Record<string, unknown>;
    const drop = (o: Record<string, unknown>, ...ks: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !ks.includes(k)));
    // imb_arb / abs_imbalance <- imbalance, log_size / sizeToDepth <- sizeToDepth (JSON NaN arrives as null)
    const r = ask({ ...drop(f, 'imbalance'), sizeToDepth: null, nSwaps: 'many' }, 'oniblock1');
    expect(r.status).toBe(400);
    expect((r.body as { fields: string[] }).fields).toEqual(['imbalance', 'nSwaps', 'sizeToDepth']);
    expect((r.body as { error: string }).error).toMatch(/imbalance, nSwaps, sizeToDepth/);
    expect(invalidTabularFields({ ...f, arbShare: Number.POSITIVE_INFINITY }, m.features)).toEqual(['arbShare']);
    // v2 fields are optional (absent = no mid history = 0) but must be finite when present, for a model that uses them
    const users = versions.filter((v) => loadTabularModel(defaultTabularPath(v))!.features.includes('ret900Bps'));
    for (const v of users) {
      expect(ask(drop(f, 'ret900Bps', 'vol5mBps'), tabularModelName(v)).status).toBe(200);
      const bad = ask({ ...f, ret900Bps: null }, tabularModelName(v));
      expect(bad.status).toBe(400);
      expect((bad.body as { fields: string[] }).fields).toEqual(['ret900Bps']);
      // sgap <- gapSign & gapPips
      expect((ask({ ...f, gapSign: 'x' }, tabularModelName(v)).body as { fields: string[] }).fields).toContain('gapSign');
    }
    // a model without ret900Bps among its inputs does not check it: a bad value there is not its business
    expect(invalidTabularFields({ ...f, ret900Bps: null }, m.features.filter((n) => n !== 'ret900Bps'))).toEqual([]);
  });

  it('a model that fails to load is a 503 with the message, never an exception (request and /health)', () => {
    const broken = () => {
      throw new Error('tabular model x.json: unknown features mystery');
    };
    const r = handleSystemOne({ model: 'oniblock1', state: rows[0], questions: KEV_QUESTIONS }, 'oniblock1', broken);
    expect(r.status).toBe(503);
    expect((r.body as { error: string }).error).toMatch(/oniblock1 failed to load: tabular model x.json: unknown features mystery/);
    expect(handleSystemOne({ state: rows[0], questions: KEV_QUESTIONS }, 'oniblock1', () => null).status).toBe(503); // no file
    const h = systemOneHealth(['oniblock1'], broken);
    expect(h.status).toBe(503);
    expect(h.body).toMatchObject({ ok: false, error: expect.stringMatching(/unknown features mystery/) });
    expect(systemOneHealth().status).toBe(200);
  });
});

describe('System One HTTP server', () => {
  let url = '';
  let close = () => {};
  beforeAll(async () => {
    const s = startSystemOne(0);
    await new Promise<void>((ok) => s.on('listening', ok));
    url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    close = () => s.close();
  });
  afterAll(() => close());

  it('POST /v1/systemone round trip', async () => {
    const res = await fetch(`${url}/v1/systemone`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'oniblock1', state: rows[0], questions: KEV_QUESTIONS }) });
    expect(res.status).toBe(200);
    const wire = (await res.json()) as { model: string; answers: unknown };
    const direct = ask(rows[0], 'oniblock1').body as { model: string; answers: unknown };
    expect({ model: wire.model, answers: wire.answers }).toEqual({ model: direct.model, answers: direct.answers });
  });

  it('GET /health lists the models with their sha256 (ENS model-hash)', async () => {
    const h = (await (await fetch(`${url}/health`)).json()) as { ok: boolean; default: string; models: { name: string; sha256: string }[] };
    expect(h.ok).toBe(true);
    expect(h.models.map((m) => m.name)).toEqual(['oniblock1']);
    if (!process.env.TABULAR_MODEL) expect(h.default).toBe('oniblock1');
    for (const m of h.models) expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('404 on other routes', async () => {
    expect((await fetch(`${url}/v1/other`, { method: 'POST', body: '{}' })).status).toBe(404);
  });

  it('a broken model file: 503 on both routes and the server keeps serving', async () => {
    const s = startSystemOne(0, '127.0.0.1', () => {
      throw new SyntaxError('Unexpected end of JSON input');
    });
    await new Promise<void>((ok) => s.on('listening', ok));
    const u = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    try {
      const h = await fetch(`${u}/health`);
      expect(h.status).toBe(503);
      expect(await h.json()).toMatchObject({ ok: false, error: expect.stringMatching(/Unexpected end of JSON input/) });
      const p = await fetch(`${u}/v1/systemone`, { method: 'POST', body: JSON.stringify({ model: 'oniblock1', state: rows[0], questions: KEV_QUESTIONS }) });
      expect(p.status).toBe(503);
      expect((await fetch(`${u}/health`)).status).toBe(503); // still up
    } finally {
      s.close();
    }
  });
});
