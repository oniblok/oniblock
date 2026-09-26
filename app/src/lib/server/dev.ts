/**
 * Dev-only actions (local anvil 31337 or an anvil fork). Signed server-side with anvil's PUBLIC default
 * keys (devkeys.ts); refused on any non-dev chain. Nothing here runs in the browser.
 */
import 'server-only';
import { createWalletClient, http, maxUint256, parseAbi, type Address, type Hex } from 'viem';
import { ctx, tryRead, type Ctx } from './chain';
import { backupQuoterAddress, devAccount, type DevRole } from './devkeys';
import { readFlags, writeFlags } from './flags';
import { order } from './live';
import { priceX96ToMid, sqrtPriceX96ToPriceX96 } from './shared';

const MIN_SQRT_PRICE = 4295128739n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

const erc20 = parseAbi([
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function mint(address,uint256)',
]);
const mockOracle = parseAbi(['function setQuoter(address,bool)', 'function isQuoter(address) view returns (bool)']);
const ensRegistry = parseAbi([
  'function grantRoles(uint256 anyId, uint256 roleBitmap, address account) returns (bool)',
  'function revokeRoles(uint256 anyId, uint256 roleBitmap, address account) returns (bool)',
]);
const splitRouter = parseAbi([
  'function swap((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, address recipient) returns (int256)',
]);

export class DevError extends Error {
  constructor(
    msg: string,
    readonly status = 400,
  ) {
    super(msg);
  }
}

export async function devCtx(): Promise<Ctx> {
  if (process.env.APP_DEV_CONTROLS === '0') throw new DevError('dev controls disabled (APP_DEV_CONTROLS=0)', 403);
  const c = await ctx();
  if (!c.sel.isDev) throw new DevError('dev controls are only available on local anvil or an anvil fork', 403);
  const id = await c.pc.getChainId();
  if (c.sel.name === 'local' && id !== 31337) throw new DevError(`CHAIN=local but RPC chainId is ${id}`, 403);
  return c;
}

function wallet(c: Ctx, role: DevRole) {
  return createWalletClient({ chain: c.sel.chain, account: devAccount(role), transport: http(c.sel.rpcUrl) });
}

async function send(c: Ctx, role: DevRole, req: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }): Promise<{ hash: Hex; status: string; block: number }> {
  const w = wallet(c, role);
  const { request } = await c.pc.simulateContract({ ...(req as object), account: w.account } as never);
  const hash = await w.writeContract(request as never);
  const rc = await c.pc.waitForTransactionReceipt({ hash, timeout: 30_000 });
  return { hash, status: rc.status, block: Number(rc.blockNumber) };
}

// ------------------------------------------------------------------------------------------ swap

export interface SwapReq {
  direction: 'arb' | 'reverse';
  /** size in base-token units (e.g. ETH) */
  size: number;
  target?: 'both' | 'oniblock' | 'vanilla';
}

