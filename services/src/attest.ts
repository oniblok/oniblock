/**
 * EIP-712 attestation signing (attestor key = TEE stand-in).
 *
 * MUST match OniblockHook's typehash:
 *   Attestation(bytes32 poolId,uint64 blockNumber,uint256 oracleMidX96,uint32 pToxicBps,uint32 confidenceBps,bytes32 modelNode)
 * domain: { name, version: "1", chainId, verifyingContract: hook }
 *
 * NOTE: BUILD_SPEC says name "OniblockHook", but the deployed contract uses EIP712("Oniblock", "1").
 * Always resolve the name from the chain (`resolveAttestDomain` reads EIP-5267 `eip712Domain()`),
 * falling back to deployments.eip712.name, then the spec default.
 */
import {
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  toBytes,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
} from 'viem';

export const ATTESTATION_TYPES = {
  Attestation: [
    { name: 'poolId', type: 'bytes32' },
    { name: 'blockNumber', type: 'uint64' },
    { name: 'oracleMidX96', type: 'uint256' },
    { name: 'pToxicBps', type: 'uint32' },
    { name: 'confidenceBps', type: 'uint32' },
    { name: 'modelNode', type: 'bytes32' },
  ],
} as const;

export const ATTESTATION_TYPE_STRING =
  'Attestation(bytes32 poolId,uint64 blockNumber,uint256 oracleMidX96,uint32 pToxicBps,uint32 confidenceBps,bytes32 modelNode)';
export const ATTESTATION_TYPEHASH = keccak256(toBytes(ATTESTATION_TYPE_STRING));

export interface AttestationFields {
  poolId: Hex;
  blockNumber: bigint;
  oracleMidX96: bigint;
  pToxicBps: number;
  confidenceBps: number;
  modelNode: Hex;
}

/** The on-chain struct passed to setAttestation (poolId is implied by the PoolKey). */
export interface AttestationStruct {
  blockNumber: bigint;
  oracleMidX96: bigint;
  pToxicBps: number;
  confidenceBps: number;
  modelNode: Hex;
  signature: Hex;
}

export const DEFAULT_DOMAIN_NAME = 'Oniblock';

export interface DomainOpts {
  name?: string;
  version?: string;
}

export function attestationDomain(chainId: number, hook: Address, o: DomainOpts = {}) {
  return { name: o.name ?? DEFAULT_DOMAIN_NAME, version: o.version ?? '1', chainId, verifyingContract: hook } as const;
}

/** Read the EIP-712 domain from the hook (EIP-5267). Falls back to `fallback` then the spec default. */
export async function resolveAttestDomain(pc: PublicClient, hook: Address, fallback: DomainOpts = {}): Promise<Required<DomainOpts>> {
  try {
    const d = await pc.getEip712Domain({ address: hook });
    return { name: d.domain.name ?? fallback.name ?? DEFAULT_DOMAIN_NAME, version: d.domain.version ?? fallback.version ?? '1' };
  } catch {
    return { name: fallback.name ?? DEFAULT_DOMAIN_NAME, version: fallback.version ?? '1' };
  }
}

export function attestationDigest(chainId: number, hook: Address, a: AttestationFields, o: DomainOpts = {}): Hex {
  return hashTypedData({
    domain: attestationDomain(chainId, hook, o),
    types: ATTESTATION_TYPES,
    primaryType: 'Attestation',
    message: a,
  });
}

export async function signAttestation(
  signer: LocalAccount,
  chainId: number,
  hook: Address,
  a: AttestationFields,
  o: DomainOpts = {},
): Promise<AttestationStruct> {
  const signature = await signer.signTypedData({
    domain: attestationDomain(chainId, hook, o),
    types: ATTESTATION_TYPES,
    primaryType: 'Attestation',
    message: a,
  });
  return {
    blockNumber: a.blockNumber,
    oracleMidX96: a.oracleMidX96,
    pToxicBps: a.pToxicBps,
    confidenceBps: a.confidenceBps,
    modelNode: a.modelNode,
    signature,
  };
}

export async function recoverAttestor(chainId: number, hook: Address, a: AttestationFields, signature: Hex, o: DomainOpts = {}): Promise<Address> {
  return recoverTypedDataAddress({
    domain: attestationDomain(chainId, hook, o),
    types: ATTESTATION_TYPES,
    primaryType: 'Attestation',
    message: a,
    signature,
  });
}
