/**
 * Scorer entry point: Jev first (bounded latency), deterministic heuristic fallback.
 * `degraded` mode deliberately inverts predictions with high confidence so the settler's
 * Brier score worsens and the on-chain calibration gate demotes the model (demo step 5).
 */
import { env } from '../config.js';
import { featuresToState, type Features } from '../features.js';
import { scoreHeuristic } from './heuristic.js';
import { defaultJevPrompt, scoreWithJev, type JevCache, type JevPrompt } from './jev.js';
import { scoreWithKev } from './kev.js';
import { scoreTabular } from './tabular.js';
import { clampBps, type ModelScore } from './types.js';

export * from './types.js';
export { scoreHeuristic } from './heuristic.js';
export { scoreWithJev, parseJev, JevCache, JEV_QUESTIONS, JEV_QUESTIONS_V1, JEV_QUESTIONS_V4, JEV_MODEL, jevCacheKey, defaultJevPrompt, type JevPrompt } from './jev.js';

export { scoreWithKev, parseKev, KEV_QUESTIONS, kevModelName, kevSize } from './kev.js';
export { scoreTabular, predictTabular, loadTabularModel, tabularInputs } from './tabular.js';

/** kev = local fine-tuned Kev server (KEV_URL, KEV_MODEL=0.8b|4b); tabular = tabular-v1 LightGBM (in-process). Both fall back to the heuristic. */
export type ModelMode = 'auto' | 'jev' | 'heuristic' | 'kev' | 'tabular';

export interface ScoreOpts {
  /** auto = Jev then heuristic (default); jev = Jev only (heuristic still used if Jev fails); heuristic = skip Jev. */
  mode?: ModelMode;
  degraded?: boolean;
  cache?: JevCache;
  timeoutMs?: number;
  baseIsToken0?: boolean;
  /** Jev question + state format (default v4; env JEV_PROMPT=v1 restores the pre-v4 texts). */
  prompt?: JevPrompt;
}

/** Deliberately wrong transform: flip probability, claim high confidence, swap class. */
export function degrade(s: ModelScore): ModelScore {
  return {
    ...s,
    pToxicBps: clampBps(10_000 - s.pToxicBps),
    confidenceBps: 9_500,
    cls: s.cls === 'informed' ? 'dump' : s.cls === 'dump' ? 'informed' : 'informed',
    degraded: true,
  };
}

export async function score(f: Features, opts: ScoreOpts = {}): Promise<ModelScore> {
  const mode = opts.mode ?? (env('MODEL_MODE', 'auto') as ModelMode);
  let s: ModelScore | null = null;
  if (mode === 'kev') {
    s = await scoreWithKev(featuresToState(f, { baseIsToken0: opts.baseIsToken0 }), { timeoutMs: opts.timeoutMs });
  } else if (mode === 'tabular') {
    s = scoreTabular(f);
  } else if (mode !== 'heuristic') {
    const prompt = opts.prompt ?? defaultJevPrompt();
    s = await scoreWithJev(featuresToState(f, { baseIsToken0: opts.baseIsToken0, format: prompt === 'v4' ? 'v4' : 'auto' }), {
      prompt,
      cache: opts.cache,
      timeoutMs: opts.timeoutMs,
    });
  }
  if (!s) s = scoreHeuristic(f);
  return opts.degraded ? degrade(s) : s;
}
