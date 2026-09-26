/**
 * Fresh anvil per run (dedicated port, deterministic: automine OFF after deploy, blocks mined manually) and the
 * benchmark deployment (contracts/script/bench/DeployBench.s.sol).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { namehash, type Address, type Hex } from 'viem';
import { CONTRACTS_DIR, ROOT, Rpc, log, sleep } from './util.js';

/** Anvil dev key #0 (public, well-known; local chain only). */
const ANVIL0_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
/** Anvil dev key #3 = attestor (TEE stand-in) — public dev key, local only. */
export const ATTESTOR_PK: Hex = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
export const ACTOR: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // anvil #1: quoter + settler + trader

export const MODEL_NAMES = {
  const: 'const-k.models.oniblock.eth',
  model: 'jev-v1.models.oniblock.eth',
  gated: 'jev-v1-gated.models.oniblock.eth',
} as const;
export const MODEL_NODES = {
  const: namehash(MODEL_NAMES.const),
  model: namehash(MODEL_NAMES.model),
  gated: namehash(MODEL_NAMES.gated),
} as const;

export interface BenchPoolJson {
  poolId: Hex;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  hooked: boolean;
  kMinBps?: number;
  kMaxBps?: number;
  kDefaultBps?: number;
  brierDemoteBps?: number;
  baseFee?: number;
  feeMax?: number;
}

export interface BenchDeployment {
  chainId: number;
  poolManager: Address;
  hook: Address;
  roleOracle: Address;
  splitSwapRouter: Address;
  actor: Address;
  attestor: Address;
  currency0: Address;
  currency1: Address;
  wethIsToken0: boolean;
  sqrtPriceX96: string | number;
  liquidity: string | number;
  pools: Record<'fixed' | 'detox' | 'const' | 'model' | 'gated', BenchPoolJson>;
}

export class Anvil {
  proc?: ChildProcess;
  readonly rpc: Rpc;
  constructor(readonly port: number) {
    this.rpc = new Rpc(`http://127.0.0.1:${port}`);
  }
  get url() {
    return this.rpc.url;
  }

  private async up(): Promise<boolean> {
    try {
      await this.rpc.call('eth_chainId');
      return true;
    } catch {
      return false;
    }
  }

  async start() {
    if (await this.up()) throw new Error(`port ${this.port} already serves an RPC; pick another --port`);
    this.proc = spawn(
      'anvil',
      ['--port', String(this.port), '--chain-id', '31337', '--silent', '--base-fee', '0', '--gas-price', '0', '--gas-limit', '4000000000', '--order', 'fifo', '--prune-history'],
      { stdio: 'ignore' },
    );
    for (let i = 0; i < 100; i++) {
      if (await this.up()) return;
      await sleep(100);
    }
    throw new Error('anvil did not start');
  }

  stop() {
    if (this.proc && !this.proc.killed) this.proc.kill('SIGTERM');
  }

  async restart() {
    this.stop();
    for (let i = 0; i < 50 && (await this.up()); i++) await sleep(100);
    await this.start();
  }
}

/** Deploy with automine ON (forge waits for receipts), then switch automine OFF for the replay. */
export async function deployBench(anvil: Anvil, initialMid: number, liquidity: bigint): Promise<BenchDeployment> {
  const out = resolve(ROOT, 'deployments', `bench-${anvil.port}.json`);
  const script = 'script/bench/DeployBench.s.sol';
  const t0 = Date.now();
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = spawnSync('forge', ['script', script, '--rpc-url', anvil.url, '--broadcast', '--private-key', ANVIL0_PK, '--slow'], {
      cwd: CONTRACTS_DIR,
      env: {
        ...process.env,
        // Local anvil keys only; overrides any sepolia key in the environment for this child.
        LOCAL_PK: ANVIL0_PK,
        PRIVATE_KEY: ANVIL0_PK,
        DEPLOYER_PK: ANVIL0_PK,
        INIT_PRICE_USD_E8: String(Math.round(initialMid * 1e8)),
        LIQUIDITY: liquidity.toString(),
        BENCH_OUT: out,
        MODEL_NODES: Object.values(MODEL_NODES).join(','),
        ARB_THRESHOLD_PIPS: '0', // v1/v2 law (premium from the first pip); v3 uses src/v3
      },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 300_000, // a broadcast that stalls (seen once: nonce gap on anvil) is retried on a fresh anvil
    });
    if (r.status === 0 && existsSync(out)) break;
    const tail = ((r.stdout ?? '') + '\n' + (r.stderr ?? '')).slice(-3000);
    log('deploy_failed', { attempt, timedOut: !!r.error, tail });
    // Another agent may be editing contracts/src concurrently: wait for the build to settle and retry.
    if (attempt === 5) throw new Error('bench deploy failed (see log)');
    await sleep(r.error ? 1_000 : 30_000);
    await anvil.restart(); // drop any half-broadcast state
  }
  const d = JSON.parse(readFileSync(out, 'utf8')) as BenchDeployment;
  rmSync(out, { force: true });
  await anvil.rpc.call('evm_setAutomine', [false]);
  log('deployed', { hook: d.hook, ms: Date.now() - t0 });
  return d;
}
