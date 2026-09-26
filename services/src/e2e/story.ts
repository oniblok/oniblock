/**
 * Demo narrative check: reads the hook's events since deployBlock and reports the calibration-gate story
 *
 *   unseasoned (n < minSamples, k = kDefault) -> seasoned (calibration n >= minSamples, Brier <= threshold,
 *   k moves off kDefault) -> degraded (keeper flag) -> Brier > brierDemoteBps -> demoted (k = kDefault)
 *
 * plus kill-switch evidence (attestation gaps, stale receipts at conservativeFee, quoter changes), plus the v5 JIT story
 * (docs/review/V5_JIT_HEAD_SPEC.md §5): `jit-caught` = at least one JitPenalty whose position was held >= 10 blocks
 * (it would have escaped the old fixed 10-block wall), `jit-seasoned` = seasoned AND active: a CalibrationUpdated on
 * the graded model's jitCalibrationKey with n >= CALIB_MIN_N and brier <= brierDemoteBps (the same demote threshold the
 * arb `seasoned` phase reads from the pool config; the on-chain twin of the calibration.jit.* ENS records). A JIT record
 * with n >= CALIB_MIN_N but brier > brierDemoteBps is a demoted head (the hook falls back to jitWindowDefault), not a
 * seasoned one.
 *
 * CLI: tsx src/e2e/story.ts [--chain local|fork] [--from BLOCK] [--degraded-at BLOCK] [--model-node NODE]
 *                           [--expect seasoned,demoted,honest-active,stale,resumed,jit-caught,jit-seasoned]
 * The k phases are graded for the model that actually ran the pool (the dominant attestation node, e.g. heuristic-v1
 * when Jev was unreachable; --model-node forces one) — see `modelGraded` in the summary.
 * With --degraded-at (the block the keeper was degraded), "demoted" must happen after it and "honest-active"
 * requires that no settler post before it demoted the (honest) model once seasoned.
 * Exit 1 if an expected phase is missing. Prints one JSON line ({c:"story", e:"summary", ...}).
 */
import { namehash, type Hex } from 'viem';
import { oniblockHookAbi } from '../abi/oniblockHook.js';
import { getAttestations, getJitPenalties, getReceipts, jitCalibrationKey } from '../chain.js';
import { env, envInt, loadDeployment, log, makePublicClient, oniblockPool, parseArgs, selectChain, type ChainName } from '../config.js';

const a = parseArgs();
const sel = selectChain((a.chain as ChainName) ?? (env('CHAIN', 'local') as ChainName));
const pc = makePublicClient(sel);
const d = loadDeployment(sel.chain.id);
const pool = oniblockPool(d);
const cfgRaw = ((d.raw.pools as Record<string, { config?: Record<string, number> }>)?.[pool.name]?.config ?? {}) as Record<string, number>;
const kDefault = Number(cfgRaw.kDefaultBps ?? 5000);
const minSamples = Number(cfgRaw.minSamples ?? 10);
const brierDemote = Number(cfgRaw.brierDemoteBps ?? 2500);
const staleBlocks = Number(cfgRaw.staleBlocks ?? 5);
const conservativeFee = Number(cfgRaw.conservativeFee ?? 5000);

