import { describe, expect, it } from 'vitest';
import { decodeFunctionData, namehash } from 'viem';
import { calibrationMulticallData, calibrationTextRecords, dnsEncode, EnsV2CalibrationWriter, JIT_CALIBRATION_KEYS, NoopCalibrationWriter, resolverAbi } from '../src/ens.js';
import { JIT_KEY_SALT, jitCalibrationKey, type TxSender } from '../src/chain.js';
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

describe('v5: JIT head calibration records', () => {
  const rec = { brierBps: 1830, hitRateBps: 6120, n: 412, epoch: 7, rawBrierBps: 1400, skillBps: 2400, baseRateBps: 3750 };
  it('writes calibration.jit.{brier,hitRate,n,epoch,brierRaw,skill,baseRate} through the same setText multicall path', () => {
    expect(calibrationTextRecords(rec, true, 'jit').map(([k]) => k)).toEqual(JIT_CALIBRATION_KEYS);
    expect(JIT_CALIBRATION_KEYS).toEqual(['calibration.jit.brier', 'calibration.jit.hitRate', 'calibration.jit.n', 'calibration.jit.epoch', 'calibration.jit.brierRaw', 'calibration.jit.skill', 'calibration.jit.baseRate']);
    expect(calibrationTextRecords(rec, false, 'jit')).toHaveLength(4);
    const calls = calibrationMulticallData('jev-v1.models.oniblock.eth', rec, true, 'jit');
    expect(calls).toHaveLength(7);
    const d = decodeFunctionData({ abi: resolverAbi, data: calls[0]! });
    expect(d.functionName).toBe('setText');
    expect(d.args).toEqual([dnsEncode('jev-v1.models.oniblock.eth'), 'calibration.jit.brier', '1830']);
    // the arb head is untouched
    expect(calibrationTextRecords(rec, true).map(([k]) => k)).toEqual(['calibration.brier', 'calibration.hitRate', 'calibration.n', 'calibration.epoch', 'calibration.brierRaw', 'calibration.skill', 'calibration.baseRate']);
    expect(calibrationTextRecords(rec, true, 'arb')).toEqual(calibrationTextRecords(rec));
  });
  it('jitCalibrationKey = keccak256(abi.encodePacked(modelNode, keccak256("jit"))) (cast vector)', () => {
    expect(JIT_KEY_SALT).toBe('0x83660ad8f263f82d58addf6babb58c292c39f49be85833b25523715b3be73e02');
    expect(jitCalibrationKey('0x32a8db0cb3a8a2e435ad7fdcd6b92d2e61ba5c4f8276bdcb6937dde855e0cdcf')).toBe('0x2ccc4a08aeae3ff0269b307ffa9a8ac1577f1d9e79d625c8d35b87dce29111e6');
  });
  it('EnsV2CalibrationWriter: one multicall per head, detail-key fallback tracked per head', async () => {
    const sent: { label?: string; calls: number }[] = [];
    let failFirst = true;
    const fakeSender = {
      address: '0x0000000000000000000000000000000000000002',
      send: async (req: { label?: string; args: readonly unknown[] }) => {
        const calls = (req.args[0] as unknown[]).length;
        sent.push({ label: req.label, calls });
        if (failFirst && calls === 7 && req.label?.includes('calibration.jit')) {
          failFirst = false;
          return null; // EACUnauthorizedAccountRoles on a jit detail key (EnsSetup without grant-jit)
        }
        return { hash: '0xabc', status: 'success', blockNumber: 1n, gasUsed: 0n };
      },
    } as unknown as TxSender;
    const node = namehash('jev-v1.models.oniblock.eth');
    const w = new EnsV2CalibrationWriter(fakeSender, { resolver: '0x0000000000000000000000000000000000000003', namehashes: { 'jev-v1.models.oniblock.eth': node }, file: 'x' });
    expect(await w.write(node, rec, 'jit')).toBe(true);
    expect(sent.map((s) => s.calls)).toEqual([7, 4]); // jit: detail keys refused once, base keys written
    expect(await w.write(node, rec)).toBe(true);
    expect(sent[2]).toEqual({ label: 'ens calibration jev-v1.models.oniblock.eth', calls: 7 }); // arb head still writes all 7
    expect(await w.write(node, rec, 'jit')).toBe(true);
    expect(sent[3]).toEqual({ label: 'ens calibration.jit jev-v1.models.oniblock.eth', calls: 4 }); // remembered per head
    expect(await new NoopCalibrationWriter().write(node, rec, 'jit')).toBe(false);
  });
});
