import { existsSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Features } from '../src/features.js';
import { KEV_QUESTIONS, parseKev } from '../src/model/kev.js';
import { defaultTabularPath, loadTabularModel, predictTabular, tabularModelName, type TabularVersion } from '../src/model/tabular.js';
import { handleSystemOne, startSystemOne } from '../src/systemone.js';

const fixture = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/kev2-state-parity.json'), 'utf8')) as { features: Features }[];
const rows = fixture.map((r) => r.features).filter((f) => Number.isFinite(f.gapPips) && Number.isFinite(f.realizedVolBps)).slice(0, 200);
const versions: TabularVersion[] = (['oniblock1', 'v1', 'v2'] as const).filter((v) => existsSync(defaultTabularPath(v)));
const ask = (state: unknown, model?: string) => handleSystemOne({ model, state, questions: KEV_QUESTIONS });

describe('System One endpoint for the tree models', () => {
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
    expect(ask({ gapSign: 1 }, 'oniblock1').status).toBe(400); // missing fields
    expect(handleSystemOne({ state: rows[0], questions: { regime: { type: 'choice' } } }).status).toBe(400);
    expect(handleSystemOne({ state: rows[0], questions: { informed: { type: 'boolean' } } }).status).toBe(400);
    expect(handleSystemOne('nope').status).toBe(400);
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
    expect(h.models.map((m) => m.name)).toEqual(['oniblock1', 'tabular-v1']);
    if (!process.env.TABULAR_MODEL) expect(h.default).toBe('oniblock1');
    for (const m of h.models) expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('404 on other routes', async () => {
    expect((await fetch(`${url}/v1/other`, { method: 'POST', body: '{}' })).status).toBe(404);
  });
});
