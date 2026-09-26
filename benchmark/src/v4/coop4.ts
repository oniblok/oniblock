/**
 * Mainnet block timing with and without a cooperating block builder, with our LightGBM models in the keeper
 * (sim4.ts mainnet block mode). Every Oniblock pool competes with its own vanilla neighbour (same fee tier, same
 * liquidity) for the same routed retail and the same two arbitrageurs; the vanilla neighbour is the "without this
 * hook" baseline.
 *
 * Runs (one per keeper placement; ETH windows; post policy `change`):
 *   realistic : keeper post lands at the END of the previous block (no builder deal), Binance mid read 13 s before the
 *               block it prices; model tabular-v2 (trained on ~11 s-old mids)
 *   coop      : a cooperating builder puts the keeper post FIRST in the block, mid read 2 s before it; model
 *               oniblock1 (trained on ~2 s-old mids)
 * Arms (pools inside those runs; same order flow):
 *   R  = realistic, pool ai      : tabular-v2 + charge gate at its chargeThreshold
 *   R0 = realistic, pool aigated : tabular-v2, gate off (k = 0.8 p)
 *   C  = coop, pool ai           : oniblock1 + charge gate
 *   C0 = coop, pool aigated      : oniblock1, gate off (k = 0.8 p)
 *   Rh / Ch = pool aiheur        : the heuristic at the same timing (reference)
 *
 *   tsx src/v4/coop4.ts --run realistic|coop [--tier 3000|500] [--windows ...] [--steps 3600] [--port 8950]
 *   tsx src/v4/coop4.ts --report-only
 * Each run writes raw-<run>-<tier>.json into the out dir (default results_v4/coop-builder).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BENCH_DIR, ROOT, log } from '../util.js';
import { loadPathV2, selectWindowsV2 } from '../v2/windows.js';
import { aggWindows, type Agg } from '../v2/report2.js';
import { runOneV4, type RunConfigV4, type RunResultV4 } from './sim4.js';
import { keeperCost, marketMetrics, verdict } from './report4.js';
import { BASE } from './base4.js';
import type { Hooked, Pool } from './chain4.js';

const argv = process.argv.slice(2);
const a: Record<string, string | boolean> = {};
for (let i = 0; i < argv.length; i++) {
  const k = argv[i]!;
  if (!k.startsWith('--')) continue;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) a[k.slice(2)] = true;
  else (a[k.slice(2)] = v), i++;
}
const outDir = resolve(String(a.out ?? resolve(BENCH_DIR, 'results_v4/coop-builder')));
const steps = Number(a.steps ?? 3600);
const WARMUP_SEC = 1800; // keeper MidHistory before the window: ret900 needs 15 min, realizedVol 120 reads = 24 min
const MODELS = { v2: resolve(ROOT, 'ml/models/tabular-v2.json'), oniblock1: resolve(ROOT, 'ml/models/oniblock1.json') };

/** Block-mode config: BASE (results_v4/heuristic-full) with mainnet timing, post-on-change, the live settler's dead band. */
const BLOCK: Partial<RunConfigV4> = {
  postMode: 'change',
  staleSteps: 5, // mainnet blocks (DeployBase STALE_BLOCKS 5) = 10 anvil blocks
  heartbeatBlocks: 8, // 4 mainnet blocks
  settleEvery: 2, // blocks (24 s; the 1 s benchmark settled every 20 s)
  deadbandUsd: 1, // services default: y = markout > max($1, 1 bp of arb volume), the label tabular-v2 is trained on
  deadbandBps: 1,
};
const RUNS: Record<string, { label: string; over: Partial<RunConfigV4>; model: keyof typeof MODELS }> = {
  realistic: { label: 'keeper post lands last in the previous block (no builder deal), mid 13 s old', over: { blockMode: { placement: 'realistic' } }, model: 'v2' },
  coop: { label: 'keeper post first in the block (cooperating builder), mid 2 s old', over: { blockMode: { placement: 'coop' } }, model: 'oniblock1' },
};
const ARMS = [
  { arm: 'R', run: 'realistic', pool: 'ai', label: 'R: post lands last in the previous block (no builder deal), mid 13 s old; tabular-v2 + charge gate' },
  { arm: 'R0', run: 'realistic', pool: 'aigated', label: 'R0: as R, gate off (k = 0.8 p)' },
  { arm: 'C', run: 'coop', pool: 'ai', label: 'C: keeper posts first in the block (cooperating builder), mid 2 s old; oniblock1 + charge gate' },
  { arm: 'C0', run: 'coop', pool: 'aigated', label: 'C0: as C, gate off (k = 0.8 p)' },
  { arm: 'Rh', run: 'realistic', pool: 'aiheur', label: 'Rh: realistic timing, heuristic scorer (reference)' },
  { arm: 'Ch', run: 'coop', pool: 'aiheur', label: 'Ch: coop timing, heuristic scorer (reference)' },
] as const;
const MARKET_OF: Record<string, { mk: 'ai' | 'aigated' | 'aiheur'; van: Pool }> = {
  ai: { mk: 'ai', van: 'v_ai' },
  aigated: { mk: 'aigated', van: 'v_aigated' },
  aiheur: { mk: 'aiheur', van: 'v_aiheur' },
};

