/**
 * Swap execution abstraction for the bots.
 *  - PoolSwapTestExecutor: v4-core PoolSwapTest router (one swap per tx).
 *  - SplitRouterExecutor: SplitSwapRouter — single swaps and N sub-swaps in ONE tx (default).
 * Both need ERC20 approvals from the bot to the router; `ensureFunding` approves and, on dev
 * chains, mints MockERC20 balance if short.
 */
import { maxUint256, type Address, type PublicClient } from 'viem';
import { erc20Abi, poolSwapTestAbi, splitRouterAbi } from '../abi/oniblockHook.js';
import { log, type PoolKeyJson } from '../config.js';
import { keyTuple, TxSender } from '../chain.js';

export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

export type SwapResult = { hash: `0x${string}`; status: 'success' | 'reverted'; blockNumber: bigint; gasUsed: bigint } | null;

export interface SwapExecutor {
  readonly kind: string;
  readonly router: Address;
  /** amountSpecified < 0 = exact input (v4 convention). */
  swap(key: PoolKeyJson, zeroForOne: boolean, amountSpecified: bigint, sqrtPriceLimitX96: bigint): Promise<SwapResult>;
  /** N sub-swaps in one tx; each sub-swap gets 1/N of the amount and an interpolated limit. */
  splitSwap?(key: PoolKeyJson, zeroForOne: boolean, amountSpecified: bigint, sqrtPriceLimitX96: bigint, n: number): Promise<SwapResult>;
}

export class PoolSwapTestExecutor implements SwapExecutor {
  readonly kind = 'PoolSwapTest';
  constructor(
    private readonly sender: TxSender,
    readonly router: Address,
  ) {}
  swap(key: PoolKeyJson, zeroForOne: boolean, amountSpecified: bigint, sqrtPriceLimitX96: bigint) {
    return this.sender.send({
      address: this.router,
      abi: poolSwapTestAbi,
      functionName: 'swap',
      args: [keyTuple(key), { zeroForOne, amountSpecified, sqrtPriceLimitX96 }, { takeClaims: false, settleUsingBurn: false }, '0x'],
      label: 'swap',
    });
  }
}

/** contracts/src/periphery/SplitSwapRouter.sol: `swap` and `swapSplit` (N sub-swaps, one unlock, one tx). */
export class SplitRouterExecutor implements SwapExecutor {
  readonly kind = 'SplitSwapRouter';
  constructor(
    private readonly sender: TxSender,
    readonly router: Address,
  ) {}
  swap(key: PoolKeyJson, zeroForOne: boolean, amountSpecified: bigint, sqrtPriceLimitX96: bigint) {
    return this.sender.send({
      address: this.router,
      abi: splitRouterAbi,
      functionName: 'swap',
      args: [keyTuple(key), zeroForOne, amountSpecified, sqrtPriceLimitX96, this.sender.address],
      label: 'swap',
    });
  }
  splitSwap(key: PoolKeyJson, zeroForOne: boolean, amountSpecified: bigint, sqrtPriceLimitX96: bigint, n: number) {
    return this.sender.send({
      address: this.router,
      abi: splitRouterAbi,
      functionName: 'swapSplit',
      args: [keyTuple(key), zeroForOne, amountSpecified, BigInt(n), sqrtPriceLimitX96, this.sender.address],
      label: `swapSplit x${n}`,
    });
  }
}

/** Prefer SplitSwapRouter (what DeployLocal deploys); fall back to a PoolSwapTest router. */
export function makeExecutor(sender: TxSender, d: { splitRouter?: Address; swapRouter?: Address; chainId: number }): SwapExecutor {
  if (d.splitRouter) return new SplitRouterExecutor(sender, d.splitRouter);
  if (d.swapRouter) return new PoolSwapTestExecutor(sender, d.swapRouter);
  throw new Error(`deployments/${d.chainId}.json: no swap router (splitSwapRouter / swapRouter)`);
}

/** Approve `spender` for both pool tokens and (dev chains) mint if balance < minBalance. */
export async function ensureFunding(
  pc: PublicClient,
  sender: TxSender,
  tokens: Address[],
  spenders: Address[],
  opts: { isDev: boolean; minBalance?: Record<string, bigint> },
): Promise<void> {
  const me = sender.address;
  for (const t of tokens) {
    for (const sp of spenders) {
      const al = await pc.readContract({ address: t, abi: erc20Abi, functionName: 'allowance', args: [me, sp] });
      if (al < maxUint256 / 2n) {
        await sender.send({ address: t, abi: erc20Abi, functionName: 'approve', args: [sp, maxUint256], label: 'approve' });
      }
    }
    const min = opts.minBalance?.[t.toLowerCase()];
    if (opts.isDev && min !== undefined) {
      const bal = await pc.readContract({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [me] });
      if (bal < min) {
        const rc = await sender.send({ address: t, abi: erc20Abi, functionName: 'mint', args: [me, min * 10n], label: 'mint' });
        log('bot', rc ? 'minted' : 'mint_failed', { token: t, amount: min * 10n });
      }
    }
  }
}
