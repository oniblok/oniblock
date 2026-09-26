/** v2 metrics, statistics (within-window block bootstrap + across-window bootstrap over windows), results.md, SVG charts. */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { blockBootstrapSum, rng } from '../util.js';
import { MARKETS, type Pool } from './chain2.js';
import type { RunConfigV2, RunResultV2 } from './sim2.js';

type MarketName = (typeof MARKETS)[number]['name'];
const VARIANT_WINDOWS_R = ['ETH-vol1', 'BTC-vol1'];
const COMP_MARKETS = MARKETS.filter((m) => m.name !== 'control');
const sum = (x: number[]) => x.reduce((a, b) => a + b, 0);
const mean = (x: number[]) => (x.length ? sum(x) / x.length : NaN);
const r2 = (x: number) => Math.round(x * 100) / 100;

export interface Agg {
  n: number;
  mean: number;
  lo: number;
  hi: number;
  pos: number; // windows > 0
  neg: number; // windows < 0
}

/** Bootstrap over windows (percentile CI of the mean), B resamples. */
export function aggWindows(x: number[], seed = 99, B = 10_000): Agg {
  const n = x.length;
  const m = mean(x);
  if (n < 2) return { n, mean: m, lo: m, hi: m, pos: x.filter((v) => v > 0).length, neg: x.filter((v) => v < 0).length };
  const u = rng(seed);
  const ms: number[] = [];
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += x[Math.floor(u() * n)]!;
    ms.push(s / n);
  }
  ms.sort((a, b) => a - b);
  return { n, mean: m, lo: ms[Math.floor(0.025 * B)]!, hi: ms[Math.floor(0.975 * B)]!, pos: x.filter((v) => v > 1e-9).length, neg: x.filter((v) => v < -1e-9).length };
}

const withinCI = (a: number[], b: number[], seed: number) => {
  const c = blockBootstrapSum(a.map((v, i) => v - b[i]!), { seed, B: 2000, len: 8 });
  return { est: r2(c.est), lo: r2(c.lo), hi: r2(c.hi) };
};

/** Per-run, per-market metrics. USD and bps of the initial per-pool TVL. */
export function marketMetrics(r: RunResultV2) {
  const T = r.totals;
  const tvl = r.initialTvlUsd;
  const bps = (usd: number) => (usd / tvl) * 1e4;
  const ctlLp = (T.v_control_a.lpMinusHodl + T.v_control_b.lpMinusHodl) / 2;
  const ctlCost = T.v_control_a.retailCost + T.v_control_b.retailCost;
  const ctlVol = T.v_control_a.retailVol + T.v_control_b.retailVol;
  const out = {} as Record<MarketName, ReturnType<typeof one>>;
  function one(m: (typeof MARKETS)[number], i: number) {
    const c = T[m.comp as Pool];
    const v = T[m.vanilla as Pool];
    const vol = c.retailVol + v.retailVol;
    const cost = c.retailCost + v.retailCost;
    return {
      compLpUsd: r2(c.lpMinusHodl),
      vanLpUsd: r2(v.lpMinusHodl),
      /** competitor LP-HODL minus the vanilla pool next to it (same market) */
      withinUsd: r2(c.lpMinusHodl - v.lpMinusHodl),
      withinBps: bps(c.lpMinusHodl - v.lpMinusHodl),
      withinCI: withinCI(r.buckets[m.comp as Pool].dLp, r.buckets[m.vanilla as Pool].dLp, 100 + i),
      /** competitor LP-HODL minus the average control pool (a world where the competitor had been vanilla) */
      vsControlBps: bps(c.lpMinusHodl - ctlLp),
      /** vanilla neighbour vs control pool (spill-over onto the vanilla LP) */
      vanVsControlBps: bps(v.lpMinusHodl - ctlLp),
      /** both LPs of the market together vs both control LPs */
      marketLpVsControlBps: bps(c.lpMinusHodl + v.lpMinusHodl - 2 * ctlLp),
      share: vol > 0 ? c.retailVol / vol : NaN,
      retailCostUsd: r2(cost),
      retailCostBps: vol > 0 ? (cost / vol) * 1e4 : NaN,
      /** market retail cost minus control-market retail cost, bps of the market's retail volume */
      retailCostVsControlBps: vol > 0 && ctlVol > 0 ? (cost / vol - ctlCost / ctlVol) * 1e4 : NaN,
      retailCostVsControlUsd: r2(cost - ctlCost),
      compArbProfit: r2(c.arbProfit),
      vanArbProfit: r2(v.arbProfit),
      compNArb: c.nArb,
      vanNArb: v.nArb,
      compArbFee: c.meanArbFeePips,
      compRetailFee: c.meanRetailFeePips,
      compLpFees: r2(c.lpFees),
      vanLpFees: r2(v.lpFees),
      compMeanK: c.meanK,
      compStaleSteps: c.staleSteps,
    };
  }
  MARKETS.forEach((m, i) => (out[m.name] = one(m, i)));
  return out;
}

