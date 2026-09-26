/** v3 metrics, statistics (within-window block bootstrap + across-window bootstrap over windows), results.md, SVG charts. */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { blockBootstrapSum } from '../util.js';
import { aggWindows, type Agg } from '../v2/report2.js';
import { MARKETS, MODEL_POOLS, type Pool } from './chain3.js';
import type { RunConfigV3, RunResultV3 } from './sim3.js';

type MarketName = (typeof MARKETS)[number]['name'];
const COMP_MARKETS = MARKETS.filter((m) => m.name !== 'control');
const THR_MARKETS = ['tconst', 'theur', 'tjev'] as const;
const sum = (x: number[]) => x.reduce((a, b) => a + b, 0);
const mean = (x: number[]) => (x.length ? sum(x) / x.length : NaN);
const r2 = (x: number) => Math.round(x * 100) / 100;

const withinCI = (a: number[], b: number[], seed: number) => {
  const c = blockBootstrapSum(a.map((v, i) => v - b[i]!), { seed, B: 2000, len: 8 });
  return { est: r2(c.est), lo: r2(c.lo), hi: r2(c.hi) };
};

/** Per-run, per-market metrics. USD and bps of the initial per-pool TVL. */
export function marketMetrics(r: RunResultV3) {
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
    const ab = (r.arbAtBase as Record<string, { atBase: number; n: number }>)[m.comp];
    return {
      withinUsd: r2(c.lpMinusHodl - v.lpMinusHodl),
      withinBps: bps(c.lpMinusHodl - v.lpMinusHodl),
      withinCI: withinCI(r.buckets[m.comp as Pool].dLp, r.buckets[m.vanilla as Pool].dLp, 100 + i),
      vsControlBps: bps(c.lpMinusHodl - ctlLp),
      vanVsControlBps: bps(v.lpMinusHodl - ctlLp),
      marketLpVsControlBps: bps(c.lpMinusHodl + v.lpMinusHodl - 2 * ctlLp),
      share: vol > 0 ? c.retailVol / vol : NaN,
      retailCostBps: vol > 0 ? (cost / vol) * 1e4 : NaN,
      retailCostVsControlBps: vol > 0 && ctlVol > 0 ? (cost / vol - ctlCost / ctlVol) * 1e4 : NaN,
      compArbProfit: r2(c.arbProfit),
      vanArbProfit: r2(v.arbProfit),
      compNArb: c.nArb,
      vanNArb: v.nArb,
      compArbFee: c.meanArbFeePips,
      compRetailFee: c.meanRetailFeePips,
      compMeanK: c.meanK,
      arbAtBaseShare: ab && ab.n ? ab.atBase / ab.n : NaN,
    };
  }
  MARKETS.forEach((m, i) => (out[m.name] = one(m, i)));
  return out;
}

function modelMetrics(r: RunResultV3) {
  const T = r.totals;
  const bps = (usd: number) => (usd / r.initialTvlUsd) * 1e4;
  const h = r.degradeAtStep / r.config.bucketSteps;
  const second = (x: number[]) => x.slice(Math.floor(h));
  const g = r.gate.tjev;
  return {
    tconstMinusOldBps: bps(T.tconst.lpMinusHodl - T.old.lpMinusHodl),
    jevMinusConstBps: bps(T.tjev.lpMinusHodl - T.tconst.lpMinusHodl),
    heurMinusConstBps: bps(T.theur.lpMinusHodl - T.tconst.lpMinusHodl),
    jevMinusHeurBps: bps(T.tjev.lpMinusHodl - T.theur.lpMinusHodl),
    tconstMinusOldCI: withinCI(r.buckets.tconst.dLp, r.buckets.old.dLp, 200),
    jevMinusConstCI: withinCI(r.buckets.tjev.dLp, r.buckets.tconst.dLp, 201),
    gatedMinusJev2ndHalfBps: bps(sum(second(r.buckets.tgated.dLp)) - sum(second(r.buckets.tjev.dLp))),
    gateSeparationPp: (r.demoted.tgated.secondHalf - r.demoted.tjev.secondHalf) * 100,
    /** share of the Jev pool's attestation steps where the model was consulted (above threshold) */
    jevStepShare: g.rule + g.model ? g.model / (g.rule + g.model) : NaN,
  };
}

