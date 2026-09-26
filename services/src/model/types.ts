/** Typed model output (BUILD_SPEC). The model never outputs a fee — only a regime score. */
export type FlowClass = 'informed' | 'dump' | 'unknown';

export interface ModelScore {
  /** P(next block's arb-direction flow is informed/toxic) in bps (0..10000). */
  pToxicBps: number;
  /** Model confidence in bps (0..10000). */
  confidenceBps: number;
  cls: FlowClass;
  latencyMs: number;
  model: 'jev' | 'heuristic';
  /** true if the degraded (deliberately wrong) transform was applied — calibration-gate demo. */
  degraded?: boolean;
}

export const clampBps = (x: number) => Math.max(0, Math.min(10_000, Math.round(x)));
