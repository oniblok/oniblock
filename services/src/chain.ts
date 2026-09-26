/**
 * On-chain helpers shared by keeper / settler / bots:
 *  - read pool slot0 + liquidity from the v4 PoolManager via extsload (StateLibrary layout)
 *  - fetch hook Receipt / AttestationPosted logs (chunked)
 *  - TxSender: local nonce management + simulate-before-send + retry
 */
import {
  encodeAbiParameters,
  keccak256,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  type ContractFunctionName,
  type ContractFunctionArgs,
} from 'viem';
import { oniblockHookAbi, poolManagerAbi } from './abi/oniblockHook.js';
import type { PoolKeyJson } from './config.js';
import { log, sleep } from './config.js';
import type { SwapObs } from './features.js';
import { Q96 } from './price.js';

/** v4-core StateLibrary: `mapping(PoolId => Pool.State) internal _pools` is at slot 6. */
export const POOLS_SLOT = 6n;
export const LIQUIDITY_OFFSET = 3n;

export function poolStateSlot(poolId: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolId, POOLS_SLOT]));
}

export interface PoolSlot0 {
  sqrtPriceX96: bigint;
  tick: number;
  lpFee: number;
  liquidity: bigint;
}

export async function readPool(pc: PublicClient, poolManager: Address, poolId: Hex, blockNumber?: bigint): Promise<PoolSlot0> {
  const base = poolStateSlot(poolId);
  const liqSlot = (`0x${(BigInt(base) + LIQUIDITY_OFFSET).toString(16).padStart(64, '0')}`) as Hex;
  const [s0, liq] = await Promise.all([
    pc.readContract({ address: poolManager, abi: poolManagerAbi, functionName: 'extsload', args: [base], blockNumber }),
    pc.readContract({ address: poolManager, abi: poolManagerAbi, functionName: 'extsload', args: [liqSlot], blockNumber }),
  ]);
  const w = BigInt(s0 as Hex);
  const sqrtPriceX96 = w & ((1n << 160n) - 1n);
  let tick = Number((w >> 160n) & 0xffffffn);
  if (tick >= 0x800000) tick -= 0x1000000;
  const lpFee = Number((w >> 208n) & 0xffffffn);
  const liquidity = BigInt(liq as Hex) & ((1n << 128n) - 1n);
  return { sqrtPriceX96, tick, lpFee, liquidity };
}

/** Virtual token0 reserve for the active range: L * 2^96 / sqrtP. */
export function virtualDepth0(p: PoolSlot0): bigint {
  return p.sqrtPriceX96 > 0n ? (p.liquidity * Q96) / p.sqrtPriceX96 : 0n;
}

export function keyTuple(k: PoolKeyJson) {
  return { currency0: k.currency0, currency1: k.currency1, fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks };
}

export interface ReceiptLog {
  poolId: Hex;
  blockNumber: number;
  sender: Address;
  zeroForOne: boolean;
  arbDir: boolean;
  gapPips: number;
  kBps: number;
  feePips: number;
  amount0: bigint;
  amount1: bigint;
  modelNode: Hex;
  stale: boolean;
  txHash: Hex;
  logIndex: number;
}

export interface AttestationLog {
  poolId: Hex;
  blockNumber: number; // attested block number (event field)
  minedBlock: number; // block in which the tx was mined
  oracleMidX96: bigint;
  pToxicBps: number;
  confidenceBps: number;
  kBps: number;
  modelNode: Hex;
  quoter: Address;
  txHash: Hex;
}

async function chunkedLogs<T>(
  from: bigint,
  to: bigint,
  step: bigint,
  fn: (a: bigint, b: bigint) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  for (let a = from; a <= to; a += step) {
    const b = a + step - 1n > to ? to : a + step - 1n;
    out.push(...(await fn(a, b)));
  }
  return out;
}

export async function getReceipts(pc: PublicClient, hook: Address, poolId: Hex | undefined, from: bigint, to: bigint, step = 5_000n) {
  return chunkedLogs(from, to, step, async (a, b) => {
    const logs = await pc.getContractEvents({
      address: hook,
      abi: oniblockHookAbi,
      eventName: 'Receipt',
      args: poolId ? { id: poolId } : undefined,
      fromBlock: a,
      toBlock: b,
    });
    return logs.map(
      (l): ReceiptLog => ({
        poolId: l.args.id!,
        blockNumber: Number(l.args.blockNumber!),
        sender: l.args.sender!,
        zeroForOne: l.args.zeroForOne!,
        arbDir: l.args.arbDir!,
        gapPips: Number(l.args.gapPips!),
        kBps: Number(l.args.kBps!),
        feePips: Number(l.args.feePips!),
        amount0: l.args.amount0!,
        amount1: l.args.amount1!,
        modelNode: l.args.modelNode!,
        stale: l.args.stale!,
        txHash: l.transactionHash!,
        logIndex: l.logIndex!,
      }),
    );
  });
}