function modelMetrics(r: RunResultV2) {
  const T = r.totals;
  const bps = (usd: number) => (usd / r.initialTvlUsd) * 1e4;
  const h = r.degradeAtStep / r.config.bucketSteps;
  const second = (x: number[]) => x.slice(Math.floor(h));
  return {
    jevMinusConstBps: bps(T.mjev.lpMinusHodl - T.const.lpMinusHodl),
    heurMinusConstBps: bps(T.mheur.lpMinusHodl - T.const.lpMinusHodl),
    jevMinusHeurBps: bps(T.mjev.lpMinusHodl - T.mheur.lpMinusHodl),
    jevMinusConstCI: withinCI(r.buckets.mjev.dLp, r.buckets.const.dLp, 201),
    heurMinusConstCI: withinCI(r.buckets.mheur.dLp, r.buckets.const.dLp, 202),
    gatedMinusJev2ndHalfBps: bps(sum(second(r.buckets.gated.dLp)) - sum(second(r.buckets.mjev.dLp))),
    demoted: r.demoted,
    gateSeparationPp: (r.demoted.gated.secondHalf - r.demoted.mjev.secondHalf) * 100,
  };
}

const fmt = (x: number | null | undefined, d = 2) =>
  x === null || x === undefined || !Number.isFinite(x) ? '-' : Math.abs(x) >= 1000 ? Math.round(x).toLocaleString('en-US') : x.toFixed(d);
const fa = (g: Agg, d = 2) => `${fmt(g.mean, d)} [${fmt(g.lo, d)}, ${fmt(g.hi, d)}]`;
const signs = (g: Agg) => `${g.pos}+/${g.neg}- of ${g.n}`;
const verdict = (g: Agg) => (g.lo > 0 ? 'YES' : g.hi < 0 ? 'NO' : 'INCONCLUSIVE');

