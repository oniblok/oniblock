'use client';
import { useEffect, useRef, useState } from 'react';

export interface Series {
  name: string;
  color: string;
  values: { x: number; y: number }[];
}

/**
 * Minimal SVG line chart: one y-axis, 2px lines, recessive grid, crosshair + tooltip, legend and
 * direct end labels (<= 4 series).
 */
export function LineChart({
  series,
  height = 240,
  yFormat = (v: number) => v.toFixed(2),
  xFormat = (v: number) => String(v),
  zeroLine = true,
  refLine,
}: {
  series: Series[];
  height?: number;
  yFormat?: (v: number) => string;
  xFormat?: (v: number) => string;
  zeroLine?: boolean;
  refLine?: { y: number; label: string };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((e) => setW(Math.max(200, e[0]!.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const all = series.flatMap((s) => s.values);
  const pad = { l: 64, r: 96, t: 10, b: 24 };
  if (all.length < 2) {
    return (
      <div ref={ref} style={{ height }} className="flex items-center justify-center text-sm text-muted">
        Waiting for data…
      </div>
    );
  }
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  if (zeroLine) ys.push(0);
  if (refLine) ys.push(refLine.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  let y0 = Math.min(...ys);
  let y1 = Math.max(...ys);
  if (y1 - y0 < 1e-9) {
    y0 -= 1;
    y1 += 1;
  }
  const yPad = (y1 - y0) * 0.08;
  y0 -= yPad;
  y1 += yPad;
  const iw = w - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const sx = (x: number) => pad.l + ((x - x0) / Math.max(1e-9, x1 - x0)) * iw;
  const sy = (y: number) => pad.t + (1 - (y - y0) / (y1 - y0)) * ih;
  const ticks = Array.from({ length: 5 }, (_, i) => y0 + ((y1 - y0) * i) / 4);
  const xTicks = Array.from({ length: 5 }, (_, i) => Math.round(x0 + ((x1 - x0) * i) / 4));
  const path = (s: Series) => s.values.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');

  const hx = hover;
  const nearest = (s: Series) => {
    if (hx == null || !s.values.length) return undefined;
    let best = s.values[0]!;
    for (const p of s.values) if (Math.abs(p.x - hx) < Math.abs(best.x - hx)) best = p;
    return best;
  };

  return (
    <div ref={ref} className="relative select-none">
      <div className="mb-2 flex gap-4 text-xs text-ink-2">
        {series.map((s) => (
          <span key={s.name} className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 rounded" style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
      </div>
      <svg
        width={w}
        height={height}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = e.clientX - r.left;
          setHover(x0 + ((px - pad.l) / iw) * (x1 - x0));
        }}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={w - pad.r} y1={sy(t)} y2={sy(t)} stroke="var(--grid)" strokeWidth={1} />
            <text x={pad.l - 8} y={sy(t) + 4} textAnchor="end" fontSize={11} fill="var(--muted)">
              {yFormat(t)}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t} x={sx(t)} y={height - 6} textAnchor="middle" fontSize={11} fill="var(--muted)">
            {xFormat(t)}
          </text>
        ))}
        {zeroLine && y0 < 0 && y1 > 0 && <line x1={pad.l} x2={w - pad.r} y1={sy(0)} y2={sy(0)} stroke="var(--muted)" strokeWidth={1} />}
        {refLine && (
          <g>
            <line x1={pad.l} x2={w - pad.r} y1={sy(refLine.y)} y2={sy(refLine.y)} stroke="var(--bad)" strokeDasharray="4 4" strokeWidth={1} />
            <text x={w - pad.r + 6} y={sy(refLine.y) + 4} fontSize={11} fill="var(--text-2)">
              {refLine.label}
            </text>
          </g>
        )}
        {series.map((s) => (
          <path key={s.name} d={path(s)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
        ))}
        {series.length <= 4 &&
          series.map((s) => {
            const last = s.values.at(-1);
            if (!last) return null;
            return (
              <g key={s.name + 'lbl'}>
                <circle cx={sx(last.x)} cy={sy(last.y)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
                <text x={sx(last.x) + 8} y={sy(last.y) + 4} fontSize={11} fill="var(--text-2)">
                  {s.name.split(' ')[0]} {yFormat(last.y)}
                </text>
              </g>
            );
          })}
        {hx != null && hx >= x0 && hx <= x1 && (
          <g>
            <line x1={sx(hx)} x2={sx(hx)} y1={pad.t} y2={pad.t + ih} stroke="var(--muted)" strokeWidth={1} />
            {series.map((s) => {
              const p = nearest(s);
              return p ? <circle key={s.name} cx={sx(p.x)} cy={sy(p.y)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} /> : null;
            })}
          </g>
        )}
      </svg>
      {hx != null && hx >= x0 && hx <= x1 && (
        <div
          className="pointer-events-none absolute rounded-md border border-line bg-surface-2 px-3 py-2 text-xs shadow-lg"
          style={{ left: Math.min(sx(hx) + 12, w - 190), top: 28 }}
        >
          <div className="mb-1 text-muted">{xFormat(nearest(series[0]!)?.x ?? hx)}</div>
          {series.map((s) => {
            const p = nearest(s);
            return (
              <div key={s.name} className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
                <span className="text-ink-2">{s.name}</span>
                <span className="ml-auto pl-3 font-medium text-ink">{p ? yFormat(p.y) : '—'}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
