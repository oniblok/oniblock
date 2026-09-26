/** v3 deployment: contracts/script/bench/DeployBenchV3.s.sol on a fresh anvil (reuses the v1 Anvil wrapper). */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { namehash, type Address, type Hex } from 'viem';
import { Anvil } from '../chain.js';
import { CONTRACTS_DIR, ROOT, log, sleep } from '../util.js';

const ANVIL0_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

export const NODE_NAMES = {
  const: 'const-k.models.oniblock.eth',
  jev: 'jev-v1.models.oniblock.eth',
  heur: 'heur-v1.models.oniblock.eth',
  gated: 'jev-v1-gated.models.oniblock.eth',
  /** keeper's deterministic below-threshold rule (never graded by the settler) */
  rule: 'rule-v1.models.oniblock.eth',
} as const;
export const NODES = Object.fromEntries(Object.entries(NODE_NAMES).map(([k, v]) => [k, namehash(v)])) as Record<keyof typeof NODE_NAMES, Hex>;

export const POOLS = ['v_control_a', 'v_control_b', 'v_old', 'old', 'v_tconst', 'tconst', 'v_theur', 'theur', 'v_tjev', 'tjev', 'v_tgated', 'tgated'] as const;
export type Pool = (typeof POOLS)[number];
export const HOOKED = ['old', 'tconst', 'theur', 'tjev', 'tgated'] as const satisfies readonly Pool[];
export type Hooked = (typeof HOOKED)[number];
export const MODEL_POOLS = ['theur', 'tjev', 'tgated'] as const satisfies readonly Hooked[];
export type ModelPool = (typeof MODEL_POOLS)[number];
export const MARKETS = [
  { name: 'control', vanilla: 'v_control_a', comp: 'v_control_b', label: 'vanilla vs vanilla (control; = fixed-fee competitor)' },
  { name: 'old', vanilla: 'v_old', comp: 'old', label: 'vanilla vs v2 law (no threshold), constant k = 0.5 (reference)' },
  { name: 'tconst', vanilla: 'v_tconst', comp: 'tconst', label: 'vanilla vs threshold law, constant k = 0.5' },
  { name: 'theur', vanilla: 'v_theur', comp: 'theur', label: 'vanilla vs threshold law, heuristic k (gated keeper)' },
  { name: 'tjev', vanilla: 'v_tjev', comp: 'tjev', label: 'vanilla vs threshold law, Jev k, Jev called only above threshold' },
  { name: 'tgated', vanilla: 'v_tgated', comp: 'tgated', label: 'vanilla vs threshold law, Jev k degraded in 2nd half (gate arm)' },
] as const satisfies readonly { name: string; vanilla: Pool; comp: Pool; label: string }[];
export type Market = (typeof MARKETS)[number]['name'];

export interface PoolJson {
  poolId: Hex;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  hooked: boolean;
  kDefaultBps?: number;
  feeMax?: number;
  baseFee?: number;
  staleBlocks?: number;
  minSamples?: number;
  brierDemoteBps?: number;
  arbThresholdPips?: number;
}
export interface DeploymentV3 {
  poolManager: Address;
  hook: Address;
  splitSwapRouter: Address;
  currency0: Address;
  currency1: Address;
  wethIsToken0: boolean;
  pools: Record<Pool, PoolJson>;
}

export async function deployV3(
  anvil: Anvil,
  env: { initMid: number; liquidity: bigint; minSamples: number; staleBlocks: number; baseFee: number; thrPips: number; modelKStep: number },
): Promise<DeploymentV3> {
  const out = resolve(ROOT, 'deployments', `bench-v3-${anvil.port}.json`);
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = spawnSync('forge', ['script', 'script/bench/DeployBenchV3.s.sol', '--rpc-url', anvil.url, '--broadcast', '--private-key', ANVIL0_PK, '--slow'], {
      cwd: CONTRACTS_DIR,
      env: {
        ...process.env,
        LOCAL_PK: ANVIL0_PK,
        PRIVATE_KEY: ANVIL0_PK,
        DEPLOYER_PK: ANVIL0_PK,
        INIT_PRICE_USD_E8: String(Math.round(env.initMid * 1e8)),
        LIQUIDITY: env.liquidity.toString(),
        MIN_SAMPLES: String(env.minSamples),
        STALE_BLOCKS: String(env.staleBlocks),
        BASE_FEE: String(env.baseFee),
        ARB_THRESHOLD_PIPS: String(env.thrPips),
        MODEL_MAX_K_STEP_BPS: String(env.modelKStep),
        BENCH_OUT: out,
        MODEL_NODES: Object.values(NODES).join(','),
      },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 300_000,
    });
    if (r.status === 0 && existsSync(out)) break;
    log('deploy_failed', { attempt, tail: ((r.stdout ?? '') + '\n' + (r.stderr ?? '')).slice(-2000) });
    if (attempt === 3) throw new Error('bench v3 deploy failed');
    await sleep(5_000);
    await anvil.restart();
  }
  const d = JSON.parse(readFileSync(out, 'utf8')) as DeploymentV3;
  rmSync(out, { force: true });
  await anvil.rpc.call('evm_setAutomine', [false]);
  return d;
}
