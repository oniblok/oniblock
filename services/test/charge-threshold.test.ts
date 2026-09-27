import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContractFunctionExecutionError, ContractFunctionRevertedError, decodeFunctionData, encodeErrorResult, namehash, type Hex } from 'viem';
import {
  ChargeThresholdPublisher,
  chargeStats,
  chargeThresholdFor,
  chargeThresholdKey,
  chargeThresholdMaxAgeS,
  chargeThresholdTextValue,
  ensWriteDue,
  readChargeThresholdFile,
  rollingThresholdFor,
  writeChargeThresholdFile,
  type ChargeThresholdFile,
  type LabelledP,
} from '../src/chargeThreshold.js';
import { CHARGE_THRESHOLD_KEY, dnsEncode, EAC_UNAUTHORIZED_SELECTOR, EnsV2CalibrationWriter, isEnsAuthorizationError, NoopCalibrationWriter, resolverAbi, type CalibrationRecordWriter, type TextWriteResult } from '../src/ens.js';
import type { TxSender } from '../src/chain.js';
import { applyChargeThreshold, chargeRole, chargeThreshold, chargeThresholdMode, fallbackSameNodeWarning, resolveChargeThreshold } from '../src/keeper.js';

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
    expect(typeof a.updatedAt).toBe('number'); // ms
    expect(a.modelNode).toBe(A.toLowerCase());
    const b = f[Bn.toLowerCase()]!;
    expect(b).toMatchObject({ threshold: null, fpr: null, precision: null, tpr: null, coverage: null, nBenign: 15, nToxic: 5, fromBlock: 150, toBlock: 169 });
    expect(readdirSync(join(dir, 'sub'))).toEqual(['charge-threshold.json']); // no tmp file left behind
    // a later settle that only sees node A keeps B's entry (merge), and a node whose window emptied gets null
    await pub.publish(1000, recent);
    const g = JSON.parse(readFileSync(path, 'utf8')) as ChargeThresholdFile;
    expect(g[Bn.toLowerCase()]).toEqual(b);
    expect(g[A.toLowerCase()]).toMatchObject({ threshold: null, nBenign: 0, nToxic: 0, fromBlock: null, toBlock: null });
  });

  // fmax 0: t = the largest benign p + 1e-6, so benign p = x gives the ENS value ceil(x * 10000 + 0.01) = x bps + 1
  const flat = (node: Hex, x: number, n = 20) => labels(node, 0, n, () => x);

  it('ENS rate limit (pure): first value, equal, to/from empty, big move at once, small move only after the interval', () => {
    expect(ensWriteDue(undefined, '5001', 10, 100, 300)).toBe(true);
    expect(ensWriteDue(undefined, '', 10, 100, 300)).toBe(false); // never '' before a first value
    const prev = { v: '5001', head: 100 };
    expect(ensWriteDue(prev, '5001', 10_000, 100, 300)).toBe(false);
    expect(ensWriteDue(prev, '', 101, 100, 300)).toBe(true);
    expect(ensWriteDue({ v: '', head: 100 }, '5001', 101, 100, 300)).toBe(true);
    expect(ensWriteDue(prev, '5101', 101, 100, 300)).toBe(true); // |d| = 100 >= 100
    expect(ensWriteDue(prev, '4901', 101, 100, 300)).toBe(true);
    expect(ensWriteDue(prev, '5099', 399, 100, 300)).toBe(false); // small move, 299 blocks
    expect(ensWriteDue(prev, '5099', 400, 100, 300)).toBe(true); // small move, 300 blocks
  });

  it('ENS calibration.chargeThreshold: rate-limited per node (CHARGE_ENS_MIN_DELTA_BPS / _MIN_INTERVAL_BLOCKS)', async () => {
    const path = join(tmp(), 'c.json');
    const writes: [Hex, string][] = [];
    const ens: CalibrationRecordWriter = { kind: 'ensv2', write: async () => true, writeText: async (node, recs) => (writes.push([node, recs[0]![1]]), true) };
    const pub = new ChargeThresholdPublisher({ windowBlocks: 0, fmax: 0, minBenign: 5, path, ensMinDeltaBps: 100, ensMinIntervalBlocks: 300 }, ens);
    await pub.publish(100, flat(A, 0.5));
    expect(writes).toEqual([[A.toLowerCase(), '5001']]);
    await pub.publish(110, flat(A, 0.5)); // unchanged
    await pub.publish(120, flat(A, 0.505)); // +50 bps within 300 blocks: file only
    expect(writes).toHaveLength(1);
    expect(readChargeThresholdFile(path)[A.toLowerCase()]!.threshold).toBeCloseTo(0.505, 5); // the file always follows
    await pub.publish(400, flat(A, 0.505)); // 300 blocks since the last write: the small move goes out
    expect(writes.at(-1)).toEqual([A.toLowerCase(), '5051']);
    await pub.publish(410, flat(A, 0.6)); // +949 bps: at once
    expect(writes.at(-1)).toEqual([A.toLowerCase(), '6001']);
    await pub.publish(420, flat(Bn, 0.1, 3)); // B: null and never written -> no '' write
    expect(writes).toHaveLength(3);
    // defaults from env: 100 bps / 300 blocks
    const def = new ChargeThresholdPublisher({ windowBlocks: 0, fmax: 0, minBenign: 5, path }, ens);
    await def.publish(100, flat(A, 0.5));
    await def.publish(101, flat(A, 0.509)); // +90 bps, 1 block: not yet
    expect(writes).toHaveLength(4);
    await def.publish(102, flat(A, 0.51)); // +100 bps
    expect(writes).toHaveLength(5);
  });

  it('ENS: only an authorization refusal (or an unknown name) disables a node; transient failures are retried next settle', async () => {
    const path = join(tmp(), 'c.json');
    const attempts: string[] = [];
    let next: TextWriteResult | Error = true;
    const ens: CalibrationRecordWriter = {
      kind: 'ensv2',
      write: async () => true,
      writeText: async (node, recs) => {
        attempts.push(`${node === A.toLowerCase() ? 'A' : 'B'}:${recs[0]![1]}`);
        if (next instanceof Error) throw next;
        return next;
      },
    };
    const pub = new ChargeThresholdPublisher({ windowBlocks: 0, fmax: 0, minBenign: 5, path, ensMinDeltaBps: 100, ensMinIntervalBlocks: 300 }, ens);
    next = { ok: false, reason: 'failed', error: 'nonce too low' };
    await pub.publish(100, flat(A, 0.5));
    next = new Error('fetch failed'); // a throwing writer is transient too
    await pub.publish(101, flat(A, 0.5));
    next = false; // bare false (reason unknown) = transient
    await pub.publish(102, flat(A, 0.5));
    next = true;
    await pub.publish(103, flat(A, 0.5));
    await pub.publish(104, flat(A, 0.5)); // written at 103: nothing more to do
    expect(attempts).toEqual(['A:5001', 'A:5001', 'A:5001', 'A:5001']);
    next = { ok: false, reason: 'unauthorized', error: 'EACUnauthorizedAccountRoles' };
    await pub.publish(200, flat(A, 0.7)); // big move, resolver refuses the role
    await pub.publish(300, flat(A, 0.9)); // disabled for A: no more attempts
    expect(attempts).toHaveLength(5);
    expect(readChargeThresholdFile(path)[A.toLowerCase()]!.threshold).toBeCloseTo(0.9, 5); // the file still follows
    next = { ok: false, reason: 'unknown_node' };
    await pub.publish(301, flat(Bn, 0.4));
    await pub.publish(302, flat(Bn, 0.8));
    expect(attempts.slice(5)).toEqual(['B:4001']);
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
    expect(await w.writeText(Bn, [[CHARGE_THRESHOLD_KEY, '1']])).toEqual({ ok: false, reason: 'unknown_node' }); // no tx
    expect(sent).toHaveLength(1);
  });

  it('EnsV2CalibrationWriter.writeText classifies a failed send: permission revert -> unauthorized, anything else -> failed', async () => {
    const name = 'oniblock1.models.oniblock.eth';
    const revert = new ContractFunctionExecutionError(
      new ContractFunctionRevertedError({
        abi: resolverAbi,
        functionName: 'multicall',
        data: encodeErrorResult({ abi: resolverAbi, errorName: 'EACUnauthorizedAccountRoles', args: [1n, 2n, '0x0000000000000000000000000000000000000002'] }),
      }),
      { abi: resolverAbi, functionName: 'multicall', args: [[]] },
    );
    const writerFailingWith = (err: unknown) =>
      new EnsV2CalibrationWriter(
        { address: '0x0000000000000000000000000000000000000002', send: async (req: { onError?: (e: unknown) => void }) => (req.onError?.(err), null) } as unknown as TxSender,
        { resolver: '0x0000000000000000000000000000000000000003', namehashes: { [name]: A }, file: 'x' },
      );
    expect(isEnsAuthorizationError(revert)).toBe(true);
    expect(await writerFailingWith(revert).writeText(A, [[CHARGE_THRESHOLD_KEY, '1']])).toMatchObject({ ok: false, reason: 'unauthorized' });
    // an undecoded revert carrying the raw selector is recognised too
    expect(isEnsAuthorizationError({ shortMessage: 'reverted', cause: { data: `${EAC_UNAUTHORIZED_SELECTOR}00ff` } })).toBe(true);
    for (const e of [new Error('nonce too low'), new Error('fetch failed'), new Error('insufficient funds for gas'), undefined]) {
      expect(isEnsAuthorizationError(e)).toBe(false);
      expect(await writerFailingWith(e).writeText(A, [[CHARGE_THRESHOLD_KEY, '1']])).toMatchObject({ ok: false, reason: 'failed' });
    }
  });

  it('file identity: two pools (and chains) sharing a file never clobber each other; the settler writes the scoped shape', async () => {
    const path = join(tmp(), 'c.json');
    const P1 = '0x' + '11'.repeat(32);
    const P2 = '0x' + '22'.repeat(32);
    const pub1 = new ChargeThresholdPublisher({ windowBlocks: 0, fmax: 0, minBenign: 5, path, scope: { chainId: 1, poolId: P1 } });
    const pub2 = new ChargeThresholdPublisher({ windowBlocks: 0, fmax: 0, minBenign: 5, path, scope: { chainId: 1, poolId: P2 } });
    const pub3 = new ChargeThresholdPublisher({ windowBlocks: 0, fmax: 0, minBenign: 5, path, scope: { chainId: 11155111, poolId: P1 } });
    const now = new Date(1_700_000_000_000);
    await pub1.publish(10, flat(A, 0.5), now);
    await pub2.publish(10, flat(A, 0.7), now);
    await pub3.publish(10, flat(A, 0.9), now);
    const f = JSON.parse(readFileSync(path, 'utf8')) as ChargeThresholdFile;
    expect(Object.keys(f).sort()).toEqual([`1:${P1}:${A.toLowerCase()}`, `1:${P2}:${A.toLowerCase()}`, `11155111:${P1}:${A.toLowerCase()}`].sort());
    expect(f[chargeThresholdKey(A, { chainId: 1, poolId: P1 })]).toMatchObject({ chainId: 1, poolId: P1, modelNode: A.toLowerCase(), updatedAt: now.getTime() });
    const at = (chainId: number, poolId: string) => rollingThresholdFor(A, path, { scope: { chainId, poolId }, nowMs: now.getTime() })?.threshold;
    expect(at(1, P1)).toBeCloseTo(0.5, 5);
    expect(at(1, P2.toUpperCase().replace('0X', '0x'))).toBeCloseTo(0.7, 5); // case-insensitive
    expect(at(11155111, P1)).toBeCloseTo(0.9, 5);
    expect(at(1, '0x' + '33'.repeat(32))).toBeUndefined(); // another pool: nothing (no legacy entry)
  });

  it('legacy modelNode-only files are still read; a scoped write replaces the legacy key of the same node', () => {
    const path = join(tmp(), 'c.json');
    const P1 = '0x' + '11'.repeat(32);
    const legacy = { threshold: 0.42, fpr: 0.05, precision: 0.9, tpr: 0.7, coverage: 0.2, nBenign: 300, nToxic: 90, fromBlock: 1, toBlock: 2, updatedAt: new Date().toISOString() };
    writeChargeThresholdFile(path, { [A]: legacy });
    expect(rollingThresholdFor(A, path)?.threshold).toBe(0.42);
    expect(rollingThresholdFor(A, path, { scope: { chainId: 1, poolId: P1 } })).toMatchObject({ threshold: 0.42, key: A.toLowerCase() });
    writeChargeThresholdFile(path, { [chargeThresholdKey(A, { chainId: 1, poolId: P1 })]: { ...legacy, threshold: 0.6, updatedAt: Date.now(), chainId: 1, poolId: P1, modelNode: A.toLowerCase() } });
    bumpMtime(path);
    const f = readChargeThresholdFile(path);
    expect(f[A.toLowerCase()]).toBeUndefined();
    expect(rollingThresholdFor(A, path, { scope: { chainId: 1, poolId: P1 } })?.threshold).toBe(0.6);
  });
});

