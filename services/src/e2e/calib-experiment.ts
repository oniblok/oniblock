/**
 * Calibration-gate experiment on a live chain: does the gate separate an honest model from a degraded one?
 *
 * Reads the Receipts + attestations the keeper actually posted (honest run: keep the keeper un-degraded), labels
 * them exactly like the settler, and evaluates the gate at every labelled block (rolling window) for
 *   honest   p  (as attested)          vs   degraded  1 - p  (the keeper's degrade() transform flips p)
 * under both gate semantics (raw absolute Brier vs skill-normalised) and both markout horizons (0 = mid in force,
 * 1 = next attested mid), for several windows. Prints the share of evaluation points that would be DEMOTED
 * (posted value > brierDemoteBps). A good gate: honest ~0%, degraded ~100%.
 *
 * CLI: tsx src/e2e/calib-experiment.ts [--chain local] [--from BLOCK] [--windows 6,8,20] [--min-n 3]
 */
import { getAttestations, getReceipts } from '../chain.js';
import { env, loadDeployment, log, makePublicClient, oniblockPool, parseArgs, selectChain, type ChainName } from '../config.js';
import { attestationIndex, calibrate, labelBlocks, type CalibGate, type LabelledBlock } from '../settler.js';

const a = parseArgs();
const sel = selectChain((a.chain as ChainName) ?? (env('CHAIN', 'local') as ChainName));
const pc = makePublicClient(sel);
const d = loadDeployment(sel.chain.id);
const pool = oniblockPool(d);
const threshold = Number(((d.raw.pools as Record<string, { config?: { brierDemoteBps?: number } }>)?.[pool.name]?.config?.brierDemoteBps) ?? 2500);
const windows = String(a.windows ?? '6,8,20,50').split(',').map(Number);
const minN = Number(a['min-n'] ?? 3);
const from = BigInt(a.from ?? d.startBlock ?? 0);
const head = Number(await pc.getBlockNumber());
const [receipts, atts] = await Promise.all([getReceipts(pc, d.hook, pool.poolId, from, BigInt(head)), getAttestations(pc, d.hook, pool.poolId, from, BigInt(head))]);
const idx = attestationIndex(atts);

const rows: Record<string, unknown>[] = [];
for (const horizon of [0, 1]) {
  // Same attestation matching as the settler: each receipt's own attestation (model + k + log order).
  const labels = labelBlocks(
    receipts.filter((r) => r.blockNumber < head),
    (b, r) => (horizon === 0 ? idx.forReceipt(r)?.oracleMidX96 : idx.midAfter(b)),
    (r) => {
      const at = idx.forReceipt(r);
      return at ? at.pToxicBps / 10_000 : undefined;
    },
    {
      groupKey: (r) => {
        const at = idx.forReceipt(r);
        return at ? `${r.blockNumber}:${at.txHash}:${at.logIndex}` : `${r.blockNumber}:${r.modelNode}:unmatched`;
      },
    },
  );
  // Single node view (the keeper's primary model; others would be scored separately).
  const node = d.modelNode ?? labels[0]?.modelNode;
  const ls = labels.filter((l) => l.modelNode === node);
  const flipped: LabelledBlock[] = ls.map((l) => ({ ...l, p: 1 - l.p }));
  const baseRate = ls.length ? ls.reduce((s, l) => s + l.y, 0) / ls.length : 0;
  for (const w of windows) {
    for (const gate of ['raw', 'skill'] as CalibGate[]) {
      const evalAt = (xs: LabelledBlock[]) => {
        const vals: number[] = [];
        for (let i = minN; i <= xs.length; i++) {
          const c = calibrate(xs.slice(Math.max(0, i - w), i), 0, gate)[0];
          if (c) vals.push(c.brierBps);
        }
        return vals;
      };
      const h = evalAt(ls);
      const g = evalAt(flipped);
      const share = (v: number[]) => (v.length ? +((100 * v.filter((x) => x > threshold).length) / v.length).toFixed(1) : null);
      const med = (v: number[]) => (v.length ? [...v].sort((x, y) => x - y)[Math.floor(v.length / 2)] : null);
      rows.push({ horizon, window: w, gate, labels: ls.length, baseRatePct: +(baseRate * 100).toFixed(1), points: h.length, honestDemotedPct: share(h), degradedDemotedPct: share(g), honestMedian: med(h), degradedMedian: med(g) });
    }
  }
}
log('calib-experiment', 'result', { fromBlock: Number(from), head, receipts: receipts.length, attestations: atts.length, threshold, rows });
for (const r of rows) console.error(JSON.stringify(r));
process.exit(0);
