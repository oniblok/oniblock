'use client';
import Link from 'next/link';
import { useState } from 'react';
import { bpsPct, gapBps, kFmt, pct, prob } from '@/lib/format';
import type { PoolConfigJson, RegimeCell } from '@/lib/types';

/** Sequential single-hue (orange) ramp for attested k, dark surface: low k recedes, high k glows. */
const RAMP = ['#3b2217', '#5a2e1a', '#7d3a1d', '#a2461f', '#c75322', '#e2672f', '#f08450', '#f7a577'];

function kColor(k: number, kMin: number, kMax: number) {
  const t = Math.max(0, Math.min(1, (k - kMin) / Math.max(1, kMax - kMin)));
  return RAMP[Math.min(RAMP.length - 1, Math.floor(t * RAMP.length))]!;
}

/**
 * One cell per block, colored by the ATTESTED k in force for that block (a block regime, not a
 * per-transaction score). Stale blocks (attestation older than staleBlocks) are hatched gray: the pool
 * charged the conservative fee there.
 */
export function RegimeMap({ cells, cfg }: { cells: RegimeCell[]; cfg: PoolConfigJson }) {
  const [hover, setHover] = useState<{ c: RegimeCell; x: number; y: number } | null>(null);
  return (
    <div className="relative">
      <svg width={0} height={0} className="absolute">
        <defs>
          <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="#2a2a27" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="#6b6a63" strokeWidth="2" />
          </pattern>
        </defs>
      </svg>
      <div className="flex flex-wrap gap-[2px]" onMouseLeave={() => setHover(null)}>
        {cells.map((c) => {
          const none = c.attBlock == null;
          const content = (
            <svg width={14} height={30} className="block">
              <rect
                width={14}
                height={30}
                rx={2}
                fill={none ? '#1f1f1d' : c.stale ? 'url(#hatch)' : kColor(c.kBps ?? cfg.kDefaultBps, cfg.kMinBps, cfg.kMaxBps)}
              />
              {c.demoted && !c.stale && <rect x={1} y={1} width={12} height={28} rx={2} fill="none" stroke="var(--bad)" strokeWidth={2} />}
              {c.swaps > 0 && <circle cx={7} cy={24} r={2.5} fill="#fff" />}
              {c.posted && <rect x={4} y={3} width={6} height={2} rx={1} fill="rgba(255,255,255,0.55)" />}
            </svg>
          );
          return (
            <div
              key={c.block}
              onMouseEnter={(e) => {
                const r = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                const me = e.currentTarget.getBoundingClientRect();
                setHover({ c, x: me.left - r.left, y: me.bottom - r.top });
              }}
            >
              {c.txs[0] ? <Link href={`/receipt/${c.txs[0]}`}>{content}</Link> : content}
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-5 text-xs text-ink-2">
        <span className="flex items-center gap-2">
          attested k {kFmt(cfg.kMinBps)}
          <span className="flex">
            {RAMP.map((c) => (
              <span key={c} className="inline-block h-3 w-4" style={{ background: c }} />
            ))}
          </span>
          {kFmt(cfg.kMaxBps)}
        </span>
        <span className="flex items-center gap-1.5">
          <svg width={14} height={12}>
            <rect width={14} height={12} fill="url(#hatch)" rx={2} />
          </svg>
          stale mid → conservative fee {pct(cfg.conservativeFee)}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3.5 rounded-sm border-2 border-bad" /> model demoted by calibration gate
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-white" /> swaps in block (click → receipt)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-2 bg-white/60" /> attestation posted in block
        </span>
      </div>
      {hover && (
        <div
          className="pointer-events-none absolute z-10 w-64 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs shadow-xl"
          style={{ left: Math.max(0, hover.x - 100), top: hover.y + 6 }}
        >
          <div className="mb-1 font-semibold text-ink">Block {hover.c.block}</div>
          {hover.c.attBlock == null ? (
            <div className="text-muted">No attestation yet</div>
          ) : (
            <table className="w-full">
              <tbody className="[&_td:first-child]:text-muted [&_td:last-child]:text-right [&_td:last-child]:text-ink">
                <tr><td>p_toxic</td><td>{prob(hover.c.pToxicBps)}</td></tr>
                <tr><td>confidence</td><td>{bpsPct(hover.c.confidenceBps, 0)}</td></tr>
                <tr><td>attested k</td><td>{kFmt(hover.c.kBps)}{hover.c.stale ? ' (kDefault)' : ''}</td></tr>
                {hover.c.jitWindow != null && (
                  <tr><td>JIT window</td><td>{hover.c.stale && cfg.jitWindowDefault != null ? `${cfg.jitWindowDefault} blk (default)` : `${hover.c.jitWindow} blk`} <span className="text-muted">p_jit {prob(hover.c.pJitBps)}</span></td></tr>
                )}
                <tr><td>regime fee (arb dir)</td><td>{pct(hover.c.feePips)} <span className="text-muted">{hover.c.feeSource === 'receipt' ? 'receipt' : 'quoted'}</span></td></tr>
                <tr><td>gap vs CEX mid</td><td>{gapBps(hover.c.gapPips)}</td></tr>
                <tr><td>model</td><td>{hover.c.model ?? '—'}</td></tr>
                <tr><td>attestation age</td><td>{hover.c.age} blk{hover.c.stale ? ' · STALE' : ''}</td></tr>
                <tr><td>calibration gate</td><td>{hover.c.demoted ? 'demoted' : 'ok'}</td></tr>
                <tr><td>swaps</td><td>{hover.c.swaps}</td></tr>
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