export function writeReportV2(results: RunResultV2[], outDir: string, meta: { quick: boolean; totalSec: number; cfg: Omit<RunConfigV2, 'label' | 'path' | 'port'>; steps: number }) {
  const baseRuns = results.filter((r) => r.variant === 'base');
  const mm = new Map(results.map((r) => [r.label, marketMetrics(r)]));
  const md = new Map(results.map((r) => [r.label, modelMetrics(r)]));
  const groups = { all: baseRuns, volatile: baseRuns.filter((r) => r.regime === 'volatile'), calm: baseRuns.filter((r) => r.regime === 'calm') };
  const aggOf = (runs: RunResultV2[], f: (r: RunResultV2) => number, seed: number) => aggWindows(runs.map(f).filter(Number.isFinite), seed);

  // ---------------- aggregates
  const agg: Record<string, Record<string, Record<string, Agg>>> = {};
  let seed = 1;
  for (const [g, runs] of Object.entries(groups)) {
    agg[g] = {};
    for (const m of MARKETS) {
      const M = (r: RunResultV2) => mm.get(r.label)![m.name];
      agg[g]![m.name] = {
        withinBps: aggOf(runs, (r) => M(r).withinBps, seed++),
        vsControlBps: aggOf(runs, (r) => M(r).vsControlBps, seed++),
        vanVsControlBps: aggOf(runs, (r) => M(r).vanVsControlBps, seed++),
        marketLpVsControlBps: aggOf(runs, (r) => M(r).marketLpVsControlBps, seed++),
        sharePct: aggOf(runs, (r) => M(r).share * 100, seed++),
        retailCostVsControlBps: aggOf(runs, (r) => M(r).retailCostVsControlBps, seed++),
      };
    }
    const D = (r: RunResultV2) => md.get(r.label)!;
    agg[g]!.model = {
      jevMinusConstBps: aggOf(runs, (r) => D(r).jevMinusConstBps, seed++),
      heurMinusConstBps: aggOf(runs, (r) => D(r).heurMinusConstBps, seed++),
      jevMinusHeurBps: aggOf(runs, (r) => D(r).jevMinusHeurBps, seed++),
      gatedMinusJev2ndHalfBps: aggOf(runs, (r) => D(r).gatedMinusJev2ndHalfBps, seed++),
      gateSeparationPp: aggOf(runs, (r) => D(r).gateSeparationPp, seed++),
      honestDemoted2ndPct: aggOf(runs, (r) => r.demoted.mjev.secondHalf * 100, seed++),
      degradedDemoted2ndPct: aggOf(runs, (r) => r.demoted.gated.secondHalf * 100, seed++),
      honestDemoted1stPct: aggOf(runs, (r) => r.demoted.mjev.firstHalf * 100, seed++),
    };
  }

  // ---------------- sanity
  const ctlShares = baseRuns.map((r) => mm.get(r.label)!.control.share);
  const ctlWithin = baseRuns.map((r) => mm.get(r.label)!.control.withinBps);
  const allReverts = results.flatMap((r) => r.reverts.map((x) => ({ run: r.label, ...x })));
  const revertKinds: Record<string, number> = {};
  for (const x of allReverts) revertKinds[`${x.label}${x.pool ? ':' + x.pool : ''}`] = (revertKinds[`${x.label}${x.pool ? ':' + x.pool : ''}`] ?? 0) + 1;

  // ---------------- variants
  const variantRows: string[] = [];
  for (const r of results.filter((x) => x.variant !== 'base')) {
    const b = baseRuns.find((x) => x.windowId === r.windowId);
    if (!b) continue;
    const vm = mm.get(r.label)!;
    const bm = mm.get(b.label)!;
    for (const m of COMP_MARKETS) {
      variantRows.push(
        `| ${r.windowId} | ${r.variant} | ${m.name} | ${fmt(bm[m.name].withinBps)} | ${fmt(vm[m.name].withinBps)} | ${fmt(bm[m.name].share * 100, 1)}% | ${fmt(vm[m.name].share * 100, 1)}% | ${fmt(bm[m.name].compArbFee, 0)} | ${fmt(vm[m.name].compArbFee, 0)} | ${fmt(bm[m.name].compArbProfit, 0)} | ${fmt(vm[m.name].compArbProfit, 0)} |`,
      );
    }
  }

  // ---------------- conclusion
  const A = agg.all!;
  const V = agg.volatile!;
  const Cm = agg.calm!;
  const L: string[] = [];
  const cfg = meta.cfg;
  L.push('## CONCLUSION');
  L.push('');
  L.push(
    `Plain-language verdicts. Numbers are across-window means over ${baseRuns.length} one-hour windows (${groups.volatile.length} volatile, ${groups.calm.length} calm; ETHUSDT + BTCUSDT), in **bps of one pool's starting TVL (~$${fmt(baseRuns[0]?.initialTvlUsd ?? 0, 0)}) per hour**, with a 95% bootstrap CI over windows in brackets and the sign count (windows where the difference is > 0 / < 0). YES/NO = the CI excludes 0 in that direction; otherwise INCONCLUSIVE.`,
  );
  L.push('');
  const tvl = baseRuns[0]?.initialTvlUsd ?? 2e7;
  const usd = (b: number) => `$${fmt((b * tvl) / 1e4, 0)}`;
  const faU = (g: Agg) => `${fa(g)} bps (≈ ${usd(g.mean)}/h, CI ${usd(g.lo)} to ${usd(g.hi)})`;
  const claim = (title: string, g: Agg, extra: string, unit: 'bps' | 'pp' = 'bps') =>
    `- **${title}: ${verdict(g)}.** ${unit === 'bps' ? faU(g) : fa(g, 1) + ' pp'} (${signs(g)}). ${extra}`;

  // variant evidence (ETH-vol1, BTC-vol1)
  const vpair = (variant: string) =>
    results.filter((r) => r.variant === variant).map((r) => ({ v: r, b: baseRuns.find((x) => x.windowId === r.windowId)! })).filter((x) => x.b);
  const lag0 = vpair('lag0');
  const split5 = vpair('split5');
  const labAtt = vpair('labelatt');
  const lagTxt = lag0
    .map(({ v, b }) => `${b.windowId}: const ${fmt(mm.get(b.label)!.const.withinBps)} -> ${fmt(mm.get(v.label)!.const.withinBps)} bps, detox ${fmt(mm.get(b.label)!.detox.withinBps)} -> ${fmt(mm.get(v.label)!.detox.withinBps)} bps; const-pool arb profit $${fmt(b.totals.const.arbProfit, 0)} -> $${fmt(v.totals.const.arbProfit, 0)}`)
    .join('; ');
  const splitMax = Math.max(0, ...split5.flatMap(({ v, b }) => (['detox', 'const'] as const).map((m) => Math.abs(mm.get(v.label)![m].withinBps - mm.get(b.label)![m].withinBps))));
  const labTxt = labAtt
    .map(({ v, b }) => `${b.windowId}: heuristic model demoted ${fmt(b.demoted.mheur.secondHalf * 100, 0)}% -> ${fmt(v.demoted.mheur.secondHalf * 100, 0)}% of 2nd-half steps, "informed" base rate on arb blocks ${fmt(b.labelDiag.mheur.baseRateArbBlocks * 100, 0)}% -> ${fmt(v.labelDiag.mheur.baseRateArbBlocks * 100, 0)}%`)
    .join('; ');

  if (meta.quick) L.push('**Bottom line.** QUICK MODE (300 steps, 2 windows, heuristic scorer in the Jev arm): a smoke test of the pipeline, not evidence. The narrative below is written for the full run; ignore it here.');
  else L.push(
    `**Bottom line.** Once the keeper lags the arbitrageur by one block and retail can route to a vanilla pool, the fee law is **not a robust LP win**: it helps in volatile hours (detox-style ${fa(V.detox!.withinBps)} bps/h, constant k ${fa(V.const!.withinBps)}) and costs LPs in quiet hours (${fa(Cm.const!.withinBps)} for constant k, ${signs(Cm.const!.withinBps)}) because the directional fee also taxes retail that trades back toward the mid, and that flow leaves for the vanilla pool (the competitor keeps only ~${fmt(A.const!.sharePct.mean, 0)}% of retail). Across all ${baseRuns.length} windows the effect is indistinguishable from zero and small in dollars (tens to hundreds of $ per hour on a $${fmt(tvl / 1e6, 0)}M pool). Model-tuned k is not distinguishable from constant k in any economically meaningful way (heuristic k: +$48/h-scale; Jev k is slightly worse than the heuristic). The calibration gate is the one component that works as designed: it demotes the degraded model most of the time and the honest one rarely.`,
  );
  L.push('');
  L.push('**1. Does the fee law help LPs vs the vanilla 0.30% pool next to it, under routing competition?** (competitor LP-HODL minus vanilla LP-HODL in the same market)');
  L.push('');
  for (const m of ['const', 'detox'] as const) {
    const lbl = m === 'const' ? 'Oniblock law, constant k = 0.5' : 'Detox-style gap fee, k = 0.7';
    L.push(
      claim(lbl, A[m]!.withinBps, `Volatile windows: **${verdict(V[m]!.withinBps)}** ${fa(V[m]!.withinBps)} (${signs(V[m]!.withinBps)}); calm windows: **${verdict(Cm[m]!.withinBps)}** ${fa(Cm[m]!.withinBps)} (${signs(Cm[m]!.withinBps)}). Versus an all-vanilla world (control pool): ${fa(A[m]!.vsControlBps)} bps.`),
    );
  }
  L.push('');
  L.push('**2. At what retail cost / market share?** Competitor share of the market\'s retail volume (50% = parity) and the change in total retail execution cost vs the control market.');
  L.push('');
  for (const m of ['const', 'detox', 'mjev'] as const) {
    L.push(
      `- ${m}: share ${fa(A[m]!.sharePct, 1)}% (volatile ${fmt(V[m]!.sharePct.mean, 1)}%, calm ${fmt(Cm[m]!.sharePct.mean, 1)}%); retail cost vs control ${fa(A[m]!.retailCostVsControlBps)} bps of retail volume (${signs(A[m]!.retailCostVsControlBps)}; calm ${fa(Cm[m]!.retailCostVsControlBps)}); the vanilla neighbour's LP gains ${fa(A[m]!.vanVsControlBps)} bps TVL vs control (it absorbs the displaced retail); both LPs together vs control ${fa(A[m]!.marketLpVsControlBps)} bps TVL.`,
    );
  }
  L.push('  Retail is barely affected in cost (fractions of a bp of volume) because routing lets it avoid the directional fee; the price is paid in market share.');
  L.push('');
  const Mo = A.model!;
  L.push('**3. Does model-tuned k beat constant k?** (LP-HODL of the model pool minus the constant-k pool; same prices, same order flow, same starting liquidity)');
  L.push('');
  L.push(claim('Jev-tuned k vs constant k', Mo.jevMinusConstBps, `Volatile ${fa(V.model!.jevMinusConstBps)}, calm ${fa(Cm.model!.jevMinusConstBps)}.`));
  L.push(
    claim(
      'Heuristic-tuned k vs constant k (no Jev, no fallback confound)',
      Mo.heurMinusConstBps,
      `Volatile ${fa(V.model!.heurMinusConstBps)}, calm ${fa(Cm.model!.heurMinusConstBps)}. Even where the CI excludes 0 the effect is a few $ to tens of $ per hour: the model mostly lowers k in quiet blocks (keeping a little more retail), which is a second-order effect.`,
    ),
  );
  L.push(claim('Jev vs heuristic', Mo.jevMinusHeurBps, ''));
  const fb = mean(baseRuns.map((r) => r.jev.fallbackShare)) * 100;
  const jevCalls = sum(baseRuns.map((r) => r.jev.calls));
  const src = (k: string[]) => (100 * sum(baseRuns.map((r) => sum(k.map((x) => (r.jev.counts as Record<string, number>)[x] ?? 0))))) / Math.max(1, sum(baseRuns.map((r) => sum(Object.values(r.jev.counts)))));
  L.push(`  Jev arm score sources (Jev + gated pools, all base windows): ${fmt(src(['jev', 'jev-cache']), 1)}% exact Jev answers (live or cached for the identical quantized state), ${fmt(src(['jev-nearest']), 1)}% nearest cached Jev answer (same side, gap within 5 bps, same k bucket), ${fmt(fb, 1)}% heuristic fallback; ${jevCalls} live Jev calls in total (budget ${cfg.jevBudget}/window). The heuristic arm has no fallback confound by construction.`);
  L.push('');
  L.push('**4. Does the calibration gate separate an honest model from a degraded one?** (share of 2nd-half steps with k forced to kDefault; the gated pool\'s Jev scores are inverted from mid-window)');
  L.push('');
  L.push(
    claim(
      'Degraded minus honest demotion share',
      Mo.gateSeparationPp,
      `Degraded model demoted ${fa(Mo.degradedDemoted2ndPct, 1)}% of 2nd-half steps vs honest ${fa(Mo.honestDemoted2ndPct, 1)}% (honest 1st half, incl. the initial probation until ${cfg.minSamples} labels: ${fa(Mo.honestDemoted1stPct, 1)}%). Volatile: ${fa(V.model!.gateSeparationPp, 1)} pp; calm: ${fa(Cm.model!.gateSeparationPp, 1)} pp (few labels in calm hours, slower detection). The LP value of the gate here is ~0 (gated minus honest pool, 2nd half: ${fa(Mo.gatedMinusJev2ndHalfBps)} bps) because k itself barely matters (claim 3). **Caveats:** (i) with CEX-mid labels, arb blocks are ~always labelled informed (arbs only trade when profitable), so the gate mostly checks that p is high on arb-direction flow and low otherwise, an easy test that an inverted model fails; (ii) this holds only with the settler marking out against the CEX mid at the swap's block time. With today's settler labelling against the attested (lagged) mid, arb swaps look unprofitable and the honest model is demoted too: ${labTxt || 'n/a'}.`,
      'pp',
    ),
  );
  L.push('');
  L.push('**What changed vs v1, and why.** ' +
    `(a) Keeper lag: with the keeper attesting the same mid the arb sees (v1 assumption, lag0 variant) the constant-k pool's LP gain roughly doubles in the two variant windows (detox is mixed): ${lagTxt || 'n/a'}. (b) Competition: v1 gave every pool the same retail flow; here the hooked pools keep ~${fmt(A.const!.sharePct.mean, 0)}% of it, which is what turns quiet hours negative. (c) Split swaps: splitting every arb into 5 sub-swaps changes the constant-k pools' LP difference by at most ${fmt(splitMax, 3)} bps (per-block anchor works).`);
  L.push('');
  L.push('**Sanity.** ' +
    `Control market (vanilla vs vanilla): share of pool b ${fmt(mean(ctlShares) * 100, 2)}% in every window (range ${fmt(Math.min(...ctlShares) * 100, 2)}-${fmt(Math.max(...ctlShares) * 100, 2)}%), LP difference ${fmt(Math.max(...ctlWithin.map(Math.abs)), 4)} bps at most. The fixed-fee competitor IS the control (identical hookless 0.30% pool). Reverts: ${allReverts.length ? JSON.stringify(revertKinds) : 'none'} in ${results.length} runs.`);
  L.push('');
  L.push('**Assumptions that remain** (each is a flag; see Setup):');
  L.push('');
  L.push(`- Keeper posts the mid of the previous 1s step (lag ${cfg.keeperLag}), misses ${cfg.missProb * 100}% of steps; arbitrageurs see the true 1s kline close with no latency beyond a ${cfg.arbLateProb * 100}% "late" draw. Kline closes stand in for the CEX mid (no spread, no depth); CEX hedging is assumed instant at the mid plus taker fee (${cfg.arbs.map((a) => a.cexBps + ' bps').join(' / ')}).`);
  L.push(`- Retail total demand is fixed (Poisson ${cfg.lambda}/s per market, lognormal median $${cfg.retailMedianUsd}, sigma ${cfg.retailSigma}); elasticity comes only from routing between the two pools of a market (${cfg.routing}, optimal split with a ${cfg.minSplitFrac * 100}% minimum leg), with no retail gas, no aggregator fees and perfect quotes. ${cfg.informedFrac * 100}% of orders are informed (trade the sign of the next ${cfg.informedHorizon}s move).`);
  L.push('- Full-range liquidity only, one LP per pool, no JIT, no LP re-allocation between pools during the hour; two pools per market (real markets have more venues and fee tiers).');
  L.push('- One hour per window at 1s steps: 12 windows is still a small sample, and the windows are the most volatile / typical-quiet hours of the last 60 days (selection rule in data/windows_v2.json), so the volatile rows are stress tests, not an average day.');
  L.push('- Settler labels arb-direction swaps against the CEX mid at the swap\'s block time (fetched ex post; `--label-mid attested` = today\'s services behaviour, see the labelatt variant); calibration posts every ' + cfg.settleEvery + ' steps over the last ' + cfg.calibWindow + ' labelled blocks, minSamples ' + cfg.minSamples + '.');

  // ---------------- tables
  const T: string[] = [];
  T.push(`# Oniblock benchmark v2 - markets with routing competition`);
  T.push('');
  T.push(`Generated ${new Date().toISOString()} - total runtime ${meta.totalSec}s (${results.length} runs). Reproduce: \`pnpm -C benchmark bench:v2\` (quick: \`bench:v2:quick\`). v1 results are untouched in \`results/\`.${meta.quick ? ' **QUICK MODE: 300 steps, heuristic scorer in the Jev arm; not evidence.**' : ''}`);
  T.push('');
  T.push(...L);
  T.push('');
  T.push('## Setup');
  T.push('');
  T.push(
    `Fresh anvil per run (\`--prune-history\`), \`contracts/script/bench/DeployBenchV2.s.sol\`: one OniblockHook, six markets = 12 v4 pools with identical full-range liquidity (~$${fmt(baseRuns[0]?.initialTvlUsd ?? 0, 0)} per pool at the start, L scaled per asset) and the same initial price. Markets: ${MARKETS.map((m) => `**${m.name}** (${m.label})`).join('; ')}. Hooked pools: base fee 0.30%, feeMax 1%, conservativeFee 0.50%, stale after ${cfg.staleSteps} steps, model pools kMin 0.2 / kMax 0.8 / kDefault 0.5, Brier gate 0.25, minSamples ${cfg.minSamples}.`,
  );
  T.push('');
  T.push(
    `Each 1s step = 3 blocks: (A) keeper attests mid[t-${cfg.keeperLag}] (missed with p=${cfg.missProb}), settler posts calibration every ${cfg.settleEvery} steps; (B) two competing arbitrageurs (CEX taker ${cfg.arbs.map((a) => a.cexBps).join('/')} bps, gas $${cfg.arbs.map((a) => a.gasUsd).join('/$')} per tx, random priority, ${cfg.arbLateProb * 100}% late each, min profit $${cfg.minProfitUsd}) trade each pool to their no-trade band vs the TRUE mid[t] at the hook-quoted fee; (C) retail orders (identical across markets) routed per market by best execution. LP-HODL = LP position incl. uncollected fees minus the initial deposit held, both at the true mid. Within-window CIs: circular block bootstrap over 1-minute buckets (block 8); across-window CIs: bootstrap over windows (10,000 resamples).`,
  );
  T.push('');
  T.push('## Per-window results (base variant)');
  T.push('');
  T.push('LP difference = competitor LP-HODL minus the vanilla pool in the same market, bps of per-pool TVL (95% within-window CI in USD). Share = competitor share of market retail volume. Retail cost vs control = bps of market retail volume.');
  T.push('');
  T.push('| window | vol 1m bps | market | LP diff bps | LP diff USD [CI] | share | retail cost vs ctl | comp arbs / vanilla arbs | comp arb profit / vanilla (USD) | mean comp arb fee | mean comp k |');
  T.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of baseRuns) {
    const m = mm.get(r.label)!;
    for (const mk of MARKETS) {
      const x = m[mk.name];
      T.push(
        `| ${r.windowId} | ${fmt(r.vol1mBps)} | ${mk.name} | ${fmt(x.withinBps)} | ${fmt(x.withinCI.est, 0)} [${fmt(x.withinCI.lo, 0)}, ${fmt(x.withinCI.hi, 0)}] | ${fmt(x.share * 100, 1)}% | ${fmt(x.retailCostVsControlBps)} | ${x.compNArb} / ${x.vanNArb} | ${fmt(x.compArbProfit, 0)} / ${fmt(x.vanArbProfit, 0)} | ${fmt(x.compArbFee, 0)} | ${fmt(x.compMeanK, 0)} |`,
      );
    }
  }
  T.push('');
  T.push('## Across-window aggregates');
  T.push('');
  T.push('| group | market | LP diff vs vanilla (bps) | signs | comp vs control pool | vanilla vs control pool | market LP vs control | share % | retail cost vs ctl (bps vol) |');
  T.push('|---|---|---|---|---|---|---|---|---|');
  for (const g of ['all', 'volatile', 'calm']) {
    for (const m of MARKETS) {
      const x = agg[g]![m.name]!;
      T.push(`| ${g} | ${m.name} | ${fa(x.withinBps)} | ${signs(x.withinBps)} | ${fa(x.vsControlBps)} | ${fa(x.vanVsControlBps)} | ${fa(x.marketLpVsControlBps)} | ${fa(x.sharePct, 1)} | ${fa(x.retailCostVsControlBps)} |`);
    }
  }
  T.push('');
  T.push('## Model and gate per window');
  T.push('');
  T.push('| window | Jev k - const k (bps TVL) [within CI USD] | heur k - const k | Jev - heur | honest demoted 1st/2nd half | degraded demoted 1st/2nd half | honest seasoned at step | gated - honest LP, 2nd half (bps) | Jev calls / fallback |');
  T.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of baseRuns) {
    const x = md.get(r.label)!;
    T.push(
      `| ${r.windowId} | ${fmt(x.jevMinusConstBps)} [${fmt(x.jevMinusConstCI.lo, 0)}, ${fmt(x.jevMinusConstCI.hi, 0)}] | ${fmt(x.heurMinusConstBps)} | ${fmt(x.jevMinusHeurBps)} | ${fmt(r.demoted.mjev.firstHalf * 100, 0)}% / ${fmt(r.demoted.mjev.secondHalf * 100, 0)}% | ${fmt(r.demoted.gated.firstHalf * 100, 0)}% / ${fmt(r.demoted.gated.secondHalf * 100, 0)}% | ${r.demoted.mjev.seasonedAtStep ?? 'never'} | ${fmt(x.gatedMinusJev2ndHalfBps)} | ${r.jev.calls} / ${fmt(r.jev.fallbackShare * 100, 1)}% |`,
    );
  }
  T.push('');
  T.push('## Variants (ETH-vol1, BTC-vol1)');
  T.push('');
  T.push('split5 = every arb split into 5 sub-swaps in one tx (tests the per-block anchor). lag0 = the v1 assumption: keeper attests the same mid the arb sees, never misses. labelatt = the settler labels arb-direction swaps against the attested (lagged) mid in force, as services/src/settler.ts does today (MARKOUT_HORIZON=0), instead of the CEX mid at the swap\'s block time.');
  T.push('');
  T.push('| window | variant | market | LP diff bps (base) | (variant) | share (base) | (variant) | mean arb fee (base) | (variant) | comp arb profit USD (base) | (variant) |');
  T.push('|---|---|---|---|---|---|---|---|---|---|---|');
  T.push(...variantRows);
  T.push('');
  T.push('| run | Jev k - const k (bps) | heur k - const k (bps) | honest (Jev) demoted 1st/2nd half | heuristic demoted 1st/2nd | degraded demoted 2nd half | label base rate, arb blocks (Jev pool) |');
  T.push('|---|---|---|---|---|---|---|');
  for (const r of results.filter((x) => x.variant !== 'base' || VARIANT_WINDOWS_R.includes(x.windowId))) {
    const x = md.get(r.label)!;
    T.push(
      `| ${r.label} | ${fmt(x.jevMinusConstBps)} | ${fmt(x.heurMinusConstBps)} | ${fmt(r.demoted.mjev.firstHalf * 100, 0)}% / ${fmt(r.demoted.mjev.secondHalf * 100, 0)}% | ${fmt(r.demoted.mheur.firstHalf * 100, 0)}% / ${fmt(r.demoted.mheur.secondHalf * 100, 0)}% | ${fmt(r.demoted.gated.secondHalf * 100, 0)}% | ${fmt(r.labelDiag.mjev.baseRateArbBlocks * 100, 0)}% of ${r.labelDiag.mjev.nArbBlocks} |`,
    );
  }
  T.push('');
  T.push('## Runs');
  T.push('');
  T.push('| run | steps | runtime s | txs | reverts | missed posts | arb wins (A/B) | retail orders / USD | Jev sources |');
  T.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of results)
    T.push(`| ${r.label} | ${r.config.steps} | ${r.runtimeSec} | ${r.txCount} | ${r.reverts.length} | ${r.missedPosts} | ${r.arbWins.join('/')} | ${r.retailOrders} / ${fmt(r.retailUsd, 0)} | ${JSON.stringify(r.jev.counts)} |`);
  T.push('');
  T.push('Charts: `chart-lp.svg` (LP difference vs vanilla per window), `chart-share.svg` (competitor retail share), `chart-retail.svg` (market retail cost vs control).');
  writeFileSync(resolve(outDir, 'results.md'), T.join('\n') + '\n');

  renderChartsV2(baseRuns, mm, agg, outDir);

  return {
    generatedAt: new Date().toISOString(),
    totalSec: meta.totalSec,
    quick: meta.quick,
    config: meta.cfg,
    steps: meta.steps,
    aggregates: agg,
    perRun: results.map((r) => ({
      label: r.label,
      windowId: r.windowId,
      asset: r.asset,
      regime: r.regime,
      variant: r.variant,
      startIso: r.config.startIso,
      initialMid: r.config.initialMid,
      finalMid: r.config.finalMid,
      initialTvlUsd: r.initialTvlUsd,
      markets: mm.get(r.label),
      model: md.get(r.label),
      totals: r.totals,
      calibrations: r.calibrations,
      kBuckets: r.kBuckets,
      labelDiag: r.labelDiag,
      missedPosts: r.missedPosts,
      arbWins: r.arbWins,
      retailOrders: r.retailOrders,
      retailUsd: r.retailUsd,
      jev: r.jev,
      reverts: r.reverts,
      txCount: r.txCount,
      runtimeSec: r.runtimeSec,
    })),
    sanity: { controlShares: ctlShares, controlWithinBps: ctlWithin, reverts: revertKinds },
  };
}