export async function getAttestations(pc: PublicClient, hook: Address, poolId: Hex | undefined, from: bigint, to: bigint, step = 5_000n) {
  return chunkedLogs(from, to, step, async (a, b) => {
    const logs = await pc.getContractEvents({
      address: hook,
      abi: oniblockHookAbi,
      eventName: 'AttestationPosted',
      args: poolId ? { id: poolId } : undefined,
      fromBlock: a,
      toBlock: b,
    });
    return logs.map(
      (l): AttestationLog => ({
        poolId: l.args.id!,
        blockNumber: Number(l.args.blockNumber!),
        minedBlock: Number(l.blockNumber!),
        oracleMidX96: l.args.oracleMidX96!,
        pToxicBps: Number(l.args.pToxicBps!),
        confidenceBps: Number(l.args.confidenceBps!),
        kBps: Number(l.args.kBps!),
        modelNode: l.args.modelNode!,
        quoter: l.args.quoter!,
        txHash: l.transactionHash!,
      }),
    );
  });
}

export function receiptToSwapObs(r: ReceiptLog): SwapObs {
  return { block: r.blockNumber, zeroForOne: r.zeroForOne, amount0: r.amount0, amount1: r.amount1, fee: r.feePips, arbDir: r.arbDir };
}

/**
 * Sends contract writes from one account with a locally tracked nonce. Simulates first
 * (surfaces revert reasons without burning gas), retries transient failures, resyncs the
 * nonce on "nonce too low/high" errors. Never throws from `send` unless `throwOnError`.
 */
export class TxSender {
  private nonce: number | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly pc: PublicClient,
    private readonly wc: WalletClient<Transport, Chain, Account>,
    private readonly component: string,
  ) {}

  get address(): Address {
    return this.wc.account.address;
  }

  async resync() {
    this.nonce = await this.pc.getTransactionCount({ address: this.address, blockTag: 'pending' });
  }

  /**
   * Broadcast is serialised (nonce order); receipt waiting is concurrent so a slow block
   * doesn't stall the next send. Resolves to the mined result, or null on failure.
   */
  async send<const abi extends Abi, fn extends ContractFunctionName<abi, 'nonpayable' | 'payable'>>(req: {
    address: Address;
    abi: abi;
    functionName: fn;
    args: ContractFunctionArgs<abi, 'nonpayable' | 'payable', fn>;
    value?: bigint;
    label?: string;
    retries?: number;
    wait?: boolean;
    /** Called once the tx is broadcast (or failed to broadcast: null), before waiting for the receipt. */
    onBroadcast?: (hash: Hex | null) => void;
  }): Promise<{ hash: Hex; status: 'success' | 'reverted'; blockNumber: bigint; gasUsed: bigint } | null> {
    const label = req.label ?? String(req.functionName);
    const broadcast = async (): Promise<Hex | null> => {
      const retries = req.retries ?? 2;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          if (this.nonce === undefined) await this.resync();
          // Simulate against the pending block: that is the block the tx will (most likely) land in.
          const { request } = await this.pc.simulateContract({
            account: this.wc.account,
            address: req.address,
            abi: req.abi as Abi,
            functionName: req.functionName as string,
            args: req.args as readonly unknown[],
            value: req.value,
            blockTag: 'pending',
          } as any);
          const hash = await this.wc.writeContract({ ...(request as any), nonce: this.nonce });
          this.nonce!++;
          return hash;
        } catch (e) {
          const msg = (e as Error).message ?? String(e);
          const short = (e as { shortMessage?: string }).shortMessage ?? msg.split('\n')[0];
          const isRevert = /revert|ContractFunctionRevertedError/i.test(msg);
          log(this.component, 'tx_error', { label, attempt, revert: isRevert, error: short });
          this.nonce = undefined; // resync on next attempt (covers nonce too low/high)
          if (isRevert) return null; // deterministic; do not retry
          await sleep(300 * (attempt + 1));
        }
      }
      return null;
    };
    const p = this.queue.then(broadcast, broadcast);
    this.queue = p.catch(() => undefined);
    const hash = await p;
    req.onBroadcast?.(hash);
    if (!hash) return null;
    if (req.wait === false) return { hash, status: 'success', blockNumber: 0n, gasUsed: 0n };
    try {
      const rc = await this.pc.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 200 });
      if (rc.status !== 'success') log(this.component, 'tx_reverted', { label, hash, block: rc.blockNumber });
      return { hash, status: rc.status, blockNumber: rc.blockNumber, gasUsed: rc.gasUsed };
    } catch (e) {
      log(this.component, 'tx_wait_error', { label, hash, error: (e as Error).message.split('\n')[0] });
      this.nonce = undefined;
      return null;
    }
  }
}
