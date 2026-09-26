/**
 * Public "Swap" button: an exact-in swap on the Oniblock pool, signed server-side by a demo swapper so visitors need
 * no wallet or test ETH. Dev chains use anvil's public swapper key; Sepolia uses SWAPPER_PK from the root .env
 * (a throwaway key holding only test ETH; the pool tokens are freely mintable mocks).
 *
 * Abuse limits: size caps, one swap per client every 10 s, one in flight at a time (also keeps the nonce simple).
 */
import 'server-only';
import { createWalletClient, http, maxUint256, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Ctx } from './chain';
import { ctx } from './chain';
import { devAccount } from './devkeys';
import { rootEnv } from './env';

export const SWAP_LIMITS = { maxBase: 3, maxQuote: 10_000 };
const MIN_SQRT_PRICE = 4295128739n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
const COOLDOWN_MS = 10_000;

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
const lastByClient = new Map<string, number>();

export interface PublicSwapReq {
  /** which token the user pays */
  pay: 'base' | 'quote';
  amount: number;
  client: string;
}

export async function publicSwap(req: PublicSwapReq): Promise<{ hash: Hex; zeroForOne: boolean }> {
  const c = await ctx();
  if (!swapEnabled(c)) throw new SwapError('swaps are disabled on this deployment', 403);
  const max = req.pay === 'base' ? SWAP_LIMITS.maxBase : SWAP_LIMITS.maxQuote;
  if (!(req.amount > 0) || !Number.isFinite(req.amount)) throw new SwapError('amount must be > 0');
  if (req.amount > max) throw new SwapError(`max ${max} per swap`);
  const now = Date.now();
  const last = lastByClient.get(req.client) ?? 0;
  if (now - last < COOLDOWN_MS) throw new SwapError(`one swap every ${COOLDOWN_MS / 1000} s — try again in ${Math.ceil((COOLDOWN_MS - (now - last)) / 1000)} s`, 429);
  if (busy) throw new SwapError('another swap is being sent — try again in a few seconds', 429);
  busy = true;
  lastByClient.set(req.client, now);
  try {
    const key = swapperKey(c);
    const account = key ? privateKeyToAccount(key) : devAccount('swapper');
    const w = createWalletClient({ chain: c.sel.chain, account, transport: http(c.sel.rpcUrl) });
    const me = account.address as Address;
    const payIsToken0 = (req.pay === 'base') === c.d.baseIsToken0;
    const zeroForOne = payIsToken0; // paying token0 = swapping 0 -> 1
    const tok = payIsToken0 ? c.d.token0 : c.d.token1;
    const amountIn = BigInt(Math.floor(req.amount * 10 ** Math.min(tok.decimals, 12))) * 10n ** BigInt(Math.max(0, tok.decimals - 12));
    const rtr = c.d.splitSwapRouter!;
    const wait = (hash: Hex) => c.pc.waitForTransactionReceipt({ hash, timeout: 90_000 });

    const [bal, al] = await Promise.all([
      c.pc.readContract({ address: tok.address, abi: erc20, functionName: 'balanceOf', args: [me] }) as Promise<bigint>,
      c.pc.readContract({ address: tok.address, abi: erc20, functionName: 'allowance', args: [me, rtr] }) as Promise<bigint>,
    ]);
    if (bal < amountIn) await wait(await w.writeContract({ address: tok.address, abi: erc20, functionName: 'mint', args: [me, amountIn * 1000n] }));
    if (al < amountIn) await wait(await w.writeContract({ address: tok.address, abi: erc20, functionName: 'approve', args: [rtr, maxUint256] }));

    const args = [c.d.oniblock.key, zeroForOne, -amountIn, zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n, me] as const;
    const { request } = await c.pc.simulateContract({ address: rtr, abi: router, functionName: 'swap', args, account });
    const hash = await w.writeContract(request);
    return { hash, zeroForOne };
  } catch (e) {
    lastByClient.delete(req.client);
    if (e instanceof SwapError) throw e;
    throw new SwapError(`swap failed: ${(e as Error).message.split('\n')[0]}`, 500);
  } finally {
    busy = false;
  }
}
