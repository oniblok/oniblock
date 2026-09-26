/**
 * Scorer entry point: Jev first (bounded latency), deterministic heuristic fallback.
 * `degraded` mode deliberately inverts predictions with high confidence so the settler's
 * Brier score worsens and the on-chain calibration gate demotes the model (demo step 5).
 */
import { env } from '../config.js';
import { canonicalFeatures, featuresToState, type Features } from '../features.js';
import { scoreHeuristic } from './heuristic.js';
import { defaultJevPrompt, scoreWithJev, type JevCache, type JevPrompt } from './jev.js';
import { scoreWithKev } from './kev.js';
import { scoreTabular } from './tabular.js';
import { clampBps, type ModelScore } from './types.js';

export * from './types.js';
export { scoreHeuristic, heuristicAttack, heuristicPJitBps } from './heuristic.js';
export { scoreWithJev, parseJev, JevCache, JEV_QUESTIONS, JEV_QUESTIONS_V1, JEV_QUESTIONS_V4, JEV_QUESTIONS_V5, JEV_QUESTIONS_V6, JEV_MODEL, jevCacheKey, jevQuestions, defaultJevPrompt, type JevPrompt } from './jev.js';

export { scoreWithKev, parseKev, KEV_QUESTIONS, kevModelName, kevSize } from './kev.js';
export { scoreTabular, predictTabular, loadTabularModel, tabularInputs, tabularVersion, tabularModelName, TABULAR_FEATURES } from './tabular.js';

/**
 * kev = local fine-tuned Kev server (KEV_URL, KEV_MODEL=0.8b|4b, KEV_STATE_FORMAT=auto|kev2); tabular = LightGBM trees in-process
 * with the oniblock1 model (MODEL_MODE=tabular and MODEL_MODE=oniblock1 are the same). All fall back to the heuristic.
 */
export type ModelMode = 'auto' | 'jev' | 'heuristic' | 'kev' | 'tabular' | 'oniblock1';

export interface ScoreOpts {
  /** auto = Jev then heuristic (default); jev = Jev only (heuristic still used if Jev fails); heuristic = skip Jev. */
  mode?: ModelMode;
  degraded?: boolean;
  cache?: JevCache;
  timeoutMs?: number;
  baseIsToken0?: boolean;
  /** Jev question + state format (default v6 = one malicious score + one attack type; env JEV_PROMPT=v5|v4|v1 restores the older texts). */
  prompt?: JevPrompt;
}

/** State text format for a Jev prompt: v6 reuses the v5 text unchanged (v4 lines + liquidity lines), v4 is the k-free v4 text, v1 the original. */
export const stateFormatFor = (p: JevPrompt) => (p === 'v5' || p === 'v6' ? 'v5' : p === 'v4' ? 'v4' : 'auto');

/** Deliberately wrong transform: flip probability, claim high confidence, swap class (pJit, pMalicious and the attack head untouched: the demo degrades the arb head). */
export function degrade(s: ModelScore): ModelScore {
  return {
    ...s,
    pToxicBps: clampBps(10_000 - s.pToxicBps),
    // keep the recorded verdict consistent with the flipped score (the app shows both)
    ...(s.pMaliciousBps !== undefined ? { pMaliciousBps: clampBps(10_000 - s.pMaliciousBps) } : {}),
    confidenceBps: 9_500,
    cls: s.cls === 'informed' ? 'dump' : s.cls === 'dump' ? 'informed' : 'informed',
    degraded: true,
  };
}

/** Kev state format (env KEV_STATE_FORMAT): auto = the v1 adapter's 8-line base-fee text (default), kev2 = + the 3 v2 lines. */
export type KevStateFormat = 'auto' | 'kev2';
export const kevStateFormat = (): KevStateFormat => (env('KEV_STATE_FORMAT', 'auto') === 'kev2' ? 'kev2' : 'auto');

/**
 * State text for Kev. Kev was fine-tuned only on the base-fee wording of featuresToState (no row of
 * ml/train_kev4b/data/train.jsonl mentions the hook's arb fee), so the k-dependent fields are dropped before
 * rendering: the text is in the training distribution and does not depend on the on-chain k that Kev's own answer
 * sets (a k-dependent edge would feed back: high k -> edge < 0 -> "benign" -> k = 0 -> edge > 0 -> "toxic" ...).
 * Orientation (SPEC_v2): every training row is a USDC = token0 / WETH = token1 pool, so gapSign / imbalance are
 * mirrored into that orientation (canonicalFeatures) and the text always uses the baseIsToken0 = false wording.
 * `format` defaults to KEV_STATE_FORMAT.
 */
export function kevState(f: Features, baseIsToken0?: boolean, format: KevStateFormat = kevStateFormat()): string {
  const { kBps: _k, arbFeePips: _fee, arbThresholdPips: _thr, ...kFree } = canonicalFeatures(f, baseIsToken0);
  return featuresToState(kFree, { baseIsToken0: false, ...(format === 'kev2' ? { format: 'kev2' as const } : {}) });
}

export async function score(f: Features, opts: ScoreOpts = {}): Promise<ModelScore> {
  const mode = opts.mode ?? (env('MODEL_MODE', 'auto') as ModelMode);
  let s: ModelScore | null = null;
  if (mode === 'kev') {
    s = await scoreWithKev(kevState(f, opts.baseIsToken0), { timeoutMs: opts.timeoutMs });
  } else if (mode === 'tabular' || mode === 'oniblock1') {
    s = scoreTabular(canonicalFeatures(f, opts.baseIsToken0), undefined, mode === 'oniblock1' ? 'oniblock1' : undefined);
  } else if (mode !== 'heuristic') {
    const prompt = opts.prompt ?? defaultJevPrompt();
    s = await scoreWithJev(featuresToState(f, { baseIsToken0: opts.baseIsToken0, format: stateFormatFor(prompt) }), {
      prompt,
      cache: opts.cache,
      timeoutMs: opts.timeoutMs,
    });
  }
  if (!s) s = scoreHeuristic(f);
  return opts.degraded ? degrade(s) : s;
}
