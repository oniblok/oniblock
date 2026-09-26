import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { concat, encodeAbiParameters, keccak256, namehash, toBytes, verifyTypedData } from 'viem';
import { ANVIL_KEYS, ROLE_INDEX } from '../src/config.js';
import { ATTESTATION_TYPEHASH, ATTESTATION_TYPES, ATTESTATION_TYPE_STRING, attestationDigest, attestationDomain, recoverAttestor, signAttestation } from '../src/attest.js';

describe('EIP-712 attestation (v5: pJitBps before modelNode)', () => {
  const attestor = privateKeyToAccount(ANVIL_KEYS[3]!);
  const hook = '0x00000000000000000000000000000000000044C0' as const;
  const fields = {
    poolId: keccak256(toBytes('pool')),
    blockNumber: 123n,
    oracleMidX96: 212345678901234567890123n,
    pToxicBps: 7000,
    confidenceBps: 5700,
    pJitBps: 2500,
    modelNode: namehash('jev-v1.models.oniblock.eth'),
  };

  it('type string is exactly the spec §2.1 string and the typehash its keccak', () => {
    expect(ATTESTATION_TYPE_STRING).toBe(
      'Attestation(bytes32 poolId,uint64 blockNumber,uint256 oracleMidX96,uint32 pToxicBps,uint32 confidenceBps,uint32 pJitBps,bytes32 modelNode)',
    );
    expect(ATTESTATION_TYPEHASH).toBe(keccak256(toBytes(ATTESTATION_TYPE_STRING)));
    expect(ATTESTATION_TYPES.Attestation.map((f) => `${f.type} ${f.name}`)).toEqual([
      'bytes32 poolId', 'uint64 blockNumber', 'uint256 oracleMidX96', 'uint32 pToxicBps', 'uint32 confidenceBps', 'uint32 pJitBps', 'bytes32 modelNode',
    ]);
  });

  it('digest = keccak(0x1901 || domainSeparator || structHash), computed by hand (independent of viem typed data)', () => {
    // Mirrors OniblockHook: _hashTypedDataV4(keccak256(abi.encode(ATTESTATION_TYPEHASH, poolId, ..., pJitBps, modelNode)))
    const domainTypehash = keccak256(toBytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
        [domainTypehash, keccak256(toBytes('Oniblock')), keccak256(toBytes('1')), 31337n, hook],
      ),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint64' }, { type: 'uint256' }, { type: 'uint32' }, { type: 'uint32' }, { type: 'uint32' }, { type: 'bytes32' }],
        [ATTESTATION_TYPEHASH, fields.poolId, fields.blockNumber, fields.oracleMidX96, fields.pToxicBps, fields.confidenceBps, fields.pJitBps, fields.modelNode],
      ),
    );
    expect(attestationDigest(31337, hook, fields)).toBe(keccak256(concat(['0x1901', domainSeparator, structHash])));
  });

  it('signs and recovers the attestor; the on-chain struct carries pJitBps in position 5 (before modelNode)', async () => {
    const a = await signAttestation(attestor, 31337, hook, fields);
    expect(a.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(Object.keys(a)).toEqual(['blockNumber', 'oracleMidX96', 'pToxicBps', 'confidenceBps', 'pJitBps', 'modelNode', 'signature']);
    expect(a.pJitBps).toBe(2500);
    expect(await recoverAttestor(31337, hook, fields, a.signature)).toBe(attestor.address);
    expect(
      await verifyTypedData({ address: attestor.address, domain: attestationDomain(31337, hook), types: ATTESTATION_TYPES, primaryType: 'Attestation', message: fields, signature: a.signature }),
    ).toBe(true);
  });

  it('binds chainId, hook and every field — a signature over a different pJit fails', async () => {
    const a = await signAttestation(attestor, 31337, hook, fields);
    expect(await recoverAttestor(11155111, hook, fields, a.signature)).not.toBe(attestor.address);
    expect(await recoverAttestor(31337, '0x0000000000000000000000000000000000000001', fields, a.signature)).not.toBe(attestor.address);
    expect(await recoverAttestor(31337, hook, { ...fields, pToxicBps: 7001 }, a.signature)).not.toBe(attestor.address);
    expect(await recoverAttestor(31337, hook, { ...fields, pJitBps: 2501 }, a.signature)).not.toBe(attestor.address);
    expect(attestationDigest(31337, hook, fields)).not.toBe(attestationDigest(31337, hook, { ...fields, pJitBps: 0 }));
    expect(attestationDigest(31337, hook, fields)).not.toBe(attestationDigest(31337, hook, { ...fields, blockNumber: 124n }));
  });
});

describe('anvil role keys', () => {
  it('derive to the addresses DeployLocal / demo-fork.sh configure (0-5 roles, 6 backup quoter, 7 demo swapper, 8 jit bot)', () => {
    const want = [
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      '0x90F79bf6EB2c4f870365E785982E1f101E93b906', '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
      '0x976EA74026E726554dB657fA54763abd0C3a0aa9', '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955', '0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f',
      '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720',
    ];
    expect(ANVIL_KEYS.map((k) => privateKeyToAccount(k).address)).toEqual(want);
    expect(ROLE_INDEX.jit).toBe(8);
  });
});