mkdirSync(outDir, { recursive: true });
if (!a['report-only']) {
  const runName = String(a.run ?? 'realistic');
  const spec = RUNS[runName];
  if (!spec) throw new Error(`--run must be one of ${Object.keys(RUNS).join(', ')}`);
  const tier = Number(a.tier ?? 3000);
  const modelPath = String(a.model ?? MODELS[spec.model]);
  if (!existsSync(modelPath)) throw new Error(`model not found: ${modelPath}`);
  const all = await selectWindowsV2();
  const wanted = String(a.windows ?? 'ETH-vol1,ETH-vol2,ETH-vol3,ETH-calm1,ETH-calm2,ETH-calm3').split(',');
  const windows = all.filter((w) => wanted.includes(w.id));
  let port = Number(a.port ?? 8950);
  const results: RunResultV4[] = [];
  const file = resolve(outDir, `raw-${runName}-${tier}.json`);
  for (const w of windows) {
    const full = await loadPathV2(w, 1);
    const warm = await loadPathV2({ ...w, startMs: w.startMs - WARMUP_SEC * 1000, endMs: w.startMs }, 1);
    const path = { ...full, mids: full.mids.slice(0, steps), times: full.times.slice(0, steps) };
    const cfg: RunConfigV4 = {
      ...BASE,
      ...BLOCK,
      ...spec.over,
      baseFee: tier,
      thrPips: tier + 300,
      warmupMids: warm.mids,
      tabularPools: { ai: { path: modelPath, gate: true }, aigated: { path: modelPath, gate: false } },
      label: `${w.id}:${tier === 3000 ? 'base' : `b${tier}`}`,
      path,
      port: port++,
    };
    const r = await runOneV4(cfg);
    const kc = keeperCost(r, 'ai', 'v_ai')!;
    log('coop_run_done', { run: runName, tier, label: r.label, sec: r.runtimeSec, reverts: r.reverts.length, posts: kc.posts, kMiss: kc.kPredictMiss, grossAi: kc.grossBpsPerHour, charged: r.tabular?.ai?.charged, graded: r.tabular?.ai?.pairs.length });
    results.push(r);
    writeFileSync(file, JSON.stringify({ run: runName, tier, spec: { ...spec, modelPath }, steps, results }));
  }
  process.exit(0);
}

// ------------------------------------------------------------------------------------------------ report
type Raw = { run: string; tier: number; spec: { label: string; modelPath: string }; steps: number; results: RunResultV4[] };
const raws = readdirSync(outDir)
  .filter((f) => /^raw-[a-z]+-\d+\.json$/.test(f))
  .map((f) => JSON.parse(readFileSync(resolve(outDir, f), 'utf8')) as Raw);
if (!raws.length) process.exit(0);
const fmt = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '-' : x.toFixed(d));
const fa = (g: Agg, d = 2) => `${fmt(g.mean, d)} [${fmt(g.lo, d)}, ${fmt(g.hi, d)}]`;
const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '-');
const MAINNET_GAS = 110_000;
const BLOCKS_PER_HOUR = 300;
let seed = 21;

