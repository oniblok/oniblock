/** Metrics (block-bootstrap CIs), results.md, chart.svg, chart-gate.svg. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { POOL_NAMES, type PoolName, type RunResult } from './sim.js';
import { blockBootstrapSum, round, type CI } from './util.js';

const POOL_LABEL: Record<PoolName, string> = {
  fixed: '1 fixed 0.30%',
  detox: '2 detox-style k=0.7',
  const: '3 oniblock const k=0.5',
  model: '4 oniblock model k',
  gated: '5 oniblock gated',
};
// Reference categorical palette (dataviz skill), fixed order = pool order. Light / dark steps.
const COLOR_L = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'];
const COLOR_D = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'];

const sum = (x: number[]) => x.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
const mean = (x: number[]) => {
  const f = x.filter(Number.isFinite);
  return f.length ? sum(f) / f.length : NaN;
};
const ci = (x: number[], seed = 1) => {
  const c = blockBootstrapSum(x.map((v) => (Number.isFinite(v) ? v : 0)), { seed, B: 2000 });
  return { est: round(c.est, 2), lo: round(c.lo, 2), hi: round(c.hi, 2) };
};
const diff = (a: number[], b: number[]) => a.map((v, i) => v - b[i]!);
const fmtCI = (c: CI) => `${fmt(c.est)} [${fmt(c.lo)}, ${fmt(c.hi)}]`;
const fmt = (x: number) => (Math.abs(x) >= 1000 ? Math.round(x).toLocaleString('en-US') : x.toFixed(Math.abs(x) >= 10 ? 0 : 2));
const verdict = (c: CI) => (c.lo > 0 ? 'better (CI > 0)' : c.hi < 0 ? 'worse (CI < 0)' : 'no significant difference (CI spans 0)');

export function poolMetrics(r: RunResult, n: PoolName) {
  const s = r.pools[n];
  const retailVol = sum(s.retailVol);
  const nArb = sum(s.nArb);
  const lvr = ci(s.arbProfit, 2);
  return {
    lpVsHodl: ci(s.dLp, 1),
    lvr,
    lpFees: ci(s.lpFees, 3),
    retailCost: ci(s.retailCost, 4),
    retailCostBps: retailVol > 0 ? round((sum(s.retailCost) / retailVol) * 1e4, 2) : null,
    arbFees: round(sum(s.arbFees), 2),
    retailFees: round(sum(s.retailFees), 2),
    arbVolUsd: round(sum(s.arbVol), 0),
    retailVolUsd: round(retailVol, 0),
    nArb,
    arbSubSwaps: sum(s.arbSubSwaps),
    arbNetAfterGasUsd: round(lvr.est - nArb * r.config.gasUsd, 2),
    meanArbFeePips: Number.isFinite(mean(s.arbFeePips)) ? Math.round(mean(s.arbFeePips)) : null,
    meanK: Number.isFinite(mean(s.k)) ? Math.round(mean(s.k)) : null,
    meanGapBps: round(mean(s.gapBps), 2),
    finalLpMinusHodl: round(s.lpMinusHodl[s.lpMinusHodl.length - 1] ?? 0, 2),
  };
}

function comparisons(r: RunResult) {
  const P = r.pools;
  const h = r.degradeAtStep;
  const second = (x: number[]) => x.slice(h);
  return {
    modelVsConst: {
      lpVsHodl: ci(diff(P.model.dLp, P.const.dLp), 11),
      lvr: ci(diff(P.model.arbProfit, P.const.arbProfit), 12),
      retailCost: ci(diff(P.model.retailCost, P.const.retailCost), 13),
    },
    gatedVsModelSecondHalf: {
      lpVsHodl: ci(diff(second(P.gated.dLp), second(P.model.dLp)), 14),
      lvr: ci(diff(second(P.gated.arbProfit), second(P.model.arbProfit)), 15),
    },
    constVsFixed: { lpVsHodl: ci(diff(P.const.dLp, P.fixed.dLp), 16), lvr: ci(diff(P.const.arbProfit, P.fixed.arbProfit), 17), retailCost: ci(diff(P.const.retailCost, P.fixed.retailCost), 18) },
    detoxVsFixed: { lpVsHodl: ci(diff(P.detox.dLp, P.fixed.dLp), 19), lvr: ci(diff(P.detox.arbProfit, P.fixed.arbProfit), 20) },
    constVsDetox: { lpVsHodl: ci(diff(P.const.dLp, P.detox.dLp), 21), lvr: ci(diff(P.const.arbProfit, P.detox.arbProfit), 22), retailCost: ci(diff(P.const.retailCost, P.detox.retailCost), 23) },
  };
}

function downsample<T>(x: T[], maxPts = 600): T[] {
  if (x.length <= maxPts) return x;
  const st = x.length / maxPts;
  const out: T[] = [];
  for (let i = 0; i < maxPts; i++) out.push(x[Math.floor(i * st)]!);
  out.push(x[x.length - 1]!);
  return out;
}

function demotionSpans(r: RunResult, pool: PoolName = 'gated', threshold = 2500): [number, number][] {
  const spans: [number, number][] = [];
  let start: number | null = null;
  for (const c of r.calibrations.filter((c) => c.pool === pool && c.ok)) {
    if (c.brierBps > threshold && start === null) start = c.step;
    if (c.brierBps <= threshold && start !== null) spans.push([start, c.step]), (start = null);
  }
  if (start !== null) spans.push([start, r.config.blocks]);
  return spans;
}

// ------------------------------------------------------------------------------------------------ SVG

const svgStyle = () => `<style>
  .bg{fill:#fcfcfb} .ax{stroke:#c9c8c2;stroke-width:1} .grid{stroke:#e8e7e2;stroke-width:1}
  .t{fill:#0b0b0b;font:600 14px system-ui,sans-serif} .l{fill:#52514e;font:11px system-ui,sans-serif}
  .zero{stroke:#8a8983;stroke-width:1;stroke-dasharray:3 3}
  ${COLOR_L.map((c, i) => `.s${i}{stroke:${c};fill:none;stroke-width:2} .f${i}{fill:${c}}`).join(' ')}
  .shade{fill:#e34948;opacity:.10} .mark{stroke:#52514e;stroke-width:1;stroke-dasharray:4 3}
  @media (prefers-color-scheme: dark){
    .bg{fill:#1a1a19} .ax{stroke:#4a4a47} .grid{stroke:#2b2b29} .t{fill:#fff} .l{fill:#c3c2b7} .zero{stroke:#77766f} .mark{stroke:#c3c2b7}
    ${COLOR_D.map((c, i) => `.s${i}{stroke:${c}} .f${i}{fill:${c}}`).join(' ')}
    .shade{fill:#e66767;opacity:.16}
  }
</style>`;

function niceTicks(lo: number, hi: number, n = 5): number[] {
  const span = hi - lo || 1;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0)!;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(round(v, 6));
  return out;
}

interface Panel {
  title: string;
  xLabel: string;
  xs: number[];
  series: { name: string; cls: number; ys: number[]; dash?: boolean }[];
  yLabel: string;
  vlines?: { x: number; label: string }[];
  shades?: [number, number][];
  markers?: { x: number; y: number; label: string }[];
  yMin?: number;
  yMax?: number;
}

function panelSvg(p: Panel, ox: number, oy: number, w: number, h: number): string {
  const m = { l: 64, r: 150, t: 28, b: 38 };
  const iw = w - m.l - m.r;
  const ih = h - m.t - m.b;
  const all = p.series.flatMap((s) => s.ys.filter(Number.isFinite));
  let lo = p.yMin ?? Math.min(0, ...all);
  let hi = p.yMax ?? Math.max(0, ...all);
  if (hi - lo < 1e-9) hi = lo + 1;
  const pad = (hi - lo) * 0.05;
  lo -= p.yMin === undefined ? pad : 0;
  hi += p.yMax === undefined ? pad : 0;
  const x0 = p.xs[0]!;
  const x1 = p.xs[p.xs.length - 1]!;
  const X = (x: number) => ox + m.l + ((x - x0) / (x1 - x0 || 1)) * iw;
  const Y = (y: number) => oy + m.t + (1 - (y - lo) / (hi - lo)) * ih;
  const out: string[] = [];
  out.push(`<text class="t" x="${ox + m.l}" y="${oy + 18}">${p.title}</text>`);
  for (const [a, b] of p.shades ?? []) out.push(`<rect class="shade" x="${X(a)}" y="${oy + m.t}" width="${Math.max(1, X(b) - X(a))}" height="${ih}"/>`);
  for (const v of niceTicks(lo, hi)) {
    out.push(`<line class="grid" x1="${ox + m.l}" x2="${ox + m.l + iw}" y1="${Y(v)}" y2="${Y(v)}"/>`);
    out.push(`<text class="l" x="${ox + m.l - 6}" y="${Y(v) + 4}" text-anchor="end">${fmt(v)}</text>`);
  }
  for (const v of niceTicks(x0, x1, 6)) out.push(`<text class="l" x="${X(v)}" y="${oy + m.t + ih + 16}" text-anchor="middle">${fmt(v)}</text>`);
  out.push(`<text class="l" x="${ox + m.l + iw / 2}" y="${oy + h - 6}" text-anchor="middle">${p.xLabel}</text>`);
  out.push(`<text class="l" transform="translate(${ox + 14},${oy + m.t + ih / 2}) rotate(-90)" text-anchor="middle">${p.yLabel}</text>`);
  if (lo < 0 && hi > 0) out.push(`<line class="zero" x1="${ox + m.l}" x2="${ox + m.l + iw}" y1="${Y(0)}" y2="${Y(0)}"/>`);
  out.push(`<line class="ax" x1="${ox + m.l}" x2="${ox + m.l}" y1="${oy + m.t}" y2="${oy + m.t + ih}"/>`);
  for (const v of p.vlines ?? []) {
    out.push(`<line class="mark" x1="${X(v.x)}" x2="${X(v.x)}" y1="${oy + m.t}" y2="${oy + m.t + ih}"/>`);
    out.push(`<text class="l" x="${X(v.x) + 4}" y="${oy + m.t + 12}">${v.label}</text>`);
  }
  // series + direct labels at the right end (nudged apart)
  const ends: { y: number; name: string; cls: number }[] = [];
  for (const s of p.series) {
    const pts = s.ys.map((y, i) => (Number.isFinite(y) ? `${X(p.xs[i]!).toFixed(1)},${Y(y).toFixed(1)}` : null)).filter(Boolean);
    if (!pts.length) continue;
    out.push(`<polyline class="s${s.cls}" ${s.dash ? 'stroke-dasharray="5 3"' : ''} stroke-linejoin="round" points="${pts.join(' ')}"><title>${s.name}</title></polyline>`);
    const last = [...s.ys].reverse().find(Number.isFinite)!;
    ends.push({ y: Y(last), name: s.name, cls: s.cls });
  }
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i]!.y - ends[i - 1]!.y < 13) ends[i]!.y = ends[i - 1]!.y + 13;
  for (const e of ends) {
    out.push(`<rect class="f${e.cls}" x="${ox + m.l + iw + 6}" y="${e.y - 4}" width="8" height="8" rx="2"/>`);
    out.push(`<text class="l" x="${ox + m.l + iw + 18}" y="${e.y + 4}">${e.name}</text>`);
  }
  for (const mk of p.markers ?? []) {
    out.push(`<circle class="f4" cx="${X(mk.x)}" cy="${Y(mk.y)}" r="4" stroke="#fcfcfb" stroke-width="2"><title>${mk.label}</title></circle>`);
  }
  return out.join('\n');
}

function svgDoc(w: number, h: number, body: string, title: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${title}">
<title>${title}</title>
${svgStyle()}
<rect class="bg" width="${w}" height="${h}"/>
${body}
</svg>\n`;
}

/** Minimal shape the charts need; satisfied by each run in results.json (so charts can be re-rendered from it). */
export interface ChartRun {
  label: string;
  config: { split: number; stepSeconds: number; window: { startIso: string } };
  degradeAtStep: number;
  calibrations: { step: number; pool: string; brierBps: number; n: number; ok: boolean }[];
  demotionSpans: { model: [number, number][]; gated: [number, number][] };
  series: { step: number[] } & Record<string, any>;
}