const fmt = (x: number | null | undefined, d = 2) =>
  x === null || x === undefined || !Number.isFinite(x) ? '-' : Math.abs(x) >= 1000 ? Math.round(x).toLocaleString('en-US') : x.toFixed(d);
const fa = (g: Agg, d = 2) => `${fmt(g.mean, d)} [${fmt(g.lo, d)}, ${fmt(g.hi, d)}]`;
const signs = (g: Agg) => `${g.pos}+/${g.neg}- of ${g.n}`;
const verdict = (g: Agg) => (g.lo > 0 ? 'YES' : g.hi < 0 ? 'NO' : 'INCONCLUSIVE');
const pctFee = (pips: number) => `${(pips / 1e4).toFixed(2)}%`;

type Meta = { quick: boolean; totalSec: number; cfg: Omit<RunConfigV3, 'label' | 'path' | 'port'>; steps: number };

export function writeReportV3(results: RunResultV3[], outDir: string, meta: Meta) {
  const mm = new Map(results.map((r) => [r.label, marketMetrics(r)]));
  const md = new Map(results.map((r) => [r.label, modelMetrics(r)]));
  const byVar = (v: string) => results.filter((r) => r.variant === v);
  const variantsPresent = [...new Set(results.map((r) => r.variant))];
  const aggOf = (runs: RunResultV3[], f: (r: RunResultV3) => number, seed: number) => aggWindows(runs.map(f).filter(Number.isFinite), seed);

  // ---------------- aggregates per fee tier (base = 0.30%, b500 = 0.05%) x regime group
  type G = Record<string, Record<string, Agg>>;
  const agg: Record<string, Record<string, G>> = {};
  let seed = 1;
  for (const v of ['base', 'b500']) {
    const runs = byVar(v);
    if (!runs.length) continue;
    agg[v] = {};
    const groups = { all: runs, volatile: runs.filter((r) => r.regime === 'volatile'), calm: runs.filter((r) => r.regime === 'calm') };
    for (const [g, rs] of Object.entries(groups)) {
      const x: G = {};
      for (const m of MARKETS) {
        const M = (r: RunResultV3) => mm.get(r.label)![m.name];
        x[m.name] = {
          withinBps: aggOf(rs, (r) => M(r).withinBps, seed++),
          vsControlBps: aggOf(rs, (r) => M(r).vsControlBps, seed++),
          vanVsControlBps: aggOf(rs, (r) => M(r).vanVsControlBps, seed++),
          marketLpVsControlBps: aggOf(rs, (r) => M(r).marketLpVsControlBps, seed++),
          sharePct: aggOf(rs, (r) => M(r).share * 100, seed++),
          retailCostVsControlBps: aggOf(rs, (r) => M(r).retailCostVsControlBps, seed++),
          arbAtBasePct: aggOf(rs, (r) => M(r).arbAtBaseShare * 100, seed++),
        };
      }
      const D = (r: RunResultV3) => md.get(r.label)!;
      x.model = {
        tconstMinusOldBps: aggOf(rs, (r) => D(r).tconstMinusOldBps, seed++),
        jevMinusConstBps: aggOf(rs, (r) => D(r).jevMinusConstBps, seed++),
        heurMinusConstBps: aggOf(rs, (r) => D(r).heurMinusConstBps, seed++),
        jevMinusHeurBps: aggOf(rs, (r) => D(r).jevMinusHeurBps, seed++),
        gatedMinusJev2ndHalfBps: aggOf(rs, (r) => D(r).gatedMinusJev2ndHalfBps, seed++),
        gateSeparationPp: aggOf(rs, (r) => D(r).gateSeparationPp, seed++),
        honestDemoted2ndPct: aggOf(rs, (r) => r.demoted.tjev.secondHalf * 100, seed++),
        degradedDemoted2ndPct: aggOf(rs, (r) => r.demoted.tgated.secondHalf * 100, seed++),
        jevStepSharePct: aggOf(rs, (r) => D(r).jevStepShare * 100, seed++),
        labelledJev: aggOf(rs, (r) => r.labelDiag.tjev.n, seed++),
        labelledGated: aggOf(rs, (r) => r.labelDiag.tgated.n, seed++),
      };
      agg[v]![g] = x;
    }
  }

  // ---------------- sanity
  const ctlShares = results.map((r) => mm.get(r.label)!.control.share);
  const ctlWithin = results.map((r) => mm.get(r.label)!.control.withinBps);
  const allReverts = results.flatMap((r) => r.reverts.map((x) => ({ run: r.label, ...x })));
  const revertKinds: Record<string, number> = {};
  for (const x of allReverts) revertKinds[`${x.label}${x.pool ? ':' + x.pool : ''}`] = (revertKinds[`${x.label}${x.pool ? ':' + x.pool : ''}`] ?? 0) + 1;
  const split5 = byVar('split5').map((v) => ({ v, b: byVar('base').find((x) => x.windowId === v.windowId)! })).filter((x) => x.b);
  const splitMax = Math.max(0, ...split5.flatMap(({ v, b }) => (['old', 'tconst'] as const).map((m) => Math.abs(mm.get(v.label)![m].withinBps - mm.get(b.label)![m].withinBps))));

  // ---------------- conclusion
  const cfg = meta.cfg;
  const L: string[] = [];
  const baseRuns = byVar('base');
  const tvl = baseRuns[0]?.initialTvlUsd ?? 2e7;
  const usd = (b: number) => `$${fmt((b * tvl) / 1e4, 0)}`;
  const faU = (g: Agg) => `${fa(g)} bps (≈ ${usd(g.mean)}/h, CI ${usd(g.lo)} to ${usd(g.hi)})`;
  const claim = (title: string, g: Agg, extra: string, unit: 'bps' | 'pp' = 'bps') =>
    `- **${title}: ${verdict(g)}.** ${unit === 'bps' ? faU(g) : fa(g, 1) + ' pp'} (${signs(g)}). ${extra}`;
  L.push('## CONCLUSION');
  L.push('');
  L.push(
    `Plain-language verdicts. Numbers are across-window means over ${baseRuns.length} one-hour windows (${baseRuns.filter((r) => r.regime === 'volatile').length} volatile, ${baseRuns.filter((r) => r.regime === 'calm').length} calm; ETHUSDT + BTCUSDT; the same frozen windows as v2), in **bps of one pool's starting TVL (~$${fmt(tvl, 0)}) per hour**, with a 95% bootstrap CI over windows in brackets and the sign count (windows > 0 / < 0). YES/NO = the CI excludes 0 in that direction; otherwise INCONCLUSIVE. Main tier: every pool (hooked and vanilla) at base fee ${pctFee(cfg.baseFee)}, threshold ${pctFee(cfg.thrPips)}; the "b500" tier repeats all 12 windows with base fee 0.05% on every pool (threshold 0.08%).`,
  );
  L.push('');
  const B = agg.base;
  const F = agg.b500;
  if (meta.quick || !B) {
    L.push('**Bottom line.** QUICK MODE: a smoke test of the pipeline, not evidence.');
  } else {
    const A = B.all!;
    const V = B.volatile!;
    const C = B.calm!;
    const calmFixed = Math.abs(C.tconst!.withinBps.mean) < Math.abs(C.old!.withinBps.mean) / 3;
    const volKept = V.tconst!.withinBps.mean >= 0.8 * V.old!.withinBps.mean || V.tconst!.withinBps.mean >= V.old!.withinBps.mean - 0.02;
    L.push(
      `**Bottom line.** ${calmFixed ? `**Calm hours are essentially fixed** (the loss shrinks from ${usd(C.old!.withinBps.mean)}/h to ${usd(C.tconst!.withinBps.mean)}/h)` : '**Calm hours are NOT fixed**'}: with the threshold the hooked pool charges exactly the base fee whenever the gap is below ${pctFee(cfg.thrPips)}, i.e. it is a vanilla pool in quiet markets (calm-window LP difference vs vanilla: threshold law ${fa(C.tconst!.withinBps)} bps/h, ${signs(C.tconst!.withinBps)}, vs ${fa(C.old!.withinBps)} for the v2 law; retail share ${fmt(C.tconst!.sharePct.mean, 1)}% vs ${fmt(C.old!.sharePct.mean, 1)}%). ${volKept ? 'Volatile-hour gains are **kept**' : 'Volatile-hour gains are **NOT kept**'} (volatile: ${fa(V.tconst!.withinBps)} vs v2 law ${fa(V.old!.withinBps)}). Over all ${baseRuns.length} windows the threshold law with constant k is **${verdict(A.tconst!.withinBps)}** vs the vanilla pool next to it (${faU(A.tconst!.withinBps)}). Model-tuned k (Jev only above the threshold, or the heuristic) vs constant k: Jev ${fa(A.model!.jevMinusConstBps)} bps, heuristic ${fa(A.model!.heurMinusConstBps)} bps. The keeper consulted Jev on only ${fmt(A.model!.jevStepSharePct.mean, 1)}% of steps (the rest were rule-v1 posts below the threshold).`,
    );
    const volRuns = baseRuns.filter((r) => r.regime === 'volatile');
    const mFee = (m: MarketName) => mean(volRuns.map((r) => mm.get(r.label)![m].compArbFee ?? NaN).filter(Number.isFinite));
    L.push('');
    L.push(
      `**Why.** Competing arbitrageurs keep every pool inside its no-trade band (gap ≈ base fee + CEX taker fee ≈ ${pctFee(cfg.baseFee + 200)}), so a new 1 s move opens a gap only a little above the ${pctFee(cfg.thrPips)} threshold. The v2 law charged k on the WHOLE gap (volatile-hour mean arb fee on the v2-law pool ${fmt(mFee('old'), 0)} pips) and so earned more per arb but lost ~${fmt(100 - 2 * A.old!.sharePct.mean, 0)} pp of retail share; the threshold law charges k only on the excess (mean arb fee ${fmt(mFee('tconst'), 0)} pips, ${fmt(V.tconst!.arbAtBasePct.mean, 0)}% of volatile-hour arbs pay exactly the base fee) and keeps retail parity (${fmt(A.tconst!.sharePct.mean, 1)}% share). The result is a pool that behaves almost exactly like its vanilla neighbour: the calm-hour loss is gone, but so is most of the volatile-hour gain.`,
    );
    L.push('');
    L.push('**1. Are calm hours fixed?** (competitor LP-HODL minus vanilla LP-HODL in the same market, calm windows)');
    L.push('');
    for (const m of ['old', 'tconst', 'theur', 'tjev'] as const)
      L.push(`- ${m} (${MARKETS.find((x) => x.name === m)!.label}): **${verdict(C[m]!.withinBps)}** ${fa(C[m]!.withinBps)} bps/h (${signs(C[m]!.withinBps)}); retail share ${fa(C[m]!.sharePct, 1)}%; arbs paying exactly base fee ${fmt(C[m]!.arbAtBasePct.mean, 0)}%.`);
    L.push('');
    L.push('**2. Are volatile-hour gains kept?** (volatile windows)');
    L.push('');
    for (const m of ['old', 'tconst', 'theur', 'tjev'] as const)
      L.push(`- ${m}: **${verdict(V[m]!.withinBps)}** ${fa(V[m]!.withinBps)} bps/h (${signs(V[m]!.withinBps)}); share ${fmt(V[m]!.sharePct.mean, 1)}%; arbs paying exactly base ${fmt(V[m]!.arbAtBasePct.mean, 0)}%.`);
    L.push(claim('Threshold law minus v2 law, same constant k (paired per window, volatile)', V.model!.tconstMinusOldBps, `Calm: ${fa(C.model!.tconstMinusOldBps)}; all: ${fa(A.model!.tconstMinusOldBps)} (${signs(A.model!.tconstMinusOldBps)}).`));
    L.push('');
    L.push('**3. Overall: does the LP beat the vanilla pool next to it under routing competition?** (all windows)');
    L.push('');
    for (const m of ['old', ...THR_MARKETS] as const)
      L.push(claim(MARKETS.find((x) => x.name === m)!.label.replace('vanilla vs ', ''), A[m]!.withinBps, `Volatile ${fa(V[m]!.withinBps)}, calm ${fa(C[m]!.withinBps)}. Versus an all-vanilla world (control pool): ${fa(A[m]!.vsControlBps)} bps.`));
    L.push('');
    L.push('**4. Jev-gated k vs constant k vs heuristic k** (LP-HODL difference between hooked pools, same prices / flow / liquidity; all three use the threshold law)');
    L.push('');
    L.push(claim('Jev k (Jev only above threshold) minus constant k', A.model!.jevMinusConstBps, `Volatile ${fa(V.model!.jevMinusConstBps)}, calm ${fa(C.model!.jevMinusConstBps)}.`));
    L.push(claim('Heuristic k minus constant k', A.model!.heurMinusConstBps, `Volatile ${fa(V.model!.heurMinusConstBps)}, calm ${fa(C.model!.heurMinusConstBps)}.`));
    L.push(claim('Jev minus heuristic', A.model!.jevMinusHeurBps, ''));
    const jevCalls = sum(baseRuns.map((r) => r.jev.calls));
    const cnt = (k: string[]) => sum(baseRuns.map((r) => sum(k.map((x) => (r.jev.counts as Record<string, number>)[x] ?? 0))));
    const nScores = cnt(['jev', 'jev-cache', 'jev-nearest', 'heuristic', 'heuristic-paced', 'heuristic-jev-failed']);
    const ruleSteps = sum(baseRuns.map((r) => r.gate.tjev.rule));
    const modelSteps = sum(baseRuns.map((r) => r.gate.tjev.model));
    L.push(
      `  **Jev call share:** the Jev pool's keeper posted ${ruleSteps} rule-v1 attestations and consulted the model on ${modelSteps} steps (${fmt((100 * modelSteps) / Math.max(1, ruleSteps + modelSteps), 1)}% of attestation steps; volatile ${fmt(V.model!.jevStepSharePct.mean, 1)}%, calm ${fmt(C.model!.jevStepSharePct.mean, 1)}%). Jev + gated pools together: ${nScores} model scores, of which ${fmt((100 * cnt(['jev', 'jev-cache'])) / Math.max(1, nScores), 1)}% exact Jev answers (live or cached), ${fmt((100 * cnt(['jev-nearest'])) / Math.max(1, nScores), 1)}% nearest cached Jev answer, ${fmt((100 * cnt(['heuristic', 'heuristic-paced', 'heuristic-jev-failed'])) / Math.max(1, nScores), 1)}% heuristic fallback; ${jevCalls} live Jev calls in total across the ${baseRuns.length} base runs (budget ${cfg.jevBudget}/run) vs 1883 in v2.`,
    );
    L.push('');
    L.push('**5. Retail share and cost** (competitor share of the market\'s retail volume, 50% = parity; market retail cost vs the control market, bps of retail volume)');
    L.push('');
    for (const m of ['old', ...THR_MARKETS] as const)
      L.push(`- ${m}: share ${fa(A[m]!.sharePct, 1)}% (volatile ${fmt(V[m]!.sharePct.mean, 1)}%, calm ${fmt(C[m]!.sharePct.mean, 1)}%); retail cost vs control ${fa(A[m]!.retailCostVsControlBps)} bps (calm ${fa(C[m]!.retailCostVsControlBps)}); both LPs of the market together vs control ${fa(A[m]!.marketLpVsControlBps)} bps TVL.`);
    L.push('');
    L.push('**6. Does the calibration gate still separate an honest model from a degraded one?** (share of 2nd-half steps with the model node demoted; the gated pool\'s Jev scores are inverted from mid-window; only above-threshold blocks are graded)');
    L.push('');
    L.push(
      claim(
        'Degraded minus honest demotion share',
        A.model!.gateSeparationPp,
        `Degraded demoted ${fa(A.model!.degradedDemoted2ndPct, 1)}% vs honest ${fa(A.model!.honestDemoted2ndPct, 1)}% (volatile windows: degraded ${fa(V.model!.degradedDemoted2ndPct, 1)}% vs honest ${fa(V.model!.honestDemoted2ndPct, 1)}%; the honest all-window share is inflated by calm windows in which no block is ever graded, so both nodes stay on probation — unseasoned, k = kDefault — which the metric counts as demoted). Volatile ${fa(V.model!.gateSeparationPp, 1)} pp, calm ${fa(C.model!.gateSeparationPp, 1)} pp. Graded blocks per window: honest ${fmt(A.model!.labelledJev.mean, 0)} (volatile ${fmt(V.model!.labelledJev.mean, 0)}, calm ${fmt(C.model!.labelledJev.mean, 0)}), degraded ${fmt(A.model!.labelledGated.mean, 0)} (the gated keeper only produces gradeable blocks when the gap is above the threshold, so calm hours give the gate little or no evidence and the node stays unseasoned — i.e. at kDefault, which is harmless below the threshold). LP value of the gate: ${fa(A.model!.gatedMinusJev2ndHalfBps)} bps (gated minus honest pool, 2nd half).`,
        'pp',
      ),
    );
    L.push('');
    if (F) {
      const FA = F.all!;
      const FV = F.volatile!;
      const FC = F.calm!;
      L.push('**7. Realistic ETH/USDC tier: base fee 0.05% on both pools, threshold 0.08% (b500 variant, all 12 windows)**');
      L.push('');
      for (const m of ['old', ...THR_MARKETS] as const)
        L.push(`- ${m}: all **${verdict(FA[m]!.withinBps)}** ${fa(FA[m]!.withinBps)} bps/h (${signs(FA[m]!.withinBps)}); volatile ${fa(FV[m]!.withinBps)}, calm ${fa(FC[m]!.withinBps)}; share ${fmt(FA[m]!.sharePct.mean, 1)}% (calm ${fmt(FC[m]!.sharePct.mean, 1)}%); arbs paying exactly base ${fmt(FA[m]!.arbAtBasePct.mean, 0)}%.`);
      L.push(`- Threshold minus v2 law (paired): ${fa(FA.model!.tconstMinusOldBps)} (volatile ${fa(FV.model!.tconstMinusOldBps)}, calm ${fa(FC.model!.tconstMinusOldBps)}). Jev k - const k ${fa(FA.model!.jevMinusConstBps)}; heuristic k - const k ${fa(FA.model!.heurMinusConstBps)}; Jev consulted on ${fmt(FA.model!.jevStepSharePct.mean, 1)}% of steps; gate separation ${fa(FA.model!.gateSeparationPp, 1)} pp.`);
      L.push('');
    }
  }
  L.push(
    '**Sanity.** ' +
      `Control market (vanilla vs vanilla): share of pool b ${fmt(mean(ctlShares) * 100, 2)}% (range ${fmt(Math.min(...ctlShares) * 100, 2)}-${fmt(Math.max(...ctlShares) * 100, 2)}%), LP difference ${fmt(Math.max(...ctlWithin.map(Math.abs)), 4)} bps at most, over all ${results.length} runs. Split swaps (split5 variant, every arb split into 5 sub-swaps): the old / threshold constant-k pools' LP difference changes by at most ${fmt(splitMax, 3)} bps. Reverts: ${allReverts.length ? JSON.stringify(revertKinds) : 'none'} in ${results.length} runs.`,
  );
  L.push('');
  L.push('**Assumptions that remain** (as in v2, plus the v3 keeper):');
  L.push('');
  L.push(`- Keeper posts the mid of the previous 1s step (lag ${cfg.keeperLag}), misses ${cfg.missProb * 100}% of steps; arbitrageurs see the true 1s kline close (${cfg.arbLateProb * 100}% "late" draw); kline closes stand in for the CEX mid; CEX taker ${cfg.arbs.map((a) => a.cexBps + ' bps').join(' / ')}, gas $${cfg.arbs.map((a) => a.gasUsd).join(' / $')}.`);
  L.push(`- Retail demand fixed (Poisson ${cfg.lambda}/s per market, lognormal median $${cfg.retailMedianUsd}, sigma ${cfg.retailSigma}); elasticity only via routing between the two pools of a market (${cfg.routing}, ${cfg.minSplitFrac * 100}% minimum leg), no retail gas / aggregator fees; ${cfg.informedFrac * 100}% informed orders.`);
  L.push('- Full-range liquidity, one LP per pool, no JIT, no LP re-allocation; two pools per market.');
  L.push(`- v3 keeper gate: below threshold minus ${cfg.hystPips} pips (vs the mid it attests) the keeper posts rule-v1 (p = 0.10, c = 1.0); rule-v1 is allowlisted but never graded, so it is unseasoned and pins k to kDefault. Model pools therefore use maxKStepBps = ${cfg.modelKStep} so one above-threshold attestation can reach the model's k (with v2's 1000 the rule posts would keep k near kDefault). Settler labels: CEX mid at the swap's block time (--label-mid ${cfg.labelMid}); calibration every ${cfg.settleEvery} steps over the last ${cfg.calibWindow} graded blocks, minSamples ${cfg.minSamples}.`);
  L.push('- 12 one-hour windows (most volatile / typical-quiet hours of the last 60 days, data/windows_v2.json): small sample; volatile rows are stress tests.');

  // ---------------- tables
  const T: string[] = [];
  T.push('# Oniblock benchmark v3 - threshold fee law under routing competition');
  T.push('');
  T.push(`Generated ${new Date().toISOString()} - total runtime ${meta.totalSec}s (${results.length} runs: ${variantsPresent.map((v) => `${byVar(v).length} ${v}`).join(', ')}). Reproduce: \`pnpm -C benchmark bench:v3\` (quick: \`bench:v3:quick\`; re-render: \`bench:v3 --report-only\`). v1 (\`results/\`) and v2 (\`results_v2/\`) results are untouched.${meta.quick ? ' **QUICK MODE: not evidence.**' : ''}`);
  T.push('');
  T.push(...L);
  T.push('');
  T.push('## Setup');
  T.push('');
  T.push(
    `Fresh anvil per run (\`--prune-history\`), \`contracts/script/bench/DeployBenchV3.s.sol\`: one OniblockHook, six markets = 12 v4 pools with identical full-range liquidity (~$${fmt(tvl, 0)} per pool) and the same initial price. Markets: ${MARKETS.map((m) => `**${m.name}** (${m.label})`).join('; ')}. Hooked pools: baseFee = the vanilla fee tier, feeMax 1%, conservativeFee = base + 0.20%, stale after ${cfg.staleSteps} steps; threshold arms arbThresholdPips = base + 300 pips (old = 0); model pools kMin 0.2 / kMax 0.8 / kDefault 0.5, maxKStep ${cfg.modelKStep / 1e4}, Brier gate 0.25, minSamples ${cfg.minSamples}. Fee law (arb direction, live price on the arb side of the mid): fee = min(base + k * max(0, gapHW - arbThresholdPips), feeMax).`,
  );
  T.push('');
  T.push(
    `Each 1s step = 3 blocks: (A) keeper attests mid[t-${cfg.keeperLag}] (missed with p=${cfg.missProb}; model pools: rule-v1 below threshold, else Jev / heuristic), settler posts calibration every ${cfg.settleEvery} steps; (B) two competing arbitrageurs trade each pool to their no-trade band vs the TRUE mid[t] at the hook-quoted fee; (C) retail orders (identical across markets) routed per market by best execution. LP-HODL marked at the true mid. Within-window CIs: circular block bootstrap over 1-minute buckets; across-window CIs: bootstrap over windows.`,
  );
  for (const v of ['base', 'b500']) {
    const runs = byVar(v);
    if (!runs.length) continue;
    T.push('');
    T.push(`## Per-window results (${v === 'base' ? `base fee ${pctFee(cfg.baseFee)}, threshold ${pctFee(cfg.thrPips)}` : 'b500: base fee 0.05%, threshold 0.08%'})`);
    T.push('');
    T.push('| window | vol 1m bps | market | LP diff bps | LP diff USD [CI] | share | retail cost vs ctl | comp arbs / vanilla arbs | arbs at base fee | mean comp arb fee | mean comp k |');
    T.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of runs) {
      const m = mm.get(r.label)!;
      for (const mk of MARKETS) {
        const x = m[mk.name];
        T.push(
          `| ${r.windowId} | ${fmt(r.vol1mBps)} | ${mk.name} | ${fmt(x.withinBps)} | ${fmt(x.withinCI.est, 0)} [${fmt(x.withinCI.lo, 0)}, ${fmt(x.withinCI.hi, 0)}] | ${fmt(x.share * 100, 1)}% | ${fmt(x.retailCostVsControlBps)} | ${x.compNArb} / ${x.vanNArb} | ${mk.name === 'control' ? '-' : fmt(x.arbAtBaseShare * 100, 0) + '%'} | ${fmt(x.compArbFee, 0)} | ${fmt(x.compMeanK, 0)} |`,
        );
      }
    }
  }
  T.push('');
  T.push('## Across-window aggregates');
  T.push('');
  T.push('| tier | group | market | LP diff vs vanilla (bps) | signs | comp vs control pool | market LP vs control | share % | retail cost vs ctl (bps vol) | arbs at base % |');
  T.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const v of Object.keys(agg))
    for (const g of ['all', 'volatile', 'calm'])
      for (const m of MARKETS) {
        const x = agg[v]![g]![m.name]!;
        T.push(`| ${v} | ${g} | ${m.name} | ${fa(x.withinBps)} | ${signs(x.withinBps)} | ${fa(x.vsControlBps)} | ${fa(x.marketLpVsControlBps)} | ${fa(x.sharePct, 1)} | ${fa(x.retailCostVsControlBps)} | ${fmt(x.arbAtBasePct!.mean, 0)} |`);
      }
  T.push('');
  T.push('## Model, keeper gate and calibration gate per run');
  T.push('');
  T.push('| run | thr - old (bps) | Jev k - const k (bps) | heur k - const k | Jev - heur | Jev consulted (steps) / rule-v1 | live Jev calls | honest demoted 1st/2nd | degraded demoted 1st/2nd | graded blocks honest / degraded | gated - honest LP 2nd half |');
  T.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const x = md.get(r.label)!;
    T.push(
      `| ${r.label} | ${fmt(x.tconstMinusOldBps)} | ${fmt(x.jevMinusConstBps)} | ${fmt(x.heurMinusConstBps)} | ${fmt(x.jevMinusHeurBps)} | ${r.gate.tjev.model} / ${r.gate.tjev.rule} | ${r.jev.calls} | ${fmt(r.demoted.tjev.firstHalf * 100, 0)}% / ${fmt(r.demoted.tjev.secondHalf * 100, 0)}% | ${fmt(r.demoted.tgated.firstHalf * 100, 0)}% / ${fmt(r.demoted.tgated.secondHalf * 100, 0)}% | ${r.labelDiag.tjev.n} / ${r.labelDiag.tgated.n} | ${fmt(x.gatedMinusJev2ndHalfBps)} |`,
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
  T.push('Charts: `chart-lp.svg` / `chart-lp-b500.svg` (LP difference vs vanilla per window and market), `chart-share.svg` (competitor retail share, base tier).');
  writeFileSync(resolve(outDir, 'results.md'), T.join('\n') + '\n');

  const comp: MarketName[] = COMP_MARKETS.map((m) => m.name);
  for (const v of ['base', 'b500']) {
    const runs = byVar(v);
    if (!runs.length || !agg[v]) continue;
    const A = agg[v]!.all!;
    writeFileSync(
      resolve(outDir, v === 'base' ? 'chart-lp.svg' : 'chart-lp-b500.svg'),
      barPanels(`LP-HODL of the competitor minus the vanilla pool in the same market (bps of pool TVL, 1 h; ${v === 'base' ? 'base fee 0.30%' : 'base fee 0.05%'})`, 'bps TVL', runs, comp, (r, m) => mm.get(r.label)![m].withinBps, (m) => A[m]!.withinBps),
    );
    if (v === 'base')
      writeFileSync(
        resolve(outDir, 'chart-share.svg'),
        barPanels('Competitor share of market retail volume (%; 50% = parity; base fee 0.30%)', '% share', runs, comp, (r, m) => mm.get(r.label)![m].share * 100, (m) => A[m]!.sharePct, 50),
      );
  }
  void MODEL_POOLS;

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
      initialTvlUsd: r.initialTvlUsd,
      markets: mm.get(r.label),
      model: md.get(r.label),
      totals: r.totals,
      gate: r.gate,
      arbAtBase: r.arbAtBase,
      demoted: r.demoted,
      calibrations: r.calibrations,
      labelDiag: r.labelDiag,
      jev: r.jev,
      reverts: r.reverts,
      txCount: r.txCount,
      runtimeSec: r.runtimeSec,
    })),
    sanity: { controlShares: ctlShares, controlWithinBps: ctlWithin, reverts: revertKinds, split5MaxDeltaBps: splitMax },
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
  runs: RunResultV3[],
  markets: MarketName[],
  val: (r: RunResultV3, m: MarketName) => number,
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

