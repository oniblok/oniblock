/** v4 deployment: contracts/script/bench/DeployBenchV4.s.sol on a fresh anvil (reuses the v1 Anvil wrapper). */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { namehash, type Address, type Hex } from 'viem';
import { Anvil } from '../chain.js';
import { CONTRACTS_DIR, ROOT, log, sleep } from '../util.js';

const ANVIL0_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

export const NODE_NAMES = {
  const: 'const-k.models.oniblock.eth',
  ai: 'jev-v1.models.oniblock.eth',
  aiheur: 'heur-v1.models.oniblock.eth',
  aigated: 'jev-v1-gated.models.oniblock.eth',
  aidz: 'jev-v1-dz.models.oniblock.eth',
} as const;
export const NODES = Object.fromEntries(Object.entries(NODE_NAMES).map(([k, v]) => [k, namehash(v)])) as Record<keyof typeof NODE_NAMES, Hex>;

export const POOLS = [
  'v_control_a',
  'v_control_b',
  'v_v2k',
  'v2k',
  'v_thrk',
  'thrk',
  'v_ai',
  'ai',
  'v_aiheur',
  'aiheur',
  'v_aigated',
  'aigated',
  'v_aidz',
  'aidz',
] as const;
export type Pool = (typeof POOLS)[number];
export const HOOKED = ['v2k', 'thrk', 'ai', 'aiheur', 'aigated', 'aidz'] as const satisfies readonly Pool[];
export type Hooked = (typeof HOOKED)[number];
export const MODEL_POOLS = ['ai', 'aiheur', 'aigated', 'aidz'] as const satisfies readonly Hooked[];
export type ModelPool = (typeof MODEL_POOLS)[number];
export const MARKETS = [
  { name: 'control', vanilla: 'v_control_a', comp: 'v_control_b', label: 'vanilla vs vanilla (control)' },
  { name: 'v2k', vanilla: 'v_v2k', comp: 'v2k', label: '(a) v2 law, constant k = 0.5, no threshold (reference)' },
  { name: 'thrk', vanilla: 'v_thrk', comp: 'thrk', label: '(b) hard-coded threshold base + 0.03%, constant k = 0.5 (v3 reference)' },
  { name: 'ai', vanilla: 'v_ai', comp: 'ai', label: '(c) AI decides: Jev every block, threshold 0, kMin 0 (PRIMARY)' },
  { name: 'aiheur', vanilla: 'v_aiheur', comp: 'aiheur', label: '(d) same as (c) with the heuristic every block (no Jev)' },
  { name: 'aigated', vanilla: 'v_aigated', comp: 'aigated', label: '(e) same as (c), Jev degraded in the 2nd half (calibration-gate arm)' },
  { name: 'aidz', vanilla: 'v_aidz', comp: 'aidz', label: '(f) exploratory: (c) + proposed contract dead-zone on p*c (emulated by the keeper)' },
] as const satisfies readonly { name: string; vanilla: Pool; comp: Pool; label: string }[];
export type Market = (typeof MARKETS)[number]['name'];

export interface PoolJson {
  poolId: Hex;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  hooked: boolean;
  kMinBps?: number;
  kMaxBps?: number;
  kDefaultBps?: number;
  maxKStepBps?: number;
  feeMax?: number;
  baseFee?: number;
  staleBlocks?: number;
  brierDemoteBps?: number;
  arbThresholdPips?: number;
}
export interface DeploymentV4 {
  poolManager: Address;
  hook: Address;
  splitSwapRouter: Address;
  currency0: Address;
  currency1: Address;
  wethIsToken0: boolean;
  pools: Record<Pool, PoolJson>;
}

export async function deployV4(
  anvil: Anvil,
  env: { initMid: number; liquidity: bigint; staleBlocks: number; baseFee: number; thrPips: number; aiKMax: number; aiKStep: number; aiKDefault: number },
): Promise<DeploymentV4> {
  const out = resolve(ROOT, 'deployments', `bench-v4-${anvil.port}.json`);
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = spawnSync('forge', ['script', 'script/bench/DeployBenchV4.s.sol', '--rpc-url', anvil.url, '--broadcast', '--private-key', ANVIL0_PK, '--slow'], {
      cwd: CONTRACTS_DIR,
      env: {
        ...process.env,
        LOCAL_PK: ANVIL0_PK,
        PRIVATE_KEY: ANVIL0_PK,
        DEPLOYER_PK: ANVIL0_PK,
        INIT_PRICE_USD_E8: String(Math.round(env.initMid * 1e8)),
        LIQUIDITY: env.liquidity.toString(),
        STALE_BLOCKS: String(env.staleBlocks),
        BASE_FEE: String(env.baseFee),
        ARB_THRESHOLD_PIPS: String(env.thrPips),
        AI_K_MAX_BPS: String(env.aiKMax),
        AI_K_STEP_BPS: String(env.aiKStep),
        AI_K_DEFAULT_BPS: String(env.aiKDefault),
        BENCH_OUT: out,
        MODEL_NODES: Object.values(NODES).join(','),
      },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 300_000,
    });
    if (r.status === 0 && existsSync(out)) break;
    log('deploy_failed', { attempt, tail: ((r.stdout ?? '') + '\n' + (r.stderr ?? '')).slice(-2000) });
    if (attempt === 3) throw new Error('bench v4 deploy failed');
    await sleep(5_000);
    await anvil.restart();
  }
  const d = JSON.parse(readFileSync(out, 'utf8')) as DeploymentV4;
  rmSync(out, { force: true });
  await anvil.rpc.call('evm_setAutomine', [false]);
  return d;
}
