/**
 * oniblock1, the production model: Kev (jaredpalmer/kev, an open TypeSafe System One decision model) fine-tuned on
 * Oniblock's mainnet dataset (ml/hf_release). Today's weights are the Kev-0.8B LoRA adapter ml/models/kev08b-v1/adapter
 * (v1 data: base-fee state wording, Binance read ~11 s old); Kev v2 replaces them later. It runs locally behind Kev's own
 * System One server:
 *
 *   ml/serve/start-kev.sh        # wraps `python -m kev.serve --run ml/models/kev08b-v1/adapter --port 8008`
 *
 *   POST http://127.0.0.1:8008/v1/systemone
 *   body   { model: "kev-latest", state: string, questions: { informed: { type: "noul", instructions, criteria } } }
 *   answer { answers: { informed: { type: "noul", noul: <P(true)> } }, latency_ms }
 *
 * The state is the featuresToState text rendered from k-free features (index.ts kevState drops kBps / arbFeePips /
 * arbThresholdPips), so it always uses the base-fee wording, exactly what the model was fine-tuned on (ml/src/states.py
 * is a byte-identical port), independent of the on-chain k. KEV_STATE_FORMAT picks the text: auto (default, the v1
 * adapter's 8 lines) or kev2 (+ the 3 v2 lines; only for a Kev v2 adapter, and the keeper then fetches the kline mids).
 * Kev has a single calibrated probability head and no separate confidence, so parseKev reports confidence 1
 * (10000 bps) and the hook's k = kMin + (kMax - kMin) * p is monotonic in p. The question text must stay identical to ml/src/states.py KEV_QUESTION.
 * Env: KEV_URL (default http://127.0.0.1:8008/v1/systemone), KEV_TIMEOUT_MS (default 1500), KEV_API_KEY (optional
 * bearer, if the server was started with one), KEV_THRESHOLD_FILE (the adapter's validation-chosen charge threshold, the
 * keeper's last CHARGE_THRESHOLD=auto fallback; default ml/models/kev08b-v1/charge_threshold.json).
 * `scoreWithKev` never throws: any failure returns null so the caller falls back to the heuristic.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { env, ROOT } from '../config.js';
import { clampBps, type ModelScore } from './types.js';

export const KEV_URL = () => env('KEV_URL', 'http://127.0.0.1:8008/v1/systemone')!;
/** ENS model node the Kev answers are posted under (MODEL_MODE=oniblock1, and its alias MODEL_MODE=kev). */
export const KEV_MODEL_NAME = 'oniblock1.models.oniblock.eth';

export function kevThresholdPath(): string {
  return env('KEV_THRESHOLD_FILE', resolve(ROOT, 'ml', 'models', 'kev08b-v1', 'charge_threshold.json'))!;
}

export interface KevThresholdFile {
  chargeThreshold: number;
  chosenOn?: string;
  /** KEV_STATE_FORMAT the threshold was chosen with (auto | kev2). */
  stateFormat?: string;
}

const thrCache = new Map<string, { mtimeMs: number; t: KevThresholdFile | null }>();
/**
 * The adapter's validation-chosen charge threshold (KEV_THRESHOLD_FILE; re-read when the mtime changes). Null if the
 * file is missing / unparseable / has no chargeThreshold in [0,1] (the keeper then charges nothing). Never throws.
 */
export function loadKevThreshold(path = kevThresholdPath()): KevThresholdFile | null {
  try {
    if (!existsSync(path)) return null;
    const m = statSync(path).mtimeMs;
    const c = thrCache.get(path);
    if (c?.mtimeMs === m) return c.t;
    const j = JSON.parse(readFileSync(path, 'utf8')) as Partial<KevThresholdFile> | null;
    const v = j?.chargeThreshold;
    const t = typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? ({ ...j, chargeThreshold: v } as KevThresholdFile) : null;
    thrCache.set(path, { mtimeMs: m, t });
    return t;
  } catch {
    return null;
  }
}

/** Must match ml/src/states.py KEV_QUESTION (training text). */
export const KEV_QUESTIONS = {
  informed: {
    type: 'noul',
    instructions:
      "Is this block's arbitrage-direction flow informed, i.e. will the swaps that move the pool toward the Binance mid be profitable against the Binance mid at swap time after paying the pool fee?",
    criteria: {
      true: 'informed / toxic: arbitrage-direction swaps profit against the CEX mid after the fee (LPs lose)',
      false: 'benign: arbitrage-direction swaps do not profit against the CEX mid after the fee',
    },
  },
} as const;

export function parseKev(raw: unknown, latencyMs: number): ModelScore | null {
  const p = (raw as { answers?: { informed?: { noul?: number } } } | null)?.answers?.informed?.noul;
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) return null;
  return {
    pToxicBps: clampBps(p * 10_000),
    // Single calibrated probability, no confidence head: full confidence keeps k = kMax * p monotonic in p.
    confidenceBps: 10_000,
    pJitBps: 0, // no JIT head yet (Kev was fine-tuned on the arb question only) => the hook uses jitWindowDefault
    cls: p >= 0.6 ? 'informed' : 'unknown',
    latencyMs: Math.round(latencyMs),
    model: 'kev',
  };
}

export interface KevOpts {
  timeoutMs?: number;
  url?: string;
  fetchImpl?: typeof fetch;
}

export async function scoreWithKev(state: string, opts: KevOpts = {}): Promise<ModelScore | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? Number(env('KEV_TIMEOUT_MS', '1500')));
  const t0 = performance.now();
  try {
    const key = env('KEV_API_KEY');
    const res = await (opts.fetchImpl ?? fetch)(opts.url ?? KEV_URL(), {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: 'kev-latest', state, questions: KEV_QUESTIONS }),
    });
    if (!res.ok) return null;
    return parseKev(await res.json(), performance.now() - t0);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