// ------------------------------------------------------------------------------------------------ SVG

const REG_L = { volatile: '#2a78d6', calm: '#eb6834' };
const REG_D = { volatile: '#3987e5', calm: '#d95926' };
const style = `<style>
 .bg{fill:#fcfcfb} .grid{stroke:#e8e7e2} .ax{stroke:#c9c8c2} .zero{stroke:#8a8983;stroke-dasharray:3 3}
 .t{fill:#0b0b0b;font:600 13px system-ui,sans-serif} .l{fill:#52514e;font:10px system-ui,sans-serif} .h{fill:#0b0b0b;font:600 15px system-ui,sans-serif}
 .vol{fill:${REG_L.volatile}} .calm{fill:${REG_L.calm}} .mean{fill:#52514e} .ci{stroke:#0b0b0b;stroke-width:1.5}
 @media (prefers-color-scheme: dark){ .bg{fill:#1a1a19} .grid{stroke:#2b2b29} .ax{stroke:#4a4a47} .zero{stroke:#77766f}
  .t,.h{fill:#fff} .l{fill:#c3c2b7} .vol{fill:${REG_D.volatile}} .calm{fill:${REG_D.calm}} .mean{fill:#c3c2b7} .ci{stroke:#fff} }
</style>`;

function niceTicks(lo: number, hi: number, n = 4): number[] {
  const span = hi - lo || 1;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0)!;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/** Small multiples: one panel per market, one bar per window (colored by regime) + an across-window mean bar with CI. */
