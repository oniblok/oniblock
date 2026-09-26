/**
 * ENSIP-19 primary names for the Oniblock service keys (ENSv2 Sepolia beta): `pnpm -C services ens:primary`.
 *
 *   quoter key  -> primary name quoter.<root>    root = --root | ENS_NAME | deployments/<chainId>.ens.json .name | oniblock.eth
 *   settler key -> primary name settler.<root>
 *
 * Mechanism (docs/ENS_INTEGRATION.md §8; verified against the Etherscan-verified Sepolia sources and on an anvil fork):
 *   - ENS publishes ONE DefaultReverseRegistrar per L1 (ensjs `ensDefaultReverseRegistrar`; Sepolia
 *     0x4F382928805ba0e23B30cFB75fC9E848e82DFD47, verified `DefaultReverseRegistrar`, solc 0.8.26). It is a standalone
 *     address -> name mapping: no registry node, no resolver. `setName(string)` writes the record for msg.sender and
 *     emits `NameForAddrChanged(addr, name)`; `nameForAddr(address)` reads it. (`setNameForAddrWithSignature(address,
 *     uint256,string,bytes)` exists for keys that cannot send a transaction; `setNameForAddr` is controller-only.)
 *   - UniversalResolverV2.reverse(addressBytes, 60) (ENSIP-19) resolves `<addr>.addr.reverse` through the v2 root's
 *     "reverse" resolver (an ENSv1 mirror), which falls back to the default registrar's name, then forward-verifies it:
 *     it reverts with ReverseAddressMismatch unless addr(<name>, 60) is the same address. EnsSetup writes that forward
 *     record (`setAddress(quoter.<root>, 60, quoter)`), so the two must agree for the name to show up as primary.
 *
 * Idempotent: `nameForAddr` is read first and a name that already matches is skipped. The forward `addr()` and the UR
 * reverse view are reported as checks; a forward mismatch is a warning (the reverse record is still written, the
 * name owner fixes the forward record), not a failure.
 *
 * Keys: roleAccount('quoter' | 'settler'): anvil keys on local/fork (USE_ENV_KEYS_ON_DEV=1 for the .env keys), .env
 * keys on sepolia, where QUOTER_PK / SETTLER_PK must be set explicitly (the DEPLOYER_PK fallback of roleKey is
 * refused: it would give both roles the same key). Two roles resolving to the same address is always an error, since
 * one key can hold only one primary name. Nothing secret is ever logged. `--dry-run` prints the transactions it would
 * send and exits 0. `--only quoter|settler` limits the roles (a bare `--only` is an error); `--registrar 0x…` /
 * ENS_DEFAULT_REVERSE_REGISTRAR override the registrar.
 */
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isAddress,
  namehash,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { TxSender } from './chain.js';
import { env, log, makePublicClient, makeWalletClient, parseArgs, roleAccount, selectChain } from './config.js';
import { dnsEncode, loadEnsDeployment } from './ens.js';

export const SEPOLIA_CHAIN_ID = 11155111;
/**
 * ENSv2 Sepolia DefaultReverseRegistrar. Sources: docs.ens.domains/learn/deployments ("Default Reverse Registrar",
 * Sepolia), docs.ens.domains/registry/reverse (Sepolia · Default), ensjs PR #387 (`ensDefaultReverseRegistrar` in the
 * L1 Sepolia config; its HCA adapter `ensDefaultReverseRegistrarAdapter` is 0x4F32A1c62E202922d4d6307126F43218DB9dA6f5).
 * Mainnet uses a different address (0x283F…), so nothing is baked in for other chains.
 */
export const SEPOLIA_DEFAULT_REVERSE_REGISTRAR: Address = '0x4F382928805ba0e23B30cFB75fC9E848e82DFD47';
/** ENSIP-19 coin type the UR reads for an L1 primary name (`<addr>.addr.reverse`), forward-checked with addr(name, 60). */
export const REVERSE_COIN_TYPE = 60n;

