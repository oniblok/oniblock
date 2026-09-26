/**
 * viem public client + shared context (deployment, ABIs, ENS, model-name lookup) for API routes.
 */
import 'server-only';
import {
  concat,
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  namehash,
  parseAbi,
  stringToBytes,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { abi, loadDeployment, loadEnsDeployment, type Deployment, type EnsDeployment } from './deployment';
import { chainSel, rpcTransport, type ChainSel } from './env';

const clients = new Map<string, PublicClient>();
export function publicClient(sel: ChainSel): PublicClient {
  let c = clients.get(sel.rpcUrl);
  if (!c) {
    c = createPublicClient({
      chain: sel.chain,
      // JSON-RPC batching: concurrent reads (history snapshots) go out as one HTTP request.
      transport: rpcTransport(sel, { batch: { batchSize: 200, wait: 8 }, retryCount: 2, retryDelay: 200, timeout: 15_000 }),
    }) as PublicClient;
    clients.set(sel.rpcUrl, c);
  }
  return c;
}

export interface Ctx {
  sel: ChainSel;
  pc: PublicClient;
  d: Deployment;
  ens?: EnsDeployment;
  hookAbi: Abi;
  stateViewAbi: Abi;
  poolManagerAbi: Abi;
  /** Lower-cased namehash -> ENS name (from ENS deployment, deployment file, APP_MODEL_NAMES). */
  names: Map<string, string>;
}

/** Default model names the keeper uses (services/src/keeper.ts); used only to label namehashes locally. */
const DEFAULT_NAMES = [
  'jev-v1.models.oniblock.eth',
  'heuristic-v1.models.oniblock.eth',
  'kev-v1.models.oniblock.eth',
  'oniblock1.models.oniblock.eth',
  'rule-v1.models.oniblock.eth',
  'quoter.oniblock.eth',
  'settler.oniblock.eth',
  'weth-usdc.pools.oniblock.eth',
];

export async function ctx(): Promise<Ctx> {
  const sel = chainSel();
  const pc = publicClient(sel);
  const chainId = sel.name === 'local' ? 31337 : sel.chain.id;
  const d = loadDeployment(chainId);
  const ens = sel.name === 'local' ? undefined : loadEnsDeployment(chainId, sel.name === 'fork');
  const names = new Map<string, string>();
  const extra = (process.env.APP_MODEL_NAMES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const n of [...DEFAULT_NAMES, ...extra]) names.set(namehash(n).toLowerCase(), n);
  for (const [n, h] of Object.entries(d.names)) names.set(h.toLowerCase(), n);
  for (const [n, h] of Object.entries(ens?.namehashes ?? {})) names.set(h.toLowerCase(), n);
  return {
    sel,
    pc,
    d,
    ens,
    hookAbi: abi('OniblockHook'),
    stateViewAbi: abi('StateView'),
    poolManagerAbi: abi('PoolManager'),
    names,
  };
}

export function nameOf(c: Ctx, node: Hex | undefined): string | undefined {
  return node ? c.names.get(node.toLowerCase()) : undefined;
}

/** Call a hook view that may not exist in older/newer ABIs; returns undefined instead of throwing. */
export async function tryRead<T>(c: Ctx, fn: string, args: readonly unknown[], blockNumber?: bigint): Promise<T | undefined> {
  if (!c.hookAbi.some((x) => x.type === 'function' && x.name === fn)) return undefined;
  try {
    return (await c.pc.readContract({ address: c.d.hook, abi: c.hookAbi, functionName: fn, args, blockNumber })) as T;
  } catch {
    return undefined;
  }
}

export const hasFn = (a: Abi, name: string) => a.some((x) => x.type === 'function' && x.name === name);
export const hasEvent = (a: Abi, name: string) => a.some((x) => x.type === 'event' && x.name === name);

/**
 * v5 JIT head: calibration key of a model's JIT predictions = keccak256(abi.encodePacked(modelNode, keccak256("jit"))),
 * identical to OniblockHook.jitCalibrationKey (pure). Computed locally so the models page needs no extra eth_call per node;
 * the settler writes the record with setCalibration(jitCalibrationKey(modelNode), ...).
 */
export function jitCalibrationKey(modelNode: Hex): Hex {
  return keccak256(concat([modelNode, keccak256(stringToBytes('jit'))]));
}

/** The deployed ABI carries the v5 JIT head (jitCalibrationKey / isJitDemoted / jitWindowFromScore, PoolState.jitWindow). */
export const jitHeadSupported = (c: Ctx) => hasFn(c.hookAbi, 'jitCalibrationKey');

// ------------------------------------------------------------------------------------------ ENS (UR v2)

/** DNS wire-format name (EnsV2Lib.dnsEncode). */
export function dnsEncode(name: string): Hex {
  return concat([
    ...name.split('.').map((l) => {
      const b = stringToBytes(l);
      return concat([toHex(b.length, { size: 1 }), toHex(b)]);
    }),
    '0x00',
  ]);
}

const urAbi = parseAbi([
  'function resolve(bytes name, bytes data) view returns (bytes, address)',
  'function reverse(bytes lookupAddress, uint256 coinType) view returns (string name, address resolver, address reverseResolver)',
]);
const profileAbi = parseAbi([
  'function text(bytes32 node, string key) view returns (string)',
  'function addr(bytes32 node) view returns (address)',
  'function multicall(bytes[] calls) returns (bytes[])',
]);

/** True if the chain has our ENS deployment and the UniversalResolverV2 has code. */
export async function ensAvailable(c: Ctx): Promise<boolean> {
  if (!c.ens?.universalResolver) return false;
  try {
    const code = await c.pc.getCode({ address: c.ens.universalResolver });
    return !!code && code !== '0x';
  } catch {
    return false;
  }
}

/** Resolve text records for `name` via UniversalResolverV2 (one multicall). Missing -> ''. */
export async function ensTexts(c: Ctx, name: string, keys: string[]): Promise<Record<string, string> | undefined> {
  if (!c.ens?.universalResolver) return undefined;
  const node = namehash(name);
  const calls = keys.map((k) => encodeFunctionData({ abi: profileAbi, functionName: 'text', args: [node, k] }));
  const data = encodeFunctionData({ abi: profileAbi, functionName: 'multicall', args: [calls] });
  try {
    const [out] = await c.pc.readContract({ address: c.ens.universalResolver, abi: urAbi, functionName: 'resolve', args: [dnsEncode(name), data] });
    const results = decodeFunctionResult({ abi: profileAbi, functionName: 'multicall', data: out }) as readonly Hex[];
    const rec: Record<string, string> = {};
    keys.forEach((k, i) => {
      try {
        rec[k] = decodeFunctionResult({ abi: profileAbi, functionName: 'text', data: results[i]! }) as string;
      } catch {
        rec[k] = '';
      }
    });
    return rec;
  } catch {
    return undefined;
  }
}

/** Forward-resolve addr(name) via UniversalResolverV2. */
export async function ensAddr(c: Ctx, name: string): Promise<Address | undefined> {
  if (!c.ens?.universalResolver) return undefined;
  try {
    const data = encodeFunctionData({ abi: profileAbi, functionName: 'addr', args: [namehash(name)] });
    const [out] = await c.pc.readContract({ address: c.ens.universalResolver, abi: urAbi, functionName: 'resolve', args: [dnsEncode(name), data] });
    return decodeFunctionResult({ abi: profileAbi, functionName: 'addr', data: out }) as Address;
  } catch {
    return undefined;
  }
}

/** ENSIP-19: an L1 primary name is `<addr>.addr.reverse` = coin type 60; the UR forward-checks it with addr(name, 60). */
export const REVERSE_COIN_TYPE = 60n;
const reverseCache = new Map<string, { name: string | null; t: number }>();

/**
 * Primary name of an address via UniversalResolverV2.reverse(addr, 60) (ENSIP-19). The UR reads the reverse record
 * (on Sepolia: the DefaultReverseRegistrar's nameForAddr, set by `pnpm -C services ens:primary`) and reverts unless
 * addr(name) resolves back to the address, so a returned name is forward-verified. null = none / mismatch / no ENS.
 * Cached 15 s per address (the status strip polls every 2 s).
 */
export async function ensReverse(c: Ctx, addr: Address | undefined): Promise<string | null> {
  if (!addr || !c.ens?.universalResolver) return null;
  const k = `${c.sel.rpcUrl}|${c.ens.universalResolver}|${addr.toLowerCase()}`;
  const hit = reverseCache.get(k);
  if (hit && Date.now() - hit.t < 15_000) return hit.name;
  let name: string | null = null;
  try {
    const [n] = await c.pc.readContract({ address: c.ens.universalResolver, abi: urAbi, functionName: 'reverse', args: [addr, REVERSE_COIN_TYPE] });
    name = n || null;
  } catch {
    name = null;
  }
  reverseCache.set(k, { name, t: Date.now() });
  return name;
}

/** calibration.brier = the gate value posted on-chain (skill-normalised, 2500 = base rate); brierRaw / skill / baseRate are detail records. */
export const CALIBRATION_KEYS = ['calibration.brier', 'calibration.brierRaw', 'calibration.skill', 'calibration.baseRate', 'calibration.hitRate', 'calibration.n', 'calibration.epoch'];
export const MODEL_KEYS = [...CALIBRATION_KEYS, 'model-hash', 'agent-context', 'description'];
/** v5: the JIT head's records on the same model name (mirrors CALIBRATION_KEYS under calibration.jit.*). */
export const JIT_CALIBRATION_KEYS = CALIBRATION_KEYS.map((k) => k.replace(/^calibration\./, 'calibration.jit.'));
