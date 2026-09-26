/**
 * Scorer entry point: Jev first (bounded latency), deterministic heuristic fallback.
 * `degraded` mode deliberately inverts predictions with high confidence so the settler's
 * Brier score worsens and the on-chain calibration gate demotes the model (demo step 5).
 */
import { env } from '../config.js';
import { featuresToState, type Features } from '../features.js';
import { scoreHeuristic } from './heuristic.js';
import { scoreWithJev, type JevCache } from './jev.js';
import { clampBps, type ModelScore } from './types.js';

export * from './types.js';
export { scoreHeuristic } from './heuristic.js';
export { scoreWithJev, parseJev, JevCache, JEV_QUESTIONS, JEV_MODEL } from './jev.js';

export type ModelMode = 'auto' | 'jev' | 'heuristic';

export interface ScoreOpts {
  /** auto = Jev then heuristic (default); jev = Jev only (heuristic still used if Jev fails); heuristic = skip Jev. */
  mode?: ModelMode;
  degraded?: boolean;
  cache?: JevCache;
  timeoutMs?: number;
  baseIsToken0?: boolean;
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
  if (mode !== 'heuristic') {
    s = await scoreWithJev(featuresToState(f, { baseIsToken0: opts.baseIsToken0 }), {
      cache: opts.cache,
      timeoutMs: opts.timeoutMs,
    });
  }
  if (!s) s = scoreHeuristic(f);
  return opts.degraded ? degrade(s) : s;
}