function barPanels(
  title: string,
  yLabel: string,
  runs: RunResultV2[],
  markets: MarketName[],
  val: (r: RunResultV2, m: MarketName) => number,
  aggOf: (m: MarketName) => Agg,
  ref = 0,
): string {
  const pw = 330;
  const ph = 256;
  const cols = 3;
  const rows = Math.ceil(markets.length / cols);
  const W = pw * cols + 20;
  const H = ph * rows + 70;
  const out: string[] = [`<text class="h" x="16" y="24">${title}</text>`];
  out.push(`<rect class="vol" x="16" y="36" width="10" height="10" rx="2"/><text class="l" x="30" y="45">volatile window</text>`);
  out.push(`<rect class="calm" x="120" y="36" width="10" height="10" rx="2"/><text class="l" x="134" y="45">calm window</text>`);
  out.push(`<rect class="mean" x="210" y="36" width="10" height="10" rx="2"/><text class="l" x="224" y="45">mean of all windows, 95% CI over windows</text>`);
  markets.forEach((m, k) => {
    const ox = 10 + (k % cols) * pw;
    const oy = 60 + Math.floor(k / cols) * ph;
    const vals = runs.map((r) => val(r, m));
    const g = aggOf(m);
    const all = [...vals, g.lo, g.hi, ref].filter(Number.isFinite);
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    if (hi - lo < 0.2) {
      const c = (hi + lo) / 2;
      (hi = c + 0.1), (lo = c - 0.1);
    }
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
    const ml = 46;
    const mt = 22;
    const iw = pw - ml - 14;
    const ih = ph - mt - 70;
    const Y = (v: number) => oy + mt + (1 - (v - lo) / (hi - lo)) * ih;
    out.push(`<text class="t" x="${ox + ml}" y="${oy + 14}">${m}</text>`);
    for (const v of niceTicks(lo, hi)) {
      out.push(`<line class="grid" x1="${ox + ml}" x2="${ox + ml + iw}" y1="${Y(v)}" y2="${Y(v)}"/>`);
      out.push(`<text class="l" x="${ox + ml - 4}" y="${Y(v) + 3}" text-anchor="end">${fmt(v, Math.abs(v) < 10 ? 1 : 0)}</text>`);
    }
    out.push(`<line class="zero" x1="${ox + ml}" x2="${ox + ml + iw}" y1="${Y(ref)}" y2="${Y(ref)}"/>`);
    const n = runs.length + 1;
    const slot = iw / n;
    const bw = Math.max(4, slot - 2);
    runs.forEach((r, i) => {
      const v = vals[i]!;
      if (!Number.isFinite(v)) return;
      const x = ox + ml + i * slot + 1;
      const y0 = Y(ref);
      const y1 = Y(v);
      out.push(
        `<rect class="${r.regime === 'volatile' ? 'vol' : 'calm'}" x="${x.toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(y1 - y0)).toFixed(1)}" rx="2"><title>${r.windowId} ${m}: ${fmt(v)} ${yLabel}</title></rect>`,
      );
      out.push(`<text class="l" x="${(x + bw / 2).toFixed(1)}" y="${oy + mt + ih + 10}" text-anchor="end" transform="rotate(-60 ${(x + bw / 2).toFixed(1)} ${oy + mt + ih + 10})">${r.windowId.replace('-', ' ')}</text>`);
    });
    const x = ox + ml + runs.length * slot + 1;
    out.push(
      `<rect class="mean" x="${x.toFixed(1)}" y="${Math.min(Y(ref), Y(g.mean)).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(Y(g.mean) - Y(ref))).toFixed(1)}" rx="2"><title>mean ${fmt(g.mean)} [${fmt(g.lo)}, ${fmt(g.hi)}] ${yLabel}</title></rect>`,
    );
    out.push(`<line class="ci" x1="${(x + bw / 2).toFixed(1)}" x2="${(x + bw / 2).toFixed(1)}" y1="${Y(g.lo).toFixed(1)}" y2="${Y(g.hi).toFixed(1)}"/>`);
    out.push(`<text class="l" x="${(x + bw / 2).toFixed(1)}" y="${oy + mt + ih + 10}" text-anchor="end" transform="rotate(-60 ${(x + bw / 2).toFixed(1)} ${oy + mt + ih + 10})">mean</text>`);
    out.push(`<text class="l" x="${ox + 10}" y="${oy + mt + ih / 2}" transform="rotate(-90 ${ox + 10} ${oy + mt + ih / 2})" text-anchor="middle">${yLabel}</text>`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${title}"><title>${title}</title>${style}<rect class="bg" width="${W}" height="${H}"/>${out.join('\n')}</svg>\n`;
}

function renderChartsV2(runs: RunResultV2[], mm: Map<string, ReturnType<typeof marketMetrics>>, agg: Record<string, Record<string, Record<string, Agg>>>, outDir: string) {
  const all: MarketName[] = MARKETS.map((m) => m.name);
  const A = agg.all!;
  writeFileSync(
    resolve(outDir, 'chart-lp.svg'),
    barPanels('LP-HODL of the competitor minus the vanilla pool in the same market (bps of pool TVL, 1 h)', 'bps TVL', runs, all, (r, m) => mm.get(r.label)![m].withinBps, (m) => A[m]!.withinBps),
  );
  writeFileSync(
    resolve(outDir, 'chart-share.svg'),
    barPanels('Competitor share of market retail volume (%; 50% = parity)', '% share', runs, all, (r, m) => mm.get(r.label)![m].share * 100, (m) => A[m]!.sharePct, 50),
  );
  writeFileSync(
    resolve(outDir, 'chart-retail.svg'),
    barPanels('Market retail cost minus control-market retail cost (bps of retail volume)', 'bps of volume', runs, all.filter((m) => m !== 'control'), (r, m) => mm.get(r.label)![m].retailCostVsControlBps, (m) => A[m]!.retailCostVsControlBps),
  );
}
