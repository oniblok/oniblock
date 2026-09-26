'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FeedBucket } from '@/lib/types';
import { signed } from '@/lib/format';

/**
 * One line: what Oniblock saved LPs so far = cumulative LP P&L vs Binance with Oniblock minus the plain pool next to
 * it on the same trades. Flat on ordinary trades (both pools earn the same), a step up when arbitrage pays more on
 * Oniblock, a step down if Oniblock did worse. Bars = the step per interval.
 */
export function Chart({ buckets, quote }: { buckets: FeedBucket[]; quote: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  const [h, setH] = useState(220);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      setW(Math.max(200, e!.contentRect.width));
      setH(Math.max(140, e!.contentRect.height));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pad = { l: 8, r: 76, t: 12, b: 22 };
  const g = useMemo(() => {
    const n = buckets.length;
    const edges = buckets.map((b) => b.oni - b.van);
    const cum = buckets.map((b) => b.oniCum - b.vanCum);
    const vals = [0, ...cum];
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    if (hi - lo < 1) {
      hi += 0.5;
      lo -= 0.5;
    }
    const m = (hi - lo) * 0.12;
    hi += m;
    lo -= m;
    const iw = w - pad.l - pad.r;
    const ih = h - pad.t - pad.b;
    // lines use the top 70%; the edge bars get their own strip in the bottom 24% (baseline in its middle)
    const lineH = ih * 0.7;
    const x = (i: number) => pad.l + (n <= 1 ? iw / 2 : (i + 0.5) * (iw / n));
    const y = (v: number) => pad.t + ((hi - v) / (hi - lo)) * lineH;
    const eMax = Math.max(1e-9, ...edges.map(Math.abs));
    const band = ih * 0.12;
    const barBase = pad.t + ih * 0.88;
    const barW = Math.max(2, Math.min(18, (iw / Math.max(1, n)) * 0.56));
    // step line: the saving changes at a trade and holds until the next one
    const line = cum.map((v, i) => (i ? `H${x(i).toFixed(1)}V${y(v).toFixed(1)}` : `M${x(0).toFixed(1)},${y(v).toFixed(1)}`)).join('');
    const area = n ? `${line}L${x(n - 1).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z` : '';
    const ticks = niceTicks(lo, hi, 4);
    return { n, edges, cum, eMax, band, barBase, barW, x, y, line, area, ticks, iw, ih };
  }, [buckets, w, h, pad.l, pad.r, pad.t, pad.b]);

  const zeroY = g.y(0);
  const hb = hover !== null ? buckets[hover] : undefined;

  return (
    <div ref={wrap} className="relative h-full w-full select-none">
      <svg width={w} height={h} className="block">
        <defs>
          <linearGradient id="oniFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--oni)" stopOpacity="0.14" />
            <stop offset="100%" stopColor="var(--oni)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {g.ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={w - pad.r} y1={g.y(t)} y2={g.y(t)} stroke="var(--grid)" strokeWidth={1} />
            <text x={w - pad.r + 10} y={g.y(t) + 4} fontSize={10.5} fill="var(--muted)" className="mono">
              {fmtAxis(t)}
            </text>
          </g>
        ))}
        <line x1={pad.l} x2={w - pad.r} y1={zeroY} y2={zeroY} stroke="var(--axis)" strokeWidth={1} />
        {/* edge bars (own strip) */}
        <line x1={pad.l} x2={w - pad.r} y1={g.barBase} y2={g.barBase} stroke="var(--grid)" strokeWidth={1} />
        <text x={w - pad.r + 10} y={g.barBase + 4} fontSize={10.5} fill="var(--muted)">
          per trade
        </text>
        {g.edges.map((e, i) => {
          const hgt = (Math.abs(e) / g.eMax) * g.band;
          if (hgt < 0.5) return null;
          const pos = e >= 0;
          return (
            <rect
              key={i}
              x={g.x(i) - g.barW / 2}
              y={pos ? g.barBase - hgt : g.barBase}
              width={g.barW}
              height={hgt}
              rx={Math.min(1.5, g.barW / 4)}
              fill={pos ? 'var(--oni)' : 'var(--bad)'}
              opacity={hover === i ? 1 : 0.8}
            />
          );
        })}
        {g.n > 1 && (
          <>
            <path d={g.area} fill="url(#oniFill)" />
            <path d={g.line} fill="none" stroke="var(--oni)" strokeWidth={2.25} strokeLinejoin="round" />
          </>
        )}
        {hb && hover !== null && (
          <g>
            <line x1={g.x(hover)} x2={g.x(hover)} y1={pad.t} y2={h - pad.b} stroke="var(--axis)" strokeDasharray="2 3" />
            <circle cx={g.x(hover)} cy={g.y(g.cum[hover]!)} r={4} fill="var(--oni)" />
          </g>
        )}
        {/* hover capture */}
        {buckets.map((_, i) => (
          <rect
            key={`h${i}`}
            x={g.x(i) - g.iw / Math.max(1, g.n) / 2}
            y={pad.t}
            width={g.iw / Math.max(1, g.n)}
            height={g.ih}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
        {buckets.length > 0 && (
          <>
            <text x={pad.l} y={h - 6} fontSize={10.5} fill="var(--muted)" className="mono">
              #{buckets[0]!.fromBlock.toLocaleString()}
            </text>
            <text x={w - pad.r} y={h - 6} fontSize={10.5} fill="var(--muted)" textAnchor="end" className="mono">
              #{buckets.at(-1)!.toBlock.toLocaleString()}
            </text>
          </>
        )}
      </svg>
      {hb && hover !== null && (
        <div
          className="pointer-events-none absolute top-2 z-10 min-w-[190px] rounded-md border border-line bg-surface-2 px-3 py-2 text-xs shadow-lg fade-in"
          style={{ left: Math.min(Math.max(g.x(hover) + 12, 8), w - 210) }}
        >
          <div className="mb-1.5 text-muted mono">
            blocks {hb.fromBlock.toLocaleString()}–{hb.toBlock.toLocaleString()}
          </div>
          <Row c="var(--oni)" k="Saved so far" v={`${signed(hb.oniCum - hb.vanCum)} ${quote}`} />
          <Row c={hb.oni - hb.van >= 0 ? 'var(--oni)' : 'var(--bad)'} k="This interval" v={`${signed(hb.oni - hb.van)} ${quote}`} />
          <div className="mt-1.5 border-t border-line pt-1.5 text-muted">
            <Row c="var(--oni)" k="Oniblock LPs" v={`${signed(hb.oniCum)} ${quote}`} />
            <Row c="var(--vanilla)" k="Plain pool LPs" v={`${signed(hb.vanCum)} ${quote}`} />
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ c, k, v }: { c: string; k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-0.5">
      <span className="flex items-center gap-1.5 text-ink-2">
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: c }} />
        {k}
      </span>
      <span className="mono text-ink">{v}</span>
    </div>
  );
}

function niceTicks(lo: number, hi: number, n: number): number[] {
  const span = hi - lo;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const out: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) out.push(Math.round(t / step) * step);
  return out;
}

function fmtAxis(v: number) {
  const a = Math.abs(v);
  const s = a >= 1000 ? `${(a / 1000).toFixed(a >= 10_000 ? 0 : 1)}k` : a >= 10 ? a.toFixed(0) : a.toFixed(a >= 1 ? 1 : 2);
  return `${v < 0 ? '−' : v > 0 ? '+' : ''}$${s}`;
}