export async function devSwap(req: SwapReq) {
  const c = await devCtx();
  if (!c.d.splitSwapRouter) throw new DevError('deployment has no splitSwapRouter');
  if (!(req.size > 0) || !Number.isFinite(req.size)) throw new DevError('size must be > 0');
  const o = order(c);
  const id = c.d.oniblock.poolId;
  const ps = await tryRead<readonly [Record<string, unknown>, Record<string, unknown>, boolean]>(c, 'poolState', [id]);
  const midX96 = BigInt((ps?.[0]?.oracleMidX96 as bigint | undefined) ?? 0n);
  if (midX96 === 0n) throw new DevError('no attested oracle mid yet (is the keeper running?)');
  const s0 = (await c.pc.readContract({ address: c.d.stateView!, abi: c.stateViewAbi, functionName: 'getSlot0', args: [id] })) as readonly [bigint];
  const poolX96 = sqrtPriceX96ToPriceX96(s0[0]);
  // Arb direction per the fee law: the swap that moves the pool toward the oracle mid.
  const arbZeroForOne = poolX96 === midX96 ? true : poolX96 > midX96;
  const zeroForOne = req.direction === 'arb' ? arbZeroForOne : !arbZeroForOne;
  const mid = priceX96ToMid(midX96, o);
  // paying token0 when zeroForOne. Convert the base-denominated size into the input token.
  const payToken = zeroForOne ? c.d.token0 : c.d.token1;
  const payIsBase = zeroForOne === c.d.baseIsToken0;
  const human = payIsBase ? req.size : req.size * mid;
  const amountIn = BigInt(Math.floor(human * 10 ** Math.min(payToken.decimals, 12))) * 10n ** BigInt(Math.max(0, payToken.decimals - 12));

  const me = devAccount('swapper').address;
  const bal = (await c.pc.readContract({ address: payToken.address, abi: erc20, functionName: 'balanceOf', args: [me] })) as bigint;
  const targets = req.target ?? 'both';
  const pools = [
    ...(targets !== 'vanilla' ? [c.d.oniblock] : []),
    ...(targets !== 'oniblock' && c.d.vanilla ? [c.d.vanilla] : []),
  ];
  if (bal < amountIn * BigInt(pools.length)) {
    await send(c, 'swapper', { address: payToken.address, abi: erc20, functionName: 'mint', args: [me, amountIn * BigInt(pools.length) * 10n] });
  }
  const al = (await c.pc.readContract({ address: payToken.address, abi: erc20, functionName: 'allowance', args: [me, c.d.splitSwapRouter] })) as bigint;
  if (al < amountIn * BigInt(pools.length)) {
    await send(c, 'swapper', { address: payToken.address, abi: erc20, functionName: 'approve', args: [c.d.splitSwapRouter, maxUint256] });
  }
  const quoted = await tryRead<readonly [number, boolean, number, boolean]>(c, 'quoteFee', [c.d.oniblock.key, zeroForOne]);
  const results = [];
  for (const p of pools) {
    const r = await send(c, 'swapper', {
      address: c.d.splitSwapRouter,
      abi: splitRouter,
      functionName: 'swap',
      args: [p.key, zeroForOne, -amountIn, zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n, me],
    });
    results.push({ pool: p.name, ...r });
  }
  return {
    zeroForOne,
    direction: req.direction,
    arbDirection: zeroForOne === arbZeroForOne,
    amountIn: amountIn.toString(),
    payToken: payToken.symbol,
    quotedFeePips: quoted ? Number(quoted[0]) : null,
    quotedGapPips: quoted ? Number(quoted[2]) : null,
    results,
  };
}

// ------------------------------------------------------------------------------------------ keeper flags

export async function devDegrade(degraded: boolean) {
  await devCtx();
  return writeFlags({ degraded });
}

// ------------------------------------------------------------------------------------------ quoter role

export type QuoterAction = 'revoke' | 'grant-backup' | 'restore';

export async function devQuoter(action: QuoterAction) {
  const c = await devCtx();
  const quoter = c.d.quoter;
  if (!quoter) throw new DevError('deployment has no quoter address');
  const backup = backupQuoterAddress();
  const oracle = ((await tryRead<Address>(c, 'roleOracle', [])) ?? c.d.roleOracle)!;
  const useEns = !!c.ens?.registry && !!c.ens.roleOracle && c.ens.roleOracle.toLowerCase() === oracle.toLowerCase();
  const txs: { what: string; hash: Hex; status: string }[] = [];

  const setRole = async (who: Address, on: boolean) => {
    if (useEns) {
      // ENSv2: owner grants/revokes ROLE_QUOTER on quoter.<name> in our UserRegistry (docs/ENS_INTEGRATION.md §3).
      const owner = devAccount('owner').address;
      if (c.ens!.owner && c.ens!.owner.toLowerCase() !== owner.toLowerCase()) {
        throw new DevError(`ENS owner ${c.ens!.owner} is not the anvil dev key; cannot sign on this fork`);
      }
      const r = await send(c, 'owner', {
        address: c.ens!.registry!,
        abi: ensRegistry,
        functionName: on ? 'grantRoles' : 'revokeRoles',
        args: [BigInt(c.ens!.quoterLabelId!), BigInt(c.ens!.roleQuoter!), who],
      });
      txs.push({ what: `ENS ${on ? 'grantRoles' : 'revokeRoles'}(quoter, ROLE_QUOTER, ${who})`, hash: r.hash, status: r.status });
    } else {
      const r = await send(c, 'owner', { address: oracle, abi: mockOracle, functionName: 'setQuoter', args: [who, on] });
      txs.push({ what: `MockRoleOracle.setQuoter(${who}, ${on})`, hash: r.hash, status: r.status });
    }
  };

  if (action === 'revoke') {
    await setRole(quoter, false);
  } else if (action === 'grant-backup') {
    await setRole(backup, true);
    writeFlags({ useBackupQuoter: true });
  } else {
    await setRole(quoter, true);
    if (backup.toLowerCase() !== quoter.toLowerCase()) await setRole(backup, false).catch(() => undefined);
    writeFlags({ useBackupQuoter: false });
  }
  return { action, mechanism: useEns ? 'ensv2' : 'mock', quoter, backup, txs, flags: readFlags() };
}