function chartPnl(runs: ChartRun[]): string {
  const W = 960;
  const H = 340;
  const body = runs
    .map((r, i) => {
      const idx = r.series.step;
      return panelSvg(
        {
          title: `LP value minus HODL (USD, marked to Binance mid) - ${r.label} window, ${r.config.window.startIso.slice(0, 16)}Z`,
          xLabel: 'minutes into window',
          yLabel: 'LP - HODL (USD)',
          xs: idx.map((j) => (j * r.config.stepSeconds) / 60),
          series: POOL_NAMES.map((p, c) => ({ name: POOL_LABEL[p], cls: c, ys: r.series[p].lpMinusHodl as number[] })),
          vlines: [{ x: (r.degradeAtStep * r.config.stepSeconds) / 60, label: 'pool 5 model degraded' }],
        },
        0,
        i * H,
        W,
        H,
      );
    })
    .join('\n');
  return svgDoc(W, H * runs.length, body, 'Cumulative LP PnL vs HODL per pool');
}

function chartGate(r: ChartRun, kDefault = 5000): string {
  const W = 960;
  const H = 360;
  const idx = r.series.step;
  const mins = (j: number) => (j * r.config.stepSeconds) / 60;
  const num = (x: unknown) => (typeof x === 'number' ? x : NaN);
  // Only mark settler posts that flip pool 5's demotion state (a post every M steps would be unreadable).
  const flips: { x: number; y: number; label: string }[] = [];
  let dem = false;
  for (const c of r.calibrations.filter((c) => c.pool === 'gated' && c.ok)) {
    const d = c.brierBps > 2500;
    if (d !== dem) flips.push({ x: mins(c.step), y: d ? 9400 : 600, label: `settler post step ${c.step}: Brier ${(c.brierBps / 1e4).toFixed(3)}, n=${c.n} -> ${d ? 'demoted' : 'restored'}` });
    dem = d;
  }
  const body = panelSvg(
    {
      title: `Calibration gate - on-chain k per block (${r.label}). Shaded: pool 5 demoted (Brier > 0.25) -> k = kDefault`,
      xLabel: 'minutes into window',
      yLabel: 'k (bps)',
      xs: idx.map(mins),
      yMin: 0,
      yMax: 10000,
      series: [
        { name: '3 const k = kDefault', cls: 2, ys: idx.map(() => kDefault), dash: true },
        { name: '4 model k (honest)', cls: 3, ys: (r.series.model.k as unknown[]).map(num) },
        { name: '5 gated k', cls: 4, ys: (r.series.gated.k as unknown[]).map(num) },
      ],
      vlines: [{ x: mins(r.degradeAtStep), label: 'pool 5 model degraded' }],
      shades: r.demotionSpans.gated.map(([a, b]) => [mins(a), mins(b)] as [number, number]),
      markers: flips,
    },
    0,
    0,
    W,
    H,
  );
  return svgDoc(W, H, body, 'Calibration gate: k over time for pool 5');
}

