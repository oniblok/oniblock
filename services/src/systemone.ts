/**
 * TypeSafe System One endpoint for the tree models (oniblock1, tabular-v1), so they, Kev and Jev sit behind one interface.
 * The keeper still calls tabular in-process (services/src/model/tabular.ts); this is the same prediction over HTTP.
 *
 *   POST /v1/systemone
 *   body   { model?: "oniblock1" | "tabular-v1" | "tabular-latest" (= the default),
 *            state: { ...Features, baseIsToken0?: boolean },
 *            questions: { informed: { type: "noul", instructions?, criteria? } } }
 *   answer { model, answers: { informed: { type: "noul", noul: <P(true)> } }, latency_ms }
 *   GET  /health -> { ok, models: [{ name, sha256, chargeThreshold }] }
 *
 * `state` must be the numeric Features object (System One allows an object state): trees need exact numbers, not
 * the rounded text. It is canonicalised to the training orientation with `baseIsToken0`, like the keeper does.
 * Env: SYSTEMONE_PORT (8010), SYSTEMONE_HOST (127.0.0.1), SYSTEMONE_API_KEY (optional bearer), TABULAR_MODEL (default model;
 * unset = oniblock1).
 * CLI: tsx src/systemone.ts
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { env, envInt } from './config.js';
import { canonicalFeatures, type Features } from './features.js';
import { defaultTabularPath, loadTabularModel, parseTabularVersion, predictTabular, tabularModelName, type TabularVersion } from './model/tabular.js';

export interface SystemOneResult {
  status: number;
  body: unknown;
}

const REQUIRED: (keyof Features)[] = ['gapPips', 'gapSign', 'baseFee', 'realizedVolBps'];
const bad = (status: number, error: string): SystemOneResult => ({ status, body: { error } });

/** Listed by /health (tabular-v2 is still accepted in a request). */
const HEALTH_MODELS: readonly TabularVersion[] = ['oniblock1', 'v1'];

/** The server's default model: TABULAR_MODEL if set, else oniblock1 (the keeper's own default stays tabular-v1). */
export const systemOneDefault = (): TabularVersion => parseTabularVersion(env('TABULAR_MODEL')) ?? 'oniblock1';

export function modelSha256(v: TabularVersion): string {
  return createHash('sha256').update(readFileSync(defaultTabularPath(v))).digest('hex');
}

/** Pure request handler (no I/O besides loading the model file once). */
export function handleSystemOne(req: unknown, defaultVersion: TabularVersion = systemOneDefault()): SystemOneResult {
  const t0 = performance.now();
  if (!req || typeof req !== 'object') return bad(400, 'body must be a JSON object');
  const r = req as { model?: unknown; state?: unknown; questions?: unknown };
  const requested = typeof r.model === 'string' && r.model !== 'tabular-latest' ? parseTabularVersion(r.model) : defaultVersion;
  if (!requested) return bad(400, `unknown model ${String(r.model)}`);
  if (!r.state || typeof r.state !== 'object' || Array.isArray(r.state))
    return bad(400, 'state must be the numeric Features object (text states are not supported by tree models)');
  const st = r.state as Record<string, unknown>;
  const missing = REQUIRED.filter((k) => typeof st[k] !== 'number' || !Number.isFinite(st[k] as number));
  if (missing.length) return bad(400, `state is missing numeric ${missing.join(', ')}`);
  const qs = r.questions && typeof r.questions === 'object' ? (r.questions as Record<string, { type?: unknown }>) : undefined;
  if (!qs || !Object.keys(qs).length) return bad(400, 'questions is required');
  const extra = Object.keys(qs).filter((k) => k !== 'informed');
  if (extra.length) return bad(400, `unsupported questions: ${extra.join(', ')} (tabular answers only "informed")`);
  if (qs.informed?.type !== 'noul') return bad(400, 'questions.informed.type must be "noul"');

  const m = loadTabularModel(defaultTabularPath(requested));
  if (!m) return bad(503, `model ${tabularModelName(requested)} is not available`);
  const f = canonicalFeatures(st as unknown as Features, st.baseIsToken0 === true);
  const p = predictTabular(m, f);
  if (!Number.isFinite(p)) return bad(500, 'prediction is not finite');
  return {
    status: 200,
    body: { model: tabularModelName(requested), answers: { informed: { type: 'noul', noul: p } }, latency_ms: +(performance.now() - t0).toFixed(3) },
  };
}

export function startSystemOne(port = envInt('SYSTEMONE_PORT', 8010), host = env('SYSTEMONE_HOST', '127.0.0.1')!): Server {
  const key = env('SYSTEMONE_API_KEY');
  const send = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    if (key && req.headers.authorization !== `Bearer ${key}`) return send(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET' && req.url === '/health') {
      const models = HEALTH_MODELS.map((v) => {
        const m = loadTabularModel(defaultTabularPath(v));
        return m ? { name: tabularModelName(v), sha256: modelSha256(v), chargeThreshold: m.chargeThreshold ?? null } : null;
      }).filter(Boolean);
      return send(res, 200, { ok: true, default: tabularModelName(systemOneDefault()), models });
    }
    if (req.method !== 'POST' || req.url !== '/v1/systemone') return send(res, 404, { error: 'not found' });
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: 'invalid JSON' });
      }
      const r = handleSystemOne(body);
      send(res, r.status, r.body);
    });
  });
  server.listen(port, host);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = startSystemOne();
  s.on('listening', () => console.log(JSON.stringify({ c: 'systemone', e: 'listening', address: s.address(), default: tabularModelName(systemOneDefault()) })));
}
