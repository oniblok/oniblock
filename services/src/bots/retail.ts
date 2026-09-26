/**
 * Retail noise flow: per block, K ~ Poisson(lambda) exact-input swaps with random direction
 * and log-normal USD size. Seeded PRNG so runs are replayable (fixed-seed demo cron).
 *
 * CLI: tsx src/bots/retail.ts [--chain local] [--pool NAME | --all] [--lambda 0.5]
 *                             [--usd 300] [--seed 42] [--once]
 */
import type { PublicClient } from 'viem';
import { lazyMidSource } from '../pricesource.js';
import {
  env,
  loadDeployment,
  log,
  makePublicClient,
  makeWalletClient,
  oniblockPool,
  pairMeta,
  parseArgs,
  selectChain,
  type ChainName,
  type Deployment,
  type PoolEntry,
} from '../config.js';
import { TxSender } from '../chain.js';
import { ensureFunding, makeExecutor, MAX_SQRT_PRICE, MIN_SQRT_PRICE, type SwapExecutor } from './executor.js';

/** mulberry32 PRNG. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function poisson(lambda: number, u: () => number): number {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= u();
  } while (p > L);
  return k - 1;
}

/** Log-normal with median `median` and sigma 0.8. */
export function lognormal(median: number, u: () => number, sigma = 0.8): number {
  const z = Math.sqrt(-2 * Math.log(Math.max(1e-12, u()))) * Math.cos(2 * Math.PI * u());
  return median * Math.exp(sigma * z);
}

export interface RetailOpts {
  chain: ChainName;
  pools?: string[];
  all?: boolean;
  lambda?: number;
  usdMedian?: number;
  seed?: number;
  midSource?: (block?: number) => Promise<number>;
  deployment?: Deployment;
}

export class RetailBot {
  readonly pc: PublicClient;
  readonly d: Deployment;
  private readonly sender: TxSender;
  private readonly exec: SwapExecutor;
  private readonly pools: PoolEntry[];
  private readonly u: () => number;
  private readonly isDev: boolean;
  private funded = false;
  private busy = false;
  private readonly midSource: (block?: number) => Promise<number>;

  constructor(private readonly o: RetailOpts) {
    const sel = selectChain(o.chain);
    this.isDev = sel.isDev;
    this.pc = makePublicClient(sel);
    this.d = o.deployment ?? loadDeployment(sel.chain.id);
    this.sender = new TxSender(this.pc, makeWalletClient(sel, 'retail'), 'retail');
    this.exec = makeExecutor(this.sender, this.d);
    this.pools = o.all ? this.d.pools : o.pools?.length ? this.d.pools.filter((p) => o.pools!.includes(p.name)) : [oniblockPool(this.d)];
    this.u = rng(o.seed ?? Number(env('RETAIL_SEED', '42')));
    this.midSource = o.midSource ?? lazyMidSource(this.d.startBlock ?? 0, 'retail');
  }

  private async fund() {
    if (this.funded) return;
    const tokens = [...new Set(this.pools.flatMap((p) => [p.key.currency0, p.key.currency1]))];
    const minBalance: Record<string, bigint> = {};
    for (const t of tokens) minBalance[t.toLowerCase()] = 10n ** BigInt(this.d.decimals[t.toLowerCase()] ?? 18) * 100_000n;
    await ensureFunding(this.pc, this.sender, tokens, [this.exec.router], { isDev: this.isDev, minBalance });
    this.funded = true;
  }

  async step(block?: number): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      await this.fund();
      const k = poisson(this.o.lambda ?? Number(env('RETAIL_LAMBDA', '0.5')), this.u);
      if (!k) return 0;
      const mid = await this.midSource(block ?? Number(await this.pc.getBlockNumber()));
      let done = 0;
      for (let i = 0; i < k; i++) {
        // Same random draws for every pool so vanilla vs Oniblock see identical retail flow.
        const usd = lognormal(this.o.usdMedian ?? Number(env('RETAIL_USD', '300')), this.u);
        const buyBase = this.u() < 0.5;
        for (const pool of this.pools) {
          const meta = pairMeta(this.d, pool);
          // Input token: buying base => pay quote; selling base => pay base.
          const payToken0 = buyBase ? !meta.baseIsToken0 : meta.baseIsToken0;
          const zeroForOne = payToken0; // paying token0 = selling token0
          const payIsBase = buyBase ? false : true;
          const dec = payToken0 ? meta.decimals0 : meta.decimals1;
          const humanIn = payIsBase ? usd / mid : usd;
          const amountIn = BigInt(Math.floor(humanIn * 10 ** Math.min(dec, 12))) * 10n ** BigInt(Math.max(0, dec - 12));
          if (amountIn <= 0n) continue;
          const rc = await this.exec.swap(pool.key, zeroForOne, -amountIn, zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n);
          if (rc?.status === 'success') done++;
          log('retail', rc?.status === 'success' ? 'swap' : 'swap_failed', { pool: pool.name, usd: Math.round(usd), buyBase, zeroForOne, amountIn, tx: rc?.hash });
        }
      }
      return done;
    } finally {
      this.busy = false;
    }
  }

  run(): () => void {
    log('retail', 'start', { pools: this.pools.map((p) => p.name), bot: this.sender.address });
    return this.pc.watchBlockNumber({
      emitMissed: false,
      onBlockNumber: (bn) => void this.step(Number(bn)).catch((e) => log('retail', 'step_error', { error: (e as Error).message.split('\n')[0] })),
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = parseArgs();
  const bot = new RetailBot({
    chain: (a.chain as ChainName) ?? (env('CHAIN', 'local') as ChainName),
    pools: typeof a.pool === 'string' ? a.pool.split(',') : undefined,
    all: a.all === true,
    lambda: a.lambda ? Number(a.lambda) : undefined,
    usdMedian: a.usd ? Number(a.usd) : undefined,
    seed: a.seed ? Number(a.seed) : undefined,
  });
  if (a.once) {
    console.log(await bot.step());
    process.exit(0);
  } else bot.run();
}