export function renderCharts(runs: ChartRun[], outDir: string) {
  const base = runs.filter((r) => r.config.split === 1);
  if (base.length) writeFileSync(resolve(outDir, 'chart.svg'), chartPnl(base));
  const gateRun = base.find((r) => r.label === 'volatile') ?? base[0];
  if (gateRun) writeFileSync(resolve(outDir, 'chart-gate.svg'), chartGate(gateRun));
}

// ------------------------------------------------------------------------------------------------ markdown

export function writeReport(results: RunResult[], outDir: string, meta: { quick: boolean; totalSec: number }) {
  const runs = results.map((r) => {
    const metrics = Object.fromEntries(POOL_NAMES.map((n) => [n, poolMetrics(r, n)])) as Record<PoolName, ReturnType<typeof poolMetrics>>;
    const idx = downsample([...Array(r.config.blocks).keys()], 1200);
    return {
      label: r.label,
      window: r.config.window,
      config: r.config,
      runtimeSec: r.runtimeSec,
      txCount: r.txCount,
      initialTvlUsd: Math.round(r.initialTvlUsd),
      priceRangePct: round((Math.max(...r.mids) / Math.min(...r.mids) - 1) * 100, 3),
      jev: r.jev,
      reverts: { count: r.reverts.length, byLabel: countBy(r.reverts.map((x) => `${x.label}:${x.pool ?? ''}`)), first: r.reverts.slice(0, 10) },
      calibrations: r.calibrations,
      offchainCalibration: r.offchainCalibration,
      degradeAtStep: r.degradeAtStep,
      demotionSpans: { model: demotionSpans(r, 'model'), gated: demotionSpans(r, 'gated') },
      metrics,
      comparisons: comparisons(r),
      series: {
        step: idx,
        mid: idx.map((j) => r.mids[j]),
        ...Object.fromEntries(POOL_NAMES.map((n) => [n, { lpMinusHodl: idx.map((j) => round(r.pools[n].lpMinusHodl[j]!, 2)), k: idx.map((j) => r.pools[n].k[j]) }])),
      },
    };
  });

  renderCharts(runs as unknown as ChartRun[], outDir);

  const md: string[] = [];
  md.push(`# Oniblock benchmark results${meta.quick ? ' (QUICK run - short window, heuristic only; not the headline result)' : ''}`);
  md.push('');
  md.push(`Generated ${new Date().toISOString()} - total runtime ${meta.totalSec}s. Reproduce: \`pnpm -C benchmark ${meta.quick ? 'run:quick' : 'bench'}\`.`);
  md.push('');
  md.push('**Setup.** Real Binance ETHUSDT 1s klines (held-out windows, frozen in `data/windows.json`), one kline step = one price step, replayed on a fresh anvil (automine off, manual mining; each step = keeper block + trading block). Five v4 pools with identical full-range liquidity and initial price (mWETH/mUSDC): (1) hookless 0.30%; (2) Detox-style gap fee, constant k=0.7; (3) Oniblock law, constant k=0.5; (4) Oniblock law, k from the model (Jev via /v1/evaluate with quantized-state cache + bounded budget, heuristic fallback); (5) like 4 but the model is deliberately degraded (probability inverted, confidence 0.95) for the second half; the settler posts calibration every M steps and the on-chain Brier gate demotes k to kDefault. One hook instance, four pool keys (tickSpacing 10/20/30/40), each with its own PoolConfig; base fee 0.30%, feeMax 1%. Arb: rational, trades to the no-trade band edge at the hook-quoted per-block fee vs the kline mid, only if profit at mid > fixed gas. Retail: identical seeded Poisson orders on all pools (same sizes/directions).');
  md.push('');
  const c0 = results[0]?.config;
  if (c0) md.push(`**Model/settler mode:** label horizon ${c0.markoutHorizon} (${c0.markoutHorizon === 0 ? 'markout vs the attested mid in force at the swap block' : 'markout vs the next step mid'}), model state ${c0.feeAware ? 'fee-aware (Jev/heuristic see min(base + k*gap, feeMax))' : 'base-fee only'}.`);
  md.push('');
  md.push(...beforeAfter(results, outDir));
  md.push('**Metrics** (USD, marked to the kline mid): LP-HODL = LP position value incl. uncollected fees minus value of the initial deposit held; LVR proxy = sum of arb profit at mid (before gas); LP fees = fee growth accrued; retail cost = paid - received at mid (fees + price impact; negative = retail gained, e.g. trading against a stale pool price). Brackets are 95% circular block-bootstrap CIs over steps (block length ~ sqrt(N)); they capture within-path noise only, not across-path/regime uncertainty.');
  md.push('');
  for (const r of runs) {
    const c = r.config;
    md.push(`## Window: ${r.label}`);
    md.push('');
    md.push(`${r.window.startIso} + ${c.blocks * c.stepSeconds / 60} min at ${c.interval} (${c.blocks} steps), price range ${r.priceRangePct}%, TVL/pool ~$${r.initialTvlUsd.toLocaleString('en-US')}, split=${c.split}, retail lambda=${c.lambda}/step median $${c.retailUsd}, gas $${c.gasUsd}/arb tx, model=${c.modelMode}. Runtime ${r.runtimeSec}s, ${r.txCount} txs, reverts: ${r.reverts.count}.`);
    md.push('');
    md.push('| pool | LP - HODL | LVR proxy (arb profit) | LP fees (from arbs / retail) | retail cost | retail cost bps | arbs | arb vol | retail vol | mean k | mean arb fee (pips) |');
    md.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const n of POOL_NAMES) {
      const m = r.metrics[n];
      md.push(`| ${POOL_LABEL[n]} | ${fmtCI(m.lpVsHodl)} | ${fmtCI(m.lvr)} | ${fmtCI(m.lpFees)} (${fmt(m.arbFees)} / ${fmt(m.retailFees)}) | ${fmtCI(m.retailCost)} | ${m.retailCostBps ?? '-'} | ${m.nArb} | ${fmt(m.arbVolUsd)} | ${fmt(m.retailVolUsd)} | ${m.meanK ?? '-'} | ${m.meanArbFeePips ?? '-'} |`);
    }
    md.push('');
    const cm = r.comparisons;
    md.push('Paired differences (A - B, sum over steps, 95% CI):');
    md.push('');
    md.push('| comparison | LP - HODL | LVR proxy | retail cost |');
    md.push('|---|---|---|---|');
    md.push(`| **4 model - 3 const** | ${fmtCI(cm.modelVsConst.lpVsHodl)} | ${fmtCI(cm.modelVsConst.lvr)} | ${fmtCI(cm.modelVsConst.retailCost)} |`);
    md.push(`| 3 const - 1 fixed | ${fmtCI(cm.constVsFixed.lpVsHodl)} | ${fmtCI(cm.constVsFixed.lvr)} | ${fmtCI(cm.constVsFixed.retailCost)} |`);
    md.push(`| 2 detox - 1 fixed | ${fmtCI(cm.detoxVsFixed.lpVsHodl)} | ${fmtCI(cm.detoxVsFixed.lvr)} | - |`);
    md.push(`| 3 const - 2 detox | ${fmtCI(cm.constVsDetox.lpVsHodl)} | ${fmtCI(cm.constVsDetox.lvr)} | ${fmtCI(cm.constVsDetox.retailCost)} |`);
    md.push(`| 5 gated - 4 model (2nd half) | ${fmtCI(cm.gatedVsModelSecondHalf.lpVsHodl)} | ${fmtCI(cm.gatedVsModelSecondHalf.lvr)} | - |`);
    md.push('');
    md.push(`**Does the model beat constant k? ${verdict(cm.modelVsConst.lpVsHodl)}** (LP - HODL, pool 4 - pool 3: ${fmtCI(cm.modelVsConst.lpVsHodl)} USD).`);
    md.push('');
    const spanLen = (sp: [number, number][]) => sp.reduce((a, [x, y]) => a + y - x, 0);
    const cal = (p: PoolName) => r.calibrations.filter((x) => x.pool === p && x.ok);
    const g = cal('gated');
    const firstPost = (p: PoolName) => cal(p)[0]?.step;
    const firstDemoteAfter = g.find((x) => x.step >= r.degradeAtStep && x.brierBps > 2500);
    const preDemoted = r.demotionSpans.gated.some(([a, b]) => a < r.degradeAtStep && b > a);
    md.push(`Gate (allowlist + brierDemoteBps 2500, settler every ${c.settleEvery} steps over the last ${c.calibWindow} labelled blocks, posting after ${c.calibMinN} graded blocks): models are active from the first attestation; first calibration post: pool 4 at step ${firstPost('model') ?? 'never'}, pool 5 at step ${firstPost('gated') ?? 'never'}. Pool 5 model degraded at step ${r.degradeAtStep}; ${firstDemoteAfter ? `first post-degradation calibration above threshold at step ${firstDemoteAfter.step} (Brier ${(firstDemoteAfter.brierBps / 1e4).toFixed(3)}, n=${firstDemoteAfter.n}) -> k forced to kDefault (lag ${firstDemoteAfter.step - r.degradeAtStep} steps)` : 'no demotion after degradation'}${preDemoted ? ' (note: pool 5 was ALSO demoted before the degradation, i.e. the honest model failed the gate)' : ''}. Steps demoted: pool 4 (honest) ${spanLen(r.demotionSpans.model)}/${c.blocks}, pool 5 ${spanLen(r.demotionSpans.gated)}/${c.blocks}. End-of-run calibration (off-chain, same labelling): pool 4 ${JSON.stringify(r.offchainCalibration.model)}, pool 5 ${JSON.stringify(r.offchainCalibration.gated)}.`);
    md.push('');
    md.push(`Model sources (pool 4+5 scores): ${JSON.stringify(r.jev.counts)}; Jev API calls ${r.jev.calls} (failures ${r.jev.failures}, p50 latency ${r.jev.p50LatencyMs ?? '-'} ms).`);
    md.push('');
  }
  // split robustness
  const vol = results.find((r) => r.label === 'volatile');
  const vs = results.find((r) => r.label.startsWith('volatile-split'));
  if (vol && vs) {
    md.push(`## Split-swap robustness (volatile window, split=1 vs split=${vs.config.split})`);
    md.push('');
    md.push('| pool | LVR split=1 | LVR split=N | arbs / sub-swaps split=1 | split=N | mean arb fee split=1 | split=N | LP-HODL split=1 | split=N |');
    md.push('|---|---|---|---|---|---|---|---|---|');
    for (const n of POOL_NAMES) {
      const a = poolMetrics(vol, n);
      const b = poolMetrics(vs, n);
      md.push(`| ${POOL_LABEL[n]} | ${fmt(a.lvr.est)} | ${fmt(b.lvr.est)} | ${a.nArb} / ${a.arbSubSwaps} | ${b.nArb} / ${b.arbSubSwaps} | ${a.meanArbFeePips ?? '-'} | ${b.meanArbFeePips ?? '-'} | ${fmt(a.lpVsHodl.est)} | ${fmt(b.lpVsHodl.est)} |`);
    }
    md.push('');
    const same = (['fixed', 'detox', 'const'] as PoolName[]).every((n) => Math.abs(poolMetrics(vol, n).lvr.est - poolMetrics(vs, n).lvr.est) < 1 && poolMetrics(vol, n).meanArbFeePips === poolMetrics(vs, n).meanArbFeePips);
    md.push(same
      ? `Constant-k pools (1-3): splitting every arb into ${vs.config.split} sub-swaps in one tx leaves the arb fee, LVR and LP PnL unchanged (per-block anchor: every sub-swap pays the first sub-swap's fee). Pools 4/5 differ between the two runs only because their model inputs diverged (each run sees a different Jev cache / budget state, so a few scores differ and the k paths drift apart), not because of the split.`
      : 'WARNING: constant-k pools differ between split=1 and split=N - the anchor did not fully neutralise splitting; investigate.');
    md.push('');
  }
  const hr = results.find((r) => r.label.endsWith('-highretail'));
  if (hr) {
    const cm = comparisons(hr);
    md.push(`## Sensitivity: 2x retail rate and 2x order size (${hr.label})`);
    md.push('');
    md.push(`| comparison | LP - HODL | LVR proxy | retail cost |`);
    md.push('|---|---|---|---|');
    md.push(`| **4 model - 3 const** | ${fmtCI(cm.modelVsConst.lpVsHodl)} | ${fmtCI(cm.modelVsConst.lvr)} | ${fmtCI(cm.modelVsConst.retailCost)} |`);
    md.push(`| 3 const - 1 fixed | ${fmtCI(cm.constVsFixed.lpVsHodl)} | ${fmtCI(cm.constVsFixed.lvr)} | ${fmtCI(cm.constVsFixed.retailCost)} |`);
    md.push(`| 3 const - 2 detox | ${fmtCI(cm.constVsDetox.lpVsHodl)} | ${fmtCI(cm.constVsDetox.lvr)} | ${fmtCI(cm.constVsDetox.retailCost)} |`);
    md.push('');
  }
  md.push('## Conclusions');
  md.push('');
  md.push(...conclusions(runs));
  md.push('');
  md.push('Charts: `chart.svg` (LP - HODL over time per pool), `chart-gate.svg` (k over time, pool 5 vs pool 4, degradation point, settler posts, demotion).');
  writeFileSync(resolve(outDir, 'results.md'), md.join('\n') + '\n');
  return { generatedAt: new Date().toISOString(), quick: meta.quick, totalSec: meta.totalSec, runs };
}

