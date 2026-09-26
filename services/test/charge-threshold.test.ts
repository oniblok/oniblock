import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, namehash, type Hex } from 'viem';
import {
  ChargeThresholdPublisher,
  chargeStats,
  chargeThresholdFor,
  chargeThresholdTextValue,
  readChargeThresholdFile,
  rollingThresholdFor,
  writeChargeThresholdFile,
  type ChargeThresholdFile,
  type LabelledP,
} from '../src/chargeThreshold.js';
import { CHARGE_THRESHOLD_KEY, dnsEncode, EnsV2CalibrationWriter, NoopCalibrationWriter, resolverAbi, type CalibrationRecordWriter } from '../src/ens.js';
import type { TxSender } from '../src/chain.js';
import { applyChargeThreshold, chargeThreshold, chargeThresholdMode, resolveChargeThreshold } from '../src/keeper.js';

const B = (p: number): LabelledP => ({ p, y: 0 });
const T = (p: number): LabelledP => ({ p, y: 1 });
const tmp = () => mkdtempSync(join(tmpdir(), 'charge-'));

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('chargeThresholdFor (pure)', () => {
  it('hand case: t = the (floor(fmax * N))-th (0-indexed) largest benign p + epsilon; stats of "charge iff p >= t"', () => {
    // 20 benign 0.05..1.00 step 0.05 (desc: 1.00, 0.95, 0.90, ...), fmax 0.1 -> m = 2 -> t just above 0.90
    const benign = Array.from({ length: 20 }, (_, i) => B((i + 1) * 0.05));
    const toxic = [T(0.99), T(0.93), T(0.905), T(0.9), T(0.5)];
    const r = chargeThresholdFor([...benign, ...toxic], { fmax: 0.1, minBenign: 1 })!;
    expect(r.threshold).toBeGreaterThan(0.9);
    expect(r.threshold).toBeLessThan(0.9 + 1e-5);
    expect(r.fpr).toBe(2 / 20); // 1.00, 0.95
    expect(r.nBenign).toBe(20);
    expect(r.nToxic).toBe(5);
    expect(r.tpr).toBe(3 / 5); // 0.99, 0.93, 0.905 (0.9 == b_{m+1} is not charged)
    expect(r.precision).toBe(3 / 5);
    expect(r.coverage).toBe(5 / 25);
  });

  it('ties at b_{m+1} are all left uncharged (FPR below fmax, never above)', () => {
    const pairs = [B(0.9), B(0.8), B(0.8), B(0.8), ...Array.from({ length: 6 }, () => B(0.1)), T(0.8), T(0.85)];
    const r = chargeThresholdFor(pairs, { fmax: 0.2, minBenign: 1 })!; // m = 2, b_3 = 0.8
    expect(r.threshold).toBeGreaterThan(0.8);
    expect(r.fpr).toBe(0.1); // only 0.9
    expect(r.tpr).toBe(0.5); // 0.85 charged, 0.8 not
  });

  it('fmax 0 = above every benign p; fmax 1 = charge everything; 0.05 * 200 is exactly 10 allowed', () => {
    const pairs = [B(0.2), B(0.7), B(0.4), T(0.71), T(0.3)];
    const z = chargeThresholdFor(pairs, { fmax: 0, minBenign: 1 })!;
    expect(z.fpr).toBe(0);
    expect(z.threshold).toBeGreaterThan(0.7);
    expect(z.tpr).toBe(0.5);
    const one = chargeThresholdFor(pairs, { fmax: 1, minBenign: 1 })!;
    expect(one.threshold).toBe(0);
    expect(one.fpr).toBe(1);
    expect(one.coverage).toBe(1);
    const n200 = Array.from({ length: 200 }, (_, i) => B(i / 200));
    const r = chargeThresholdFor(n200)!; // defaults: fmax 0.05, minBenign 200
    expect(r.fpr).toBe(10 / 200);
    expect(r.threshold).toBeGreaterThan(189 / 200); // b_11 = 189/200
    expect(r.precision).toBe(0);
    expect(r.tpr).toBeNull();
  });

  it('too few benign labels -> null (default minBenign 200)', () => {
    expect(chargeThresholdFor([])).toBeNull();
    expect(chargeThresholdFor(Array.from({ length: 199 }, () => B(0.3)))).toBeNull();
    expect(chargeThresholdFor([...Array.from({ length: 5 }, () => B(0.3)), ...Array.from({ length: 500 }, () => T(0.9))], { minBenign: 6 })).toBeNull();
    expect(chargeThresholdFor(Array.from({ length: 5 }, () => B(0.3)), { minBenign: 5 })).not.toBeNull();
  });

  it('FPR guarantee on random data (continuous and bps-quantized p), and tight: one step lower would exceed fmax', () => {
    const r = rng(42);
    for (let trial = 0; trial < 300; trial++) {
      const n = 20 + Math.floor(r() * 400);
      const fmax = [0.01, 0.05, 0.07, 0.2, r()][trial % 5]!;
      const quantized = trial % 2 === 0;
      const pairs: LabelledP[] = Array.from({ length: n }, () => {
        const y = r() < 0.3 ? 1 : 0;
        let p = y ? Math.min(1, r() * 0.5 + 0.5) : r() * 0.9;
        if (quantized) p = Math.round(p * 100) / 100; // many ties
        return { p, y: y as 0 | 1 };
      });
      const res = chargeThresholdFor(pairs, { fmax, minBenign: 1 });
      const nb = pairs.filter((x) => x.y === 0).length;
      if (!nb) {
        expect(res).toBeNull();
        continue;
      }
      expect(res!.fpr).toBeLessThanOrEqual(fmax + 1e-12);
      const { threshold, ...rest } = res!;
      expect(chargeStats(pairs, threshold)).toEqual(rest);
      const benignDesc = pairs.filter((x) => x.y === 0).map((x) => x.p).sort((a, b) => b - a);
      const m = Math.floor(fmax * nb + 1e-9);
      if (m < nb) {
        // charging p >= b_{m+1} charges at least m + 1 benign > fmax * N
        expect(chargeStats(pairs, benignDesc[m]!).fpr).toBeGreaterThan(fmax);
        // and without ties at b_{m+1} the bound is attained exactly
        if (benignDesc[m - 1] === undefined || benignDesc[m - 1]! > benignDesc[m]! + 1e-6) expect(res!.fpr).toBe(m / nb);
      }
    }
  });

  it('ENS value is bps: charged iff pToxicBps >= value', () => {
    expect(chargeThresholdTextValue(null)).toBe('');
    expect(chargeThresholdTextValue(0)).toBe('0');
    expect(chargeThresholdTextValue(0.6123 + 1e-6)).toBe('6124');
    expect(chargeThresholdTextValue(0.5)).toBe('5000');
    expect(chargeThresholdTextValue(1 + 1e-6)).toBe('10001'); // above every p: never charged
  });
});