/** Verified ABI subset of DefaultReverseRegistrar (IDefaultReverseRegistrar + IStandaloneReverseRegistrar). */
export const defaultReverseRegistrarAbi = parseAbi([
  'function setName(string name)',
  'function setNameForAddr(address addr, string name)',
  'function setNameForAddrWithSignature(address addr, uint256 signatureExpiry, string name, bytes signature)',
  'function nameForAddr(address addr) view returns (string)',
  'event NameForAddrChanged(address indexed addr, string name)',
]);

/** UniversalResolverV2: ENSIP-19 reverse view + ENSIP-10 forward resolve. */
export const universalResolverAbi = parseAbi([
  'function reverse(bytes lookupAddress, uint256 coinType) view returns (string name, address resolver, address reverseResolver)',
  'function resolve(bytes name, bytes data) view returns (bytes, address)',
  'error ReverseAddressMismatch(string primary, bytes primaryAddress)',
  'error PrimaryNameNotNormalized(string primary)',
  'error ResolverNotFound(bytes name)',
]);
const addrProfileAbi = parseAbi(['function addr(bytes32 node) view returns (address)']);

export type PrimaryRole = 'quoter' | 'settler';
export const PRIMARY_ROLES: readonly PrimaryRole[] = ['quoter', 'settler'];

/** Lower-case, no surrounding dots (ENS names are ENSIP-15 normalised; ours are plain ASCII labels). */
export function normaliseRoot(root: string): string {
  const r = root.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!r || !r.includes('.')) throw new Error(`ENS root name "${root}" is not a full name like oniblock.eth`);
  return r;
}

export interface PrimaryTarget {
  role: PrimaryRole;
  name: string;
}

/** The primary name of each service key: `<role>.<root>` (the subnames EnsSetup registers with addr = that key). */
export function primaryNameTargets(root: string, roles: readonly PrimaryRole[] = PRIMARY_ROLES): PrimaryTarget[] {
  const r = normaliseRoot(root);
  return roles.map((role) => ({ role, name: `${role}.${r}` }));
}

/** `--only` value -> roles. Absent = every role; a bare `--only` (no value), an empty list or an unknown role throws. */
export function parseOnly(v: string | boolean | undefined): PrimaryRole[] {
  if (v === undefined) return [...PRIMARY_ROLES];
  if (typeof v !== 'string') throw new Error('--only needs a value: --only quoter, --only settler or --only quoter,settler');
  const names = v.split(',').map((s) => s.trim()).filter(Boolean);
  if (!names.length) throw new Error('--only needs a value: --only quoter, --only settler or --only quoter,settler');
  const bad = names.filter((n) => !(PRIMARY_ROLES as readonly string[]).includes(n));
  if (bad.length) throw new Error(`--only must name quoter and/or settler, got "${v}"`);
  return PRIMARY_ROLES.filter((r) => names.includes(r));
}

/** Env var that must hold each role's key on a non-dev chain (no DEPLOYER_PK fallback for primary names). */
export const PRIMARY_KEY_ENV: Record<PrimaryRole, string> = { quoter: 'QUOTER_PK', settler: 'SETTLER_PK' };

/** On a non-dev chain (sepolia) every role needs its own explicit key env; roleKey's DEPLOYER_PK fallback is refused. */
export function assertExplicitKeys(roles: readonly PrimaryRole[], isDev: boolean, getEnv: (name: string) => string | undefined = env): void {
  if (isDev) return;
  const missing = roles.filter((r) => !getEnv(PRIMARY_KEY_ENV[r]));
  if (missing.length) {
    throw new Error(
      `set ${missing.map((r) => PRIMARY_KEY_ENV[r]).join(' and ')} explicitly: on sepolia ens:primary refuses the DEPLOYER_PK fallback (it would set two primary names from one key)`,
    );
  }
}

/** One key holds one primary name: two roles on the same address is an error, never two setName calls. */
export function assertDistinctAddresses(targets: readonly (PrimaryTarget & { address: Address })[]): void {
  const seen = new Map<string, PrimaryRole>();
  for (const t of targets) {
    const k = t.address.toLowerCase();
    const prev = seen.get(k);
    if (prev) throw new Error(`roles ${prev} and ${t.role} resolve to the same address ${t.address}: one key can hold only one primary name; give each role its own key`);
    seen.set(k, t.role);
  }
}

