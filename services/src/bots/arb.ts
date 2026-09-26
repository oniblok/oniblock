/**
 * Rational arbitrageur. Each block, for each target pool:
 *   CEX mid (Binance) + pool price + current fee (hook.quoteFee for Oniblock pools, lpFee otherwise)
 *   -> trade to the edge of the no-trade band if profit > gas + ARB_MIN_PROFIT_USD.
 * `--split N` executes the trade as N sub-swaps in one tx via the router helper (tests the
 * per-block fee anchor). Falls back to N separate txs if no split router is deployed.
 *
 * CLI: tsx src/bots/arb.ts [--chain local] [--pool NAME | --all] [--split N] [--once]
 */
import type { Hex, PublicClient } from 'viem';
import { oniblockHookAbi } from '../abi/oniblockHook.js';
import { lazyMidSource } from '../pricesource.js';
import {
  env,
  envInt,
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
import { keyTuple, readPool, TxSender } from '../chain.js';
import { midToPriceX96, gapPips } from '../price.js';
import { planArb, splitLimits, token1ToUsd } from './arbMath.js';
import { ensureFunding, makeExecutor, type SwapExecutor } from './executor.js';

export interface ArbOpts {
  chain: ChainName;
  pools?: string[]; // names; default = oniblock pool
  all?: boolean;
  split?: number;
  /** Called with the observed block (PRICE_SOURCE=replay indexes the path by block). */
  midSource?: (block?: number) => Promise<number>;
  deployment?: Deployment;
  minProfitUsd?: number;
}

export interface ArbStepResult {
  pool: string;
  traded: boolean;
  reason?: string;
  zeroForOne?: boolean;
  feePips?: number;
  gapPips?: number;
  profitUsd?: number;
  hash?: Hex;
}

export class ArbBot {
  readonly pc: PublicClient;
  readonly d: Deployment;
  private readonly sender: TxSender;
  private readonly exec: SwapExecutor;
  private readonly pools: PoolEntry[];
  private readonly isDev: boolean;
  private funded = false;
  private busy = false;
  private readonly midSource: (block?: number) => Promise<number>;

  constructor(private readonly o: ArbOpts) {
    const sel = selectChain(o.chain);
    this.isDev = sel.isDev;
    this.pc = makePublicClient(sel);
    this.d = o.deployment ?? loadDeployment(sel.chain.id);
    this.sender = new TxSender(this.pc, makeWalletClient(sel, 'arb'), 'arb');
    this.exec = makeExecutor(this.sender, this.d);
    this.pools = o.all
      ? this.d.pools
      : o.pools?.length
        ? o.pools.map((n) => {
            const p = this.d.pools.find((x) => x.name === n);
            if (!p) throw new Error(`pool ${n} not in deployment`);
            return p;
          })
        : [oniblockPool(this.d)];
    this.midSource = o.midSource ?? lazyMidSource(this.d.startBlock ?? 0, 'arb');
  }

  private async fund() {
    if (this.funded) return;
    const tokens = [...new Set(this.pools.flatMap((p) => [p.key.currency0, p.key.currency1]))];
    const spenders = [this.exec.router];
    const minBalance: Record<string, bigint> = {};
    for (const t of tokens) minBalance[t.toLowerCase()] = 10n ** BigInt(this.d.decimals[t.toLowerCase()] ?? 18) * 1_000_000n;
    await ensureFunding(this.pc, this.sender, tokens, spenders, { isDev: this.isDev, minBalance });
    this.funded = true;
  }

  private async feeFor(pool: PoolEntry, zeroForOne: boolean, lpFee: number): Promise<{ fee: number; stale?: boolean }> {
    if (pool.key.hooks.toLowerCase() === this.d.hook.toLowerCase()) {
      const [fee, , , stale] = await this.pc.readContract({
        address: this.d.hook,
        abi: oniblockHookAbi,
        functionName: 'quoteFee',
        args: [keyTuple(pool.key), zeroForOne],
      });
      return { fee: Number(fee), stale };
    }
    // Static-fee pool: key.fee unless dynamic flag (0x800000), then slot0 lpFee.
    return { fee: pool.key.fee & 0x800000 ? lpFee : pool.key.fee };
  }

  async stepPool(pool: PoolEntry, mid: number, gasPrice: bigint): Promise<ArbStepResult> {
    const meta = pairMeta(this.d, pool);
    const st = await readPool(this.pc, this.d.poolManager, pool.poolId);
    const M = midToPriceX96(mid.toFixed(8), meta);
    const P = (st.sqrtPriceX96 * st.sqrtPriceX96) >> 96n;
    const zfo = P > M;
    const { fee, stale } = await this.feeFor(pool, zfo, st.lpFee);
    const plan = planArb({ sqrtPriceX96: st.sqrtPriceX96, liquidity: st.liquidity, oracleX96: M, feePips: fee });
    const gap = gapPips(P, M);
    if (!plan) return { pool: pool.name, traded: false, reason: 'in_band', feePips: fee, gapPips: gap };
    const n = Math.max(1, this.o.split ?? 1);
    const gasUnits = BigInt(envInt('ARB_GAS_PER_SWAP', 160_000)) * BigInt(n);
    const gasUsd = (Number(gasUnits * gasPrice) / 1e18) * mid;
    const profitUsd = token1ToUsd(plan.profitToken1, meta, mid);
    const minProfit = this.o.minProfitUsd ?? Number(env('ARB_MIN_PROFIT_USD', '0'));
    if (profitUsd <= gasUsd + minProfit) {
      return { pool: pool.name, traded: false, reason: 'unprofitable', feePips: fee, gapPips: gap, profitUsd };
    }
    // Exact input with a little slack; the price limit stops the swap at the band edge.
    const amountSpecified = -((plan.amountIn * 1005n) / 1000n);
    let rc;
    if (n > 1 && this.exec.splitSwap) {
      rc = await this.exec.splitSwap(pool.key, plan.zeroForOne, amountSpecified, plan.sqrtTargetX96, n);
    } else if (n > 1) {
      // No split router: N separate txs (NOT one tx — anchor still applies within a block only if mined together).
      const limits = splitLimits(st.sqrtPriceX96, plan.sqrtTargetX96, n);
      for (const lim of limits) rc = await this.exec.swap(pool.key, plan.zeroForOne, amountSpecified / BigInt(n), lim);
    } else {
      rc = await this.exec.swap(pool.key, plan.zeroForOne, amountSpecified, plan.sqrtTargetX96);
    }
    const res: ArbStepResult = {
      pool: pool.name,
      traded: rc?.status === 'success',
      reason: rc?.status === 'success' ? undefined : 'tx_failed',
      zeroForOne: plan.zeroForOne,
      feePips: fee,
      gapPips: gap,
      profitUsd,
      hash: rc?.hash,
    };
    log('arb', res.traded ? 'arb' : 'arb_failed', { ...res, mid, stale, split: n, amountIn: plan.amountIn, block: rc?.blockNumber });
    return res;
  }

  /** One pass over all pools at CEX mid for `block` (default: current head). */
  async step(block?: number): Promise<ArbStepResult[]> {
    if (this.busy) return [];
    this.busy = true;
    try {
      await this.fund();
      const bn = block ?? Number(await this.pc.getBlockNumber());
      const [mid, gasPrice] = await Promise.all([this.midSource(bn), this.pc.getGasPrice()]);
      const out: ArbStepResult[] = [];
      for (const p of this.pools) {
        try {
          out.push(await this.stepPool(p, mid, gasPrice));
        } catch (e) {
          log('arb', 'pool_error', { pool: p.name, error: (e as Error).message.split('\n')[0] });
        }
      }
      return out;
    } finally {
      this.busy = false;
    }
  }

  run(): () => void {
    log('arb', 'start', { pools: this.pools.map((p) => p.name), bot: this.sender.address, exec: this.exec.kind, split: this.o.split ?? 1 });
    return this.pc.watchBlockNumber({
      emitOnBegin: true,
      emitMissed: false,
      onBlockNumber: (bn) => void this.step(Number(bn)).catch((e) => log('arb', 'step_error', { error: (e as Error).message.split('\n')[0] })),
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = parseArgs();
  const bot = new ArbBot({
    chain: (a.chain as ChainName) ?? (env('CHAIN', 'local') as ChainName),
    pools: typeof a.pool === 'string' ? a.pool.split(',') : undefined,
    all: a.all === true,
    split: a.split ? Number(a.split) : undefined,
  });
  if (a.once) {
    console.log(JSON.stringify(await bot.step(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    process.exit(0);
  } else bot.run();
}
