'use client';
import { useEffect, useRef, useState } from 'react';
import type { FeedRow } from '@/lib/types';
import { ago, amt, rowKey, tint, usd, verdict } from './score';

const ROW_H = 56;

export interface Pending {
  hash: string;
  label: string;
}

/**
 * Newest swap at the bottom; as many rows as fit, older ones scroll off the top.
 * Each row: age · trade (+ who) · fee charged (+ extra vs base) · Oniblock score. Everything else is in the modal.
 */
export function TxList({
  rows,
  base,
  mine,
  pending,
  now,
  onOpen,
}: {
  rows: FeedRow[];
  base: string;
  mine: Set<string>;
  pending: Pending[];
  now: number;
  onOpen: (r: FeedRow) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(8);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setFit(Math.max(1, Math.floor(e!.contentRect.height / ROW_H))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const room = Math.max(0, fit - pending.length);
  const shown = room > 0 ? rows.slice(-room) : [];

  return (
    <div ref={box} className="relative flex h-full flex-col justify-end overflow-hidden">
      {shown.length === 0 && pending.length === 0 && (
        <div className="absolute inset-0 grid place-items-center text-sm text-muted">No swaps yet. Press Swap to make the first one.</div>
      )}
      {shown.map((r) => (
        <Row key={rowKey(r)} r={r} base={base} you={mine.has(r.tx.toLowerCase())} now={now} onOpen={onOpen} />
      ))}
      {pending.map((p) => (
        <div key={p.hash} className="row-enter you-glow mx-1 mb-1 flex items-center gap-3 rounded-md px-4" style={{ height: ROW_H - 4 }}>
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
          <span className="text-sm text-ink">{p.label}</span>
          <span className="rounded-sm bg-primary px-2 py-0.5 text-[10px] font-bold tracking-wider text-white">YOU</span>
          <span className="ml-auto text-xs text-muted">confirming on-chain…</span>
        </div>
      ))}
    </div>
  );
}

function Row({ r, base, you, now, onOpen }: { r: FeedRow; base: string; you: boolean; now: number; onOpen: (r: FeedRow) => void }) {
  const v = verdict(r);
  const t = tint(r.score);
  const extra = r.feePips - r.baseFeePips >= 100 && r.extraUsd >= 0.005; // ≥ 0.01% above base
  const who = you ? null : r.trader === 'arb' ? 'arb bot' : r.trader === 'retail' ? 'retail' : r.trader === 'demo' ? 'demo swap' : null;
  return (
    <button
      onClick={() => onOpen(r)}
      className={`row-enter group relative mx-1 mb-1 grid shrink-0 cursor-pointer grid-cols-[52px_minmax(0,1fr)_minmax(0,150px)_minmax(0,190px)_16px] items-center gap-4 overflow-hidden rounded-md px-4 text-left transition-colors hover:bg-white/[0.035] ${you ? 'you-glow' : ''}`}
      style={{ height: ROW_H - 4, background: r.score >= 0.15 ? t.bg : undefined }}
    >
      <span className="absolute inset-y-2 left-0 w-[3px] rounded-sm" style={{ background: t.strip }} />
      <span className="mono text-xs text-muted">{ago(r.ts, now)}</span>

      <span className="flex min-w-0 items-center gap-3">
        <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-md text-[13px] ${r.side === 'buy' ? 'bg-oni/12 text-oni' : 'bg-sell/12 text-sell'}`}>
          {r.side === 'buy' ? '↗' : '↘'}
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-2 truncate text-sm text-ink">
            {r.side === 'buy' ? 'Buy' : 'Sell'} {amt(r.baseAmount)} {base}
            {you && <span className="rounded-sm bg-primary px-2 py-0.5 text-[10px] font-bold tracking-wider text-white">YOU</span>}
          </span>
          <span className="block truncate text-xs text-muted">
            {usd(r.usd)}
            {who && <> · {who}</>}
          </span>
        </span>
      </span>

      <span className="min-w-0">
        <span className="mono block text-sm text-ink">{(r.feePips / 10_000).toFixed(2)}%</span>
        <span className={`block truncate text-xs ${extra ? 'text-oni' : 'text-muted'}`}>{r.stale ? 'conservative fee' : extra ? `+${usd(r.extraUsd, 2)} to LPs` : 'base fee'}</span>
      </span>

      <span className="flex min-w-0 items-center gap-3">
        <Meter score={r.arbDir && !r.stale ? r.score : 0} />
        <span className="min-w-0">
          <span className="mono block text-sm" style={{ color: r.score >= 0.15 ? t.text : 'var(--text-2)' }}>
            {r.arbDir && !r.stale ? r.score.toFixed(2) : '—'}
          </span>
          <span className={`block truncate text-xs ${v.tone === 'toxic' ? 'text-bad' : v.tone === 'watch' ? 'text-bad-softer' : v.tone === 'stale' ? 'text-warn' : 'text-muted'}`}>{v.label}</span>
        </span>
      </span>
      <span className="text-muted opacity-0 transition-opacity group-hover:opacity-100">›</span>
    </button>
  );
}

function Meter({ score }: { score: number }) {
  const segs = 5;
  const lit = Math.round(score * segs);
  return (
    <span className="flex gap-[3px]">
      {Array.from({ length: segs }, (_, i) => (
        <span
          key={i}
          className="h-3.5 w-[5px] rounded-[2px]"
          style={{ background: i < lit ? `rgba(var(--toxic) / ${(0.35 + (0.65 * (i + 1)) / segs).toFixed(2)})` : 'rgba(255,255,255,0.07)' }}
        />
      ))}
    </span>
  );
}
