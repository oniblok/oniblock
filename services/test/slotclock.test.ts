import { describe, expect, it } from 'vitest';
import { BlockTimeEstimator, blockTimeEnvMs, broadcastLeadMs, expectedMidAgeMs, firstInBlock, readLagMs, readLeadMs, SlotScheduler, slotDelayMs, slotMode, type Timers } from '../src/slotclock.js';

/** Manual clock: timers fire only on advance(). */
function fakeTimers(start = 0) {
  let now = start;
  let id = 0;
  const q = new Map<number, { at: number; fn: () => void }>();
  const t: Timers & { advance: (ms: number) => void; pending: () => number } = {
    now: () => now,
    setTimeout: (fn, ms) => (q.set(++id, { at: now + ms, fn }), id),
    clearTimeout: (h) => void q.delete(h as number),
    advance(ms) {
      now += ms;
      for (const [k, v] of [...q.entries()].sort((a, b) => a[1].at - b[1].at)) if (v.at <= now) (q.delete(k), v.fn());
    },
    pending: () => q.size,
  };
  return t;
}

const TS = 1_780_000_000_000; // ts_N (ms)

describe('slot clock helpers', () => {
  it('delay = ts_N + blockTime - lead - now, floored at 0', () => {
    expect(slotDelayMs({ blockTsMs: TS, nowMs: TS + 1500, leadMs: 1000, blockTimeMs: 12_000 })).toBe(9500); // read at ts_N + 11 s
    expect(slotDelayMs({ blockTsMs: TS, nowMs: TS + 11_000, leadMs: 1000, blockTimeMs: 12_000 })).toBe(0);
    expect(slotDelayMs({ blockTsMs: TS, nowMs: TS + 13_000, leadMs: 1000, blockTimeMs: 12_000 })).toBe(0); // late: tick now
    expect(slotDelayMs({ blockTsMs: TS, nowMs: TS + 300, leadMs: 500, blockTimeMs: 2000 })).toBe(1200); // local 2 s blocks
  });
  it('readLag and the expected mid age at N+2 (arrival vs slot mode)', () => {
    expect(readLagMs(TS + 1500, TS)).toBe(1500);
    expect(expectedMidAgeMs(TS + 1500, TS, 12_000)).toBe(22_500); // today: read on arrival -> ~22 s old at N+2
    expect(expectedMidAgeMs(TS + 11_000, TS, 12_000)).toBe(13_000); // slot mode, lead 1 s -> blockTime + lead
  });
  it('env parsing: unset = off; invalid throws', () => {
    expect(readLeadMs(undefined)).toBeUndefined();
    expect(readLeadMs('')).toBeUndefined();
    expect(readLeadMs('800')).toBe(800);
    expect(readLeadMs('0')).toBe(0);
    for (const bad of ['-1', 'x']) expect(() => readLeadMs(bad)).toThrow(/KEEPER_READ_LEAD_MS/);
    expect(blockTimeEnvMs(undefined)).toBeUndefined();
    expect(blockTimeEnvMs('2000')).toBe(2000);
    for (const bad of ['0', '-5', 'y']) expect(() => blockTimeEnvMs(bad)).toThrow(/KEEPER_BLOCK_TIME_MS/);
  });
  it('block time estimator: fallback until two blocks, then (dts / dn)', () => {
    const e = new BlockTimeEstimator(12_000);
    expect(e.value()).toBe(12_000);
    e.observe(10, TS);
    expect(e.value()).toBe(12_000);
    e.observe(12, TS + 4000);
    expect(e.value()).toBe(2000);
    e.observe(11, TS + 1000); // older block: ignored
    expect(e.value()).toBe(2000);
  });
});

describe('SlotScheduler', () => {
  const setup = (lead = 1000, bt = 12_000) => {
    const t = fakeTimers(TS + 1500); // block N arrives 1.5 s after ts_N
    const fired: [number, number][] = [];
    const s = new SlotScheduler({ leadMs: lead, blockTimeMs: () => bt, fire: (b, ts) => fired.push([b, ts]) }, t);
    return { t, fired, s };
  };
  it('fires once at ts_N + blockTime - lead', () => {
    const { t, fired, s } = setup();
    expect(s.arm(100, TS)).toEqual({ armed: true, block: 100, delayMs: 9500 });
    t.advance(9499);
    expect(fired).toEqual([]);
    t.advance(1);
    expect(fired).toEqual([[100, TS]]);
    expect(s.pendingBlock()).toBeUndefined();
    expect(t.pending()).toBe(0);
  });
  it('a newer block before the timer cancels the pending tick and re-arms from the new block', () => {
    const { t, fired, s } = setup();
    s.arm(100, TS);
    t.advance(3000); // block 101 arrives early (now = ts_N + 4.5 s; its ts = ts_N + 4 s)
    expect(s.arm(101, TS + 4000)).toEqual({ armed: true, block: 101, delayMs: 10_500, replaced: 100 });
    expect(t.pending()).toBe(1);
    t.advance(10_500);
    expect(fired).toEqual([[101, TS + 4000]]); // 100 never fired
  });
  it('never fires a block twice: duplicate and stale arms are ignored', () => {
    const { t, fired, s } = setup();
    s.arm(100, TS);
    expect(s.arm(100, TS)).toEqual({ armed: false, block: 100, reason: 'duplicate' });
    t.advance(9500);
    expect(s.arm(100, TS)).toEqual({ armed: false, block: 100, reason: 'duplicate' }); // re-emitted after firing
    expect(s.arm(99, TS - 12_000)).toEqual({ armed: false, block: 99, reason: 'stale' });
    t.advance(60_000);
    expect(fired).toEqual([[100, TS]]);
  });
  it('late arrival (past the read time) fires immediately; cancel() drops the pending tick', () => {
    const { t, fired, s } = setup();
    t.advance(12_000); // now = ts_N + 13.5 s
    expect(s.arm(100, TS)).toMatchObject({ delayMs: 0 });
    t.advance(0);
    expect(fired).toEqual([[100, TS]]);
    s.arm(101, TS + 12_000);
    s.cancel();
    t.advance(60_000);
    expect(fired).toEqual([[100, TS]]);
  });
});