function selective(pairs: [number, number][], t: number) {
  const n = pairs.length;
  const tox = pairs.filter((x) => x[1] === 1).length;
  const ben = n - tox;
  const ch = pairs.filter((x) => x[0] >= t);
  const tp = ch.filter((x) => x[1] === 1).length;
  const fp = ch.length - tp;
  const brier = n ? pairs.reduce((s, [p, y]) => s + (p - y) ** 2, 0) / n : NaN;
  return { n, toxic: tox, baseRate: n ? tox / n : NaN, charged: ch.length, tp, fp, pass: ch.length ? tp / ch.length : NaN, fpr: ben ? fp / ben : NaN, coverage: n ? ch.length / n : NaN, tpr: tox ? tp / tox : NaN, brier };
}

function perRun(r: RunResultV4, pool: 'ai' | 'aigated' | 'aiheur') {
  const { mk, van } = MARKET_OF[pool]!;
  const comp = pool as Hooked;
  const kc = keeperCost(r, comp, van)!;
  const k110 = keeperCost(r, comp, van, { gasPerPost: MAINNET_GAS })!;
  const m = marketMetrics(r)[mk];
  const T = r.totals;
  const hours = r.config.steps / 3600;
  const bps = (usd: number) => (usd / r.initialTvlUsd) * 1e4;
  const c = T[comp];
  const v = T[van];
  const ctlVol = T.v_control_a.retailVol + T.v_control_b.retailVol;
  const ctlCostBps = ctlVol ? ((T.v_control_a.retailCost + T.v_control_b.retailCost) / ctlVol) * 1e4 : NaN;
  const postsPerHour = kc.mainnetPostsPerHour;
  return {
    windowId: r.windowId,
    regime: r.regime,
    grossBps: kc.grossBpsPerHour,
    grossUsd: kc.grossUsdPerHour,
    withinLoUsd: (m.withinCI.lo * 3600) / r.config.steps,
    withinHiUsd: (m.withinCI.hi * 3600) / r.config.steps,
    keeperUsd: kc.mainnetUsdPerHour,
    keeperUsd110k: k110.mainnetUsdPerHour,
    netBps: kc.netBpsPerHour,
    netUsd: kc.netUsdPerHour,
    netBps110k: k110.netBpsPerHour,
    netUsd110k: k110.netUsdPerHour,
    postsPerHour,
    gasPerPost: kc.gasPerPost,
    reasons: kc.reasons,
    kPredictMiss: kc.kPredictMiss,
    share: m.share,
    compRetailCostBps: c.retailVol ? (c.retailCost / c.retailVol) * 1e4 : NaN,
    vanRetailCostBps: v.retailVol ? (v.retailCost / v.retailVol) * 1e4 : NaN,
    marketRetailCostBps: m.retailCostBps,
    marketRetailCostVsControlBps: m.retailCostBps - ctlCostBps,
    compArbFeePips: c.meanArbFeePips ?? NaN,
    vanArbFeePips: v.meanArbFeePips ?? NaN,
    arbRatio: v.nArb ? c.nArb / v.nArb : NaN,
    compArbProfitUsdH: c.arbProfit / hours,
    vanArbProfitUsdH: v.arbProfit / hours,
    meanK: c.meanK ?? NaN,
    staleSteps: c.staleSteps,
    // break-even builder payment (coop): the net LP gain vs vanilla that could be paid for first position
    breakEvenPerBlockUsd: kc.netUsdPerHour / BLOCKS_PER_HOUR,
    breakEvenPerPostUsd: postsPerHour > 0 ? kc.netUsdPerHour / postsPerHour : NaN,
    breakEvenPerBlockUsd110k: k110.netUsdPerHour / BLOCKS_PER_HOUR,
    tab: r.tabular?.[pool as 'ai' | 'aigated'],
    demoted: r.demoted[pool as 'ai' | 'aigated' | 'aiheur'],
    reverts: r.reverts.length,
    runtimeSec: r.runtimeSec,
    bps,
  };
}
type Row = ReturnType<typeof perRun>;

