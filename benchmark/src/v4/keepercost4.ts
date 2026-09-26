/**
 * Keeper-cost study on the v4 benchmark: does the AI-decides pool still beat its vanilla neighbour once the keeper's
 * setAttestation gas is paid, and how much does "post only on change" (services/src/postPolicy.ts) save?
 *
 * Arms (heuristic scorer only, NO Jev calls; base fee 0.30%; ETH windows):
 *   a  post every,  lag 1  (= the v4 default: reproduces results_v4/heuristic-full)
 *   b  post change, lag 1
 *   c  post every,  lag 12 (attested mid 12 s old at every swap)
 *   d  post change, lag 12
 *   e  post every,  keeper turn every 12 steps (one per 12 s block), lag 6, stale after 60 steps, heartbeat 4 turns
 *   f  post change, same as e
 *
 *   tsx src/v4/keepercost4.ts [--arms a,b,c,d,e,f] [--windows ETH-vol1,...] [--steps 3600] [--port 8800]
 *   tsx src/v4/keepercost4.ts --report-only        merge raw-*.json in the out dir into results.md / results.json
 * Several processes can run disjoint --arms on disjoint --port ranges; each writes raw-<arm>.json.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BENCH_DIR, log } from '../util.js';
import { loadPathV2, selectWindowsV2 } from '../v2/windows.js';
import { aggWindows, type Agg } from '../v2/report2.js';
import { runOneV4, type RunConfigV4, type RunResultV4 } from './sim4.js';
import { BASE } from './base4.js';
import { keeperCost, marketMetrics, verdict } from './report4.js';

const argv = process.argv.slice(2);
const a: Record<string, string | boolean> = {};
for (let i = 0; i < argv.length; i++) {
  const k = argv[i]!;
  if (!k.startsWith('--')) continue;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) a[k.slice(2)] = true;
  else (a[k.slice(2)] = v), i++;
}
const outDir = resolve(String(a.out ?? resolve(BENCH_DIR, 'results_v4/keeper-cost')));
const steps = Number(a.steps ?? 3600);

// 12 s-cadence arms: stale after 5 mainnet blocks (DeployBase STALE_BLOCKS 5) = 60 steps = 180 sim blocks; heartbeat
// staleBlocks - 1 = 4 mainnet blocks = 4 turns x 36 sim blocks; lag 6 => attested mid 6..17 s old at the arb (mean 11.5)
const MAINNET_CADENCE: Partial<RunConfigV4> = { keeperEvery: 12, keeperLag: 6, staleSteps: 60, heartbeatBlocks: 144 };
const ARMS: Record<string, { label: string; over: Partial<RunConfigV4> }> = {
  a: { label: 'every, lag 1 s (v4 default)', over: { postMode: 'every', keeperLag: 1 } },
  b: { label: 'change, lag 1 s', over: { postMode: 'change', keeperLag: 1 } },
  c: { label: 'every, lag 12 s', over: { postMode: 'every', keeperLag: 12 } },
  d: { label: 'change, lag 12 s', over: { postMode: 'change', keeperLag: 12 } },
  e: { label: 'every, 12 s keeper cadence, lag 6 s', over: { ...MAINNET_CADENCE, postMode: 'every' } },
  f: { label: 'change, 12 s keeper cadence, lag 6 s', over: { ...MAINNET_CADENCE, postMode: 'change' } },
};
const COMP = 'aiheur' as const; // market (d): the heuristic decides the fee every block (== (c) in heuristic mode)
const VAN = 'v_aiheur' as const;

mkdirSync(outDir, { recursive: true });
if (!a['report-only']) {
  const arms = String(a.arms ?? 'a,b,c,d,e,f').split(',');
  const all = await selectWindowsV2();
  const wanted = String(a.windows ?? 'ETH-vol1,ETH-vol2,ETH-vol3,ETH-calm1,ETH-calm2,ETH-calm3').split(',');
  const windows = all.filter((w) => wanted.includes(w.id));
  let port = Number(a.port ?? 8800);
  for (const arm of arms) {
    const spec = ARMS[arm];
    if (!spec) throw new Error(`unknown arm ${arm}`);
    const results: RunResultV4[] = [];
    for (const w of windows) {
      const full = await loadPathV2(w, 1);
      const path = { ...full, mids: full.mids.slice(0, steps), times: full.times.slice(0, steps) };
      const cfg: RunConfigV4 = { ...BASE, ...spec.over, label: `${w.id}:base`, path, port: port++ };
      const r = await runOneV4(cfg);
      const kc = keeperCost(r, COMP, VAN)!;
      log('kc_run_done', { arm, label: r.label, sec: r.runtimeSec, reverts: r.reverts.length, posts: kc.posts, perStep: kc.postsPerStep, kMiss: kc.kPredictMiss, gross: kc.grossBpsPerHour });
      results.push(r);
      writeFileSync(resolve(outDir, `raw-${arm}.json`), JSON.stringify({ arm, spec, steps, results }));
    }
  }
}

// ------------------------------------------------------------------------------------------------ report
const raws = readdirSync(outDir)
  .filter((f) => /^raw-[a-z]\.json$/.test(f))
  .map((f) => JSON.parse(readFileSync(resolve(outDir, f), 'utf8')) as { arm: string; spec: { label: string; over: Partial<RunConfigV4> }; steps: number; results: RunResultV4[] })
  .sort((x, y) => x.arm.localeCompare(y.arm));
if (!raws.length) process.exit(0);

const fmt = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '-' : x.toFixed(d));
const fa = (g: Agg, d = 2) => `${fmt(g.mean, d)} [${fmt(g.lo, d)}, ${fmt(g.hi, d)}]`;
const GWEI = [0.5, 1, 2];
const MAINNET_GAS = 110_000; // the task's mainnet figure (with the Chainlink sanity band the bench does not deploy)
let seed = 11;
type Row = ReturnType<typeof perRun>;
function perRun(r: RunResultV4) {
  const kc = keeperCost(r, COMP, VAN)!;
  const m = marketMetrics(r)[COMP];
  const at = (gwei: number, gasPerPost?: number) => keeperCost(r, COMP, VAN, { gwei, gasPerPost })!;
  return {
    label: r.label,
    windowId: r.windowId,
    regime: r.regime,
    ethUsd: kc.ethUsd,
    posts: kc.posts,
    reverted: kc.reverted,
    postsPerStep: kc.postsPerStep,
    postsPerTurn: kc.postsPerTurn,
    reasons: kc.reasons,
    kPredictMiss: kc.kPredictMiss,
    gas: kc.gas,
    gasPerPost: kc.gasPerPost,
    simUsd1gwei: kc.simUsd,
    simBps1gwei: kc.simBps,
    mainnetPostsPerHour: kc.mainnetPostsPerHour,
    mainnetUsdPerHour: Object.fromEntries(GWEI.map((g) => [g, at(g).mainnetUsdPerHour])) as Record<number, number>,
    mainnetBpsPerHour: Object.fromEntries(GWEI.map((g) => [g, at(g).mainnetBpsPerHour])) as Record<number, number>,
    mainnetUsdPerHour110k: at(1, MAINNET_GAS).mainnetUsdPerHour,
    grossBpsPerHour: kc.grossBpsPerHour,
    grossUsdPerHour: kc.grossUsdPerHour,
    grossWithinCIPerHour: { lo: (m.withinCI.lo * 3600) / r.config.steps, hi: (m.withinCI.hi * 3600) / r.config.steps },
    netBpsPerHour: Object.fromEntries(GWEI.map((g) => [g, at(g).netBpsPerHour])) as Record<number, number>,
    netUsdPerHour1gwei: kc.netUsdPerHour,
    netBpsPerHour110k1gwei: at(1, MAINNET_GAS).netBpsPerHour,
    sharePct: m.share * 100,
    compArbFeePips: m.compArbFee ?? NaN,
    compNArb: m.compNArb,
    vanNArb: m.vanNArb,
    staleSteps: r.totals[COMP].staleSteps,
    reverts: r.reverts.length,
    runtimeSec: r.runtimeSec,
  };
}
const tvl = raws[0]!.results[0]!.initialTvlUsd;
const armOut = raws.map((raw) => {
  const rows = raw.results.map(perRun);
  const g = (sel: (x: Row) => boolean) => {
    const rs = rows.filter(sel);
    const A = (f: (x: Row) => number) => aggWindows(rs.map(f), seed++);
    return {
      n: rs.length,
      postsPerStep: A((x) => x.postsPerStep),
      postsPerTurn: A((x) => x.postsPerTurn),
      gasPerPost: A((x) => x.gasPerPost),
      mainnetPostsPerHour: A((x) => x.mainnetPostsPerHour),
      mainnetUsdPerHour: Object.fromEntries(GWEI.map((gw) => [gw, A((x) => x.mainnetUsdPerHour[gw]!)])) as Record<number, Agg>,
      mainnetUsdPerHour110k: A((x) => x.mainnetUsdPerHour110k),
      grossBps: A((x) => x.grossBpsPerHour),
      grossUsd: A((x) => x.grossUsdPerHour),
      netBps: Object.fromEntries(GWEI.map((gw) => [gw, A((x) => x.netBpsPerHour[gw]!)])) as Record<number, Agg>,
      netUsd1gwei: A((x) => x.netUsdPerHour1gwei),
      netBps110k: A((x) => x.netBpsPerHour110k1gwei),
      sharePct: A((x) => x.sharePct),
      compArbFeePips: aggWindows(rs.map((x) => x.compArbFeePips).filter(Number.isFinite), seed++),
      arbRatio: aggWindows(rs.filter((x) => x.vanNArb > 0).map((x) => x.compNArb / x.vanNArb), seed++),
      staleSteps: A((x) => x.staleSteps),
    };
  };
  return { arm: raw.arm, label: raw.spec.label, over: raw.spec.over, rows, all: g(() => true), volatile: g((x) => x.regime === 'volatile'), calm: g((x) => x.regime === 'calm') };
});

const L: string[] = [];
const nV = armOut[0]!.volatile.n;
const nC = armOut[0]!.calm.n;
L.push('# Keeper cost and post-on-change (v4 benchmark, 0.30% tier)');
L.push('');
L.push(
  `Generated ${new Date().toISOString()} by \`benchmark/src/v4/keepercost4.ts\`. ${armOut[0]!.all.n} ETHUSDT one-hour windows (${nV} volatile, ${nC} calm; data/windows_v2.json), ${raws[0]!.steps} 1 s steps each, heuristic scorer only (no Jev calls), base fee 0.30% on every pool, $${(tvl / 1e6).toFixed(0)}M full-range TVL per pool. Pool = market (d) \`aiheur\` (the heuristic decides the fee every block; identical to (c) in heuristic mode) vs its vanilla 0.30% neighbour, with routing competition. Everything else is the v4 default (results_v4/heuristic-full); arm a reproduces it exactly.`,
);
L.push('');
L.push('## What is measured');
L.push('');
L.push(
  `- **Keeper gas**: gasUsed of every setAttestation receipt on anvil (txs are sent at gasPrice 0; gasUsed does not depend on it). Mean ${fmt(armOut[0]!.all.gasPerPost.mean, 0)} gas per post (full tx incl. 21k intrinsic). The bench deploys **no Chainlink sanity band**; a mainnet pool with the band does an extra feed read per post, so the ~110k mainnet figure is also shown.`,
);
L.push(
  `- **Keeper cost on mainnet** = posts per keeper turn × 300 turns/h (one 12 s block each) × gas/post × gas price × ETH (window mean mid, ≈ $${fmt(armOut[0]!.rows.reduce((s, x) => s + x.ethUsd, 0) / armOut[0]!.rows.length, 0)}). For 'every' this is exactly 300 × (1 − miss 5%) posts/h. For 'change' in the 1 s-cadence arms (b, d) it is a **lower bound** (a 12 s block sees more drift than a 1 s step); arms e/f give the keeper one turn per 12 steps and count posts directly.`,
);
L.push(
  '- **Net LP-HODL vs vanilla** = gross (per hour of replayed data) − mainnet keeper cost, in bps of the Oniblock pool\'s TVL. **This assumes the LPs (or the pool) fund the keeper.** The vanilla pool pays nothing. CIs are 95% bootstrap over windows (the within-window block-bootstrap CI per run is in the per-run table).',
);
L.push(
  '- **Post policy** (services/src/postPolicy.ts, the live keeper\'s rule): `change` posts when k would move ≥ 500 bps, the JIT window ≥ 5 blocks (never: pJit = 0 in the bench), the mid drifts > 2 bps while k > 0, the model pToxic moves ≥ 1000 bps (10 points; keeps the graded probabilities current while k is pinned), or a heartbeat of staleBlocks − 1 blocks. `last` = the AttestationPosted state in force on-chain; `now` = the k setAttestation would store (demotion + kFromScore + maxKStep replicated from poolConfig and checked against every posted k).',
);
L.push('');
L.push('## Lag / block-time approximation: what is and is not modelled');
L.push('');
L.push('- The simulator is 1 s steps (3 anvil blocks each: keeper, arbs vs the true mid, retail). It was not rewritten.');
L.push('- **lag 12 (arms c, d)**: the keeper signs mid[t − 12]; arbs trade vs mid[t]. So every swap sees an attested mid 12 s old (the mainnet case "post lands late in block N, prices block N+1"). Keeper and arbs still act every second: the arb gets 12× more (smaller) opportunities per hour than on 12 s blocks and the keeper refreshes k every second.');
L.push('- **12 s keeper cadence (arms e, f)**: the keeper gets a turn only every 12 steps (one post opportunity per mainnet block) with lag 6, so the attestation in force is 6–17 s old at the arb (mean 11.5 s); stale after 60 steps (5 mainnet blocks, the production STALE_BLOCKS), heartbeat 4 turns. Arbs and retail still act every 1 s step.');
L.push('- Not modelled: 12 s arb/retail blocks (arbs trade every second), builder/top-of-block ordering or bribes, the keeper tx competing for inclusion (a missed post is the 5% miss draw only), priority fees, gas-price volatility, the Chainlink sanity-band gas (see the 110k column), settler (setCalibration) gas, L2 costs. Retail demand is fixed and does not react to the fee except by routing between the two pools.');
L.push('');
L.push('## Results by arm (all windows)');
L.push('');
L.push('| arm | policy | posts/step | mainnet posts/h | keeper USD/h @0.5 / 1 / 2 gwei | keeper @1 gwei, 110k gas | gross LP−HODL vs vanilla bps/h [CI] | gross USD/h | net bps/h @1 gwei [CI] | net USD/h @1 gwei | net @2 gwei | retail share % |');
L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const x of armOut) {
  const A = x.all;
  L.push(
    `| ${x.arm} | ${x.label} | ${fmt(A.postsPerStep.mean, 3)} | ${fmt(A.mainnetPostsPerHour.mean, 0)} | ${GWEI.map((g) => fmt(A.mainnetUsdPerHour[g]!.mean, 1)).join(' / ')} | ${fmt(A.mainnetUsdPerHour110k.mean, 1)} | ${fa(A.grossBps, 3)} | ${fmt(A.grossUsd.mean, 0)} | ${fa(A.netBps[1]!, 3)} | ${fmt(A.netUsd1gwei.mean, 0)} | ${fmt(A.netBps[2]!.mean, 3)} | ${fmt(A.sharePct.mean, 1)} |`,
  );
}
L.push('');
L.push('## By regime');
L.push('');
L.push('| arm | regime | posts/step | mainnet posts/h | keeper USD/h @1 gwei | gross bps/h [CI] | net bps/h @1 gwei [CI] | retail share % | stale steps |');
L.push('|---|---|---|---|---|---|---|---|---|');
for (const x of armOut)
  for (const reg of ['volatile', 'calm'] as const) {
    const G = x[reg];
    L.push(`| ${x.arm} | ${reg} | ${fmt(G.postsPerStep.mean, 3)} | ${fmt(G.mainnetPostsPerHour.mean, 0)} | ${fmt(G.mainnetUsdPerHour[1]!.mean, 1)} | ${fa(G.grossBps, 3)} | ${fa(G.netBps[1]!, 3)} | ${fmt(G.sharePct.mean, 1)} | ${fmt(G.staleSteps.mean, 0)} |`);
  }
L.push('');
const byArm = Object.fromEntries(armOut.map((x) => [x.arm, x]));
const saving = (ev: string, ch: string) =>
  byArm[ev] && byArm[ch] ? `${ch} vs ${ev}: ${fmt((1 - byArm[ch]!.all.mainnetPostsPerHour.mean / byArm[ev]!.all.mainnetPostsPerHour.mean) * 100, 0)}% fewer posts (${fmt(byArm[ev]!.all.mainnetUsdPerHour[1]!.mean, 1)} → ${fmt(byArm[ch]!.all.mainnetUsdPerHour[1]!.mean, 1)} USD/h at 1 gwei), gross LP ${fmt(byArm[ch]!.all.grossBps.mean - byArm[ev]!.all.grossBps.mean, 3)} bps/h` : '';
L.push('## Post-on-change saving');
L.push('');
for (const [ev, ch] of [['a', 'b'], ['c', 'd'], ['e', 'f']]) {
  const s = saving(ev!, ch!);
  if (s) L.push(`- ${s}.`);
}
L.push('');
L.push('## Why the lag matters more than the gas');
L.push('');
for (const x of armOut)
  L.push(`- arm ${x.arm}: volatile windows, mean fee paid by arbs on the Oniblock pool ${fmt(x.volatile.compArbFeePips.mean / 1e4, 3)}% (vanilla 0.30%), arb trades on it ${fmt(x.volatile.arbRatio.mean * 100, 0)}% of the vanilla pool's; retail share ${fmt(x.all.sharePct.mean, 1)}%.`);
L.push('');
L.push('With a stale attested mid the hook measures the gap against the wrong price: the arb that trades toward the TRUE mid often shows no (or a reversed) gap vs the attested one, so it pays about the base fee and the pool loses its LVR protection, while retail that happens to trade toward the attested mid still pays the surcharge and routes to the vanilla pool.');
L.push('');
L.push('## Verdict (net of keeper cost, 1 gwei, measured gas)');
L.push('');
for (const x of armOut)
  L.push(`- arm ${x.arm} (${x.label}): net **${verdict(x.all.netBps[1]!)}** ${fa(x.all.netBps[1]!, 3)} bps/h (${x.all.netBps[1]!.pos}+/${x.all.netBps[1]!.neg}- of ${x.all.n}); volatile ${fa(x.volatile.netBps[1]!, 3)}, calm ${fa(x.calm.netBps[1]!, 3)}.`);
L.push('');
L.push('## Per run');
L.push('');
L.push('| arm | window | posts | posts/step | reasons | k predict miss | gas/post | keeper gas | sim USD @1 gwei | mainnet USD/h @1 gwei | mainnet bps/h | gross bps/h | gross USD/h [within-window CI] | net bps/h @1 gwei | share % | stale steps | reverts |');
L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const x of armOut)
  for (const r of x.rows)
    L.push(
      `| ${x.arm} | ${r.windowId} | ${r.posts} | ${fmt(r.postsPerStep, 3)} | ${Object.entries(r.reasons).map(([k, v]) => `${k} ${v}`).join(', ')} | ${r.kPredictMiss} | ${fmt(r.gasPerPost, 0)} | ${r.gas} | ${fmt(r.simUsd1gwei, 1)} | ${fmt(r.mainnetUsdPerHour[1], 2)} | ${fmt(r.mainnetBpsPerHour[1], 4)} | ${fmt(r.grossBpsPerHour, 3)} | ${fmt(r.grossUsdPerHour, 0)} [${fmt(r.grossWithinCIPerHour.lo, 0)}, ${fmt(r.grossWithinCIPerHour.hi, 0)}] | ${fmt(r.netBpsPerHour[1], 3)} | ${fmt(r.sharePct, 1)} | ${r.staleSteps} | ${r.reverts} |`,
    );
L.push('');
L.push('Reproduce: `pnpm -C benchmark exec tsx src/v4/keepercost4.ts` (or per arm: `--arms a,b --port 8800`), then `--report-only`. Single runs with the same knobs: `tsx src/v4/run4.ts --jev heuristic --steps 3600 --b500 false --post change --keeper-lag 12 [--keeper-every 12 --stale-steps 60 --heartbeat 144]`.');
writeFileSync(resolve(outDir, 'results.md'), L.join('\n') + '\n');
const round = (_k: string, v: unknown) => (typeof v === 'number' ? (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null) : v);
writeFileSync(resolve(outDir, 'results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), comp: COMP, vanilla: VAN, arms: armOut }, round, 1));
log('kc_report', { outDir, arms: armOut.map((x) => x.arm), exists: existsSync(resolve(outDir, 'results.md')) });
process.exit(0);
