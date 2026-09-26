/**
 * v4 metrics, statistics (within-window block bootstrap + across-window bootstrap over windows), results.md, SVG charts.
 * Key comparison: (c) AI decides (Jev every block, threshold 0, kMin 0) vs (b) the hard-coded threshold and vs vanilla.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { blockBootstrapSum } from '../util.js';
import { aggWindows, type Agg } from '../v2/report2.js';
import { MARKETS, type Pool } from './chain4.js';
import type { RunConfigV4, RunResultV4 } from './sim4.js';

type MarketName = (typeof MARKETS)[number]['name'];
const COMP_MARKETS = MARKETS.filter((m) => m.name !== 'control');
const ARMS = ['v2k', 'thrk', 'ai', 'aiheur', 'aigated', 'aidz'] as const;
const sum = (x: number[]) => x.reduce((a, b) => a + b, 0);
const mean = (x: number[]) => (x.length ? sum(x) / x.length : NaN);
const r2 = (x: number) => Math.round(x * 100) / 100;

const withinCI = (a: number[], b: number[], seed: number) => {
  const c = blockBootstrapSum(a.map((v, i) => v - b[i]!), { seed, B: 2000, len: 8 });
  return { est: r2(c.est), lo: r2(c.lo), hi: r2(c.hi) };
};

/** Per-run, per-market metrics. USD and bps of the initial per-pool TVL. */
export function marketMetrics(r: RunResultV4) {
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

function modelMetrics(r: RunResultV4) {
  const T = r.totals;
  const bps = (usd: number) => (usd / r.initialTvlUsd) * 1e4;
  const h = r.degradeAtStep / r.config.bucketSteps;
  const second = (x: number[]) => x.slice(Math.floor(h));
  const d = (a: Pool, b: Pool) => bps(T[a].lpMinusHodl - T[b].lpMinusHodl);
  const se = r.scoreByEdge.ai;
  return {
    aiMinusThrkBps: d('ai', 'thrk'),
    aiMinusV2kBps: d('ai', 'v2k'),
    heurMinusThrkBps: d('aiheur', 'thrk'),
    aiMinusHeurBps: d('ai', 'aiheur'),
    dzMinusAiBps: d('aidz', 'ai'),
    thrkMinusV2kBps: d('thrk', 'v2k'),
    aiMinusThrkCI: withinCI(r.buckets.ai.dLp, r.buckets.thrk.dLp, 201),
    gatedMinusAi2ndHalfBps: bps(sum(second(r.buckets.aigated.dLp)) - sum(second(r.buckets.ai.dLp))),
    gateSeparationPp: (r.demoted.aigated.secondHalf - r.demoted.ai.secondHalf) * 100,
    aiKZeroShare: r.kZero.ai.steps ? r.kZero.ai.zero / r.kZero.ai.steps : NaN,
    aiKLowShare: r.kZero.ai.steps ? r.kZero.ai.low / r.kZero.ai.steps : NaN,
    aiPcNoEdge: se.negN ? se.negPc / se.negN : NaN,
    aiPcEdge: se.posN ? se.posPc / se.posN : NaN,
  };
}

const fmt = (x: number | null | undefined, d = 2) =>
  x === null || x === undefined || !Number.isFinite(x) ? '-' : Math.abs(x) >= 1000 ? Math.round(x).toLocaleString('en-US') : x.toFixed(d);
const fa = (g: Agg, d = 2) => `${fmt(g.mean, d)} [${fmt(g.lo, d)}, ${fmt(g.hi, d)}]`;
const signs = (g: Agg) => `${g.pos}+/${g.neg}- of ${g.n}`;
export const verdict = (g: Agg) => (g.lo > 0 ? 'YES' : g.hi < 0 ? 'NO' : 'INCONCLUSIVE');
const pctFee = (pips: number) => `${(pips / 1e4).toFixed(2)}%`;
const label = (m: MarketName) => MARKETS.find((x) => x.name === m)!.label;

type Meta = { quick: boolean; totalSec: number; cfg: Omit<RunConfigV4, 'label' | 'path' | 'port'>; steps: number };

export function writeReportV4(results: RunResultV4[], outDir: string, meta: Meta) {
  const mm = new Map(results.map((r) => [r.label, marketMetrics(r)]));
  const md = new Map(results.map((r) => [r.label, modelMetrics(r)]));
  const byVar = (v: string) => results.filter((r) => r.variant === v);
  const variantsPresent = [...new Set(results.map((r) => r.variant))];
  const aggOf = (runs: RunResultV4[], f: (r: RunResultV4) => number, seed: number) => aggWindows(runs.map(f).filter(Number.isFinite), seed);

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
        const M = (r: RunResultV4) => mm.get(r.label)![m.name];
        x[m.name] = {
          withinBps: aggOf(rs, (r) => M(r).withinBps, seed++),
          vsControlBps: aggOf(rs, (r) => M(r).vsControlBps, seed++),
          marketLpVsControlBps: aggOf(rs, (r) => M(r).marketLpVsControlBps, seed++),
          sharePct: aggOf(rs, (r) => M(r).share * 100, seed++),
          retailCostVsControlBps: aggOf(rs, (r) => M(r).retailCostVsControlBps, seed++),
          arbAtBasePct: aggOf(rs, (r) => M(r).arbAtBaseShare * 100, seed++),
          meanArbFee: aggOf(rs, (r) => M(r).compArbFee ?? NaN, seed++),
          meanK: aggOf(rs, (r) => M(r).compMeanK ?? NaN, seed++),
        };
      }
      const D = (r: RunResultV4) => md.get(r.label)!;
      x.model = {
        aiMinusThrkBps: aggOf(rs, (r) => D(r).aiMinusThrkBps, seed++),
        aiMinusV2kBps: aggOf(rs, (r) => D(r).aiMinusV2kBps, seed++),
        heurMinusThrkBps: aggOf(rs, (r) => D(r).heurMinusThrkBps, seed++),
        aiMinusHeurBps: aggOf(rs, (r) => D(r).aiMinusHeurBps, seed++),
        dzMinusAiBps: aggOf(rs, (r) => D(r).dzMinusAiBps, seed++),
        thrkMinusV2kBps: aggOf(rs, (r) => D(r).thrkMinusV2kBps, seed++),
        gatedMinusAi2ndHalfBps: aggOf(rs, (r) => D(r).gatedMinusAi2ndHalfBps, seed++),
        gateSeparationPp: aggOf(rs, (r) => D(r).gateSeparationPp, seed++),
        honestDemoted2ndPct: aggOf(rs, (r) => r.demoted.ai.secondHalf * 100, seed++),
        degradedDemoted2ndPct: aggOf(rs, (r) => r.demoted.aigated.secondHalf * 100, seed++),
        aiKZeroPct: aggOf(rs, (r) => D(r).aiKZeroShare * 100, seed++),
        aiKLowPct: aggOf(rs, (r) => D(r).aiKLowShare * 100, seed++),
        aiPcNoEdge: aggOf(rs, (r) => D(r).aiPcNoEdge, seed++),
        aiPcEdge: aggOf(rs, (r) => D(r).aiPcEdge, seed++),
        labelledAi: aggOf(rs, (r) => r.labelDiag.ai.n, seed++),
        labelledGated: aggOf(rs, (r) => r.labelDiag.aigated.n, seed++),
        seasonedAt: aggOf(rs, (r) => r.demoted.ai.seasonedAtStep ?? NaN, seed++),
      };
      agg[v]![g] = x;
    }
  }

  // ---------------- sanity + Jev accounting
  const ctlShares = results.map((r) => mm.get(r.label)!.control.share);
  const ctlWithin = results.map((r) => mm.get(r.label)!.control.withinBps);
  const allReverts = results.flatMap((r) => r.reverts.map((x) => ({ run: r.label, ...x })));
  const revertKinds: Record<string, number> = {};
  for (const x of allReverts) revertKinds[`${x.label}${x.pool ? ':' + x.pool : ''}`] = (revertKinds[`${x.label}${x.pool ? ':' + x.pool : ''}`] ?? 0) + 1;
  const jevCalls = sum(results.map((r) => r.jev.calls));
  const jevFail = sum(results.map((r) => r.jev.failures));
  const cnt = (rs: RunResultV4[], k: string[]) => sum(rs.map((r) => sum(k.map((x) => (r.jev.counts as Record<string, number>)[x] ?? 0))));
  const nScores = cnt(results, ['jev', 'jev-cache', 'jev-nearest', 'heuristic', 'heuristic-paced', 'heuristic-jev-failed']);
  const jevStats = {
    liveCalls: jevCalls,
    failures: jevFail,
    scores: nScores,
    exactPct: (100 * cnt(results, ['jev', 'jev-cache'])) / Math.max(1, nScores),
    cacheHitPct: (100 * cnt(results, ['jev-cache'])) / Math.max(1, nScores),
    nearestPct: (100 * cnt(results, ['jev-nearest'])) / Math.max(1, nScores),
    fallbackPct: (100 * cnt(results, ['heuristic', 'heuristic-paced', 'heuristic-jev-failed'])) / Math.max(1, nScores),
    maxRunFallbackPct: Math.max(0, ...results.map((r) => r.jev.fallbackShare * 100)),
    retries: sum(results.map((r) => r.jev.retries ?? 0)),
    highFallbackRuns: results.filter((r) => r.jev.fallbackShare > 0.1).map((r) => `${r.label} ${fmt(r.jev.fallbackShare * 100, 0)}%`),
  };

  // ---------------- conclusion
  const cfg = meta.cfg;
  const L: string[] = [];
  const baseRuns = byVar('base');
  const tvl = baseRuns[0]?.initialTvlUsd ?? results[0]?.initialTvlUsd ?? 2e7;
  const usd = (b: number) => `$${fmt((b * tvl) / 1e4, 0)}`;
  const faU = (g: Agg) => `${fa(g)} bps (≈ ${usd(g.mean)}/h, CI ${usd(g.lo)} to ${usd(g.hi)})`;
  const claim = (title: string, g: Agg, extra: string, unit: 'bps' | 'pp' = 'bps') =>
    `- **${title}: ${verdict(g)}.** ${unit === 'bps' ? faU(g) : fa(g, 1) + ' pp'} (${signs(g)}). ${extra}`;
  L.push('## CONCLUSION');
  L.push('');
  L.push(
    `Plain-language verdicts. Numbers are across-window means over ${baseRuns.length} one-hour windows (${baseRuns.filter((r) => r.regime === 'volatile').length} volatile, ${baseRuns.filter((r) => r.regime === 'calm').length} calm; ETHUSDT + BTCUSDT; the same frozen windows as v2/v3), in **bps of one pool's starting TVL (~$${fmt(tvl, 0)}) per hour**, with a 95% bootstrap CI over windows in brackets and the sign count (windows > 0 / < 0). YES/NO = the CI excludes 0 in that direction; otherwise INCONCLUSIVE. Main tier: every pool (hooked and vanilla) at base fee ${pctFee(cfg.baseFee)}; the "b500" tier repeats all 12 windows at base fee 0.05% on every pool. Arm (b)'s hard-coded threshold is base + 0.03% (${pctFee(cfg.thrPips)} / 0.08%); every AI arm has threshold 0, kMin 0, kDefault ${cfg.aiKDefault / 1e4}, kMax ${cfg.aiKMax / 1e4}, maxKStep ${cfg.aiKStep / 1e4}, and its model is asked on every step.`,
  );
  L.push('');
  const B = agg.base;
  const F = agg.b500;
  if (meta.quick || !B) {
    L.push('**Bottom line.** QUICK MODE: a smoke test of the pipeline, not evidence.');
  } else {
    const tiers: [string, Record<string, G>][] = [['0.30%', B]];
    if (F) tiers.push(['0.05% (b500)', F]);
    const line = (name: string, T: Record<string, G>) => {
      const A = T.all!;
      const V = T.volatile!;
      const C = T.calm!;
      return `At the ${name} tier the AI-decided pool (c) vs the vanilla pool next to it is **${verdict(A.ai!.withinBps)}** ${faU(A.ai!.withinBps)} (${signs(A.ai!.withinBps)}; volatile ${fa(V.ai!.withinBps)}, calm ${fa(C.ai!.withinBps)}), and vs the hard-coded threshold (c − b, paired) **${verdict(A.model!.aiMinusThrkBps)}** ${fa(A.model!.aiMinusThrkBps)} bps (${signs(A.model!.aiMinusThrkBps)}; volatile ${fa(V.model!.aiMinusThrkBps)}, calm ${fa(C.model!.aiMinusThrkBps)}). Retail share (c) ${fmt(A.ai!.sharePct.mean, 1)}% (calm ${fmt(C.ai!.sharePct.mean, 1)}%, volatile ${fmt(V.ai!.sharePct.mean, 1)}%) vs (b) ${fmt(A.thrk!.sharePct.mean, 1)}% and the v2 law ${fmt(A.v2k!.sharePct.mean, 1)}%.`;
    };
    L.push(`**Bottom line.** ${tiers.map(([n, T]) => line(n, T)).join(' ')}`);
    L.push('');
    for (const [name, T] of tiers) {
      const A = T.all!;
      const V = T.volatile!;
      const C = T.calm!;
      L.push(`### Base fee ${name}`);
      L.push('');
      L.push('**1. Does each arm beat the vanilla pool next to it?** (competitor LP-HODL minus vanilla LP-HODL in the same market)');
      L.push('');
      for (const m of ARMS)
        L.push(claim(label(m), A[m]!.withinBps, `Volatile ${fa(V[m]!.withinBps)} (${signs(V[m]!.withinBps)}), calm ${fa(C[m]!.withinBps)} (${signs(C[m]!.withinBps)}); retail share ${fmt(A[m]!.sharePct.mean, 1)}% (calm ${fmt(C[m]!.sharePct.mean, 1)}%); mean arb fee ${fmt(A[m]!.meanArbFee.mean, 0)} pips; mean k ${fmt(A[m]!.meanK.mean, 0)} bps; arbs at exactly base ${fmt(A[m]!.arbAtBasePct.mean, 0)}%.`));
      L.push('');
      L.push('**2. Key comparison: AI decides (c) vs the hard-coded threshold (b) and the v2 law (a)** (paired per window, same prices / flow / liquidity)');
      L.push('');
      L.push(claim('(c) AI decides minus (b) hard-coded threshold', A.model!.aiMinusThrkBps, `Volatile ${fa(V.model!.aiMinusThrkBps)} (${signs(V.model!.aiMinusThrkBps)}), calm ${fa(C.model!.aiMinusThrkBps)} (${signs(C.model!.aiMinusThrkBps)}).`));
      L.push(claim('(c) AI decides minus (a) v2 law constant k', A.model!.aiMinusV2kBps, `Volatile ${fa(V.model!.aiMinusV2kBps)}, calm ${fa(C.model!.aiMinusV2kBps)}.`));
      L.push(claim('(b) threshold minus (a) v2 law (v3 reproduction)', A.model!.thrkMinusV2kBps, `Volatile ${fa(V.model!.thrkMinusV2kBps)}, calm ${fa(C.model!.thrkMinusV2kBps)}.`));
      L.push('');
      L.push('**3. Jev vs heuristic** (both asked every block, same config)');
      L.push('');
      L.push(claim('(c) Jev minus (d) heuristic', A.model!.aiMinusHeurBps, `Volatile ${fa(V.model!.aiMinusHeurBps)}, calm ${fa(C.model!.aiMinusHeurBps)}.`));
      L.push(claim('(d) heuristic minus (b) threshold', A.model!.heurMinusThrkBps, `Volatile ${fa(V.model!.heurMinusThrkBps)}, calm ${fa(C.model!.heurMinusThrkBps)}.`));
      L.push(`- What Jev decided (pool c): stored k = 0 on ${fmt(A.model!.aiKZeroPct.mean, 1)}% of steps and k < 0.05 on ${fmt(A.model!.aiKLowPct.mean, 1)}% (calm ${fmt(C.model!.aiKLowPct.mean, 1)}%, volatile ${fmt(V.model!.aiKLowPct.mean, 1)}%). Mean posted p·c when the gap was ≤ the base fee (no profitable arbitrage): ${fmt(A.model!.aiPcNoEdge.mean / 100, 2)}% (→ k ≈ ${fmt((A.model!.aiPcNoEdge.mean * cfg.aiKMax) / 1e4, 0)} bps); when the gap exceeded the base fee: ${fmt(A.model!.aiPcEdge.mean / 100, 1)}% (→ k ≈ ${fmt((A.model!.aiPcEdge.mean * cfg.aiKMax) / 1e4, 0)} bps). The model has no power until seasoned: first seasoned step ${fmt(A.model!.seasonedAt.mean, 0)} on average (calm ${fmt(C.model!.seasonedAt.mean, 0)}, volatile ${fmt(V.model!.seasonedAt.mean, 0)}); until then k = kDefault = ${cfg.aiKDefault}.`);
      L.push('');
      L.push('**4. Calibration gate** (arm e: Jev inverted from mid-window; share of 2nd-half steps with the node demoted or unseasoned, i.e. k = kDefault = 0 = a vanilla pool)');
      L.push('');
      L.push(claim('Degraded minus honest demotion share', A.model!.gateSeparationPp, `Degraded ${fa(A.model!.degradedDemoted2ndPct, 1)}% vs honest ${fa(A.model!.honestDemoted2ndPct, 1)}% (volatile ${fa(V.model!.degradedDemoted2ndPct, 1)}% vs ${fa(V.model!.honestDemoted2ndPct, 1)}%; calm ${fa(C.model!.degradedDemoted2ndPct, 1)}% vs ${fa(C.model!.honestDemoted2ndPct, 1)}%). Graded blocks per window: honest ${fmt(A.model!.labelledAi.mean, 0)} (calm ${fmt(C.model!.labelledAi.mean, 0)}, volatile ${fmt(V.model!.labelledAi.mean, 0)}). LP of the gated pool minus the honest pool, 2nd half: ${fa(A.model!.gatedMinusAi2ndHalfBps)} bps; gated pool vs its vanilla neighbour: ${fa(A.aigated!.withinBps)} bps.`, 'pp'));
      L.push('');
      L.push(`**5. Exploratory (f): a contract dead-zone on p·c (z = ${fmt(cfg.dzBps / 100, 1)}%)** — k = kMax·max(0, p·c − z)/(1 − z), emulated by the keeper; a proposal, not in the contract.`);
      L.push('');
      L.push(claim('(f) dead-zone minus (c)', A.model!.dzMinusAiBps, `Volatile ${fa(V.model!.dzMinusAiBps)}, calm ${fa(C.model!.dzMinusAiBps)}; (f) vs vanilla ${fa(A.aidz!.withinBps)} (${signs(A.aidz!.withinBps)}); retail share ${fmt(A.aidz!.sharePct.mean, 1)}% (calm ${fmt(C.aidz!.sharePct.mean, 1)}%).`));
      L.push('');
      L.push('**6. Retail** (competitor share of market retail volume, 50% = parity; market retail cost vs the control market, bps of retail volume)');
      L.push('');
      for (const m of ARMS)
        L.push(`- ${m}: share ${fa(A[m]!.sharePct, 1)}% (volatile ${fmt(V[m]!.sharePct.mean, 1)}%, calm ${fmt(C[m]!.sharePct.mean, 1)}%); retail cost vs control ${fa(A[m]!.retailCostVsControlBps)} bps; both LPs of the market vs control ${fa(A[m]!.marketLpVsControlBps)} bps TVL.`);
      L.push('');
    }
  }
  if (jevStats.highFallbackRuns.length)
    L.push(`**Fallback flag.** Heuristic fallback exceeded 10% of the Jev pools' scores in ${jevStats.highFallbackRuns.length} run(s): ${jevStats.highFallbackRuns.join(', ')} — in those runs arm (c) is partly heuristic-scored; read c − d with that in mind.`);
  L.push(
    `**Jev accounting.** Scorer mode: ${cfg.jevMode}${cfg.jevMode === 'heuristic' ? ' (NO live Jev: every AI arm is heuristic-scored; c ≡ d)' : ''}. ${jevStats.liveCalls} live Jev calls in ${results.length} runs (hard cap ${cfg.jevBudget}/run; ${jevStats.failures} failed after ${jevStats.retries} retries), ${jevStats.scores} Jev-pool scores (pools c, e, f; asked every step): ${fmt(jevStats.exactPct, 1)}% exact Jev answers (${fmt(jevStats.cacheHitPct, 1)}% from the cache), ${fmt(jevStats.nearestPct, 1)}% nearest cached Jev answer (same side, never across the base-fee boundary), ${fmt(jevStats.fallbackPct, 1)}% heuristic fallback (worst run ${fmt(jevStats.maxRunFallbackPct, 1)}%).`,
  );
  L.push('');
  L.push(
    '**Sanity.** ' +
      `Control market (vanilla vs vanilla): share of pool b ${fmt(mean(ctlShares) * 100, 2)}% (range ${fmt(Math.min(...ctlShares) * 100, 2)}-${fmt(Math.max(...ctlShares) * 100, 2)}%), LP difference ${fmt(Math.max(...ctlWithin.map(Math.abs)), 4)} bps at most, over all ${results.length} runs. Reverts: ${allReverts.length ? JSON.stringify(revertKinds) : 'none'} in ${results.length} runs.`,
  );
  L.push('');
  L.push('**Assumptions that remain** (as in v2/v3):');
  L.push('');
  L.push(`- Keeper posts the mid of the previous 1s step (lag ${cfg.keeperLag}), misses ${cfg.missProb * 100}% of steps; arbitrageurs see the true 1s kline close (${cfg.arbLateProb * 100}% "late" draw); kline closes stand in for the CEX mid; CEX taker ${cfg.arbs.map((a) => a.cexBps + ' bps').join(' / ')}, gas $${cfg.arbs.map((a) => a.gasUsd).join(' / $')}.`);
  L.push(`- Retail demand fixed (Poisson ${cfg.lambda}/s per market, lognormal median $${cfg.retailMedianUsd}, sigma ${cfg.retailSigma}); elasticity only via routing between the two pools of a market (${cfg.routing}, ${cfg.minSplitFrac * 100}% minimum leg), no retail gas / aggregator fees; ${cfg.informedFrac * 100}% informed orders.`);
  L.push('- Full-range liquidity, one LP per pool, no JIT, no LP re-allocation; two pools per market.');
  L.push(`- v4 keeper: no gate, the model is asked on every attested step; Jev sees the k-free v4 state (gap, base fee, edge at the base fee, flow, volatility) with the v4 question; states are quantized (0.01% gap buckets within ±0.10% of the base fee) for the cache. Settler labels: CEX mid at the swap's block time (--label-mid ${cfg.labelMid}); calibration every ${cfg.settleEvery} steps over the last ${cfg.calibWindow} graded blocks, minSamples ${cfg.minSamples}, Brier gate 0.25.`);
  L.push('- 12 one-hour windows (most volatile / typical-quiet hours of the last 60 days, data/windows_v2.json): small sample; volatile rows are stress tests.');

  // ---------------- tables
  const T: string[] = [];
  T.push('# Oniblock benchmark v4 - the AI decides the fee (no hard-coded threshold)');
  T.push('');
  T.push(`Generated ${new Date().toISOString()} - total runtime ${meta.totalSec}s (${results.length} runs: ${variantsPresent.map((v) => `${byVar(v).length} ${v}`).join(', ')}). Reproduce: \`pnpm -C benchmark bench:v4\` (quick: \`bench:v4:quick\`; re-render: \`bench:v4 --report-only\`). v1-v3 results are untouched.${meta.quick ? ' **QUICK MODE: not evidence.**' : ''}`);
  T.push('');
  T.push(...L);
  T.push('');
  T.push('## Setup');
  T.push('');
  T.push(
    `Fresh anvil per run (\`--prune-history\`), \`contracts/script/bench/DeployBenchV4.s.sol\`: one OniblockHook, seven markets = 14 v4 pools with identical full-range liquidity (~$${fmt(tvl, 0)} per pool) and the same initial price. Markets: ${MARKETS.map((m) => `**${m.name}** ${m.label}`).join('; ')}. Hooked pools: baseFee = the vanilla fee tier, feeMax 1%, conservativeFee = base + 0.20%, stale after ${cfg.staleSteps} steps. Fee law (arb direction): fee = min(base + k * max(0, gapHW - arbThresholdPips), feeMax); k = kMin + (kMax - kMin) * p * c for a seasoned model, kDefault otherwise.`,
  );
  T.push('');
  T.push(
    `Each 1s step = 3 blocks: (A) keeper attests mid[t-${cfg.keeperLag}] (missed with p=${cfg.missProb}) with the model's score for every model pool, settler posts calibration every ${cfg.settleEvery} steps; (B) two competing arbitrageurs trade each pool to their no-trade band vs the TRUE mid[t] at the hook-quoted fee; (C) retail orders (identical across markets) routed per market by best execution. LP-HODL marked at the true mid. Within-window CIs: circular block bootstrap over 1-minute buckets; across-window CIs: bootstrap over windows.`,
  );
  for (const v of ['base', 'b500']) {
    const runs = byVar(v);
    if (!runs.length) continue;
    T.push('');
    T.push(`## Per-window results (${v === 'base' ? `base fee ${pctFee(cfg.baseFee)}` : 'b500: base fee 0.05%'})`);
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
  T.push('## Model decisions and calibration gate per run');
  T.push('');
  T.push('| run | c - b (bps) | c - a | c - d (Jev - heur) | f - c | AI k=0 / k<0.05 steps | p·c no edge / edge (AI) | live Jev calls | honest demoted 1st/2nd | degraded demoted 1st/2nd | graded blocks honest / degraded | seasoned at step | gated - honest LP 2nd half |');
  T.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const x = md.get(r.label)!;
    T.push(
      `| ${r.label} | ${fmt(x.aiMinusThrkBps)} | ${fmt(x.aiMinusV2kBps)} | ${fmt(x.aiMinusHeurBps)} | ${fmt(x.dzMinusAiBps)} | ${fmt(x.aiKZeroShare * 100, 0)}% / ${fmt(x.aiKLowShare * 100, 0)}% | ${fmt(x.aiPcNoEdge, 0)} / ${fmt(x.aiPcEdge, 0)} | ${r.jev.calls} | ${fmt(r.demoted.ai.firstHalf * 100, 0)}% / ${fmt(r.demoted.ai.secondHalf * 100, 0)}% | ${fmt(r.demoted.aigated.firstHalf * 100, 0)}% / ${fmt(r.demoted.aigated.secondHalf * 100, 0)}% | ${r.labelDiag.ai.n} / ${r.labelDiag.aigated.n} | ${r.demoted.ai.seasonedAtStep ?? '-'} | ${fmt(x.gatedMinusAi2ndHalfBps)} |`,
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

  return {
    generatedAt: new Date().toISOString(),
    totalSec: meta.totalSec,
    quick: meta.quick,
    config: meta.cfg,
    steps: meta.steps,
    aggregates: agg,
    jev: jevStats,
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
      kZero: r.kZero,
      scoreByEdge: r.scoreByEdge,
      arbAtBase: r.arbAtBase,
      demoted: r.demoted,
      calibrations: r.calibrations,
      labelDiag: r.labelDiag,
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
  runs: RunResultV4[],
  markets: MarketName[],
  val: (r: RunResultV4, m: MarketName) => number,
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

