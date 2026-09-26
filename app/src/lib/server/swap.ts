/**
 * Public "Swap" button: an exact-in swap on the Oniblock pool, signed server-side by a demo swapper so visitors need
 * no wallet or test ETH. Dev chains use anvil's public swapper key; Sepolia uses SWAPPER_PK from the root .env
 * (a throwaway key holding only test ETH; the pool tokens are freely mintable mocks).
 *
 * No size caps or per-client cooldown (local/demo use). One swap in flight at a time keeps the swapper's nonce simple.
 */
import 'server-only';
import { rpcTransport } from './env';
import { createWalletClient, maxUint256, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Ctx } from './chain';
import { ctx } from './chain';
import { devAccount } from './devkeys';
import { rootEnv } from './env';

const MIN_SQRT_PRICE = 4295128739n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

const erc20 = parseAbi([
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function mint(address,uint256)',
]);
const router = parseAbi([
  'function swap((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, address recipient) returns (int256)',
]);

export class SwapError extends Error {
  constructor(
    msg: string,
    readonly status = 400,
  ) {
    super(msg);
  }
}

function swapperKey(c: Ctx): Hex | undefined {
  if (process.env.APP_SWAP === '0') return undefined;
  const k = rootEnv('SWAPPER_PK');
  return k && !c.sel.isDev ? ((k.startsWith('0x') ? k : `0x${k}`) as Hex) : undefined;
}

export function swapEnabled(c: Ctx): boolean {
  return !!c.d.splitSwapRouter && process.env.APP_SWAP !== '0' && (c.sel.isDev || !!swapperKey(c));
}

let busy = false;

export interface PublicSwapReq {
  /** which token the user pays */
  pay: 'base' | 'quote';
  amount: number;
  client: string;
}

export async function publicSwap(req: PublicSwapReq): Promise<{ hash: Hex; zeroForOne: boolean; mirrorHash?: Hex }> {
  const c = await ctx();
  if (!swapEnabled(c)) throw new SwapError('swaps are disabled on this deployment', 403);
  if (req.pay !== 'base' && req.pay !== 'quote') throw new SwapError("pay must be 'base' or 'quote'");
  if (!(req.amount > 0) || !Number.isFinite(req.amount)) throw new SwapError('amount must be > 0');
  const payIsToken0 = (req.pay === 'base') === c.d.baseIsToken0;
  const zeroForOne = payIsToken0; // paying token0 = swapping 0 -> 1
  const tok = payIsToken0 ? c.d.token0 : c.d.token1;
  const amountIn = BigInt(Math.floor(req.amount * 10 ** Math.min(tok.decimals, 12))) * 10n ** BigInt(Math.max(0, tok.decimals - 12));
  // a tiny amount rounds to 0 raw units: that would send a real no-op tx (gas, no Receipt), so reject it
  if (amountIn <= 0n) throw new SwapError('amount too small');
  if (busy) throw new SwapError('another swap is being sent — try again in a few seconds', 429);
  busy = true;
  try {
    const key = swapperKey(c);
    const account = key ? privateKeyToAccount(key) : devAccount('swapper');
    const w = createWalletClient({ chain: c.sel.chain, account, transport: rpcTransport(c.sel) });
    const me = account.address as Address;
    const rtr = c.d.splitSwapRouter!;
    const wait = (hash: Hex) => c.pc.waitForTransactionReceipt({ hash, timeout: 90_000 });

    const [bal, al] = await Promise.all([
      c.pc.readContract({ address: tok.address, abi: erc20, functionName: 'balanceOf', args: [me] }) as Promise<bigint>,
      c.pc.readContract({ address: tok.address, abi: erc20, functionName: 'allowance', args: [me, rtr] }) as Promise<bigint>,
    ]);
    if (bal < amountIn) await wait(await w.writeContract({ address: tok.address, abi: erc20, functionName: 'mint', args: [me, amountIn * 1000n] }));
    if (al < amountIn) await wait(await w.writeContract({ address: tok.address, abi: erc20, functionName: 'approve', args: [rtr, maxUint256] }));

    const limit = zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n;
    const nonce = await c.pc.getTransactionCount({ address: me, blockTag: 'pending' });
    const args = [c.d.oniblock.key, zeroForOne, -amountIn, limit, me] as const;
    const { request } = await c.pc.simulateContract({ address: rtr, abi: router, functionName: 'swap', args, account });
    const hash = await w.writeContract({ ...request, nonce });
    // Mirror the same trade onto the plain (hookless) pool, so the LP chart compares both pools on identical flow and
    // the gap between the lines is only what the hook charged. Best effort: the Oniblock swap is already sent.
    let mirrorHash: Hex | undefined;
    if (c.d.vanilla) {
      try {
        const margs = [c.d.vanilla.key, zeroForOne, -amountIn, limit, me] as const;
        const m = await c.pc.simulateContract({ address: rtr, abi: router, functionName: 'swap', args: margs, account });
        mirrorHash = await w.writeContract({ ...m.request, nonce: nonce + 1 });
      } catch (e) {
        console.error('[swap] plain-pool mirror failed:', (e as Error).message.split('\n')[0]);
      }
    }
    return { hash, zeroForOne, mirrorHash };
  } catch (e) {
    if (e instanceof SwapError) throw e;
    throw new SwapError(`swap failed: ${(e as Error).message.split('\n')[0]}`, 500);
  } finally {
    busy = false;
  }
}
