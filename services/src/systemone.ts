/**
 * TypeSafe System One endpoint for the tree models (oniblock1, tabular-v1), so they, Kev and Jev sit behind one interface.
 * The keeper still calls tabular in-process (services/src/model/tabular.ts); this is the same prediction over HTTP.
 *
 *   POST /v1/systemone
 *   body   { model?: "oniblock1" | "tabular-v1" | "tabular-latest" (= the default),
 *            state: { ...Features, baseIsToken0?: boolean },
 *            questions: { informed: { type: "noul", instructions?, criteria? } } }
 *   answer { model, answers: { informed: { type: "noul", noul: <P(true)> } }, latency_ms }
 *   GET  /health -> { ok, models: [{ name, sha256, chargeThreshold }] }   (503 { ok: false, error } if a model file is unreadable)
 *   400 { error, fields } when a Features field the requested model's inputs derive from (tabular.ts TABULAR_FEATURE_INPUTS)
 *   is missing or not a finite number; 503 { error } when the model cannot be loaded.
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
import { defaultTabularPath, invalidTabularFields, loadTabularModel, parseTabularVersion, predictTabular, tabularModelName, type TabularModel, type TabularVersion } from './model/tabular.js';

export interface SystemOneResult {
  status: number;
  body: unknown;
}

const bad = (status: number, error: string, extra: Record<string, unknown> = {}): SystemOneResult => ({ status, body: { error, ...extra } });

/** Loads a model by version (default: its file, loadTabularModel; injectable for tests). Null = no file; may throw. */
export type SystemOneLoader = (v: TabularVersion) => TabularModel | null;
const defaultLoader: SystemOneLoader = (v) => loadTabularModel(defaultTabularPath(v));

/** Model for `v`; a missing file => null, an unreadable / invalid one => the error (never thrown to the caller). */
function tryLoad(v: TabularVersion, load: SystemOneLoader): { model: TabularModel | null; error?: undefined } | { model?: undefined; error: string } {
  try {
    return { model: load(v) };
  } catch (e) {
    return { error: (e as Error).message?.split('\n')[0] ?? String(e) };
  }
}

/** Listed by /health (tabular-v2 is still accepted in a request). */
const HEALTH_MODELS: readonly TabularVersion[] = ['oniblock1', 'v1'];

/** The server's default model: TABULAR_MODEL if set, else oniblock1 (the keeper's own default stays tabular-v1). */
export const systemOneDefault = (): TabularVersion => parseTabularVersion(env('TABULAR_MODEL')) ?? 'oniblock1';

export function modelSha256(v: TabularVersion): string {
  return createHash('sha256').update(readFileSync(defaultTabularPath(v))).digest('hex');
}

/** Pure request handler (no I/O besides loading the model file once). */
export function handleSystemOne(req: unknown, defaultVersion: TabularVersion = systemOneDefault(), load: SystemOneLoader = defaultLoader): SystemOneResult {
  const t0 = performance.now();
  if (!req || typeof req !== 'object') return bad(400, 'body must be a JSON object');
  const r = req as { model?: unknown; state?: unknown; questions?: unknown };
  const requested = typeof r.model === 'string' && r.model !== 'tabular-latest' ? parseTabularVersion(r.model) : defaultVersion;
  if (!requested) return bad(400, `unknown model ${String(r.model)}`);
  if (!r.state || typeof r.state !== 'object' || Array.isArray(r.state))
    return bad(400, 'state must be the numeric Features object (text states are not supported by tree models)');
  const st = r.state as Record<string, unknown>;
  const qs = r.questions && typeof r.questions === 'object' ? (r.questions as Record<string, { type?: unknown }>) : undefined;
  if (!qs || !Object.keys(qs).length) return bad(400, 'questions is required');
  const extra = Object.keys(qs).filter((k) => k !== 'informed');
  if (extra.length) return bad(400, `unsupported questions: ${extra.join(', ')} (tabular answers only "informed")`);
  if (qs.informed?.type !== 'noul') return bad(400, 'questions.informed.type must be "noul"');

  const loaded = tryLoad(requested, load);
  if (loaded.error !== undefined) return bad(503, `model ${tabularModelName(requested)} failed to load: ${loaded.error}`);
  const m = loaded.model;
  if (!m) return bad(503, `model ${tabularModelName(requested)} is not available`);
  // Every Features field this model's inputs derive from (TABULAR_FEATURE_INPUTS) must be a finite number.
  const invalid = invalidTabularFields(st, m.features);
  if (invalid.length) return bad(400, `state is missing numeric (finite) ${invalid.join(', ')}`, { fields: invalid });
  const f = canonicalFeatures(st as unknown as Features, st.baseIsToken0 === true);
  const p = predictTabular(m, f);
  if (!Number.isFinite(p)) return bad(500, 'prediction is not finite');
  return {
    status: 200,
    body: { model: tabularModelName(requested), answers: { informed: { type: 'noul', noul: p } }, latency_ms: +(performance.now() - t0).toFixed(3) },
  };
}

/** GET /health: 200 with the listed models, or 503 with the error when a model file cannot be read. Never throws. */
export function systemOneHealth(versions: readonly TabularVersion[] = HEALTH_MODELS, load: SystemOneLoader = defaultLoader): SystemOneResult {
  try {
    const models: { name: string; sha256: string; chargeThreshold: number | null }[] = [];
    for (const v of versions) {
      const l = tryLoad(v, load);
      if (l.error !== undefined) return bad(503, `model ${tabularModelName(v)} failed to load: ${l.error}`, { ok: false });
      if (l.model) models.push({ name: tabularModelName(v), sha256: modelSha256(v), chargeThreshold: l.model.chargeThreshold ?? null });
    }
    return { status: 200, body: { ok: true, default: tabularModelName(systemOneDefault()), models } };
  } catch (e) {
    return bad(503, (e as Error).message?.split('\n')[0] ?? String(e), { ok: false });
  }
}

export function startSystemOne(port = envInt('SYSTEMONE_PORT', 8010), host = env('SYSTEMONE_HOST', '127.0.0.1')!, load: SystemOneLoader = defaultLoader): Server {
  const key = env('SYSTEMONE_API_KEY');
  const send = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    if (key && req.headers.authorization !== `Bearer ${key}`) return send(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET' && req.url === '/health') {
      const h = systemOneHealth(HEALTH_MODELS, load);
      return send(res, h.status, h.body);
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
      let r: SystemOneResult;
      try {
        r = handleSystemOne(body, systemOneDefault(), load);
      } catch (e) {
        r = bad(503, (e as Error).message?.split('\n')[0] ?? String(e)); // never an uncaught exception in the server
      }
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
