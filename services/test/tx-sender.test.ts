import { describe, expect, it } from 'vitest';
import { parseGwei, type Account, type Chain, type PublicClient, type Transport, type WalletClient } from 'viem';
import { parsePriorityGwei, TxSender } from '../src/chain.js';
import { keeperPriorityFeeWei } from '../src/keeper.js';

describe('priority fee (KEEPER_PRIORITY_GWEI)', () => {
  it('parses gwei decimals; unset = undefined (viem default); invalid throws', () => {
    expect(parsePriorityGwei(undefined)).toBeUndefined();
    expect(parsePriorityGwei('')).toBeUndefined();
    expect(parsePriorityGwei('2')).toBe(2_000_000_000n);
    expect(parsePriorityGwei('0.5')).toBe(500_000_000n);
    expect(parsePriorityGwei('0')).toBe(0n);
    expect(parsePriorityGwei('0.000000001')).toBe(1n);
    for (const bad of ['-1', 'x', '1e9', '0.0000000001']) expect(() => parsePriorityGwei(bad, 'KEEPER_PRIORITY_GWEI')).toThrow(/KEEPER_PRIORITY_GWEI/);
    expect(keeperPriorityFeeWei(undefined)).toBeUndefined();
    expect(keeperPriorityFeeWei('2')).toBe(parseGwei('2'));
  });
});

/** Minimal fake clients: capture what TxSender hands to writeContract. */
function fakes() {
  const writes: Record<string, unknown>[] = [];
  const pc = {
    getTransactionCount: async () => 7,
    simulateContract: async (a: Record<string, unknown>) => ({ request: { address: a.address, abi: a.abi, functionName: a.functionName, args: a.args, account: a.account } }),
    estimateContractGas: async () => 100_000n,
    waitForTransactionReceipt: async () => ({ status: 'success', blockNumber: 11n, gasUsed: 90_000n, logs: [], transactionIndex: 0 }),
  } as unknown as PublicClient;
  const wc = {
    account: { address: '0x00000000000000000000000000000000000000aa' },
    writeContract: async (r: Record<string, unknown>) => (writes.push(r), '0x' + '11'.repeat(32)),
  } as unknown as WalletClient<Transport, Chain, Account>;
  return { pc, wc, writes };
}
const req = { address: '0x00000000000000000000000000000000000000bb' as const, abi: [{ type: 'function', name: 'f', inputs: [], outputs: [], stateMutability: 'nonpayable' }] as const, functionName: 'f' as const, args: [] as const };

describe('TxSender fees', () => {
  it('default: no fee fields (viem estimates them, today\'s behaviour)', async () => {
    const { pc, wc, writes } = fakes();
    const rc = await new TxSender(pc, wc, 't').send(req);
    expect(writes[0]).not.toHaveProperty('maxPriorityFeePerGas');
    expect(writes[0]).not.toHaveProperty('maxFeePerGas');
    expect(writes[0]).toMatchObject({ nonce: 7, gas: 150_000n });
    expect(rc).toMatchObject({ status: 'success', blockNumber: 11n, txIndex: 0 });
  });
  it('priorityFeeWei: maxPriorityFeePerGas on every tx (maxFeePerGas left to viem: 1.2 x base + tip)', async () => {
    const { pc, wc, writes } = fakes();
    const s = new TxSender(pc, wc, 't', { priorityFeeWei: parseGwei('2') });
    await s.send(req);
    await s.send(req);
    expect(writes.map((w) => w.maxPriorityFeePerGas)).toEqual([2_000_000_000n, 2_000_000_000n]);
    expect(writes[0]).not.toHaveProperty('maxFeePerGas');
    expect(writes.map((w) => w.nonce)).toEqual([7, 8]);
  });
});