describe('ChargeThresholdPublisher (settler)', () => {
  const A = namehash('oniblock1.models.oniblock.eth');
  const Bn = namehash('heuristic-v1.models.oniblock.eth');
  const labels = (node: Hex, from: number, n: number, pBenign: (i: number) => number, everyToxic = 4) =>
    Array.from({ length: n }, (_, i) => {
      const toxic = i % everyToxic === 0;
      return { block: from + i, modelNode: node, p: toxic ? 0.95 : pBenign(i), y: (toxic ? 1 : 0) as 0 | 1 };
    });

  it('trailing window per model node -> atomic JSON file (merged, lowercase keys); too few benign -> null entry', async () => {
    const dir = tmp();
    const path = join(dir, 'sub', 'charge-threshold.json');
    const pub = new ChargeThresholdPublisher({ windowBlocks: 100, fmax: 0.05, minBenign: 20, path });
    // node A: blocks 0..199; the first 100 have benign p = 0.9 (a regime the window must forget), the last 100 p = i/200
    const old = labels(A, 0, 100, () => 0.9);
    const recent = labels(A, 100, 100, (i) => i / 200);
    const few = labels(Bn, 150, 20, () => 0.2); // 15 benign < minBenign
    const head = 200;
    const out = await pub.publish(head, [...old, ...recent, ...few]);
    const f = JSON.parse(readFileSync(path, 'utf8')) as ChargeThresholdFile;
    expect(f).toEqual(out);
    expect(Object.keys(f).sort()).toEqual([A.toLowerCase(), Bn.toLowerCase()].sort());
    const a = f[A.toLowerCase()]!;
    expect(a.nBenign).toBe(75); // window (100, 200]: blocks 101..199 (block 100 is out), 99 labels, toxic i % 4 == 0 -> 24
    expect(a.nToxic).toBe(24);
    expect(a.fromBlock).toBe(101);
    expect(a.toBlock).toBe(199);
    expect(a.fpr).toBeLessThanOrEqual(0.05);
    expect(a.threshold).toBeLessThan(0.9); // the old p = 0.9 regime is outside the window
    expect(a.tpr).toBe(1);
    expect(a.precision).toBeGreaterThan(0.85);
    expect(typeof a.updatedAt).toBe('string');
    const b = f[Bn.toLowerCase()]!;
    expect(b).toMatchObject({ threshold: null, fpr: null, precision: null, tpr: null, coverage: null, nBenign: 15, nToxic: 5, fromBlock: 150, toBlock: 169 });
    expect(readdirSync(join(dir, 'sub'))).toEqual(['charge-threshold.json']); // no tmp file left behind
    // a later settle that only sees node A keeps B's entry (merge), and a node whose window emptied gets null
    await pub.publish(1000, recent);
    const g = JSON.parse(readFileSync(path, 'utf8')) as ChargeThresholdFile;
    expect(g[Bn.toLowerCase()]).toEqual(b);
    expect(g[A.toLowerCase()]).toMatchObject({ threshold: null, nBenign: 0, nToxic: 0, fromBlock: null, toBlock: null });
  });

  it('ENS calibration.chargeThreshold: written on change only; a refusal is logged once and the file keeps being written', async () => {
    const path = join(tmp(), 'c.json');
    const writes: [Hex, [string, string][]][] = [];
    let refuse = false;
    const ens: CalibrationRecordWriter = {
      kind: 'ensv2',
      write: async () => true,
      writeText: async (node, recs) => {
        writes.push([node, recs]);
        return !refuse;
      },
    };
    const pub = new ChargeThresholdPublisher({ windowBlocks: 0, fmax: 0.05, minBenign: 20, path }, ens);
    const ls = labels(A, 0, 100, (i) => i / 100);
    await pub.publish(100, ls);
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toBe(A.toLowerCase());
    expect(writes[0]![1][0]![0]).toBe(CHARGE_THRESHOLD_KEY);
    expect(writes[0]![1][0]![1]).toMatch(/^\d+$/);
    await pub.publish(100, ls); // unchanged -> no tx
    expect(writes).toHaveLength(1);
    await pub.publish(101, labels(Bn, 0, 10, () => 0.1)); // B: null and never written -> no '' write
    expect(writes).toHaveLength(1);
    refuse = true;
    await pub.publish(200, [...ls, ...labels(A, 100, 100, () => 0.5)]); // A changes, resolver refuses
    expect(writes).toHaveLength(2);
    await pub.publish(300, [...ls, ...labels(A, 100, 150, () => 0.3)]); // disabled for A: no more attempts
    expect(writes).toHaveLength(2);
    expect(readChargeThresholdFile(path)[A.toLowerCase()]!.toBlock).toBe(249); // the file still follows
  });

  it('noop writer (no ENS deployment) and a writer without writeText are fine', async () => {
    const path = join(tmp(), 'c.json');
    await new ChargeThresholdPublisher({ windowBlocks: 0, fmax: 0.05, minBenign: 5, path }, new NoopCalibrationWriter()).publish(50, labels(A, 0, 50, (i) => i / 50));
    await new ChargeThresholdPublisher({ windowBlocks: 0, fmax: 0.05, minBenign: 5, path }, { kind: 'x', write: async () => true }).publish(50, labels(A, 0, 50, (i) => i / 50));
    expect(readChargeThresholdFile(path)[A.toLowerCase()]!.threshold).not.toBeNull();
    expect(await new ChargeThresholdPublisher({ windowBlocks: 0, fmax: 0.05, minBenign: 5, path: join(tmp(), 'none.json') }).publish(1, [])).toEqual({});
  });

  it('EnsV2CalibrationWriter.writeText: one setText multicall on the model name, separate from calibration.*', async () => {
    const sent: { label?: string; args: readonly unknown[] }[] = [];
    const sender = { address: '0x0000000000000000000000000000000000000002', send: async (req: { label?: string; args: readonly unknown[] }) => (sent.push(req), { hash: '0xabc', status: 'success', blockNumber: 1n, gasUsed: 0n }) } as unknown as TxSender;
    const name = 'oniblock1.models.oniblock.eth';
    const w = new EnsV2CalibrationWriter(sender, { resolver: '0x0000000000000000000000000000000000000003', namehashes: { [name]: A }, file: 'x' });
    expect(await w.writeText(A, [[CHARGE_THRESHOLD_KEY, '8224']])).toBe(true);
    const calls = sent[0]!.args[0] as Hex[];
    expect(calls).toHaveLength(1);
    expect(decodeFunctionData({ abi: resolverAbi, data: calls[0]! }).args).toEqual([dnsEncode(name), 'calibration.chargeThreshold', '8224']);
    expect(await w.writeText(Bn, [[CHARGE_THRESHOLD_KEY, '1']])).toBe(false); // unknown node, no tx
    expect(sent).toHaveLength(1);
  });
});

