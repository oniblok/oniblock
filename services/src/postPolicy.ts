/**
 * When the keeper should send setAttestation. Shared by services/src/keeper.ts and the benchmark simulator so both
 * post on exactly the same rule.
 *
 *   every  : post every tick (the original keeper).
 *   change : post only when the posted state would price swaps differently, plus a heartbeat:
 *     - nothing posted yet
 *     - the on-chain k the new score would produce differs from the posted k by >= kStepBps
 *     - the JIT window differs from the posted one by >= jitStepBlocks
 *     - the mid has drifted > midBps from the posted mid AND k is non-zero (posted or new). With k = 0 on both
 *       sides the fee is baseFee whatever the mid is, so a drifting mid changes nothing.
 *     - pToxic or pJit moved >= pStepBps from the posted values. The settler grades the probabilities of the
 *       attestation in force, so they must stay current even while k is pinned (unseasoned/demoted model),
 *       or the model is graded on stale answers and can never season.
 *     - heartbeatBlocks > 0 and that many blocks have passed since the last post (keep it < staleBlocks, or the
 *       pool goes stale and charges conservativeFee). 0 = no heartbeat: only safe when conservativeFee == baseFee,
 *       so a silent keeper leaves a vanilla pool.
 */
export type PostMode = 'every' | 'change';

export interface PostedState {
  block: number;
  kBps: number;
  jitWindow: number;
  midX96: bigint;
  pToxicBps: number;
  pJitBps: number;
}

export interface PostPolicy {
  mode: PostMode;
  midBps: number;
  kStepBps: number;
  jitStepBlocks: number;
  pStepBps: number;
  heartbeatBlocks: number;
}

export type PostReason = 'every' | 'first' | 'k' | 'jit' | 'p' | 'mid' | 'heartbeat' | 'skip';

export function postDecision(last: PostedState | undefined, now: PostedState, p: PostPolicy): { post: boolean; reason: PostReason } {
  if (p.mode === 'every') return { post: true, reason: 'every' };
  if (!last) return { post: true, reason: 'first' };
  if (Math.abs(now.kBps - last.kBps) >= Math.max(1, p.kStepBps)) return { post: true, reason: 'k' };
  if (Math.abs(now.jitWindow - last.jitWindow) >= Math.max(1, p.jitStepBlocks)) return { post: true, reason: 'jit' };
  const pStep = Math.max(1, p.pStepBps);
  if (Math.abs(now.pToxicBps - last.pToxicBps) >= pStep || Math.abs(now.pJitBps - last.pJitBps) >= pStep) return { post: true, reason: 'p' };
  if ((now.kBps > 0 || last.kBps > 0) && midDriftBps(last.midX96, now.midX96) > p.midBps) return { post: true, reason: 'mid' };
  if (p.heartbeatBlocks > 0 && now.block - last.block >= p.heartbeatBlocks) return { post: true, reason: 'heartbeat' };
  return { post: false, reason: 'skip' };
}

/** |now / last - 1| in bps (exact bigint ratio, then to number). */
export function midDriftBps(last: bigint, now: bigint): number {
  if (last <= 0n) return Number.POSITIVE_INFINITY;
  const d = now > last ? now - last : last - now;
  return Number((d * 1_000_000n) / last) / 100;
}
