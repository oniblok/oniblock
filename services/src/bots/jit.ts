/**
 * JIT liquidity bot (v5 demo actor, docs/review/V5_JIT_HEAD_SPEC.md §3.5). Dev-chain actor on anvil key #8 (JIT_PK on
 * sepolia) that plays the opportunistic LP the adaptive window is meant to catch. Each cycle:
 *
 *   1. mint a narrow position centred on the current price (`jitRange`: [align(tick) - JIT_TICKS*spacing,
 *      align(tick) + (JIT_TICKS+1)*spacing], so the price is at least JIT_TICKS spacings from both edges and an arb
 *      swap does not fall off a liquidity cliff; size JIT_SIZE_USD) through the v4-core PoolModifyLiquidityTest router
 *      in deployments (`liquidityRouter`; the router is the position owner)
 *   2. one swap of JIT_SWAP_USD so the position earns fees — by default in the NON-arb direction (away from the
 *      keeper's attested mid, priced at the base fee): arb-direction swaps are graded by the settler and a fixed
 *      notional that overshoots the mid produces y=0 labels that wrongly demote the arb head. `--arb-dir` restores the
 *      old toward-the-mid swap. The reference mid is poolState.oracleMidX96 (the attestation in force = what the hook
 *      and settler call the arb direction), else the last AttestationPosted, else the CEX mid. Or, with --passive,
 *      wait for the next swap on the pool (retail / arb bot).
 *   3. remove the position after --hold N blocks (default 12: escapes the old fixed 10-block wall, caught by an
 *      adaptive window >= 13) and report whether the hook emitted JitPenalty (window, amounts)
 *   4. wait --every M blocks, repeat
 *
 * CLI: tsx src/bots/jit.ts [--chain local|fork|sepolia] [--pool NAME] [--hold N] [--every M] [--ticks T] [--size USD]
 *                         [--swap USD] [--arb-dir] [--passive] [--once] [--cycles N]
 * Env (defaults of the flags): JIT_HOLD (12), JIT_EVERY (30), JIT_TICKS (3), JIT_SIZE_USD (2000), JIT_SWAP_USD (5000),
 *      JIT_ARB_DIR (0; 1 = --arb-dir), JIT_PK (sepolia key; dev chains use anvil key #8).
 * Log lines (JSON): jit_start, jit_mint, jit_swap { zeroForOne, direction: 'arb'|'non-arb', midRef }, jit_remove,
 * jit_cycle { held, caught, window, penalty0, penalty1, escapedOldWall } — `caught && escapedOldWall` is the "caught by
 * the adaptive window" evidence story.ts looks for. Never crashes on a per-cycle error (logged, next cycle) nor on an
 * RPC hiccup while waiting for a block (`wait_error`, retried).
 */
import { padHex, parseEventLogs, toHex, type Address, type Hex, type PublicClient } from 'viem';
import { oniblockHookAbi, poolModifyLiquidityTestAbi, poolStateAbi } from '../abi/oniblockHook.js';
import { getAttestations, getReceipts, keyTuple, readPool, TxSender } from '../chain.js';
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
  sleep,
  type ChainName,
  type Deployment,
  type PairMeta,
  type PoolEntry,
} from '../config.js';
import { positionKey } from '../features.js';
import { arbZeroForOne, midToPriceX96, Q96, sqrtPriceX96ToPriceX96 } from '../price.js';
import { lazyMidSource } from '../pricesource.js';
import { usdPerRawToken1 } from '../settler.js';
import { ensureFunding, makeExecutor, MAX_SQRT_PRICE, MIN_SQRT_PRICE, type SwapExecutor } from './executor.js';

export interface JitOpts {
  chain: ChainName;
  poolName?: string;
  /** Blocks to hold the position (default JIT_HOLD / 12). */
  hold?: number;
  /** Blocks between cycles (default JIT_EVERY / 30). */
  every?: number;
  /** Half-width of the position in tick spacings (default JIT_TICKS / 3); see jitRange. */
  ticks?: number;
  sizeUsd?: number;
  swapUsd?: number;
  /** Swap toward the attested mid (the graded arb direction) instead of the default non-arb direction (--arb-dir / JIT_ARB_DIR=1). */
  arbDir?: boolean;
  /** Wait for someone else's swap instead of swapping ourselves. */
  passive?: boolean;
  cycles?: number;
  midSource?: (block?: number) => Promise<number>;
  deployment?: Deployment;
}

