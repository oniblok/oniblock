/**
 * Local end-to-end run (acceptance: `pnpm -C services e2e`, >= 50 blocks).
 *
 * Plan:
 *  1. Start anvil (chainId 31337) with interval mining (--block-time, default 2 s: a live Jev call takes ~0.5-1 s and
 *     the v4 keeper asks Jev every block) so several txs share
 *     a block (the per-block fee anchor only matters then). Reuse an already running node with
 *     --no-anvil.
 *  2. Deploy: `forge script script/DeployLocal.s.sol --broadcast` in ../contracts using anvil
 *     key #0 (roles: 1 quoter, 2 settler, 3 attestor, 4 arb, 5 retail — see config.ts).
 *     The script writes deployments/31337.json. Skip with --no-deploy.
 *  3. Price path: REAL Binance ETHUSDT 1m klines, replayed accelerated — one block = --step-minutes
 *     (default 3) of history. Default window: the most volatile stretch of the 24h ending at the
 *     last full hour (deterministic within the hour, disk-cached); override with --replay-start <ms>.
 *     `--live` uses the live bookTicker instead (barely moves in 60 s, so arbs are rare).
 *  4. In-process actors on every block: Keeper (Jev -> heuristic fallback), ArbBot (all pools,
 *     optional --split N), RetailBot (all pools, same seeded flow), Settler (every M blocks).
 *     `--degrade-at B` switches the keeper to the degraded model after B blocks to exercise the
 *     calibration gate (default: 60% of the run; 0 disables).
 *  5. After N blocks: final settle, then assertions over the emitted events:
 *     - attestations posted in >= 70% of blocks (KEEPER_POST=change: instead, no gap between consecutive attestations
 *       longer than staleBlocks: the default heartbeat staleBlocks - 2 lands a post staleBlocks - 1 blocks after the
 *       last one, so one missed / late tick still fits and the pool stays fresh)
 *     - swaps happened; every Receipt obeys the fee law given its anchored (gap, k):
 *         arbDir && !stale -> fee == min(base + max(0, gap - arbThresholdPips)*k/1e4, feeMax) (v3 threshold law;
 *         threshold read from hook.poolConfig); !arbDir && !stale -> fee == base
 *     - v4 default (KEEPER_GATE unset/0, threshold 0, kMin = kDefault = 0): the keeper asked the model on EVERY tick
 *       (no rule-v1 attestation at all), and every non-stale arb-direction receipt with k = 0 paid exactly base
 *       (the model said "no profitable arbitrage", or it had no power yet) — i.e. a vanilla pool
 *     - with KEEPER_GATE=1 (v3 comparison): the keeper posted under rule-v1 at least once, and every non-stale,
 *       non-floored receipt at/below the threshold paid exactly base
 *     - no CalibrationUpdated for rule-v1 (the settler grades real models only)
 *     - CalibrationUpdated emitted at least once
 *   The settler labels arbs against the replayed CEX mid of each block (SETTLER_LABEL_MID=cex, the v3 default).
 *     Prints a JSON summary (fees, attestations, calibration per model, k over time) and exits 0/1.
 *
 * Flags: --step-minutes S (3) --blocks N (60) --port P (8545) --block-time S (2) --no-anvil --no-deploy --split N --live --out FILE (deployment json)
 *        --degrade-at B --replay-start MS --base-fee PIPS (3000) --fee-max PIPS (10000) --conservative-fee PIPS (5000)
 *        --arb-threshold PIPS (v4 default 0; passed to DeployLocal as ARB_THRESHOLD_PIPS)
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { oniblockHookAbi } from '../abi/oniblockHook.js';
import { ArbBot } from '../bots/arb.js';
import { RetailBot } from '../bots/retail.js';
import { fetchKlines, fetchMid } from '../cex.js';
import { getAttestations, getReceipts } from '../chain.js';
import { namehash } from 'viem';
import { ANVIL_KEYS, CONTRACTS_DIR, loadDeployment, log, oniblockPool, parseArgs, sleep } from '../config.js';
import { Keeper, keeperGateOn } from '../keeper.js';
import { Settler } from '../settler.js';
import { feeLaw } from '../price.js';

const a = parseArgs();
const BLOCKS = Number(a.blocks ?? 60);
const PORT = Number(a.port ?? 8545);
const BLOCK_TIME = Number(a['block-time'] ?? 2);
const RPC = `http://127.0.0.1:${PORT}`;
const BASE_FEE = Number(a['base-fee'] ?? 3000);
const FEE_MAX = Number(a['fee-max'] ?? 10000);
// Hook floors a block at conservativeFee when its first touch was stale and a same-block attestation un-staled it
// (contracts CONTRACT_FIXES_2 N-07). DeployLocal default 5000.
const CONSERVATIVE_FEE = Number(a['conservative-fee'] ?? 5000);
const ARB_THRESHOLD = Number(a['arb-threshold'] ?? 0);
const RULE_NODE = namehash(process.env.RULE_MODEL_NAME || 'rule-v1.models.oniblock.eth').toLowerCase();
/** Where DeployLocal writes (and services read) the deployment. Default: deployments/31337.json. */
if (typeof a.out === 'string') process.env.DEPLOYMENTS_FILE = resolve(a.out);
const DEGRADE_AT = a['degrade-at'] !== undefined ? Number(a['degrade-at']) : Math.floor(BLOCKS * 0.6);

