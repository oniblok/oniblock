import { describe, expect, it } from 'vitest';
import { midDriftBps, postDecision, type PostedState, type PostPolicy } from '../src/postPolicy.js';

const Q = 2n ** 96n;
const change: PostPolicy = { mode: 'change', midBps: 2, kStepBps: 500, jitStepBlocks: 5, pStepBps: 1000, heartbeatBlocks: 4 };
const last: PostedState = { block: 100, kBps: 3000, jitWindow: 10, midX96: Q * 10_000n, pToxicBps: 4000, pJitBps: 0 };
const at = (o: Partial<PostedState>): PostedState => ({ ...last, block: 101, ...o });

describe('keeper post policy', () => {
  it('every mode always posts', () => {
    expect(postDecision(last, at({}), { ...change, mode: 'every' })).toEqual({ post: true, reason: 'every' });
  });
  it('first post', () => {
    expect(postDecision(undefined, at({}), change).reason).toBe('first');
  });
  it('skips when nothing that prices swaps changed', () => {
    expect(postDecision(last, at({ kBps: 3499, jitWindow: 14, midX96: Q * 10_001n }), change)).toEqual({ post: false, reason: 'skip' });
  });
  it('posts on k, JIT window and mid changes', () => {
    expect(postDecision(last, at({ kBps: 3500 }), change).reason).toBe('k');
    expect(postDecision(last, at({ kBps: 2500 }), change).reason).toBe('k');
    expect(postDecision(last, at({ jitWindow: 15 }), change).reason).toBe('jit');
    expect(postDecision(last, at({ midX96: Q * 10_003n }), change).reason).toBe('mid');
  });
  it('posts when the model probabilities move, even while k is pinned (so the settler grades current answers)', () => {
    const pinned = { ...last, kBps: 0 };
    expect(postDecision(pinned, { ...pinned, block: 101, pToxicBps: 5000 }, change).reason).toBe('p');
    expect(postDecision(pinned, { ...pinned, block: 101, pToxicBps: 3000 }, change).reason).toBe('p');
    expect(postDecision(pinned, { ...pinned, block: 101, pJitBps: 1000 }, change).reason).toBe('p');
    expect(postDecision(pinned, { ...pinned, block: 101, pToxicBps: 4999, pJitBps: 999 }, change).post).toBe(false);
  });
  it('ignores mid drift while k is 0 before and after (fee = base either way)', () => {
    const calm = { ...last, kBps: 0 };
    expect(postDecision(calm, { ...calm, block: 101, midX96: Q * 10_100n }, change).post).toBe(false);
    expect(postDecision(calm, { ...calm, block: 101, midX96: Q * 10_100n, kBps: 100 }, change).reason).toBe('mid');
  });
  it('heartbeat, and heartbeat 0 = silent', () => {
    expect(postDecision(last, at({ block: 104 }), change).reason).toBe('heartbeat');
    expect(postDecision(last, at({ block: 103 }), change).post).toBe(false);
    expect(postDecision(last, at({ block: 1_000 }), { ...change, heartbeatBlocks: 0 }).post).toBe(false);
  });
  it('mid drift in bps', () => {
    expect(midDriftBps(Q * 10_000n, Q * 10_002n)).toBe(2);
    expect(midDriftBps(Q * 10_000n, Q * 9_990n)).toBe(10);
    expect(midDriftBps(0n, Q)).toBe(Number.POSITIVE_INFINITY);
  });
});