export interface JitCycleResult {
  cycle: number;
  salt: Hex;
  positionKey: Hex;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  mintBlock: number;
  mintTx?: Hex;
  swapTx?: Hex;
  swapBlock?: number;
  removeBlock: number;
  removeTx?: Hex;
  /** removeBlock - mintBlock */
  held: number;
  /** JitPenalty emitted by the hook on the remove. */
  caught: boolean;
  window?: number;
  addedBlock?: number;
  penalty0?: bigint;
  penalty1?: bigint;
  /** held >= 10: the old fixed wall (blockNumberOffset = 10) would NOT have penalised this position. */
  escapedOldWall: boolean;
}

/** sqrt(1.0001^tick) as a float (Q96-free). */
export const sqrtRatioAtTick = (tick: number) => Math.sqrt(1.0001 ** tick);

/**
 * Position range centred on the current price: lower = align(tick) - ticks*spacing, upper = align(tick) + (ticks+1)*spacing
 * with align = floor(tick / spacing) * spacing (so align <= tick < align + spacing). The price is therefore at least
 * ticks*spacing from BOTH edges — the old `±ticks` range around align put the price as little as 1 tick below the upper
 * edge, and an arb swap crossing it hit a liquidity cliff and overshot the mid.
 */
export function jitRange(tick: number, spacing: number, ticks: number): { tickLower: number; tickUpper: number } {
  const align = Math.floor(tick / spacing) * spacing;
  return { tickLower: align - ticks * spacing, tickUpper: align + (ticks + 1) * spacing };
}

/**
 * Swap direction for the fee-capture swap. The arb direction sells token0 iff the pool price is above the reference
 * mid (arbZeroForOne); the default is the OPPOSITE (non-arb, priced at the base fee, not graded by the settler).
 * pool == mid: the arb direction is undefined; sell token0 counts as "arb" (the old default), so non-arb = buy token0.
 */
export function jitSwapZeroForOne(poolX96: bigint, refMidX96: bigint, arbDir: boolean): boolean {
  const arb = arbZeroForOne(poolX96, refMidX96) ?? true;
  return arbDir ? arb : !arb;
}

/**
 * Liquidity L whose position value at the current price is ~`sizeUsd`:
 *   amount0 = L * (sqrtU - sqrtP) / (sqrtP * sqrtU), amount1 = L * (sqrtP - sqrtL)   (raw units)
 *   value (raw token1) = amount0 * P + amount1, P = sqrtP^2
 */
export function liquidityForUsd(sizeUsd: number, sqrtPriceX96: bigint, tickLower: number, tickUpper: number, meta: PairMeta): bigint {
  const sp = Number(sqrtPriceX96) / Number(Q96);
  const sl = sqrtRatioAtTick(tickLower);
  const su = sqrtRatioAtTick(tickUpper);
  const P = sp * sp;
  const amount0PerL = sp >= su ? 0 : sp <= sl ? (su - sl) / (sl * su) : (su - sp) / (sp * su);
  const amount1PerL = sp <= sl ? 0 : sp >= su ? su - sl : sp - sl;
  const value1PerL = amount0PerL * P + amount1PerL;
  const usd1 = usdPerRawToken1(meta, sqrtPriceX96ToPriceX96(sqrtPriceX96));
  if (!(value1PerL > 0) || usd1 === undefined || !(usd1 > 0)) return 0n;
  return BigInt(Math.floor(sizeUsd / (value1PerL * usd1)));
}

/** Exact-input amount (raw units of the token paid) worth `usd` at CEX mid `mid` (quote per base). */
export function amountInForUsd(usd: number, payToken0: boolean, meta: PairMeta, mid: number): bigint {
  const payIsBase = payToken0 === meta.baseIsToken0;
  const dec = payToken0 ? meta.decimals0 : meta.decimals1;
  const humanIn = payIsBase ? usd / mid : usd;
  return BigInt(Math.floor(humanIn * 10 ** Math.min(dec, 12))) * 10n ** BigInt(Math.max(0, dec - 12));
}