const tiers = [...new Set(raws.map((x) => x.tier))].sort((x, y) => y - x);
const out: Record<string, unknown> = { generatedAt: new Date().toISOString(), tiers: {} };
const L: string[] = [];
const r0 = raws[0]!.results[0]!;
L.push('# Mainnet block timing, with and without a cooperating builder (v4 benchmark, LightGBM models)');
L.push('');
L.push(
  `Generated ${new Date().toISOString()} by \`benchmark/src/v4/coop4.ts\` (sim4.ts mainnet block mode). ${raws[0]!.results.length} ETHUSDT one-hour windows (3 volatile, 3 calm; data/windows_v2.json), ${raws[0]!.steps} s each = ${r0.blockMode?.blocks ?? '?'} blocks of 12 s, $${(r0.initialTvlUsd / 1e6).toFixed(0)}M full-range TVL per pool. Each Oniblock pool competes with its own vanilla neighbour (same fee tier, same liquidity) for the same routed retail and the same two arbitrageurs; **the vanilla neighbour is the "without this hook" baseline** and every LP number below is Oniblock minus that neighbour.`,
);
L.push('');
L.push('## What the mainnet block mode simulates');
L.push('');
L.push('- Time advances in 12 s blocks. In block b (timestamp s) everything acts at s, in this order: settler, keeper (if its post lands in this block), the two arbitrageurs (vs the Binance mid at s), then retail. Nothing trades between blocks. Arbs and retail are in the same anvil block, so retail that follows an arb in the arb direction pays the hook\'s per-block high-water fee (the fee quote for retail is taken after the arbs on a throw-away copy of the chain, then the real block is mined).');
L.push('- **realistic** (no builder deal): the keeper reads Binance 13 s before the block it prices and the chain as it is then (pool state and swaps up to block b−1; block b is not built yet); its post lands last in block b and prices block b+1. Model `tabular-v2` (trained on ~11 s-old mids).');
L.push('- **coop** (cooperating builder): the keeper reads Binance 2 s before block b and the chain after block b−1; the builder puts its post first in block b, so it prices block b. Model `oniblock1` (trained on ~2 s-old mids).');
L.push('- Keeper: in-process LightGBM (services/src/model/tabular.ts) on the features the live keeper computes (services/src/features.ts computeFeatures: a MidHistory with one CEX read per block, pre-filled from the 30 min before the window; realized vol over its last 120 reads; 20-block swap window; inputs canonicalised to the training orientation), then the keeper\'s charge gate at the model JSON\'s `chargeThreshold` (confidence = p ≥ t ? 1 : 0, so k = 0.8·p above the gate and 0 below; pToxic is posted unchanged and graded). Post policy `change` (services/src/postPolicy.ts), heartbeat 4 blocks, stale after 5 blocks, 5% of posts missed.');
L.push('- Settler: grades every block with arb-direction flow against the Binance mid at the block timestamp, label y = markout at the base fee > max($1, 1 bp of arb volume) (the live settler default and the label the models are trained on; blocks inside the dead band are not graded), posts calibration every 2 blocks; a model is demoted to k = kDefault = 0 (a vanilla pool) until it has 10 graded blocks or while its Brier > 0.25.');
L.push('- Retail: the v4 model (Poisson 0.1 orders/s → 1.2 per block, lognormal size median $400, autocorrelated direction, 5% informed over 30 s), routed per market between the two pools by best execution (optimal split). Keeper gas from the setAttestation receipts; net = gross − keeper gas at 1 gwei (LPs fund the keeper).');
L.push('- Not modelled: priority fees / bribes other than the break-even payment computed below, arbs that are also builders (the arb here never outbids the keeper), backruns within a block by other searchers, CEX–DEX arbs that trade between blocks on other venues, gas-price volatility, the Chainlink sanity-band gas (see the 110k columns), settler gas. Retail demand does not react to the fee except by routing between the two pools.');
L.push('');

