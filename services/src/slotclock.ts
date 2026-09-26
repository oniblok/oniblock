/**
 * Keeper slot clock (opt-in, KEEPER_READ_LEAD_MS). By default the keeper ticks on block ARRIVAL: it reads the CEX mid
 * a second or two after ts_N, its tx lands in block N+1 behind the top-of-block arbs, and the first block it fully
 * prices is N+2, so that mid is ~2·BLOCK_TIME − readLag ≈ 20–23 s old there (each second of age costs ~6 points of TPR
 * at a fixed 5% FPR). In slot mode the tick (CEX read, features, model, sign, send) is scheduled for
 *     ts_N + BLOCK_TIME − lead
 * so the tx still makes it into block N+1 but with a mid only ~BLOCK_TIME + lead old at N+2's first swap.
 * If block N+1 arrives before the timer fires, the pending tick is cancelled and re-armed from the new block (a block
 * is ticked at most once; stale / duplicate blocks are ignored).
 *
 * First-in-block mode (KEEPER_FIRST_IN_BLOCK=1, needs KEEPER_READ_LEAD_MS; oniblock1's training setup): same schedule,
 * but the keeper outbids every other sender of the pool (KEEPER_PRIORITY_GWEI) so its tx is included at the TOP of
 * block N+1, before any swap there: the first swap of N+1 anchors on this attestation, i.e. it prices block N+1 itself
 * with a mid only ~lead old (ts_{N+1} - read = ts_N + BLOCK_TIME - read). Only realistic where nobody else competes
 * for the top of the block (a quiet testnet); on mainnet the arbs sit there and the default N+2 accounting applies.
 *
 * Pure helpers (no I/O) so the scheduling is unit-tested; the keeper wires them to watchBlockNumber + getBlock.
 */
import { env } from './config.js';

/** KEEPER_READ_LEAD_MS: undefined = unset/empty (slot mode off, tick on arrival); else a finite number >= 0. */
export function readLeadMs(raw = env('KEEPER_READ_LEAD_MS')): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) throw new Error(`KEEPER_READ_LEAD_MS must be a number >= 0 (got ${JSON.stringify(raw)})`);
  return v;
}

/** KEEPER_BLOCK_TIME_MS if set (> 0), else undefined (caller: 12000 on sepolia, the observed block time locally). */
export function blockTimeEnvMs(raw = env('KEEPER_BLOCK_TIME_MS')): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`KEEPER_BLOCK_TIME_MS must be a number > 0 (got ${JSON.stringify(raw)})`);
  return v;
}

/** KEEPER_FIRST_IN_BLOCK: unset / '' / '0' / 'false' = off (default); '1' / 'true' = on; anything else throws. */
export function firstInBlock(raw = env('KEEPER_FIRST_IN_BLOCK')): boolean {
  const v = raw?.trim().toLowerCase();
  if (v === undefined || v === '' || v === '0' || v === 'false') return false;
  if (v === '1' || v === 'true') return true;
  throw new Error(`KEEPER_FIRST_IN_BLOCK must be 0 or 1 (got ${JSON.stringify(raw)})`);
}

/**
 * Slot-clock settings of the keeper: lead undefined = tick on block arrival. First-in-block mode is a variant of the slot
 * clock (it decides WHEN to read and send), so it requires KEEPER_READ_LEAD_MS; set alone it throws (config error)
 * rather than silently falling back to on-arrival ticks that can never make the top of the next block.
 */
export function slotMode(o: { lead?: string; first?: string } = {}): { leadMs: number | undefined; firstInBlock: boolean } {
  const leadMs = readLeadMs('lead' in o ? o.lead : env('KEEPER_READ_LEAD_MS'));
  const first = firstInBlock('first' in o ? o.first : env('KEEPER_FIRST_IN_BLOCK'));
  if (first && leadMs === undefined) throw new Error('KEEPER_FIRST_IN_BLOCK=1 needs KEEPER_READ_LEAD_MS (e.g. 2000: read + send ~2 s before the next block)');
  return { leadMs, firstInBlock: first };
}

export const MAINNET_BLOCK_TIME_MS = 12_000;