export class JitBot {
  readonly pc: PublicClient;
  readonly d: Deployment;
  readonly pool: PoolEntry;
  readonly meta: PairMeta;
  readonly router: Address;
  private readonly sender: TxSender;
  private readonly exec: SwapExecutor;
  private readonly isDev: boolean;
  private readonly midSource: (block?: number) => Promise<number>;
  private funded = false;
  private cycle = 0;

  constructor(private readonly o: JitOpts) {
    const sel = selectChain(o.chain);
    this.isDev = sel.isDev;
    this.pc = makePublicClient(sel);
    this.d = o.deployment ?? loadDeployment(sel.chain.id);
    this.pool = oniblockPool(this.d, o.poolName);
    this.meta = pairMeta(this.d, this.pool);
    if (!this.d.liquidityRouter) throw new Error(`deployments/${this.d.chainId}.json: no liquidityRouter (PoolModifyLiquidityTest) — redeploy with DeployBase`);
    this.router = this.d.liquidityRouter;
    this.sender = new TxSender(this.pc, makeWalletClient(sel, 'jit'), 'jit');
    this.exec = makeExecutor(this.sender, this.d);
    this.midSource = o.midSource ?? lazyMidSource(this.d.startBlock ?? 0, 'jit');
  }

  get address(): Address {
    return this.sender.address;
  }
  get hold(): number {
    return this.o.hold ?? envInt('JIT_HOLD', 12);
  }
  get every(): number {
    return this.o.every ?? envInt('JIT_EVERY', 30);
  }
  get ticks(): number {
    return Math.max(1, this.o.ticks ?? envInt('JIT_TICKS', 3));
  }
  get arbDir(): boolean {
    return this.o.arbDir ?? env('JIT_ARB_DIR', '0') === '1';
  }
  get sizeUsd(): number {
    return this.o.sizeUsd ?? Number(env('JIT_SIZE_USD', '2000'));
  }
  get swapUsd(): number {
    return this.o.swapUsd ?? Number(env('JIT_SWAP_USD', '5000'));
  }

  private async fund() {
    if (this.funded) return;
    const tokens = [this.pool.key.currency0, this.pool.key.currency1];
    const minBalance: Record<string, bigint> = {};
    for (const t of tokens) minBalance[t.toLowerCase()] = 10n ** BigInt(this.d.decimals[t.toLowerCase()] ?? 18) * 100_000n;
    await ensureFunding(this.pc, this.sender, tokens, [this.exec.router, this.router], { isDev: this.isDev, minBalance });
    this.funded = true;
  }

  private async head(): Promise<number> {
    return Number(await this.pc.getBlockNumber());
  }

  /**
   * Resolve once the chain head is >= target (polls; anvil mines on an interval, no subscriptions needed). Never
   * throws: an RPC error is logged as `wait_error` and retried after a short sleep (an hiccup must not kill the bot).
   */
  private async waitForBlock(target: number): Promise<number> {
    let errors = 0; // consecutive RPC failures (backoff), reset by a successful poll
    for (;;) {
      try {
        const h = await this.head();
        errors = 0;
        if (h >= target) return h;
      } catch (e) {
        errors++;
        log('jit', 'wait_error', { target, attempt: errors, error: (e as Error).message.split('\n')[0] });
        await sleep(Math.min(5_000, 500 * errors));
        continue;
      }
      await sleep(this.isDev ? 250 : 2_000);
    }
  }

  /**
   * Reference mid for the swap direction: the attestation in force (poolState.oracleMidX96 — what the hook and the
   * settler measure the arb direction against), else the last AttestationPosted, else undefined (caller uses the CEX mid).
   */
  private async attestedMidX96(head: number): Promise<{ midX96: bigint; midRef: 'poolState' | 'attestation' } | undefined> {
    try {
      const [st] = await this.pc.readContract({ address: this.d.hook, abi: poolStateAbi, functionName: 'poolState', args: [this.pool.poolId] });
      if (st.oracleMidX96 > 0n) return { midX96: st.oracleMidX96, midRef: 'poolState' };
    } catch {
      /* old hook / RPC trouble: fall through */
    }
    try {
      const at = await getAttestations(this.pc, this.d.hook, this.pool.poolId, BigInt(Math.max(0, head - 200)), BigInt(head));
      const last = at[at.length - 1];
      if (last && last.oracleMidX96 > 0n) return { midX96: last.oracleMidX96, midRef: 'attestation' };
    } catch {
      /* no attestation history readable */
    }
    return undefined;
  }