process.env.CHAIN = 'local';
process.env.LOCAL_RPC = RPC;

let anvil: ChildProcess | undefined;
const cleanup = () => {
  if (anvil && !anvil.killed) anvil.kill('SIGTERM');
};
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

async function rpcUp(): Promise<boolean> {
  try {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
    return r.ok;
  } catch {
    return false;
  }
}

// --prune-history: keep only recent states in memory. Without it anvil persists every historical state under
// ~/.foundry/anvil/tmp and never cleans up (tens of GB after long runs). Nothing here reads old state.
async function startAnvil() {
  if (await rpcUp()) throw new Error(`port ${PORT} already serves an RPC; stop it or pass --no-anvil to reuse it`);
  anvil = spawn('anvil', ['--port', String(PORT), '--block-time', String(BLOCK_TIME), '--chain-id', '31337', '--silent', '--prune-history', '64'], { stdio: 'ignore' });
  anvil.on('exit', (c) => log('e2e', 'anvil_exit', { code: c }));
  for (let i = 0; i < 50; i++) {
    if (await rpcUp()) return;
    await sleep(200);
  }
  throw new Error('anvil did not start');
}

function deploy(initialMid: number) {
  const script = resolve(CONTRACTS_DIR, 'script', 'DeployLocal.s.sol');
  if (!existsSync(script)) throw new Error(`missing ${script} (contracts agent) — cannot deploy`);
  log('e2e', 'deploy_start', { script });
  const r = spawnSync('forge', ['script', 'script/DeployLocal.s.sol', '--rpc-url', RPC, '--broadcast', '--private-key', ANVIL_KEYS[0]!, '--slow'], {
    cwd: CONTRACTS_DIR,
    // Local anvil key only; overrides any sepolia DEPLOYER_PK for the child. INIT_PRICE_USD_E8 makes
    // DeployLocal initialise the pools at the first replayed price.
    env: { ...process.env, DEPLOYER_PK: ANVIL_KEYS[0]!, PRIVATE_KEY: ANVIL_KEYS[0]!, LOCAL_PK: ANVIL_KEYS[0]!, ...(process.env.DEPLOYMENTS_FILE ? { DEPLOYMENTS_OUT: process.env.DEPLOYMENTS_FILE } : {}), INIT_PRICE_USD_E8: String(Math.round(initialMid * 1e8)), BASE_FEE: String(BASE_FEE), FEE_MAX: String(FEE_MAX), CONSERVATIVE_FEE: String(CONSERVATIVE_FEE), ARB_THRESHOLD_PIPS: String(ARB_THRESHOLD) },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    process.stderr.write((r.stdout ?? '').slice(-4000) + '\n' + (r.stderr ?? '').slice(-4000) + '\n');
    throw new Error(`forge script failed (exit ${r.status})`);
  }
  log('e2e', 'deploy_done');
}

async function main() {
  // --- price path -----------------------------------------------------------------------
  let mids: number[] = [];
  if (!a.live) {
    // Real 1m klines; one block = STEP minutes of history. By default pick the most volatile
    // window of the 24h ending at the last full hour (deterministic within the hour, disk-cached),
    // so gaps larger than the fee actually open during a short run.
    const STEP = Number(a['step-minutes'] ?? 3);
    const need = BLOCKS * STEP + 2;
    let closes: number[];
    let startIdx = 0;
    if (a['replay-start']) {
      const start = Number(a['replay-start']);
      closes = (await fetchKlines({ interval: '1m', startMs: start, endMs: start + need * 60_000 })).map((k) => k.close);
    } else {
      const end = Math.floor(Date.now() / 3_600_000) * 3_600_000;
      closes = (await fetchKlines({ interval: '1m', startMs: end - 24 * 3_600_000, endMs: end })).map((k) => k.close);
      let best = -1;
      const absRet = closes.map((c, i) => (i ? Math.abs(Math.log(c / closes[i - 1]!)) : 0));
      let acc = absRet.slice(0, need).reduce((x, y) => x + y, 0);
      for (let i = 0; i + need <= closes.length; i++) {
        if (i) acc += absRet[i + need - 1]! - absRet[i]!;
        if (acc > best) {
          best = acc;
          startIdx = i;
        }
      }
    }
    for (let b = 0; b * STEP + startIdx < closes.length && b <= BLOCKS + 1; b++) mids.push(closes[startIdx + b * STEP]!);
    const rng = Math.max(...mids) / Math.min(...mids) - 1;
    log('e2e', 'replay_path', { stepMinutes: STEP, startIdx, n: mids.length, first: mids[0], last: mids[mids.length - 1], rangePct: +(rng * 100).toFixed(3) });
  }
  const initialMid = mids[0] ?? (await fetchMid()).mid;

  if (!a['no-anvil']) await startAnvil();
  if (!a['no-deploy']) deploy(initialMid);

  const d = loadDeployment(31337);
  const pool = oniblockPool(d);
  const pc = new Keeper({ chain: 'local', deployment: d }).pc;
  const startBlock = Number(await pc.getBlockNumber());
  let step = 0;
  const midSource = a.live ? undefined : async () => mids[Math.min(step, mids.length - 1)]!;
  // CEX mid per block for the settler's ex-post labels: txs sent while `step` is s land in the next block.
  const midAtBlock = new Map<number, number>();
  const settlerMid = a.live
    ? undefined
    : async (b: number) => {
        const m = midAtBlock.get(b) ?? midAtBlock.get(b - 1);
        if (m === undefined) throw new Error(`no replay mid for block ${b}`);
        return m;
      };
  const thr = Number(
    ((await pc.readContract({ address: d.hook, abi: oniblockHookAbi, functionName: 'poolConfig', args: [pool.poolId] })) as { arbThresholdPips: number }).arbThresholdPips,
  );

  const keeper = new Keeper({ chain: 'local', deployment: d, midSource, degraded: () => DEGRADE_AT > 0 && step >= DEGRADE_AT });
  const arb = new ArbBot({ chain: 'local', deployment: d, midSource, all: true, split: a.split ? Number(a.split) : undefined });
  const retail = new RetailBot({ chain: 'local', deployment: d, midSource, all: true });
  const settler = new Settler({ chain: 'local', deployment: d, fromBlock: startBlock, every: 10, midSource: settlerMid });

  log('e2e', 'run_start', { startBlock, blocks: BLOCKS, degradeAt: DEGRADE_AT, pools: d.pools.map((p) => p.name) });
  let last = startBlock;
  const arbStats: Record<string, number> = {};
  while (step < BLOCKS) {
    const bn = Number(await pc.getBlockNumber());
    if (bn === last) {
      await sleep(100);
      continue;
    }
    last = bn;
    step++;
    const cur = mids[Math.min(step, mids.length - 1)];
    if (cur !== undefined) midAtBlock.set(bn + 1, cur);
    // Fire-and-forget: actors guard themselves with busy flags and log (never throw), so a slow
    // receipt never makes the loop skip blocks. Keeper's tx targets block bn+1.
    void keeper.tick(bn);
    void arb
      .step()
      .then((rs) => rs.forEach((r) => (arbStats[`${r.pool}:${r.traded ? 'traded' : r.reason}`] = (arbStats[`${r.pool}:${r.traded ? 'traded' : r.reason}`] ?? 0) + 1)))
      .catch(() => []);
    void retail.step().catch(() => 0);
    if (step % 10 === 0) void settler.settle(bn);
  }
  await sleep(1500);
  const endBlock = Number(await pc.getBlockNumber());
  await settler.settle(endBlock);

  // --- assertions -------------------------------------------------------------------------
  const [receipts, atts] = await Promise.all([
    getReceipts(pc, d.hook, pool.poolId, BigInt(startBlock), BigInt(endBlock)),
    getAttestations(pc, d.hook, pool.poolId, BigInt(startBlock), BigInt(endBlock)),
  ]);
  const cals = await pc.getContractEvents({ address: d.hook, abi: oniblockHookAbi, eventName: 'CalibrationUpdated', fromBlock: BigInt(startBlock), toBlock: BigInt(endBlock) });

  const failures: string[] = [];
  const attBlocks = new Set(atts.map((x) => x.minedBlock));
  // v4: Jev is asked every block (~0.5-1 s live), so on 1 s test blocks the keeper can miss ~40% of blocks (harmless:
  // staleBlocks >= 5). Require 70% coverage on >= 2 s blocks, 55% on faster ones.
  const minCoverage = BLOCK_TIME >= 2 ? 0.7 : 0.55;
  const postChange = process.env.KEEPER_POST === 'change';
  const staleBlocks = Number(((await pc.readContract({ address: d.hook, abi: oniblockHookAbi, functionName: 'poolConfig', args: [pool.poolId] })) as { staleBlocks: number }).staleBlocks);
  const mined = [...attBlocks].sort((x, y) => x - y);
  const maxAttestGap = mined.reduce((m, b, i) => (i ? Math.max(m, b - mined[i - 1]!) : m), 0);
  if (!postChange && attBlocks.size < minCoverage * BLOCKS) failures.push(`attestations in only ${attBlocks.size}/${BLOCKS} blocks (< ${minCoverage * 100}%)`);
  // Heartbeat default staleBlocks - 2 (keeperPostPolicy): nominal mined gap staleBlocks - 1, one missed/late tick = staleBlocks.
  if (postChange && (atts.length === 0 || maxAttestGap > staleBlocks)) failures.push(`KEEPER_POST=change: ${atts.length} attestations, max gap ${maxAttestGap} blocks (> staleBlocks ${staleBlocks})`);
  if (receipts.length === 0) failures.push('no swaps (Receipt events) on the Oniblock pool');
  let lawViolations = 0;
  let belowThrArb = 0;
  let belowThrNotBase = 0;
  for (const r of receipts) {
    if (r.stale) continue;
    const expected = feeLaw({ arbDir: r.arbDir, gapPips: r.gapPips, kBps: r.kBps, baseFee: BASE_FEE, feeMax: FEE_MAX, arbThresholdPips: thr });
    if (r.arbDir && r.gapPips <= thr) {
      belowThrArb++;
      if (r.feePips !== BASE_FEE && r.feePips !== CONSERVATIVE_FEE) belowThrNotBase++;
    }
    const floored = CONSERVATIVE_FEE > expected && r.feePips === CONSERVATIVE_FEE; // N-07 un-staled block
    if (r.feePips !== expected && !floored) {
      lawViolations++;
      if (lawViolations <= 5) log('e2e', 'fee_law_mismatch', { block: r.blockNumber, arbDir: r.arbDir, gap: r.gapPips, k: r.kBps, fee: r.feePips, expected });
    }
  }
  if (lawViolations) failures.push(`${lawViolations} receipts violate the fee law (base ${BASE_FEE}, feeMax ${FEE_MAX}, threshold ${thr})`);
  if (thr !== ARB_THRESHOLD) failures.push(`hook arbThresholdPips ${thr} != requested ${ARB_THRESHOLD}`);
  if (belowThrNotBase) failures.push(`${belowThrNotBase} below-threshold arb-direction receipts did not pay base`);
  const ruleAtts = atts.filter((x) => x.modelNode.toLowerCase() === RULE_NODE);
  const gate = keeperGateOn();
  if (gate && ruleAtts.length === 0) failures.push('keeper never posted under rule-v1 (v3 gate, KEEPER_GATE=1)');
  if (!gate && ruleAtts.length) failures.push(`${ruleAtts.length} rule-v1 attestations with the gate off (v4: the model decides every block)`);
  if (!gate && keeper.stats.modelTicks !== keeper.stats.ticks) failures.push(`model asked on ${keeper.stats.modelTicks}/${keeper.stats.ticks} ticks (v4: every tick)`);
  const k0Arb = receipts.filter((r) => r.arbDir && !r.stale && r.kBps === 0);
  const k0NotBase = k0Arb.filter((r) => r.feePips !== BASE_FEE && r.feePips !== CONSERVATIVE_FEE).length;
  if (k0NotBase) failures.push(`${k0NotBase} arb-direction receipts with k = 0 did not pay base`);
  const ruleCals = cals.filter((c) => String(c.args.modelNode).toLowerCase() === RULE_NODE);
  if (ruleCals.length) failures.push('settler graded rule-v1 (CalibrationUpdated for the rule node)');
  if (cals.length === 0) failures.push('no CalibrationUpdated events');

  const summary = {
    blocks: endBlock - startBlock,
    attestations: atts.length,
    attestedBlocks: attBlocks.size,
    keeperPost: postChange ? 'change' : 'every',
    maxAttestGap,
    staleBlocks,
    receipts: receipts.length,
    arbReceipts: receipts.filter((r) => r.arbDir).length,
    arbThresholdPips: thr,
    belowThresholdArbReceipts: belowThrArb,
    aboveThresholdArbReceipts: receipts.filter((r) => r.arbDir && !r.stale && r.gapPips > thr).length,
    ruleAttestations: ruleAtts.length,
    keeperGate: gate,
    arbReceiptsAtK0: k0Arb.length,
    arbReceiptsAboveBase: receipts.filter((r) => r.arbDir && !r.stale && r.feePips > BASE_FEE).length,
    kHistogram: hist(atts.map((x) => x.kBps)),
    jevCallRate: keeper.stats.ticks ? +(keeper.stats.modelTicks / keeper.stats.ticks).toFixed(3) : null,
    keeperStats: keeper.stats,
    staleReceipts: receipts.filter((r) => r.stale).length,
    arbStats,
    meanArbFeePips: avg(receipts.filter((r) => r.arbDir && !r.stale).map((r) => r.feePips)),
    kPath: atts.filter((_, i) => i % 5 === 0).map((x) => ({ b: x.minedBlock, k: x.kBps, p: x.pToxicBps })),
    calibration: cals.map((c) => ({ block: Number(c.blockNumber), node: c.args.modelNode, brierBps: c.args.brierBps, hitRateBps: c.args.hitRateBps, n: c.args.n })),
    failures,
  };
  log('e2e', failures.length ? 'FAIL' : 'PASS', summary);
  cleanup();
  process.exit(failures.length ? 1 : 0);
}

const hist = (ks: number[]) => {
  const h: Record<string, number> = { '0': 0, '1-499': 0, '500-1999': 0, '2000-4999': 0, '5000+': 0 };
  for (const k of ks) h[k === 0 ? '0' : k < 500 ? '1-499' : k < 2000 ? '500-1999' : k < 5000 ? '2000-4999' : '5000+']!++;
  return h;
};
const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null);

main().catch((e) => {
  log('e2e', 'error', { error: (e as Error).message });
  cleanup();
  process.exit(1);
});