/** ENS_DEFAULT_REVERSE_REGISTRAR (or --registrar) wins; otherwise the documented Sepolia default; other chains need the env. */
export function reverseRegistrarFor(chainId: number, override?: string): { address: Address; source: 'env' | 'sepolia-default' } {
  if (override) {
    if (!isAddress(override)) throw new Error(`ENS_DEFAULT_REVERSE_REGISTRAR "${override}" is not an address`);
    return { address: getAddress(override), source: 'env' };
  }
  if (chainId === SEPOLIA_CHAIN_ID) return { address: SEPOLIA_DEFAULT_REVERSE_REGISTRAR, source: 'sepolia-default' };
  throw new Error(`no default reverse registrar known for chain ${chainId}: set ENS_DEFAULT_REVERSE_REGISTRAR (Sepolia default is ${SEPOLIA_DEFAULT_REVERSE_REGISTRAR})`);
}

/** `setName(string)` calldata (selector 0xc47f0027). */
export function setNameCalldata(name: string): Hex {
  return encodeFunctionData({ abi: defaultReverseRegistrarAbi, functionName: 'setName', args: [name] });
}

/** Reads the plan needs; `chainReader` is the real one, tests pass a fake. */
export interface PrimaryReader {
  /** DefaultReverseRegistrar.nameForAddr(addr): '' when unset. */
  nameForAddr(addr: Address): Promise<string>;
  /** addr(<name>) through the UR (undefined when unresolvable or no UR). */
  forwardAddr(name: string): Promise<Address | undefined>;
  /** UR.reverse(addr, 60): the forward-verified primary name ('' when none; throws on mismatch). */
  urReverse(addr: Address): Promise<string | undefined>;
}

export interface PrimaryPlan extends PrimaryTarget {
  address: Address;
  /** current nameForAddr value */
  current: string;
  action: 'set' | 'skip';
  forward: Address | undefined;
  /** addr(name) == address; undefined when the forward record could not be read */
  forwardMatch: boolean | undefined;
  /** UR.reverse view before any change; undefined when it reverted (mismatch) or no UR */
  urReverse: string | undefined;
}

/** Idempotence: skip a key whose registrar record already equals the target name (exact, normalised compare). */
export async function planPrimaryNames(targets: (PrimaryTarget & { address: Address })[], reader: PrimaryReader): Promise<PrimaryPlan[]> {
  return Promise.all(
    targets.map(async (t) => {
      const current = (await reader.nameForAddr(t.address)).trim();
      const forward = await reader.forwardAddr(t.name).catch(() => undefined);
      const urReverse = await reader.urReverse(t.address).catch(() => undefined);
      return {
        ...t,
        current,
        action: current.toLowerCase() === t.name ? 'skip' : 'set',
        forward,
        forwardMatch: forward ? forward.toLowerCase() === t.address.toLowerCase() : undefined,
        urReverse,
      };
    }),
  );
}

export function chainReader(pc: PublicClient, registrar: Address, universalResolver?: Address): PrimaryReader {
  return {
    nameForAddr: (addr) => pc.readContract({ address: registrar, abi: defaultReverseRegistrarAbi, functionName: 'nameForAddr', args: [addr] }),
    forwardAddr: async (name) => {
      if (!universalResolver) return undefined;
      const data = encodeFunctionData({ abi: addrProfileAbi, functionName: 'addr', args: [namehash(name)] });
      const [out] = await pc.readContract({ address: universalResolver, abi: universalResolverAbi, functionName: 'resolve', args: [dnsEncode(name), data] });
      return decodeFunctionResult({ abi: addrProfileAbi, functionName: 'addr', data: out }) as Address;
    },
    urReverse: async (addr) => {
      if (!universalResolver) return undefined;
      const [name] = await pc.readContract({ address: universalResolver, abi: universalResolverAbi, functionName: 'reverse', args: [addr, REVERSE_COIN_TYPE] });
      return name;
    },
  };
}