  private modifyLiquidity(tickLower: number, tickUpper: number, liquidityDelta: bigint, salt: Hex, label: string) {
    return this.sender.send({
      address: this.router,
      abi: poolModifyLiquidityTestAbi,
      functionName: 'modifyLiquidity',
      args: [keyTuple(this.pool.key), { tickLower, tickUpper, liquidityDelta, salt }, '0x'],
      label,
    });
  }

  /** One mint -> (swap | wait) -> remove cycle. Throws only on a failed mint (nothing to unwind). */
  async runCycle(): Promise<JitCycleResult> {
    await this.fund();
    const cycle = ++this.cycle;
    const st = await readPool(this.pc, this.d.poolManager, this.pool.poolId);
    const { tickLower, tickUpper } = jitRange(st.tick, this.pool.key.tickSpacing, this.ticks);
    const liquidity = liquidityForUsd(this.sizeUsd, st.sqrtPriceX96, tickLower, tickUpper, this.meta);
    if (liquidity <= 0n) throw new Error(`cannot size a ${this.sizeUsd} USD position at tick ${st.tick}`);
    const salt = padHex(toHex(BigInt(Date.now()) * 1_000n + BigInt(cycle)), { size: 32 });
    const key = positionKey(this.router, tickLower, tickUpper, salt);

    // 1. mint
    const mint = await this.modifyLiquidity(tickLower, tickUpper, liquidity, salt, `jit mint #${cycle}`);
    if (mint?.status !== 'success') throw new Error(`mint failed (cycle ${cycle})`);
    const mintBlock = Number(mint.blockNumber);
    log('jit', 'jit_mint', { cycle, block: mintBlock, tick: st.tick, tickLower, tickUpper, liquidity, sizeUsd: this.sizeUsd, positionKey: key, tx: mint.hash });

    // 2. fee capture: our own swap (non-arb direction unless --arb-dir), or someone else's
    let swapTx: Hex | undefined;
    let swapBlock: number | undefined;
    const removeAt = mintBlock + this.hold - 1; // send at hold-1 so the remove mines at mint + hold
    if (!this.o.passive) {
      try {
        const mid = await this.midSource(mintBlock); // CEX mid: sizes the notional, and the direction fallback
        const attested = await this.attestedMidX96(mintBlock);
        const refMidX96 = attested?.midX96 ?? midToPriceX96(mid.toFixed(8), this.meta);
        const midRef = attested?.midRef ?? 'cex';
        const P = sqrtPriceX96ToPriceX96(st.sqrtPriceX96);
        const arbDir = this.arbDir;
        const zeroForOne = jitSwapZeroForOne(P, refMidX96, arbDir);
        const amountIn = amountInForUsd(this.swapUsd, zeroForOne, this.meta, mid);
        const rc = await this.exec.swap(this.pool.key, zeroForOne, -amountIn, zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n);
        swapTx = rc?.hash;
        swapBlock = rc ? Number(rc.blockNumber) : undefined;
        log('jit', rc?.status === 'success' ? 'jit_swap' : 'jit_swap_failed', {
          cycle,
          block: swapBlock,
          zeroForOne,
          direction: arbDir ? 'arb' : 'non-arb',
          arbDir,
          midRef,
          refMidX96,
          poolX96: P,
          usd: this.swapUsd,
          amountIn,
          mid,
          tx: swapTx,
        });
      } catch (e) {
        log('jit', 'jit_swap_failed', { cycle, error: (e as Error).message.split('\n')[0] });
      }
    } else {
      // Wait for the first Receipt on our pool after the mint (bounded by the hold).
      let from = mintBlock;
      while ((await this.head()) < removeAt) {
        const h = await this.head();
        const rs = (await getReceipts(this.pc, this.d.hook, this.pool.poolId, BigInt(from), BigInt(h))).filter((r) => r.blockNumber >= mintBlock);
        if (rs.length) {
          swapTx = rs[0]!.txHash;
          swapBlock = rs[0]!.blockNumber;
          log('jit', 'jit_swap', { cycle, block: swapBlock, passive: true, sender: rs[0]!.sender, feePips: rs[0]!.feePips, tx: swapTx });
          break;
        }
        from = h + 1;
        await sleep(this.isDev ? 250 : 2_000);
      }
    }

    // 3. remove after the hold
    await this.waitForBlock(removeAt);
    const rm = await this.modifyLiquidity(tickLower, tickUpper, -liquidity, salt, `jit remove #${cycle}`);
    const removeBlock = rm ? Number(rm.blockNumber) : await this.head();
    let penalty: { window: number; addedBlock: number; penalty0: bigint; penalty1: bigint } | undefined;
    if (rm?.status === 'success' && rm.logs) {
      try {
        const ev = parseEventLogs({ abi: oniblockHookAbi, eventName: 'JitPenalty', logs: rm.logs, strict: false }).find(
          (l) => l.address.toLowerCase() === this.d.hook.toLowerCase(),
        );
        if (ev?.args.window !== undefined) penalty = { window: Number(ev.args.window), addedBlock: Number(ev.args.addedBlock), penalty0: ev.args.penalty0 ?? 0n, penalty1: ev.args.penalty1 ?? 0n };
      } catch {
        /* pre-v5 hook without JitPenalty: not caught */
      }
    }
    const held = removeBlock - mintBlock;
    const res: JitCycleResult = {
      cycle,
      salt,
      positionKey: key,
      tickLower,
      tickUpper,
      liquidity,
      mintBlock,
      mintTx: mint.hash,
      swapTx,
      swapBlock,
      removeBlock,
      removeTx: rm?.hash,
      held,
      caught: !!penalty,
      window: penalty?.window,
      addedBlock: penalty?.addedBlock,
      penalty0: penalty?.penalty0,
      penalty1: penalty?.penalty1,
      escapedOldWall: held >= 10,
    };
    log('jit', rm?.status === 'success' ? 'jit_remove' : 'jit_remove_failed', { cycle, block: removeBlock, held, tx: rm?.hash });
    log('jit', 'jit_cycle', {
      ...res,
      verdict: !penalty ? 'not penalised' : held >= 10 ? 'caught by the adaptive window (would have escaped a 10-block wall)' : 'caught (inside the old 10-block wall too)',
    });
    return res;
  }

