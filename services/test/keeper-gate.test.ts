import { describe, expect, it } from 'vitest';
import { assertGateConfig, gateDecision, keeperGateOn, RULE_SCORE } from '../src/keeper.js';

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
  it('rule score is deterministic, low pToxic', () => {
    expect(RULE_SCORE).toEqual({ pToxicBps: 1000, confidenceBps: 10000 });
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