const from = BigInt(a.from ?? d.startBlock ?? 0);
const head = await pc.getBlockNumber();
const [allAtts, rcpts, cals, jitPenalties] = await Promise.all([
  getAttestations(pc, d.hook, pool.poolId, from, head),
  getReceipts(pc, d.hook, pool.poolId, from, head),
  pc.getContractEvents({ address: d.hook, abi: oniblockHookAbi, eventName: 'CalibrationUpdated', fromBlock: from, toBlock: head }),
  getJitPenalties(pc, d.hook, pool.poolId, from, head).catch(() => []), // pre-v5 hook: no such event
]);
const configured = (env('MODEL_NODE') as Hex | undefined) ?? d.modelNode;
// v3 gate only (KEEPER_GATE=1): attestations posted under the keeper's below-threshold rule (rule-v1, k = kDefault
// because rule-v1 is never graded) say nothing about the model's k; the k phases use model attestations only.
// Kill-switch evidence uses all. The v4 default keeper never posts rule-v1.
const ruleNode = namehash(env('RULE_MODEL_NAME', 'rule-v1.models.oniblock.eth')!).toLowerCase();
const atts = allAtts.filter((x) => x.modelNode.toLowerCase() !== ruleNode);
// The story is about the model that actually ran the pool. When Jev is slow/unreachable the keeper posts the
// heuristic fallback under heuristic-v1 (the degrade flag applies to it too), so grade the DOMINANT node of the
// model attestations unless the configured primary posted at least half of them (--model-node NODE forces one).
const byNode = new Map<string, number>();
for (const x of atts) byNode.set(x.modelNode.toLowerCase(), (byNode.get(x.modelNode.toLowerCase()) ?? 0) + 1);
const dominant = [...byNode.entries()].sort((p, q) => q[1] - p[1])[0]?.[0];
const primaryCount = configured ? (byNode.get(configured.toLowerCase()) ?? 0) : 0;
const primary = (a['model-node'] as Hex | undefined) ?? (configured && primaryCount * 2 >= atts.length ? configured : ((dominant as Hex | undefined) ?? configured));
// v5: the JIT head's records live under jitCalibrationKey(modelNode); keep them out of the k-head rows.
const jitKeys = new Map<string, string>(); // jit key -> model node
for (const node of byNode.keys()) jitKeys.set(jitCalibrationKey(node as Hex).toLowerCase(), node);
if (primary) jitKeys.set(jitCalibrationKey(primary).toLowerCase(), primary.toLowerCase());
const allCalRows = cals.map((c) => ({ block: Number(c.blockNumber), node: c.args.modelNode as Hex, brier: Number(c.args.brierBps), hit: Number(c.args.hitRateBps), n: Number(c.args.n) }));
const calRows = allCalRows.filter((c) => !jitKeys.has(c.node.toLowerCase()) && (!primary || c.node.toLowerCase() === primary.toLowerCase() || a['all-models']));
const jitCalRows = allCalRows.filter((c) => jitKeys.has(c.node.toLowerCase()) && (!primary || jitKeys.get(c.node.toLowerCase()) === primary.toLowerCase() || a['all-models']));
const calibMinN = envInt('CALIB_MIN_N', minSamples);
// Seasoned AND active: the hook uses the attested JIT window only while brier <= brierDemoteBps (else jitWindowDefault).
const jitSeasonedCal = jitCalRows.find((c) => c.n >= calibMinN && c.brier <= brierDemote);
const jitDemotedRows = jitCalRows.filter((c) => c.n >= calibMinN && c.brier > brierDemote);
// A penalty on a position held >= 10 blocks is one the old fixed wall (blockNumberOffset = 10) would have missed.
const jitCaught = jitPenalties.filter((p) => p.block - p.addedBlock >= 10);

// Phases (first block at which each holds).
const degradedAt = a['degraded-at'] !== undefined ? Number(a['degraded-at']) : undefined;
const seasonedCal = calRows.find((c) => c.n >= minSamples && c.brier <= brierDemote && (degradedAt === undefined || c.block < degradedAt));
const demotedCal = seasonedCal
  ? calRows.find((c) => c.block > seasonedCal.block && (degradedAt === undefined || c.block >= degradedAt) && c.n >= minSamples && c.brier > brierDemote)
  : undefined;
// Honest-period demotions (after seasoning, before the degrade): the gate misfiring on the honest model.
const honestDemotions =
  seasonedCal && degradedAt !== undefined ? calRows.filter((c) => c.block > seasonedCal.block && c.block < degradedAt && c.n >= minSamples && c.brier > brierDemote) : [];
const kOffDefault = seasonedCal ? atts.find((x) => x.minedBlock > seasonedCal.block && x.kBps !== kDefault) : undefined;
const kBackToDefault = demotedCal ? atts.find((x) => x.minedBlock > demotedCal.block && x.kBps === kDefault) : undefined;
const firstAtt = atts[0];
// Attestations mined strictly before the first seasoned calibration (the same block may already use it).
const unseasonedAtts = atts.filter((x) => !seasonedCal || x.minedBlock < seasonedCal.block);

// Kill switch: gaps between consecutive attestations longer than staleBlocks, and quoter changes.
const gaps: { from: number; to: number; blocks: number }[] = [];
for (let i = 1; i < allAtts.length; i++) {
  const g = allAtts[i]!.minedBlock - allAtts[i - 1]!.minedBlock;
  if (g > staleBlocks) gaps.push({ from: allAtts[i - 1]!.minedBlock, to: allAtts[i]!.minedBlock, blocks: g });
}
const quoters: { quoter: string; firstBlock: number }[] = [];
for (const x of allAtts) if (!quoters.length || quoters[quoters.length - 1]!.quoter !== x.quoter) quoters.push({ quoter: x.quoter, firstBlock: x.minedBlock });
const stale = rcpts.filter((r) => r.stale);