describe('keeper charge threshold resolution (fixed > rolling > fallback, unset = off)', () => {
  const node = namehash('oniblock1.models.oniblock.eth');
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ['CHARGE_THRESHOLD', 'CHARGE_THRESHOLD_FALLBACK', 'CHARGE_THRESHOLD_FILE']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const entry = (threshold: number | null) => ({ threshold, fpr: 0.05, precision: 0.95, tpr: 0.7, coverage: 0.3, nBenign: 300, nToxic: 100, fromBlock: 1, toBlock: 2, updatedAt: 'x' });

  it('mode parsing: unset/empty = off, auto, number; invalid is a ConfigError', () => {
    expect(chargeThresholdMode(undefined)).toBe('off');
    expect(chargeThresholdMode('')).toBe('off');
    expect(chargeThresholdMode('auto')).toBe('auto');
    expect(chargeThresholdMode('AUTO')).toBe('auto');
    expect(chargeThresholdMode('0.82')).toBe(0.82);
    expect(chargeThreshold('auto')).toBeUndefined(); // the fixed parser: auto is not a fixed value
    expect(() => chargeThresholdMode('rolling')).toThrow(/CHARGE_THRESHOLD/);
    expect(() => resolveChargeThreshold({ modelNode: node, raw: 'auto', fallbackRaw: '2', file: join(tmp(), 'none.json') })).toThrow(/CHARGE_THRESHOLD_FALLBACK/);
  });

  it('resolution order', () => {
    const file = join(tmp(), 'c.json');
    writeChargeThresholdFile(file, { [node]: entry(0.61) });
    const model = () => 0.8224;
    // unset = off (even with a file / fallback / model threshold)
    expect(resolveChargeThreshold({ modelNode: node, raw: undefined, file, fallbackRaw: '0.7', modelThreshold: model })).toEqual({ threshold: undefined, source: 'off' });
    // fixed wins
    expect(resolveChargeThreshold({ modelNode: node, raw: '0.4', file, fallbackRaw: '0.7', modelThreshold: model })).toEqual({ threshold: 0.4, source: 'fixed' });
    // auto: rolling (node key case-insensitive)
    expect(resolveChargeThreshold({ modelNode: node.toUpperCase().replace('0X', '0x'), raw: 'auto', file, fallbackRaw: '0.7', modelThreshold: model })).toEqual({ threshold: 0.61, source: 'rolling' });
    // no entry for this node -> env fallback -> model JSON -> none
    const other = namehash('kev-v1.models.oniblock.eth');
    expect(resolveChargeThreshold({ modelNode: other, raw: 'auto', file, fallbackRaw: '0.7', modelThreshold: model })).toEqual({ threshold: 0.7, source: 'fallback' });
    expect(resolveChargeThreshold({ modelNode: other, raw: 'auto', file, fallbackRaw: undefined, modelThreshold: model })).toEqual({ threshold: 0.8224, source: 'fallback' });
    const none = { threshold: Number.POSITIVE_INFINITY, source: 'none' };
    expect(resolveChargeThreshold({ modelNode: other, raw: 'auto', file, fallbackRaw: undefined, modelThreshold: () => { throw new Error('bad json'); } })).toEqual(none);
    expect(resolveChargeThreshold({ modelNode: other, raw: 'auto', file, fallbackRaw: undefined })).toEqual(none);
    // null entry (too few benign) -> fallback; missing file -> fallback
    writeChargeThresholdFile(file, { [node]: entry(null) });
    bumpMtime(file);
    expect(resolveChargeThreshold({ modelNode: node, raw: 'auto', file, fallbackRaw: undefined, modelThreshold: model })).toEqual({ threshold: 0.8224, source: 'fallback' });
    expect(resolveChargeThreshold({ modelNode: node, raw: 'auto', file: join(tmp(), 'missing.json'), fallbackRaw: '0.7' })).toEqual({ threshold: 0.7, source: 'fallback' });
  });

  it('env defaults: CHARGE_THRESHOLD / CHARGE_THRESHOLD_FALLBACK / CHARGE_THRESHOLD_FILE', () => {
    const file = join(tmp(), 'c.json');
    writeChargeThresholdFile(file, { [node]: entry(0.55) });
    process.env.CHARGE_THRESHOLD_FILE = file;
    delete process.env.CHARGE_THRESHOLD;
    expect(resolveChargeThreshold({ modelNode: node }).source).toBe('off');
    process.env.CHARGE_THRESHOLD = 'auto';
    expect(resolveChargeThreshold({ modelNode: node })).toEqual({ threshold: 0.55, source: 'rolling' });
    process.env.CHARGE_THRESHOLD_FALLBACK = '0.66';
    expect(resolveChargeThreshold({ modelNode: namehash('x.eth') })).toEqual({ threshold: 0.66, source: 'fallback' });
    expect(rollingThresholdFor(node)?.threshold).toBe(0.55);
  });

  it('auto with no rolling / fallback / model threshold charges nothing (vanilla pool), pToxic unchanged', () => {
    const r = resolveChargeThreshold({ modelNode: node, raw: 'auto', file: join(tmp(), 'missing.json'), fallbackRaw: undefined, modelThreshold: () => undefined });
    expect(r.source).toBe('none');
    for (const p of [0, 5000, 9999, 10_000]) {
      const s = { pToxicBps: p, confidenceBps: 10_000, pJitBps: 0, cls: 'unknown' as const, latencyMs: 0, model: 'tabular' as const };
      const g = applyChargeThreshold(s, r.threshold);
      expect(g).toMatchObject({ pToxicBps: p, confidenceBps: 0 }); // k = kMax * p * 0 = 0
    }
  });

  it('the keeper re-reads the file on mtime change (and only then)', () => {
    const file = join(tmp(), 'c.json');
    writeChargeThresholdFile(file, { [node]: entry(0.61) });
    const r = () => resolveChargeThreshold({ modelNode: node, raw: 'auto', file, fallbackRaw: undefined });
    expect(r().threshold).toBe(0.61);
    const m = readChargeThresholdFile(file);
    expect(readChargeThresholdFile(file)).toBe(m); // cached object
    writeChargeThresholdFile(file, { [node]: entry(0.72) });
    bumpMtime(file);
    expect(r()).toEqual({ threshold: 0.72, source: 'rolling' });
    // a rolling threshold above 1 (every benign p = 1) charges nothing
    const s = { pToxicBps: 10_000, confidenceBps: 10_000, pJitBps: 0, cls: 'unknown' as const, latencyMs: 0, model: 'tabular' as const };
    expect(applyChargeThreshold(s, 1 + 1e-6).confidenceBps).toBe(0);
    expect(existsSync(file)).toBe(true);
  });
});

let bump = 0;
function bumpMtime(path: string) {
  const t = new Date(Date.now() + 10_000 + ++bump * 1000);
  utimesSync(path, t, t);
}