describe('first-in-block mode (KEEPER_FIRST_IN_BLOCK)', () => {
  it('env parsing: off by default, 1/true on, anything else throws; it needs a lead', () => {
    for (const off of [undefined, '', '0', 'false', ' 0 ']) expect(firstInBlock(off)).toBe(false);
    for (const on of ['1', 'true', 'TRUE']) expect(firstInBlock(on)).toBe(true);
    for (const bad of ['2', 'yes', 'x']) expect(() => firstInBlock(bad)).toThrow(/KEEPER_FIRST_IN_BLOCK/);
    expect(slotMode({ lead: undefined, first: undefined })).toEqual({ leadMs: undefined, firstInBlock: false }); // defaults unchanged
    expect(slotMode({ lead: '2000', first: undefined })).toEqual({ leadMs: 2000, firstInBlock: false });
    expect(slotMode({ lead: '2000', first: '1' })).toEqual({ leadMs: 2000, firstInBlock: true });
    expect(() => slotMode({ lead: undefined, first: '1' })).toThrow(/needs KEEPER_READ_LEAD_MS/);
    expect(() => slotMode({ lead: '', first: '1' })).toThrow(/needs KEEPER_READ_LEAD_MS/);
  });
  it('expected mid age: ~lead at N+1 (tx at the top of N+1) instead of blockTime + lead at N+2', () => {
    const read = TS + 10_000; // lead 2 s, 12 s blocks
    expect(expectedMidAgeMs(read, TS, 12_000, true)).toBe(2000);
    expect(expectedMidAgeMs(read, TS, 12_000, false)).toBe(14_000); // default accounting unchanged
    expect(expectedMidAgeMs(read, TS, 12_000)).toBe(14_000);
    expect(expectedMidAgeMs(TS + 10_300, TS, 12_000, true)).toBe(1700); // read 300 ms late -> 300 ms fresher
    expect(expectedMidAgeMs(TS + 1500, TS, 12_000, true)).toBe(10_500); // on-arrival read: a whole slot old
  });
  it('broadcast lead = ts_N + blockTime - broadcast (negative = after the expected next block)', () => {
    expect(broadcastLeadMs(TS + 10_800, TS, 12_000)).toBe(1200); // read at -2 s, 800 ms read->send latency
    expect(broadcastLeadMs(TS + 12_000, TS, 12_000)).toBe(0);
    expect(broadcastLeadMs(TS + 12_400, TS, 12_000)).toBe(-400);
  });
  it('schedule: block N arriving 1.5 s after ts_N, lead 2 s -> read + send at ts_N + 10 s, prices N+1 with a ~2 s old mid', () => {
    const t = fakeTimers(TS + 1500);
    const reads: { block: number; readMs: number; ageMs: number; sendLeadMs: number }[] = [];
    const s = new SlotScheduler(
      {
        leadMs: 2000,
        blockTimeMs: () => 12_000,
        fire: (b, ts) => {
          const readMs = t.now();
          reads.push({ block: b, readMs, ageMs: expectedMidAgeMs(readMs, ts, 12_000, true), sendLeadMs: broadcastLeadMs(readMs + 700, ts, 12_000) });
        },
      },
      t,
    );
    expect(s.arm(100, TS)).toEqual({ armed: true, block: 100, delayMs: 8500 });
    t.advance(8500);
    expect(reads).toEqual([{ block: 100, readMs: TS + 10_000, ageMs: 2000, sendLeadMs: 1300 }]);
    // block 101 arrives on time (ts_N + 12 s, seen 1.5 s later): the next tick is again 2 s before block 102
    t.advance(3500); // now = ts_N + 13.5 s
    expect(s.arm(101, TS + 12_000)).toMatchObject({ armed: true, delayMs: 8500 });
    t.advance(8500);
    expect(reads[1]).toEqual({ block: 101, readMs: TS + 22_000, ageMs: 2000, sendLeadMs: 1300 });
  });
});