/** Delay (ms, >= 0) from `nowMs` until the slot-mode read time ts_N + blockTime − lead. 0 = already late: tick now. */
export function slotDelayMs(o: { blockTsMs: number; nowMs: number; leadMs: number; blockTimeMs: number }): number {
  return Math.max(0, o.blockTsMs + o.blockTimeMs - o.leadMs - o.nowMs);
}

/** Read time − block timestamp (ms). */
export const readLagMs = (readMs: number, blockTsMs: number): number => readMs - blockTsMs;

/**
 * Expected age (ms) of the mid read at `readMs` at the first swap of the first block the attestation fully prices.
 * Default: the tx is included at the end of block N+1 (behind the top-of-block arbs), so that is block N+2:
 * ts_{N+2} − read = ts_N + 2·blockTime − read. First-in-block mode: the tx is the first in block N+1, so it prices N+1
 * itself: ts_{N+1} − read = ts_N + blockTime − read (≈ the lead when the read is on time).
 */
export const expectedMidAgeMs = (readMs: number, blockTsMs: number, blockTimeMs: number, firstInBlock = false): number =>
  blockTsMs + (firstInBlock ? 1 : 2) * blockTimeMs - readMs;

/**
 * How early (ms) before the expected timestamp of block N+1 (ts_N + blockTime) a tx was broadcast; negative = after it
 * (the tx then most likely misses block N+1). First-in-block mode needs this comfortably > 0: the read happens at
 * −lead, so broadcastLead = lead − (read -> broadcast latency: features, model, sign, simulate, estimate, send).
 */
export const broadcastLeadMs = (broadcastMs: number, blockTsMs: number, blockTimeMs: number): number => blockTsMs + blockTimeMs - broadcastMs;

/** Block time from observed headers: (ts − prevTs) / (n − prevN) of the last two distinct blocks; `fallback` until known. */
export class BlockTimeEstimator {
  private prev: { n: number; ts: number } | undefined;
  private est: number | undefined;
  constructor(private readonly fallback = MAINNET_BLOCK_TIME_MS) {}
  observe(block: number, tsMs: number): void {
    if (this.prev && block > this.prev.n && tsMs > this.prev.ts) this.est = (tsMs - this.prev.ts) / (block - this.prev.n);
    if (!this.prev || block > this.prev.n) this.prev = { n: block, ts: tsMs };
  }
  value(): number {
    return this.est ?? this.fallback;
  }
}

export interface Timers {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
}
const realTimers: Timers = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

export type ArmResult = { armed: true; block: number; delayMs: number; replaced?: number } | { armed: false; block: number; reason: 'stale' | 'duplicate' };

/**
 * One pending tick at a time. `arm(N, ts_N)` schedules fire(N) at ts_N + blockTime − lead; a newer block cancels the
 * pending one (it is never fired) and re-arms; a block <= the newest armed/fired block is ignored, so no block fires twice.
 */
export class SlotScheduler {
  private pending: { block: number; handle: unknown } | undefined;
  private newest = -Infinity;
  constructor(
    private readonly o: { leadMs: number; blockTimeMs: () => number; fire: (block: number, blockTsMs: number) => void },
    private readonly t: Timers = realTimers,
  ) {}
  arm(block: number, blockTsMs: number): ArmResult {
    if (block < this.newest) return { armed: false, block, reason: 'stale' };
    if (block === this.newest) return { armed: false, block, reason: 'duplicate' };
    this.newest = block;
    const replaced = this.pending?.block;
    if (this.pending) this.t.clearTimeout(this.pending.handle);
    const delayMs = slotDelayMs({ blockTsMs, nowMs: this.t.now(), leadMs: this.o.leadMs, blockTimeMs: this.o.blockTimeMs() });
    const handle = this.t.setTimeout(() => {
      if (this.pending?.block === block) this.pending = undefined;
      this.o.fire(block, blockTsMs);
    }, delayMs);
    this.pending = { block, handle };
    return { armed: true, block, delayMs, ...(replaced !== undefined ? { replaced } : {}) };
  }
  /** Block of the pending (not yet fired) tick, if any. */
  pendingBlock(): number | undefined {
    return this.pending?.block;
  }
  cancel(): void {
    if (this.pending) this.t.clearTimeout(this.pending.handle);
    this.pending = undefined;
  }
}
