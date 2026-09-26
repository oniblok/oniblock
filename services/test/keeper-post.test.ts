import { describe, expect, it } from 'vitest';
import { KEEPER_POST_DEFAULTS, keeperHeartbeatDefault, keeperPostPolicy, postedFromPoolState, predictedK } from '../src/keeper.js';
import { postDecision } from '../src/postPolicy.js';

const envOf = (e: Record<string, string>) => (n: string) => e[n];
const fees = { baseFee: 3000, conservativeFee: 3000 };

describe('keeperPostPolicy (KEEPER_POST* env)', () => {
  it('defaults to every, ignoring the other knobs and warning about nothing', () => {
    const r = keeperPostPolicy(5, fees, envOf({ KEEPER_HEARTBEAT_BLOCKS: '99', KEEPER_POST_K_BPS: 'x' }));
    expect(r.policy.mode).toBe('every');
    expect(r.warnings).toEqual([]);
  });
  it('unknown mode => every + warning', () => {
    const r = keeperPostPolicy(5, fees, envOf({ KEEPER_POST: 'sometimes' }));
    expect(r.policy.mode).toBe('every');
    expect(r.warnings.map((w) => w.code)).toEqual(['keeper_post_invalid']);
  });
  it('change mode defaults: mid 2 bps, k 500 bps, jit 5 blocks, heartbeat staleBlocks - 2 (one block of slack)', () => {
    const r = keeperPostPolicy(5, fees, envOf({ KEEPER_POST: 'change' }));
    expect(r.policy).toEqual({ mode: 'change', ...KEEPER_POST_DEFAULTS, heartbeatBlocks: 3 });
    expect(KEEPER_POST_DEFAULTS).toEqual({ midBps: 2, kStepBps: 500, jitStepBlocks: 5, pStepBps: 1000 });
    expect(r.warnings).toEqual([]);
    expect(keeperPostPolicy(20, fees, envOf({ KEEPER_POST: 'change' })).policy.heartbeatBlocks).toBe(18);
    expect([1, 2, 3, 4, 5].map(keeperHeartbeatDefault)).toEqual([1, 1, 1, 2, 3]);
  });
  it('reads the knobs; invalid numbers fall back to the default with a warning', () => {
    const r = keeperPostPolicy(10, fees, envOf({ KEEPER_POST: 'change', KEEPER_POST_MID_BPS: '0.5', KEEPER_POST_K_BPS: '100', KEEPER_POST_JIT_BLOCKS: '-3', KEEPER_HEARTBEAT_BLOCKS: '3' }));
    expect(r.policy).toEqual({ mode: 'change', midBps: 0.5, kStepBps: 100, jitStepBlocks: 5, pStepBps: 1000, heartbeatBlocks: 3 });
    expect(r.warnings).toEqual([expect.objectContaining({ code: 'keeper_post_invalid', name: 'KEEPER_POST_JIT_BLOCKS' })]);
  });
  it('heartbeat >= staleBlocks is clamped to the default staleBlocks - 2 with a warning; an explicit staleBlocks - 1 is kept', () => {
    for (const hb of ['5', '6', '100']) {
      const r = keeperPostPolicy(5, fees, envOf({ KEEPER_POST: 'change', KEEPER_HEARTBEAT_BLOCKS: hb }));
      expect(r.policy.heartbeatBlocks).toBe(3);
      expect(r.warnings).toEqual([expect.objectContaining({ code: 'keeper_heartbeat_clamped', requested: Number(hb), staleBlocks: 5, using: 3 })]);
    }
    const explicit = keeperPostPolicy(5, fees, envOf({ KEEPER_POST: 'change', KEEPER_HEARTBEAT_BLOCKS: '4' }));
    expect(explicit.warnings).toEqual([]);
    expect(explicit.policy.heartbeatBlocks).toBe(4);
  });
  it('heartbeat 0 = off; warned only when conservativeFee != baseFee', () => {
    const off = { KEEPER_POST: 'change', KEEPER_HEARTBEAT_BLOCKS: '0' };
    const same = keeperPostPolicy(5, { baseFee: 3000, conservativeFee: 3000 }, envOf(off));
    expect(same.policy.heartbeatBlocks).toBe(0);
    expect(same.warnings).toEqual([]);
    const higher = keeperPostPolicy(5, { baseFee: 3000, conservativeFee: 5000 }, envOf(off));
    expect(higher.policy.heartbeatBlocks).toBe(0);
    expect(higher.warnings).toEqual([expect.objectContaining({ code: 'keeper_heartbeat_off', conservativeFee: 5000, baseFee: 3000 })]);
    // unknown conservativeFee: nothing to compare, no warning
    expect(keeperPostPolicy(5, { baseFee: 3000 }, envOf(off)).warnings).toEqual([]);
  });
  it('staleBlocks = 1: the heartbeat still defaults to 1, never silently to 0 (= off)', () => {
    expect(keeperPostPolicy(1, fees, envOf({ KEEPER_POST: 'change' })).policy.heartbeatBlocks).toBe(1);
  });
});

