/**
 * Demo narrative check: reads the hook's events since deployBlock and reports the calibration-gate story
 *
 *   unseasoned (n < minSamples, k = kDefault) -> seasoned (calibration n >= minSamples, Brier <= threshold,
 *   k moves off kDefault) -> degraded (keeper flag) -> Brier > brierDemoteBps -> demoted (k = kDefault)
 *
 * plus kill-switch evidence (attestation gaps, stale receipts at conservativeFee, quoter changes).
 *
 * CLI: tsx src/e2e/story.ts [--chain local|fork] [--from BLOCK] [--degraded-at BLOCK]
 *                           [--expect seasoned,demoted,honest-active,stale,resumed]
 * With --degraded-at (the block the keeper was degraded), "demoted" must happen after it and "honest-active"
 * requires that no settler post before it demoted the (honest) model once seasoned.
 * Exit 1 if an expected phase is missing. Prints one JSON line ({c:"story", e:"summary", ...}).
 */
import type { Hex } from 'viem';
import { oniblockHookAbi } from '../abi/oniblockHook.js';
import { getAttestations, getReceipts } from '../chain.js';
import { env, loadDeployment, log, makePublicClient, oniblockPool, parseArgs, selectChain, type ChainName } from '../config.js';

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
const [atts, rcpts, cals] = await Promise.all([
  getAttestations(pc, d.hook, pool.poolId, from, head),
  getReceipts(pc, d.hook, pool.poolId, from, head),
  pc.getContractEvents({ address: d.hook, abi: oniblockHookAbi, eventName: 'CalibrationUpdated', fromBlock: from, toBlock: head }),
]);
const primary = (env('MODEL_NODE') as Hex | undefined) ?? d.modelNode;
const calRows = cals
  .map((c) => ({ block: Number(c.blockNumber), node: c.args.modelNode as Hex, brier: Number(c.args.brierBps), hit: Number(c.args.hitRateBps), n: Number(c.args.n) }))
  .filter((c) => !primary || c.node.toLowerCase() === primary.toLowerCase() || a['all-models']);

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
for (let i = 1; i < atts.length; i++) {
  const g = atts[i]!.minedBlock - atts[i - 1]!.minedBlock;
  if (g > staleBlocks) gaps.push({ from: atts[i - 1]!.minedBlock, to: atts[i]!.minedBlock, blocks: g });
}
const quoters: { quoter: string; firstBlock: number }[] = [];
for (const x of atts) if (!quoters.length || quoters[quoters.length - 1]!.quoter !== x.quoter) quoters.push({ quoter: x.quoter, firstBlock: x.minedBlock });
const stale = rcpts.filter((r) => r.stale);

const summary = {
  chain: sel.name,
  hook: d.hook,
  fromBlock: Number(from),
  head: Number(head),
  config: { kDefault, minSamples, brierDemote, staleBlocks, conservativeFee },
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
};

const expect = typeof a.expect === 'string' ? a.expect.split(',') : [];
const missing: string[] = [];
if (expect.includes('seasoned') && !(seasonedCal && kOffDefault)) missing.push('seasoned (k off kDefault)');
if (expect.includes('demoted') && !(demotedCal && kBackToDefault)) missing.push('demoted (k back to kDefault)');
if (expect.includes('honest-active') && (!seasonedCal || honestDemotions.length)) missing.push(`honest-active (${honestDemotions.length} honest-period demotions)`);
if (expect.includes('stale') && !(gaps.length && stale.length)) missing.push('stale (attestation gap + stale receipts)');
if (expect.includes('resumed') && !(gaps.length && quoters.length >= 2)) missing.push('resumed (attestations from a second quoter)');
log('story', missing.length ? 'MISSING' : 'summary', { ...summary, missing });
process.exit(missing.length ? 1 : 0);