describe('keeper charge threshold resolution (fixed > rolling > fallback, unset = off)', () => {
  const node = namehash('oniblock1.models.oniblock.eth');
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ['CHARGE_THRESHOLD', 'CHARGE_THRESHOLD_FALLBACK', 'CHARGE_THRESHOLD_FILE', 'CHARGE_THRESHOLD_MAX_AGE_S']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const entry = (threshold: number | null, updatedAt: number | string = Date.now()) => ({ threshold, fpr: 0.05, precision: 0.95, tpr: 0.7, coverage: 0.3, nBenign: 300, nToxic: 100, fromBlock: 1, toBlock: 2, updatedAt });

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

  it('a stale entry (older than CHARGE_THRESHOLD_MAX_AGE_S, default 3600 s) falls back: env fallback, model JSON, else none', () => {
    const file = join(tmp(), 'c.json');
    const now = Date.now();
    writeChargeThresholdFile(file, { [node]: entry(0.61, now - 3601_000) });
    expect(chargeThresholdMaxAgeS(undefined)).toBe(3600);
    expect(resolveChargeThreshold({ modelNode: node, raw: 'auto', file, fallbackRaw: '0.7', nowMs: now })).toEqual({ threshold: 0.7, source: 'fallback' });
    expect(resolveChargeThreshold({ modelNode: node, raw: 'auto', file, fallbackRaw: undefined, modelThreshold: () => 0.8224, nowMs: now })).toEqual({ threshold: 0.8224, source: 'fallback' });
    expect(resolveChargeThreshold({ modelNode: node, raw: 'auto', file, fallbackRaw: undefined, nowMs: now })).toEqual({ threshold: Number.POSITIVE_INFINITY, source: 'none' });
    // just inside the limit it is used; env knob; <= 0 disables the limit
    expect(resolveChargeThreshold({ modelNode: node, raw: 'auto', file, fallbackRaw: undefined, nowMs: now - 2_000 })).toEqual({ threshold: 0.61, source: 'rolling' });
    process.env.CHARGE_THRESHOLD_MAX_AGE_S = '7200';
    expect(resolveChargeThreshold({ modelNode: node, raw: 'auto', file, fallbackRaw: undefined, nowMs: now }).source).toBe('rolling');
    expect(resolveChargeThreshold({ modelNode: node, raw: 'auto', file, fallbackRaw: undefined, nowMs: now, maxAgeS: 0 }).source).toBe('rolling');
    // no readable timestamp = stale; a legacy ISO timestamp is parsed
    writeChargeThresholdFile(file, { [node]: entry(0.61, 'x') });
    bumpMtime(file);
    expect(resolveChargeThreshold({ modelNode: node, raw: 'auto', file, fallbackRaw: undefined, nowMs: now }).source).toBe('none');
    writeChargeThresholdFile(file, { [node]: entry(0.61, new Date(now - 60_000).toISOString()) });
    bumpMtime(file);
    expect(resolveChargeThreshold({ modelNode: node, raw: 'auto', file, fallbackRaw: undefined, nowMs: now }).source).toBe('rolling');
  });

  it('a non-primary model is never gated by a fixed / fallback / model-JSON threshold (different p scale)', () => {
    const file = join(tmp(), 'c.json');
    const primary = node;
    const fb = namehash('heuristic-v1.models.oniblock.eth');
    expect(chargeRole(primary, primary, 'kev')).toBe('primary');
    expect(chargeRole(primary.toUpperCase().replace('0X', '0x'), primary, 'jev')).toBe('primary');
    expect(chargeRole(fb, primary, 'heuristic')).toBe('fallback');
    expect(chargeRole(primary, primary, 'heuristic')).toBe('shared'); // FALLBACK_SAME_NODE=1
    const model = () => 0.8224;
    const none = { threshold: Number.POSITIVE_INFINITY, source: 'none' };
    // fixed: the primary gets it, the fallback node does not (no entry of its own -> charges nothing)
    expect(resolveChargeThreshold({ modelNode: primary, role: 'primary', raw: '0.4', file })).toEqual({ threshold: 0.4, source: 'fixed' });
    expect(resolveChargeThreshold({ modelNode: fb, role: 'fallback', raw: '0.4', file })).toEqual(none);
    // auto: env fallback / model JSON apply to the primary only
    expect(resolveChargeThreshold({ modelNode: fb, role: 'fallback', raw: 'auto', file, fallbackRaw: '0.7', modelThreshold: model })).toEqual(none);
    expect(resolveChargeThreshold({ modelNode: primary, role: 'primary', raw: 'auto', file, fallbackRaw: '0.7', modelThreshold: model })).toEqual({ threshold: 0.7, source: 'fallback' });
    // the fallback node's own rolling entry does gate it (fixed or auto)
    writeChargeThresholdFile(file, { [fb]: entry(0.33), [primary]: entry(0.61) });
    bumpMtime(file);
    expect(resolveChargeThreshold({ modelNode: fb, role: 'fallback', raw: 'auto', file, fallbackRaw: '0.7' })).toEqual({ threshold: 0.33, source: 'rolling' });
    expect(resolveChargeThreshold({ modelNode: fb, role: 'fallback', raw: '0.4', file })).toEqual({ threshold: 0.33, source: 'rolling' });
    // shared node: the entry is the primary's -> charges nothing; unset stays off for every role
    expect(resolveChargeThreshold({ modelNode: primary, role: 'shared', raw: 'auto', file, fallbackRaw: '0.7', modelThreshold: model })).toEqual(none);
    expect(resolveChargeThreshold({ modelNode: primary, role: 'shared', raw: '0.4', file })).toEqual(none);
    for (const role of ['primary', 'fallback', 'shared'] as const) expect(resolveChargeThreshold({ modelNode: fb, role, raw: undefined, file }).source).toBe('off');
  });

  it('startup warning: FALLBACK_SAME_NODE=1 with CHARGE_THRESHOLD=auto (the settler mixes both models under the primary node)', () => {
    const env = (e: Record<string, string>) => (n: string) => e[n];
    expect(fallbackSameNodeWarning(env({ FALLBACK_SAME_NODE: '1', CHARGE_THRESHOLD: 'auto' }))?.code).toBe('charge_threshold_shared_node');
    expect(fallbackSameNodeWarning(env({ FALLBACK_SAME_NODE: '1', CHARGE_THRESHOLD: '0.8' }))).toBeUndefined();
    expect(fallbackSameNodeWarning(env({ CHARGE_THRESHOLD: 'auto' }))).toBeUndefined();
  });

  it('auto with no rolling / fallback / model threshold charges nothing (vanilla pool), pToxic unchanged', () => {
    const r = resolveChargeThreshold({ modelNode: node, raw: 'auto', file: join(tmp(), 'missing.json'), fallbackRaw: undefined, modelThreshold: () => undefined });
    expect(r.source).toBe('none');
    for (const p of [0, 5000, 9999, 10_000]) {
      const s = { pToxicBps: p, confidenceBps: 10_000, pJitBps: 0, cls: 'unknown' as const, latencyMs: 0, model: 'kev' as const };
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
    const s = { pToxicBps: 10_000, confidenceBps: 10_000, pJitBps: 0, cls: 'unknown' as const, latencyMs: 0, model: 'kev' as const };
    expect(applyChargeThreshold(s, 1 + 1e-6).confidenceBps).toBe(0);
    expect(existsSync(file)).toBe(true);
  });
});

let bump = 0;
function bumpMtime(path: string) {
  const t = new Date(Date.now() + 10_000 + ++bump * 1000);
  utimesSync(path, t, t);
}