const summary = {
  chain: sel.name,
  hook: d.hook,
  fromBlock: Number(from),
  head: Number(head),
  config: { kDefault, minSamples, brierDemote, staleBlocks, conservativeFee },
  modelGraded: { node: primary ?? null, configured: configured ?? null, attestationsByNode: Object.fromEntries(byNode) },
  ruleAttestations: allAtts.length - atts.length,
  attestations: atts.length,
  receipts: rcpts.length,
  unseasoned: firstAtt ? { firstBlock: firstAtt.minedBlock, attestations: unseasonedAtts.length, allAtKDefault: unseasonedAtts.every((x) => x.kBps === kDefault) } : null,
  seasoned: seasonedCal ? { block: seasonedCal.block, brier: seasonedCal.brier, n: seasonedCal.n, firstKOffDefault: kOffDefault ? { block: kOffDefault.minedBlock, k: kOffDefault.kBps } : null } : null,
  degradedAt: degradedAt ?? null,
  honestDemotions: honestDemotions.map((c) => ({ b: c.block, brier: c.brier, n: c.n })),
  maxKWhileSeasoned: seasonedCal ? Math.max(...atts.filter((x) => x.minedBlock > seasonedCal.block && (!demotedCal || x.minedBlock <= demotedCal.block)).map((x) => x.kBps), 0) : null,
  demoted: demotedCal ? { block: demotedCal.block, brier: demotedCal.brier, n: demotedCal.n, kBackToDefault: kBackToDefault ? { block: kBackToDefault.minedBlock, k: kBackToDefault.kBps } : null } : null,
  killSwitch: {
    attestationGaps: gaps,
    staleReceipts: stale.length,
    staleFees: [...new Set(stale.map((r) => r.feePips))],
    quoters,
  },
  calibration: calRows.map((c) => ({ b: c.block, brier: c.brier, hit: c.hit, n: c.n })),
  kPath: atts.filter((_, i) => i % 3 === 0).map((x) => `${x.minedBlock}:${x.kBps}`).join(' '),
  jit: {
    calibrationKey: primary ? jitCalibrationKey(primary) : null,
    calibMinN,
    brierDemote,
    demotedRecords: jitDemotedRows.length,
    penalties: jitPenalties.length,
    caught: jitCaught.length,
    firstCaught: jitCaught[0] ? { block: jitCaught[0].block, addedBlock: jitCaught[0].addedBlock, held: jitCaught[0].block - jitCaught[0].addedBlock, window: jitCaught[0].window, penalty0: jitCaught[0].penalty0, penalty1: jitCaught[0].penalty1 } : null,
    seasoned: jitSeasonedCal ? { block: jitSeasonedCal.block, brier: jitSeasonedCal.brier, n: jitSeasonedCal.n } : null,
    calibration: jitCalRows.map((c) => ({ b: c.block, brier: c.brier, hit: c.hit, n: c.n })),
    windowPath: atts.filter((_, i) => i % 3 === 0).map((x) => `${x.minedBlock}:${x.jitWindow}`).join(' '),
  },
};

const expect = typeof a.expect === 'string' ? a.expect.split(',') : [];
const missing: string[] = [];
if (expect.includes('seasoned') && !(seasonedCal && kOffDefault)) missing.push('seasoned (k off kDefault)');
if (expect.includes('demoted') && !(demotedCal && kBackToDefault)) missing.push('demoted (k back to kDefault)');
if (expect.includes('honest-active') && (!seasonedCal || honestDemotions.length)) missing.push(`honest-active (${honestDemotions.length} honest-period demotions)`);
if (expect.includes('stale') && !(gaps.length && stale.length)) missing.push('stale (attestation gap + stale receipts)');
if (expect.includes('resumed') && !(gaps.length && quoters.length >= 2)) missing.push('resumed (attestations from a second quoter)');
if (expect.includes('jit-caught') && !jitCaught.length) missing.push(`jit-caught (${jitPenalties.length} JitPenalty events, none with held >= 10 blocks)`);
if (expect.includes('jit-seasoned') && !jitSeasonedCal)
  missing.push(`jit-seasoned (no JIT calibration with n >= ${calibMinN} and brier <= ${brierDemote}; ${jitCalRows.length} jit records, ${jitDemotedRows.length} seasoned-but-demoted)`);
log('story', missing.length ? 'MISSING' : 'summary', { ...summary, missing });
process.exit(missing.length ? 1 : 0);