const C = 'ens-primary';

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const a = parseArgs(argv);
  const dryRun = a['dry-run'] === true || a['dry-run'] === '1';
  const sel = selectChain();
  const roles = parseOnly(a.only); // before any RPC: a bad flag fails fast
  assertExplicitKeys(roles, sel.isDev);
  const pc = makePublicClient(sel);
  const chainId = sel.chain.id;
  const ens = loadEnsDeployment(chainId);
  const root = normaliseRoot((typeof a.root === 'string' ? a.root : undefined) ?? env('ENS_NAME') ?? ens?.name ?? 'oniblock.eth');
  const reg = reverseRegistrarFor(chainId, (typeof a.registrar === 'string' ? a.registrar : undefined) ?? env('ENS_DEFAULT_REVERSE_REGISTRAR'));
  const ur = (env('ENS_UNIVERSAL_RESOLVER') ?? ens?.universalResolver) as Address | undefined;
  const keys = sel.isDev && env('USE_ENV_KEYS_ON_DEV') !== '1' ? 'anvil' : 'env';
  log(C, 'config', { chain: sel.name, chainId, root, reverseRegistrar: reg.address, reverseRegistrarSource: reg.source, coinType: REVERSE_COIN_TYPE, universalResolver: ur ?? null, ensFile: ens?.file ?? null, keys, dryRun });

  const code = await pc.getCode({ address: reg.address });
  if (!code || code === '0x') {
    log(C, 'fatal', { error: `no contract at reverse registrar ${reg.address} on chain ${chainId} (CHAIN=local has no ENS; use CHAIN=fork or sepolia)` });
    return 1;
  }
  if (!ur) log(C, 'no_universal_resolver', { hint: 'set ENS_UNIVERSAL_RESOLVER or provide deployments/<chainId>.ens.json: forward / reverse checks skipped' });

  const targets = primaryNameTargets(root, roles).map((t) => ({ ...t, address: roleAccount(t.role, sel).address }));
  assertDistinctAddresses(targets);
  const reader = chainReader(pc, reg.address, ur);
  const plans = await planPrimaryNames(targets, reader);
  for (const p of plans) {
    log(C, p.action === 'skip' ? 'already_set' : 'needs_set', { role: p.role, name: p.name, address: p.address, current: p.current, forward: p.forward ?? null, forwardMatch: p.forwardMatch ?? null, urReverse: p.urReverse ?? null });
    if (p.forwardMatch === false) {
      log(C, 'forward_mismatch', {
        role: p.role,
        name: p.name,
        address: p.address,
        forward: p.forward,
        hint: `addr(${p.name}) is not this key: the UR's reverse() rejects the name (ReverseAddressMismatch) until the name owner points the forward record at ${p.address}`,
      });
    } else if (p.forwardMatch === undefined) {
      log(C, 'forward_unverified', { role: p.role, name: p.name, hint: ur ? `${p.name} does not resolve through the UR (EnsSetup not run on this chain?)` : 'no UR' });
    }
  }

  const todo = plans.filter((p) => p.action === 'set');
  const skipped = plans.length - todo.length;
  if (dryRun) {
    for (const p of todo) log(C, 'would_send', { role: p.role, from: p.address, to: reg.address, function: 'setName(string)', args: [p.name], data: setNameCalldata(p.name) });
    log(C, 'dry_run_done', { set: todo.length, skipped });
    return 0;
  }
  let failed = 0;
  for (const p of todo) {
    const sender = new TxSender(pc, makeWalletClient(sel, p.role), C);
    const rc = await sender.send({ address: reg.address, abi: defaultReverseRegistrarAbi, functionName: 'setName', args: [p.name], label: `setName ${p.name}` });
    if (rc?.status !== 'success') {
      failed++;
      log(C, 'set_failed', { role: p.role, name: p.name, address: p.address, tx: rc?.hash ?? null });
      continue;
    }
    const [after, urAfter] = await Promise.all([reader.nameForAddr(p.address), reader.urReverse(p.address).catch(() => undefined)]);
    log(C, 'primary_name_set', { role: p.role, name: p.name, address: p.address, tx: rc.hash, block: rc.blockNumber, gasUsed: rc.gasUsed, nameForAddr: after, urReverse: urAfter ?? null });
  }
  log(C, 'done', { set: todo.length - failed, failed, skipped });
  return failed ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      log(C, 'fatal', { error: ((e as Error).message ?? String(e)).split('\n')[0] });
      process.exit(1);
    },
  );
}
