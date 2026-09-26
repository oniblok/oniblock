/**
 * Kev (jaredpalmer/kev: open, Jev-compatible decision model), fine-tuned on Oniblock's mainnet dataset
 * (ml/hf_release). It runs locally behind Kev's own TypeSafe System One server:
 *
 *   KEV_MODEL=0.8b|4b ml/serve/start-kev.sh        # wraps `python -m kev.serve --run <adapter dir> --port 8008`
 *
 *   POST http://127.0.0.1:8008/v1/systemone
 *   body   { model: "kev-latest", state: string, questions: { informed: { type: "noul", instructions, criteria } } }
 *   answer { answers: { informed: { type: "noul", noul: <P(true)> } }, latency_ms }
 *
 * The state is the plain featuresToState text (format 'auto') rendered from k-free features (index.ts kevState drops
 * kBps / arbFeePips / arbThresholdPips), so it always uses the base-fee wording, exactly what the model was fine-tuned
 * on (ml/src/states.py is a byte-identical port), independent of the on-chain k.
 * Kev has a single calibrated probability head and no separate confidence, so parseKev reports confidence 1
 * (10000 bps) and the hook's k = kMin + (kMax - kMin) * p is monotonic in p. The question text must stay identical to ml/src/states.py KEV_QUESTION.
 * Env: KEV_URL (default http://127.0.0.1:8008/v1/systemone), KEV_MODEL (0.8b|4b -> model node kev-v1 | kev4b-v1),
 * KEV_TIMEOUT_MS (default 1500), KEV_API_KEY (optional bearer, if the server was started with one).
 * `scoreWithKev` never throws: any failure returns null so the caller falls back to the heuristic.
 */
import { env } from '../config.js';
import { clampBps, type ModelScore } from './types.js';

export const KEV_URL = () => env('KEV_URL', 'http://127.0.0.1:8008/v1/systemone')!;
export type KevSize = '0.8b' | '4b';
export const kevSize = (): KevSize => (env('KEV_MODEL', '0.8b') === '4b' ? '4b' : '0.8b');
/** ENS model node names: kev-v1 = fine-tuned Kev-0.8B, kev4b-v1 = fine-tuned Kev-4B. */
export const kevModelName = (size: KevSize = kevSize()) => (size === '4b' ? 'kev4b-v1.models.oniblock.eth' : 'kev-v1.models.oniblock.eth');

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
