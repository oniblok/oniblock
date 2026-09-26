import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toBytes, namehash } from 'viem';
import { ANVIL_KEYS } from '../src/config.js';
import { ATTESTATION_TYPEHASH, attestationDigest, recoverAttestor, signAttestation } from '../src/attest.js';

describe('EIP-712 attestation', () => {
  const attestor = privateKeyToAccount(ANVIL_KEYS[3]!);
  const hook = '0x00000000000000000000000000000000000044C0' as const;
  const fields = {
    poolId: keccak256(toBytes('pool')),
    blockNumber: 123n,
    oracleMidX96: 212345678901234567890123n,
    pToxicBps: 7000,
    confidenceBps: 5700,
    modelNode: namehash('jev-v1.models.oniblock.eth'),
  };

  it('typehash matches the documented type string', () => {
    expect(ATTESTATION_TYPEHASH).toBe(
      keccak256(toBytes('Attestation(bytes32 poolId,uint64 blockNumber,uint256 oracleMidX96,uint32 pToxicBps,uint32 confidenceBps,bytes32 modelNode)')),
    );
  });

  it('signs and recovers the attestor address', async () => {
    const a = await signAttestation(attestor, 31337, hook, fields);
    expect(a.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(await recoverAttestor(31337, hook, fields, a.signature)).toBe(attestor.address);
  });

  it('binds chainId, hook and every field', async () => {
    const a = await signAttestation(attestor, 31337, hook, fields);
    expect(await recoverAttestor(11155111, hook, fields, a.signature)).not.toBe(attestor.address);
    expect(await recoverAttestor(31337, '0x0000000000000000000000000000000000000001', fields, a.signature)).not.toBe(attestor.address);
    expect(await recoverAttestor(31337, hook, { ...fields, pToxicBps: 7001 }, a.signature)).not.toBe(attestor.address);
    expect(attestationDigest(31337, hook, fields)).not.toBe(attestationDigest(31337, hook, { ...fields, blockNumber: 124n }));
  });
});

describe('anvil role keys', () => {
  it('derive to the addresses DeployLocal configures', async () => {
    const { ANVIL_KEYS } = await import('../src/config.js');
    const want = ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', '0x90F79bf6EB2c4f870365E785982E1f101E93b906', '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc'];
    expect(ANVIL_KEYS.map((k) => privateKeyToAccount(k).address)).toEqual(want);
  });
});
