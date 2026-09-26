import { describe, expect, it } from 'vitest';
import { decodeFunctionData, namehash } from 'viem';
import { calibrationMulticallData, calibrationTextRecords, dnsEncode, resolverAbi } from '../src/ens.js';
import { modelNodes } from '../src/keeper.js';

describe('ens calibration records', () => {
  it('dns-encodes like EnsV2Lib.dnsEncode', () => {
    expect(dnsEncode('a.b.eth')).toBe('0x0161016203657468' + '00');
  });
  it('builds 4 setText calls in bps units', () => {
    const rec = { brierBps: 1830, hitRateBps: 6120, n: 412, epoch: 7 };
    expect(calibrationTextRecords(rec)).toEqual([
      ['calibration.brier', '1830'], ['calibration.hitRate', '6120'], ['calibration.n', '412'], ['calibration.epoch', '7'],
    ]);
    const calls = calibrationMulticallData('jev-v1.models.oniblock.eth', rec);
    expect(calls).toHaveLength(4);
    const d = decodeFunctionData({ abi: resolverAbi, data: calls[0]! });
    expect(d.functionName).toBe('setText');
    expect(d.args).toEqual([dnsEncode('jev-v1.models.oniblock.eth'), 'calibration.brier', '1830']);
  });
  it('adds raw Brier / skill / base rate records when present', () => {
    const rec = { brierBps: 1900, hitRateBps: 7000, n: 8, epoch: 9, rawBrierBps: 1400, skillBps: 2400, baseRateBps: 3750 };
    expect(calibrationTextRecords(rec).slice(4)).toEqual([['calibration.brierRaw', '1400'], ['calibration.skill', '2400'], ['calibration.baseRate', '3750']]);
    expect(calibrationTextRecords(rec, false)).toHaveLength(4);
    expect(calibrationMulticallData('x.eth', { ...rec, skillBps: -1200 })).toHaveLength(7);
  });
  it('model nodes match the ENS setup namehashes', () => {
    const n = modelNodes();
    expect(n.primary).toBe('0x32a8db0cb3a8a2e435ad7fdcd6b92d2e61ba5c4f8276bdcb6937dde855e0cdcf');
    expect(n.fallback).toBe('0xd980c0ba3b62f0a888e318e1e91df7fc7cdaab2818956e12c7d2b573ee31f846');
    expect(n.primary).toBe(namehash('jev-v1.models.oniblock.eth'));
  });
});
