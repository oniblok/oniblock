import { describe, expect, it } from 'vitest';
import { assertGateConfig, blendPJit, gateDecision, jitChurnWeight, JIT_CHURN_WEIGHT_DEFAULT, keeperGateOn, RULE_SCORE } from '../src/keeper.js';

describe('v3 keeper gate', () => {
  it('rule below threshold - hysteresis, model otherwise', () => {
    expect(gateDecision(0, 3300, 100)).toBe('rule');
    expect(gateDecision(3199, 3300, 100)).toBe('rule');
    expect(gateDecision(3200, 3300, 100)).toBe('model'); // inside the hysteresis band: call the model
    expect(gateDecision(3300, 3300, 100)).toBe('model');
    expect(gateDecision(9000, 3300, 100)).toBe('model');
  });
  it('no threshold (v2 pool) => always model', () => {
    expect(gateDecision(0, 0, 100)).toBe('model');
    expect(gateDecision(50, 0, 0)).toBe('model');
  });
  it('rule score is deterministic, low pToxic, no JIT signal (v5)', () => {
    expect(RULE_SCORE).toEqual({ pToxicBps: 1000, confidenceBps: 10000, pJitBps: 0 });
  });
});

describe('v4 keeper default: the model decides every block', () => {
  it('gate is OFF unless KEEPER_GATE=1', () => {
    const prev = process.env.KEEPER_GATE;
    delete process.env.KEEPER_GATE;
    expect(keeperGateOn()).toBe(false);
    process.env.KEEPER_GATE = '0';
    expect(keeperGateOn()).toBe(false);
    process.env.KEEPER_GATE = '1';
    expect(keeperGateOn()).toBe(true);
    if (prev === undefined) delete process.env.KEEPER_GATE;
    else process.env.KEEPER_GATE = prev;
  });
});

describe('never gate-on with kDefault = 0', () => {
  it('throws only for gate on + kDefault 0', () => {
    expect(() => assertGateConfig(true, 0)).toThrow(/KEEPER_GATE=1/);
    expect(() => assertGateConfig(true, 5000)).not.toThrow();
    expect(() => assertGateConfig(false, 0)).not.toThrow();
    expect(() => assertGateConfig(true, undefined)).not.toThrow();
  });
});

describe('v5 JIT head: online calibration against the observed churn (blendPJit)', () => {
  it('no adds in the last 200 blocks (churn undefined) => the model answer is posted unchanged', () => {
    expect(blendPJit(3500, undefined, 0.5)).toBe(3500);
    expect(blendPJit(0, undefined, 1)).toBe(0);
    expect(blendPJit(4300, Number.NaN, 0.5)).toBe(4300);
  });
  it('posted = round((1 - w) * pModel + w * churn * 10000): churn 0.8, model 0.35, w 0.5 => 0.575', () => {
    expect(blendPJit(3500, 0.8, 0.5)).toBe(5750);
    expect(blendPJit(3500, 1, 0.5)).toBe(6750);
    expect(blendPJit(2900, 1, 0.5)).toBe(6450); // the live-run case: every graded label was y=1, Jev said 0.29
    expect(blendPJit(3500, 0, 0.5)).toBe(1750); // adds that all stayed pull the answer down
    expect(blendPJit(3500, 0.8, 0)).toBe(3500); // w = 0: raw model
    expect(blendPJit(3500, 0.8, 1)).toBe(8000); // w = 1: churn only
    expect(blendPJit(3333, 0.5, 0.5)).toBe(4167); // rounded
  });
  it('w is clamped to [0,1]; churn to [0,1]; output to 0..10000', () => {
    expect(blendPJit(3500, 0.8, 5)).toBe(8000);
    expect(blendPJit(3500, 0.8, -1)).toBe(3500);
    expect(blendPJit(3500, 7, 0.5)).toBe(6750);
    expect(blendPJit(3500, -1, 0.5)).toBe(1750);
    expect(blendPJit(3500, 0.8, Number.NaN)).toBe(blendPJit(3500, 0.8, JIT_CHURN_WEIGHT_DEFAULT));
    expect(blendPJit(20_000, 1, 0.5)).toBe(10_000);
  });
  it('JIT_CHURN_WEIGHT env: default 0.5, clamped, unparseable => default', () => {
    expect(JIT_CHURN_WEIGHT_DEFAULT).toBe(0.5);
    expect(jitChurnWeight(undefined)).toBe(0.5);
    expect(jitChurnWeight('')).toBe(0.5);
    expect(jitChurnWeight('0.7')).toBe(0.7);
    expect(jitChurnWeight('0')).toBe(0);
    expect(jitChurnWeight('2')).toBe(1);
    expect(jitChurnWeight('-1')).toBe(0);
    expect(jitChurnWeight('abc')).toBe(0.5);
    const prev = process.env.JIT_CHURN_WEIGHT;
    try {
      process.env.JIT_CHURN_WEIGHT = '0.25';
      expect(jitChurnWeight()).toBe(0.25);
      delete process.env.JIT_CHURN_WEIGHT;
      expect(jitChurnWeight()).toBe(0.5);
    } finally {
      if (prev === undefined) delete process.env.JIT_CHURN_WEIGHT;
      else process.env.JIT_CHURN_WEIGHT = prev;
    }
  });
  it('the rule score is never blended (rule-v1 is deterministic and never graded)', () => {
    expect(RULE_SCORE.pJitBps).toBe(0);
  });
});