  /** Run cycles until `cycles` (undefined = forever). */
  async run(): Promise<void> {
    log('jit', 'jit_start', {
      chain: this.o.chain,
      bot: this.address,
      pool: this.pool.name,
      liquidityRouter: this.router,
      swapRouter: this.exec.router,
      hold: this.hold,
      every: this.every,
      ticks: this.ticks,
      sizeUsd: this.sizeUsd,
      swapUsd: this.swapUsd,
      swapDirection: this.o.passive ? 'passive' : this.arbDir ? 'arb' : 'non-arb',
      passive: !!this.o.passive,
      cycles: this.o.cycles ?? 'forever',
    });
    for (let i = 0; this.o.cycles === undefined || i < this.o.cycles; i++) {
      let last: JitCycleResult | undefined;
      try {
        last = await this.runCycle();
      } catch (e) {
        log('jit', 'cycle_error', { cycle: this.cycle, error: (e as Error).message.split('\n')[0] });
      }
      if (this.o.cycles !== undefined && i + 1 >= this.o.cycles) break;
      // Inter-cycle wait: waitForBlock never throws (RPC errors -> wait_error + retry); waitForBlock(0) = the current
      // head, read with the same retry, for the case the cycle failed before it knew its remove block.
      const base = last?.removeBlock ?? (await this.waitForBlock(0));
      await this.waitForBlock(base + this.every);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = parseArgs();
  const bot = new JitBot({
    chain: (a.chain as ChainName) ?? (env('CHAIN', 'local') as ChainName),
    poolName: a.pool as string | undefined,
    hold: a.hold ? Number(a.hold) : undefined,
    every: a.every ? Number(a.every) : undefined,
    ticks: a.ticks ? Number(a.ticks) : undefined,
    sizeUsd: a.size ? Number(a.size) : undefined,
    swapUsd: a.swap ? Number(a.swap) : undefined,
    arbDir: a['arb-dir'] === true ? true : undefined,
    passive: a.passive === true,
    cycles: a.once ? 1 : a.cycles ? Number(a.cycles) : undefined,
  });
  await bot.run();
  if (a.once || a.cycles) process.exit(0);
}