for (const tier of tiers) {
  const byRun = Object.fromEntries(raws.filter((x) => x.tier === tier).map((x) => [x.run, x]));
  const armOut = ARMS.filter((A) => byRun[A.run]).map((A) => {
    const raw = byRun[A.run]!;
    const rows = raw.results.map((r) => perRun(r, A.pool));
    const g = (sel: (x: Row) => boolean) => {
      const rs = rows.filter(sel);
      const AG = (f: (x: Row) => number) => aggWindows(rs.map(f).filter(Number.isFinite), seed++);
      const pairs = rs.flatMap((x) => x.tab?.pairs ?? []);
      const thr = rs[0]?.tab?.threshold;
      return {
        n: rs.length,
        grossBps: AG((x) => x.grossBps),
        grossUsd: AG((x) => x.grossUsd),
        netBps: AG((x) => x.netBps),
        netUsd: AG((x) => x.netUsd),
        netBps110k: AG((x) => x.netBps110k),
        keeperUsd: AG((x) => x.keeperUsd),
        postsPerHour: AG((x) => x.postsPerHour),
        share: AG((x) => x.share * 100),
        compRetailCostBps: AG((x) => x.compRetailCostBps),
        vanRetailCostBps: AG((x) => x.vanRetailCostBps),
        marketRetailCostVsControlBps: AG((x) => x.marketRetailCostVsControlBps),
        compArbFeePips: AG((x) => x.compArbFeePips),
        vanArbFeePips: AG((x) => x.vanArbFeePips),
        arbRatio: AG((x) => x.arbRatio),
        breakEvenPerBlockUsd: AG((x) => x.breakEvenPerBlockUsd),
        breakEvenPerPostUsd: AG((x) => x.breakEvenPerPostUsd),
        breakEvenPerBlockUsd110k: AG((x) => x.breakEvenPerBlockUsd110k),
        chargedDecisionShare: AG((x) => (x.tab ? x.tab.charged / Math.max(1, x.tab.decisions) : NaN)),
        sel: thr !== undefined ? selective(pairs, thr) : undefined,
        threshold: thr,
      };
    };
    return { ...A, rows, all: g(() => true), volatile: g((x) => x.regime === 'volatile'), calm: g((x) => x.regime === 'calm'), modelPath: raw.spec.modelPath };
  });
  (out.tiers as Record<string, unknown>)[tier] = armOut.map(({ rows, ...x }) => ({ ...x, rows: rows.map(({ bps: _b, tab, ...r }) => ({ ...r, tab: tab ? { ...tab, pairs: undefined, graded: tab.pairs.length } : undefined })) }));
  const model = armOut.filter((x) => x.all.sel);
  L.push(`## Base fee ${(tier / 1e4).toFixed(2)}% (every pool)`);
  L.push('');
  L.push('### LP − HODL of the Oniblock pool vs its vanilla neighbour (per hour; 95% bootstrap CI over the 6 windows)');
  L.push('');
  L.push('| arm | gross bps/h [CI] | gross $/h | keeper $/h @1 gwei | net bps/h @1 gwei [CI] | net $/h | net bps/h, 110k gas | verdict (net) | windows +/− | posts/h | retail share % | retail cost bps: Oniblock / vanilla | market retail cost vs control bps | mean arb fee: Oniblock / vanilla | arb trades vs vanilla |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const x of armOut) {
    const A = x.all;
    L.push(
      `| ${x.label} | ${fa(A.grossBps, 3)} | ${fmt(A.grossUsd.mean, 0)} | ${fmt(A.keeperUsd.mean, 1)} | ${fa(A.netBps, 3)} | ${fmt(A.netUsd.mean, 0)} | ${fmt(A.netBps110k.mean, 3)} | ${verdict(A.netBps)} | ${A.netBps.pos}/${A.netBps.neg} | ${fmt(A.postsPerHour.mean, 0)} | ${fmt(A.share.mean, 1)} | ${fmt(A.compRetailCostBps.mean, 1)} / ${fmt(A.vanRetailCostBps.mean, 1)} | ${fmt(A.marketRetailCostVsControlBps.mean, 2)} | ${fmt(A.compArbFeePips.mean / 1e4, 3)}% / ${fmt(A.vanArbFeePips.mean / 1e4, 3)}% | ${fmt(A.arbRatio.mean * 100, 0)}% |`,
    );
  }
  L.push('');
  L.push('### By regime (net bps/h @1 gwei [CI])');
  L.push('');
  L.push('| arm | volatile gross | volatile net | calm gross | calm net |');
  L.push('|---|---|---|---|---|');
  for (const x of armOut) L.push(`| ${x.arm} | ${fa(x.volatile.grossBps, 3)} | ${fa(x.volatile.netBps, 3)} | ${fa(x.calm.grossBps, 3)} | ${fa(x.calm.netBps, 3)} |`);
  L.push('');
  L.push('### The model on the sim\'s own graded blocks (settler labels, all windows pooled)');
  L.push('');
  L.push('charged = the probability in force at the block ≥ the model\'s chargeThreshold (for the gate-off arms this is the same rule applied to their posted p; their k is 0.8·p regardless). pass rate = toxic charged / charged, FPR = benign charged / all benign, coverage = charged / graded, TPR = toxic charged / all toxic.');
  L.push('');
  L.push('| arm | model (chargeThreshold) | graded blocks | toxic base rate | charged | pass rate | FPR | coverage | TPR | Brier | keeper decisions charged | volatile pass / FPR / TPR | calm pass / FPR / TPR |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const x of model) {
    const s = x.all.sel!;
    const v = x.volatile.sel!;
    const c = x.calm.sel!;
    const name = x.rows[0]?.tab?.model ?? '?';
    L.push(
      `| ${x.arm} | ${name} (${fmt(x.all.threshold, 4)}) | ${s.n} | ${pct(s.baseRate)} | ${s.charged} | ${pct(s.pass)} | ${pct(s.fpr)} | ${pct(s.coverage)} | ${pct(s.tpr)} | ${fmt(s.brier, 3)} | ${pct(x.all.chargedDecisionShare.mean)} | ${pct(v.pass)} / ${pct(v.fpr)} / ${pct(v.tpr)} | ${pct(c.pass)} / ${pct(c.fpr)} / ${pct(c.tpr)} |`,
    );
  }
  L.push('');
  // paired per window (same price path, same seeded retail orders and arb draws in every run)
  const armBy = Object.fromEntries(armOut.map((x) => [x.arm, x]));
  const PAIRS = [
    ['C', 'R', 'value of the builder deal (first position + 2 s mid + oniblock1 vs no deal)'],
    ['C', 'C0', 'charge gate on vs off (coop)'],
    ['R', 'R0', 'charge gate on vs off (realistic)'],
    ['C', 'Ch', 'oniblock1 vs the heuristic, coop timing'],
    ['R', 'Rh', 'tabular-v2 vs the heuristic, realistic timing'],
  ] as const;
  const paired: Record<string, unknown> = {};
  L.push('### Paired differences (per window, then bootstrap over windows)');
  L.push('');
  L.push('| difference | net bps/h @1 gwei [CI] | net $/h | windows +/− | retail share pp | volatile net bps/h [CI] | calm net bps/h [CI] |');
  L.push('|---|---|---|---|---|---|---|');
  for (const [x, y, what] of PAIRS) {
    const X = armBy[x];
    const Y = armBy[y];
    if (!X || !Y) continue;
    const d = (sel: (r: Row) => boolean, f: (r: Row) => number) =>
      aggWindows(
        X.rows.filter(sel).map((r) => f(r) - f(Y.rows.find((q) => q.windowId === r.windowId)!)),
        seed++,
      );
    const all = () => true;
    const net = d(all, (r) => r.netBps);
    const usd = d(all, (r) => r.netUsd);
    const sh = d(all, (r) => r.share * 100);
    const vol = d((r) => r.regime === 'volatile', (r) => r.netBps);
    const calm = d((r) => r.regime === 'calm', (r) => r.netBps);
    paired[`${x}-${y}`] = { what, net, usd, sh, vol, calm };
    L.push(`| ${x} − ${y}: ${what} | ${fa(net, 3)} | ${fmt(usd.mean, 0)} | ${net.pos}/${net.neg} | ${fmt(sh.mean, 1)} | ${fa(vol, 3)} | ${fa(calm, 3)} |`);
  }
  (out.paired ??= {} as Record<string, unknown>);
  (out.paired as Record<string, unknown>)[tier] = paired;
  L.push('');
  const C = armOut.find((x) => x.arm === 'C');
  if (C) {
    L.push('### Break-even payment to the builder (arm C)');
    L.push('');
    L.push(
      `The most the LPs could pay the builder for first position before the hooked pool stops beating its vanilla neighbour = net LP gain vs vanilla (after keeper gas at 1 gwei). Per block if the slot is bought every block: **${fa(C.all.breakEvenPerBlockUsd, 2)} $/block** (volatile ${fa(C.volatile.breakEvenPerBlockUsd, 2)}, calm ${fa(C.calm.breakEvenPerBlockUsd, 2)}); per keeper post (post-on-change, ${fmt(C.all.postsPerHour.mean, 0)} posts/h): ${fa(C.all.breakEvenPerPostUsd, 2)} $/post; with 110k gas/post: ${fa(C.all.breakEvenPerBlockUsd110k, 2)} $/block. A negative value means the hook loses to vanilla even with first position for free. First position is only needed in blocks where the keeper posts. The part of that gain that first position itself buys (C − R, per window, over C's posts): ${fa(aggWindows(C.rows.map((r) => { const q = armBy.R?.rows.find((z) => z.windowId === r.windowId); return q && r.postsPerHour > 0 ? (r.netUsd - q.netUsd) / r.postsPerHour : NaN; }).filter(Number.isFinite), seed++), 2)} $/post. Pool TVL $${(r0.initialTvlUsd / 1e6).toFixed(0)}M per pool; the gain scales roughly with liquidity.`,
    );
    L.push('');
  }
  L.push('### Model inputs seen by the keeper (means over decisions)');
  L.push('');
  L.push('| arm | decisions/run | mean p | gap > base fee | gap pips | edgeSigma | abs ret12 bps | realizedVol bps | nSwaps (20 blocks) | heuristic fallbacks | seasoned at s | demoted 1st / 2nd half |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const x of model) {
    const ts = x.rows.map((r) => r.tab!).filter(Boolean);
    const m = (f: (t: NonNullable<Row['tab']>) => number) => ts.reduce((s, t) => s + f(t), 0) / Math.max(1, ts.length);
    L.push(
      `| ${x.arm} | ${fmt(m((t) => t.decisions), 0)} | ${fmt(m((t) => t.meanP), 3)} | ${pct(m((t) => t.edgePosShare))} | ${fmt(m((t) => t.meanGapPips), 0)} | ${fmt(m((t) => t.meanEdgeSigma), 2)} | ${fmt(m((t) => t.meanAbsRet12Bps), 2)} | ${fmt(m((t) => t.meanRealizedVolBps), 2)} | ${fmt(m((t) => t.meanNSwaps), 1)} | ${fmt(m((t) => t.fallback), 0)} | ${x.rows.map((r) => r.demoted.seasonedAtStep ?? '-').join(', ')} | ${x.rows.map((r) => `${pct(r.demoted.firstHalf, 0)}/${pct(r.demoted.secondHalf, 0)}`).join(', ')} |`,
    );
  }
  L.push('');
  L.push('### Per run');
  L.push('');
  L.push('| arm | window | gross $/h [within-window CI] | net $/h @1 gwei | posts/h | reasons | k predict miss | share % | arb fee Oniblock / vanilla | graded | charged | stale blocks | reverts |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const x of armOut)
    for (const r of x.rows)
      L.push(
        `| ${x.arm} | ${r.windowId} | ${fmt(r.grossUsd, 0)} [${fmt(r.withinLoUsd, 0)}, ${fmt(r.withinHiUsd, 0)}] | ${fmt(r.netUsd, 0)} | ${fmt(r.postsPerHour, 0)} | ${Object.entries(r.reasons).map(([k, v]) => `${k} ${v}`).join(', ')} | ${r.kPredictMiss} | ${fmt(r.share * 100, 1)} | ${fmt(r.compArbFeePips / 1e4, 3)}% / ${fmt(r.vanArbFeePips / 1e4, 3)}% | ${r.tab?.pairs.length ?? '-'} | ${r.tab ? r.tab.pairs.filter((p) => p[0] >= r.tab!.threshold).length : '-'} | ${r.staleSteps} | ${r.reverts} |`,
      );
  L.push('');
}
L.push('Reproduce: `pnpm -C benchmark exec tsx src/v4/coop4.ts --run realistic` and `--run coop` (add `--tier 500` for the 0.05% tier), then `--report-only`. The 1 s benchmark is unchanged: `tsx src/v4/repro4.ts` checks that keepercost4 arm a still reproduces results_v4/heuristic-full (84/84 pool totals).');
writeFileSync(resolve(outDir, 'results.md'), L.join('\n') + '\n');
const round = (_k: string, v: unknown) => (typeof v === 'number' ? (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null) : v);
writeFileSync(resolve(outDir, 'results.json'), JSON.stringify(out, round, 1));
log('coop_report', { outDir, tiers });
process.exit(0);