describe('predictedK (setAttestation k: demotion immediate, else maxKStepBps step limit)', () => {
  const base = { kDefaultBps: 5000, maxKStepBps: 1000 };
  it('demoted => kDefault at once, whatever the stored k and step limit', () => {
    expect(predictedK({ ...base, demoted: true, targetBps: 5000, curBps: 9000 })).toBe(5000);
    expect(predictedK({ ...base, demoted: true, targetBps: 5000, curBps: 0 })).toBe(5000);
  });
  it('steps at most maxKStepBps toward the target, in both directions', () => {
    expect(predictedK({ ...base, demoted: false, targetBps: 8000, curBps: 2000 })).toBe(3000);
    expect(predictedK({ ...base, demoted: false, targetBps: 1000, curBps: 7000 })).toBe(6000);
  });
  it('reaches the target when within one step (boundary: exactly one step)', () => {
    expect(predictedK({ ...base, demoted: false, targetBps: 3000, curBps: 2000 })).toBe(3000);
    expect(predictedK({ ...base, demoted: false, targetBps: 1000, curBps: 2000 })).toBe(1000);
    expect(predictedK({ ...base, demoted: false, targetBps: 2400, curBps: 2400 })).toBe(2400);
  });
  it('v4 profile (maxKStep = kMax = 8000): the target is reached in one post', () => {
    expect(predictedK({ demoted: false, kDefaultBps: 0, maxKStepBps: 8000, targetBps: 8000, curBps: 0 })).toBe(8000);
  });
});

describe('postedFromPoolState (on-chain `last`)', () => {
  const st = { kBps: 3000, jitWindow: 40, oracleMidX96: 123n << 96n, lastAttestBlock: 100n, pToxicBps: 4000, pJitBps: 500 };
  const cfg = { kDefaultBps: 0, jitWindowDefault: 10 };
  it('nothing attested yet => undefined (policy: first)', () => {
    expect(postedFromPoolState({ ...st, lastAttestBlock: 0n }, true, cfg)).toBeUndefined();
  });
  it('fresh: the stored k, window, mid; block = lastAttestBlock', () => {
    expect(postedFromPoolState(st, false, cfg)).toEqual({ block: 100, kBps: 3000, jitWindow: 40, midX96: 123n << 96n, pToxicBps: 4000, pJitBps: 500 });
  });
  it('stale: kDefault / jitWindowDefault are in force, the stored mid and block are kept', () => {
    expect(postedFromPoolState(st, true, cfg)).toEqual({ block: 100, kBps: 0, jitWindow: 10, midX96: 123n << 96n, pToxicBps: 4000, pJitBps: 500 });
    expect(postedFromPoolState(st, true, {})).toEqual({ block: 100, kBps: 3000, jitWindow: 40, midX96: 123n << 96n, pToxicBps: 4000, pJitBps: 500 });
  });
});

describe('keeper change-mode decision (pure pieces composed as in Keeper.tick)', () => {
  const policy = keeperPostPolicy(5, fees, envOf({ KEEPER_POST: 'change' })).policy;
  const mid = 2000n << 96n;
  const chain = { kBps: 4000, jitWindow: 10, oracleMidX96: mid, lastAttestBlock: 100n, pToxicBps: 5000, pJitBps: 0 };
  const decide = (demoted: boolean, target: number, block = 101, jit = 10, pToxicBps = 5000) => {
    const last = postedFromPoolState(chain, false, { kDefaultBps: 0, jitWindowDefault: 10 });
    const kBps = predictedK({ demoted, targetBps: target, curBps: chain.kBps, kDefaultBps: 0, maxKStepBps: 8000 });
    return postDecision(last, { block, kBps, jitWindow: jit, midX96: mid, pToxicBps, pJitBps: 0 }, policy);
  };
  it('same k, same window, same mid, heartbeat not due => skip', () => {
    expect(decide(false, 4100)).toEqual({ post: false, reason: 'skip' });
  });
  it('audit finding: the model is demoted while its k is stored => predicted kDefault => post (k)', () => {
    expect(decide(true, 0)).toEqual({ post: true, reason: 'k' });
  });
  it('default heartbeat fires at observed block lastAttestBlock + staleBlocks - 2: attests L + s - 1, one block of slack', () => {
    expect(decide(false, 4000, 102).post).toBe(false);
    expect(decide(false, 4000, 103)).toEqual({ post: true, reason: 'heartbeat' });
  });
  it('slack: the heartbeat attestation (target N + 1) stays fresh-covering even when mined one block late', () => {
    // Hook: stale at block B iff B - lastAttestBlock > staleBlocks; setAttestation accepts a.blockNumber in {B - 1, B}.
    const s = 5;
    const L = 100;
    const hb = keeperHeartbeatDefault(s);
    const target = L + hb + 1; // observed N = L + hb, attests N + 1
    for (const minedAt of [target, target + 1]) {
      // every block up to and including the one the tx lands in is fresh under the OLD attestation
      for (let b = L + 1; b <= minedAt; b++) expect(b - L > s).toBe(false);
    }
    // with the old default (s - 1) a one-block delay made the landing block stale
    const oldTarget = L + (s - 1) + 1;
    expect(oldTarget + 1 - L > s).toBe(true);
  });
  it('unseasoned/demoted model (k pinned at kDefault): a 10-point pToxic move still posts, so the settler grades current answers', () => {
    expect(decide(true, 0, 101, 10, 5000).reason).toBe('k'); // demotion itself: k 4000 -> 0
    const pinned = { ...chain, kBps: 0 };
    const last = postedFromPoolState(pinned, false, { kDefaultBps: 0, jitWindowDefault: 10 });
    expect(postDecision(last, { block: 101, kBps: 0, jitWindow: 10, midX96: mid, pToxicBps: 6000, pJitBps: 0 }, policy)).toEqual({ post: true, reason: 'p' });
    expect(postDecision(last, { block: 101, kBps: 0, jitWindow: 10, midX96: mid, pToxicBps: 5500, pJitBps: 0 }, policy).post).toBe(false);
  });
  it('JIT window move >= 5 blocks => post (jit)', () => {
    expect(decide(false, 4000, 101, 15)).toEqual({ post: true, reason: 'jit' });
  });
});