/** Before/after table vs results/before/results.json (pre-INTEGRATION_1: horizon 1, base-fee model state). */
function beforeAfter(results: RunResult[], outDir: string): string[] {
  const f = resolve(outDir, 'before', 'results.json');
  if (!existsSync(f) || !results[0]?.config.feeAware) return [];
  const before = JSON.parse(readFileSync(f, 'utf8')) as { runs: { label: string; metrics: any; comparisons: any; demotionSpans: any; config: { blocks: number } }[] };
  const out = [
    '## Before / after the INTEGRATION_1 fixes',
    '',
    'Before = `results/before/` (settler labels vs the NEXT step mid; model state without the hook fee). After = this run (labels vs the mid in force at the swap block; fee-aware model state). Same windows, pools, arb and retail flow.',
    '',
    '| run | 4 model - 3 const, LP-HODL (before) | (after) | honest pool-4 steps demoted (before) | (after) | degraded pool-5 steps demoted in 2nd half (before) | (after) |',
    '|---|---|---|---|---|---|---|',
  ];
  const len = (sp: [number, number][]) => sp.reduce((a, [x, y]) => a + y - x, 0);
  const len2 = (sp: [number, number][], from: number) => sp.reduce((a, [x, y]) => a + Math.max(0, y - Math.max(x, from)), 0);
  for (const r of results) {
    const b = before.runs.find((x) => x.label === r.label);
    if (!b) continue;
    const a = comparisons(r).modelVsConst.lpVsHodl;
    const h = r.degradeAtStep;
    const spA = { model: demotionSpans(r, 'model'), gated: demotionSpans(r, 'gated') };
    out.push(`| ${r.label} | ${fmtCI(b.comparisons.modelVsConst.lpVsHodl)} | ${fmtCI(a)} | ${len(b.demotionSpans.model)}/${b.config.blocks} | ${len(spA.model)}/${r.config.blocks} | ${len2(b.demotionSpans.gated, h)}/${r.config.blocks - h} | ${len2(spA.gated, h)}/${r.config.blocks - h} |`);
  }
  out.push('');
  return out;
}

