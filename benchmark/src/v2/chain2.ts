/** v2 deployment: contracts/script/bench/DeployBenchV2.s.sol on a fresh anvil (reuses the v1 Anvil wrapper). */
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
} as const;
export const NODES = Object.fromEntries(Object.entries(NODE_NAMES).map(([k, v]) => [k, namehash(v)])) as Record<keyof typeof NODE_NAMES, Hex>;

export const POOLS = ['v_control_a', 'v_control_b', 'v_detox', 'detox', 'v_const', 'const', 'v_mjev', 'mjev', 'v_mheur', 'mheur', 'v_gated', 'gated'] as const;
export type Pool = (typeof POOLS)[number];
export const HOOKED = ['detox', 'const', 'mjev', 'mheur', 'gated'] as const satisfies readonly Pool[];
export type Hooked = (typeof HOOKED)[number];
export const MARKETS = [
  { name: 'control', vanilla: 'v_control_a', comp: 'v_control_b', label: 'vanilla 0.30% vs vanilla 0.30% (control; = fixed-fee competitor)' },
  { name: 'detox', vanilla: 'v_detox', comp: 'detox', label: 'vanilla vs Detox-style gap fee, k = 0.7' },
  { name: 'const', vanilla: 'v_const', comp: 'const', label: 'vanilla vs Oniblock law, constant k = 0.5' },
  { name: 'mjev', vanilla: 'v_mjev', comp: 'mjev', label: 'vanilla vs Oniblock law, Jev-tuned k (gated)' },
  { name: 'mheur', vanilla: 'v_mheur', comp: 'mheur', label: 'vanilla vs Oniblock law, heuristic-tuned k (gated)' },
  { name: 'gated', vanilla: 'v_gated', comp: 'gated', label: 'vanilla vs Oniblock law, Jev k degraded in 2nd half (gate arm)' },
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
  staleBlocks?: number;
  minSamples?: number;
  brierDemoteBps?: number;
}
export interface DeploymentV2 {
  poolManager: Address;
  hook: Address;
  splitSwapRouter: Address;
  currency0: Address;
  currency1: Address;
  wethIsToken0: boolean;
  pools: Record<Pool, PoolJson>;
}

export async function deployV2(anvil: Anvil, env: { initMid: number; liquidity: bigint; minSamples: number; staleBlocks: number }): Promise<DeploymentV2> {
  const out = resolve(ROOT, 'deployments', `bench-v2-${anvil.port}.json`);
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = spawnSync('forge', ['script', 'script/bench/DeployBenchV2.s.sol', '--rpc-url', anvil.url, '--broadcast', '--private-key', ANVIL0_PK, '--slow'], {
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
        BENCH_OUT: out,
        MODEL_NODES: Object.values(NODES).join(','),
        ARB_THRESHOLD_PIPS: '0', // v1/v2 law (premium from the first pip); v3 uses src/v3
      },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 300_000,
    });
    if (r.status === 0 && existsSync(out)) break;
    log('deploy_failed', { attempt, tail: ((r.stdout ?? '') + '\n' + (r.stderr ?? '')).slice(-2000) });
    if (attempt === 3) throw new Error('bench v2 deploy failed');
    await sleep(5_000);
    await anvil.restart();
  }
  const d = JSON.parse(readFileSync(out, 'utf8')) as DeploymentV2;
  rmSync(out, { force: true });
  await anvil.rpc.call('evm_setAutomine', [false]);
  return d;
}