function countBy(xs: string[]) {
  const o: Record<string, number> = {};
  for (const x of xs) o[x] = (o[x] ?? 0) + 1;
  return o;
}

function conclusions(runs: { label: string; metrics: Record<PoolName, ReturnType<typeof poolMetrics>>; comparisons: ReturnType<typeof comparisons> }[]): string[] {
  const out: string[] = [];
  for (const r of runs) {
    if (r.label.includes('split')) continue;
    const m = r.metrics;
    const c = r.comparisons;
    const dArbFees = m.const.arbFees - m.fixed.arbFees;
    const dRetFees = m.const.retailFees - m.fixed.retailFees;
    out.push(`- **${r.label}** decomposition (3 const vs 1 fixed): LVR proxy lower by ${fmt(m.fixed.lvr.est - m.const.lvr.est)}, LP fees from arbs higher by ${fmt(dArbFees)}, LP fees from retail higher by ${fmt(dRetFees)} USD. The LP gain comes mainly from the higher fee charged to arb-direction flow (arbs, and retail that happens to trade toward the oracle), much more than from avoided LVR.`);
    out.push(`- **${r.label}** model vs const: the model sets mean k ${m.model.meanK} (const 5000); LP - HODL ${fmtCI(c.modelVsConst.lpVsHodl)}, retail cost ${fmtCI(c.modelVsConst.retailCost)}, LVR ${fmtCI(c.modelVsConst.lvr)}. A lower k moves value from LPs to retail (a cheaper fee toward the mid) without reducing LVR.`);
    out.push(`- **${r.label}**: LVR proxy fixed ${fmt(m.fixed.lvr.est)} vs detox ${fmt(m.detox.lvr.est)} / const ${fmt(m.const.lvr.est)} / model ${fmt(m.model.lvr.est)} USD. LP - HODL fixed ${fmt(m.fixed.lpVsHodl.est)} vs const ${fmt(m.const.lpVsHodl.est)} (const - fixed ${verdict(c.constVsFixed.lpVsHodl)}). Retail cost fixed ${m.fixed.retailCostBps} bps vs const ${m.const.retailCostBps} bps vs detox ${m.detox.retailCostBps} bps of retail volume. Model vs constant k: ${verdict(c.modelVsConst.lpVsHodl)} (${fmtCI(c.modelVsConst.lpVsHodl)}).`);
  }
  return out;
}
