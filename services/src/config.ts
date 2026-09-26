/**
 * Shared configuration for all Oniblock services.
 *
 * - Loads `<root>/.env` (never logs secret values).
 * - Selects a chain: `local` (fresh anvil, 31337), `fork` (anvil --fork-url sepolia,
 *   chainId 11155111 unless FORK_CHAIN_ID overrides) or `sepolia` (real network).
 * - Loads `<root>/deployments/<chainId>.json` with clear errors when missing.
 * - Resolves role keys: on local/fork chains defaults to anvil's well-known dev keys.
 */
import { config as loadDotenv } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Transport,
  type Account,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry, sepolia } from 'viem/chains';

const here = dirname(fileURLToPath(import.meta.url));
/** Repo root (`oniblock/`). */
export const ROOT = resolve(here, '..', '..');
export const SERVICES_DIR = resolve(here, '..');
export const DEPLOYMENTS_DIR = resolve(ROOT, 'deployments');
export const ABIS_DIR = resolve(ROOT, 'abis');
export const CONTRACTS_DIR = resolve(ROOT, 'contracts');

loadDotenv({ path: resolve(ROOT, '.env'), quiet: true } as Parameters<typeof loadDotenv>[0]);

export type ChainName = 'local' | 'fork' | 'sepolia';

/**
 * Anvil default dev accounts (mnemonic "test test ... junk"). PUBLIC, well-known keys —
 * safe to embed; only valid on local chains.
 * Role assignment (DeployLocal.s.sol must match): 0 deployer, 1 quoter, 2 settler,
 * 3 attestor, 4 arb bot, 5 retail bot.
 */
export const ANVIL_KEYS: Hex[] = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
];
export type Role = 'deployer' | 'quoter' | 'settler' | 'attestor' | 'arb' | 'retail';
export const ROLE_INDEX: Record<Role, number> = {
  deployer: 0,
  quoter: 1,
  settler: 2,
  attestor: 3,
  arb: 4,
  retail: 5,
};
const ROLE_ENV: Record<Role, string> = {
  deployer: 'DEPLOYER_PK',
  quoter: 'QUOTER_PK',
  settler: 'SETTLER_PK',
  attestor: 'ATTESTOR_PK',
  arb: 'ARB_PK',
  retail: 'RETAIL_PK',
};

export function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v !== undefined && v !== '' ? v : fallback;
}

export function envInt(name: string, fallback: number): number {
  const v = env(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number`);
  return n;
}

export interface ChainSelection {
  name: ChainName;
  chain: Chain;
  rpcUrl: string;
  /** True for anvil (local or fork): dev keys are allowed. */
  isDev: boolean;
}

export function selectChain(name: ChainName = (env('CHAIN', 'local') as ChainName)): ChainSelection {
  switch (name) {
    case 'local':
      return { name, chain: foundry, rpcUrl: env('LOCAL_RPC', 'http://127.0.0.1:8545')!, isDev: true };
    case 'fork': {
      const id = envInt('FORK_CHAIN_ID', 11155111);
      const chain = defineChain({ ...sepolia, id, name: `sepolia-fork-${id}` });
      return { name, chain, rpcUrl: env('FORK_RPC', env('LOCAL_RPC', 'http://127.0.0.1:8545'))!, isDev: true };
    }
    case 'sepolia': {
      const rpc = env('SEPOLIA_RPC_HTTPS');
      if (!rpc) throw new Error('SEPOLIA_RPC_HTTPS missing in .env');
      return { name, chain: sepolia, rpcUrl: rpc, isDev: false };
    }
    default:
      throw new Error(`unknown chain "${name}" (expected local|fork|sepolia)`);
  }
}

/** Private key for a role: explicit env var wins; dev chains fall back to anvil keys;
 *  sepolia falls back to DEPLOYER_PK for every role. Never logged. */
export function roleKey(role: Role, sel: ChainSelection): Hex {
  const explicit = env(ROLE_ENV[role]);
  // On dev chains DEPLOYER_PK from .env is the *sepolia* deployer — ignore it unless forced.
  if (explicit && (role !== 'deployer' || !sel.isDev || env('USE_ENV_DEPLOYER_ON_DEV') === '1')) {
    return (explicit.startsWith('0x') ? explicit : `0x${explicit}`) as Hex;
  }
  if (sel.isDev) return ANVIL_KEYS[ROLE_INDEX[role]]!;
  const dep = env('DEPLOYER_PK');
  if (!dep) throw new Error(`no key for role ${role}: set ${ROLE_ENV[role]} or DEPLOYER_PK`);
  return (dep.startsWith('0x') ? dep : `0x${dep}`) as Hex;
}

export function roleAccount(role: Role, sel: ChainSelection) {
  return privateKeyToAccount(roleKey(role, sel));
}

export function makePublicClient(sel: ChainSelection): PublicClient {
  return createPublicClient({
    chain: sel.chain,
    transport: http(sel.rpcUrl, { retryCount: 3, retryDelay: 250 }),
    pollingInterval: sel.isDev ? 250 : 4_000,
  }) as PublicClient;
}

export function makeWalletClient(sel: ChainSelection, role: Role): WalletClient<Transport, Chain, Account> {
  return createWalletClient({
    chain: sel.chain,
    account: roleAccount(role, sel),
    transport: http(sel.rpcUrl, { retryCount: 3, retryDelay: 250 }),
  });
}

// ---------------------------------------------------------------------------------------
// Deployments
// ---------------------------------------------------------------------------------------

export interface PoolKeyJson {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export interface PoolEntry {
  /** Logical name, e.g. "oniblock" or "vanilla". */
  name: string;
  poolId: Hex;
  key: PoolKeyJson;
}

/**
 * Normalised view of deployments/<chainId>.json. The raw file (written by the forge
 * scripts) is kept in `raw`; `normaliseDeployment` accepts a few plausible shapes so the
 * services don't break if the contracts agent picks slightly different key names.
 */
export interface Deployment {
  chainId: number;
  hook: Address;
  poolManager: Address;
  roleOracle?: Address;
  /** PoolSwapTest-style router (v4-core test router). */
  swapRouter?: Address;
  /** Router helper that executes N sub-swaps in one tx (split-swap arb). */
  splitRouter?: Address;
  tokens: Record<string, Address>;
  /** Token metadata keyed by address (lower-case). */
  decimals: Record<string, number>;
  pools: PoolEntry[];
  /** ENS namehash of the default model name (jev-v1.models.oniblock.eth). */
  modelNode?: Hex;
  ens?: Record<string, unknown>;
  startBlock?: number;
  raw: Record<string, unknown>;
}

/** deployments/<chainId>.json, or DEPLOYMENTS_FILE if set (e.g. a scratch e2e deployment). */
export function deploymentPath(chainId: number): string {
  return env('DEPLOYMENTS_FILE') ?? resolve(DEPLOYMENTS_DIR, `${chainId}.json`);
}

export function loadDeployment(chainId: number): Deployment {
  const p = deploymentPath(chainId);
  if (!existsSync(p)) {
    throw new Error(
      `deployments file not found: ${p}\n` +
        (chainId === 31337
          ? '  -> start anvil and run: cd contracts && forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast'
          : '  -> run the matching deploy script for this chain first'),
    );
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`deployments file ${p} is not valid JSON: ${(e as Error).message}`);
  }
  return normaliseDeployment(raw, chainId);
}

function pick<T = unknown>(obj: Record<string, unknown> | undefined, ...keys: string[]): T | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k] as T;
  }
  return undefined;
}

export function normaliseDeployment(raw: Record<string, unknown>, chainId: number): Deployment {
  const contracts = (pick<Record<string, unknown>>(raw, 'contracts', 'addresses') ?? raw) as Record<string, unknown>;
  const hook = pick<Address>(contracts, 'hook', 'OniblockHook', 'oniblockHook') ?? pick<Address>(raw, 'hook');
  const poolManager = pick<Address>(contracts, 'poolManager', 'PoolManager') ?? pick<Address>(raw, 'poolManager');
  if (!hook) throw new Error(`deployments/${chainId}.json: missing "hook" address`);
  if (!poolManager) throw new Error(`deployments/${chainId}.json: missing "poolManager" address`);

  // tokens: {mWETH: addr, mUSDC: addr} or {mWETH: {address, decimals}}
  const tokensRaw = (pick<Record<string, unknown>>(raw, 'tokens') ?? {}) as Record<string, unknown>;
  const tokens: Record<string, Address> = {};
  const decimals: Record<string, number> = {};
  for (const [name, v] of Object.entries(tokensRaw)) {
    if (typeof v === 'string') {
      tokens[name] = v as Address;
    } else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const a = pick<Address>(o, 'address', 'addr');
      if (a) {
        tokens[name] = a;
        const d = pick<number>(o, 'decimals');
        if (d !== undefined) decimals[a.toLowerCase()] = Number(d);
      }
    }
  }
  // Default decimals by conventional names.
  for (const [name, a] of Object.entries(tokens)) {
    if (decimals[a.toLowerCase()] === undefined) {
      if (/usdc/i.test(name)) decimals[a.toLowerCase()] = 6;
      else if (/weth|eth/i.test(name)) decimals[a.toLowerCase()] = 18;
    }
  }

  // pools: array [{name, poolId, key}] or object {name: {poolId, key|poolKey}}
  const poolsRaw = pick<unknown>(raw, 'pools') ?? {};
  const pools: PoolEntry[] = [];
  const pushPool = (name: string, v: Record<string, unknown>) => {
    const key = (pick<Record<string, unknown>>(v, 'key', 'poolKey') ?? v) as Record<string, unknown>;
    const poolId = pick<Hex>(v, 'poolId', 'id');
    if (!poolId || !key.currency0) return;
    pools.push({
      name: (pick<string>(v, 'name') ?? name) as string,
      poolId,
      key: {
        currency0: key.currency0 as Address,
        currency1: key.currency1 as Address,
        fee: Number(key.fee),
        tickSpacing: Number(key.tickSpacing),
        hooks: key.hooks as Address,
      },
    });
  };
  if (Array.isArray(poolsRaw)) poolsRaw.forEach((v, i) => pushPool(`pool${i}`, v as Record<string, unknown>));
  else for (const [n, v] of Object.entries(poolsRaw as Record<string, unknown>)) pushPool(n, v as Record<string, unknown>);

  const ens = pick<Record<string, unknown>>(raw, 'ens');
  const modelNode =
    pick<Hex>(raw, 'modelNode') ??
    pick<Hex>(ens, 'modelNode', 'jevNode', 'jev-v1') ??
    (pick<Record<string, unknown>>(ens, 'nodes') as Record<string, Hex> | undefined)?.['jev-v1.models.oniblock.eth'];

  return {
    chainId,
    hook,
    poolManager,
    roleOracle: pick<Address>(contracts, 'roleOracle', 'RoleOracle', 'MockRoleOracle', 'EnsV2RoleOracle'),
    swapRouter: pick<Address>(contracts, 'swapRouter', 'poolSwapTest', 'PoolSwapTest', 'router'),
    splitRouter: pick<Address>(contracts, 'splitRouter', 'SplitSwapRouter', 'splitSwapRouter'),
    tokens,
    decimals,
    pools,
    modelNode,
    ens,
    startBlock: pick<number>(raw, 'startBlock', 'deployBlock'),
    raw,
  };
}

/** The pool governed by our hook (hooks == deployment.hook). Prefers name "oniblock". */
export function oniblockPool(d: Deployment, name = env('POOL_NAME')): PoolEntry {
  const byName = name ? d.pools.find((p) => p.name === name) : undefined;
  if (byName) return byName;
  const ours = d.pools.filter((p) => p.key.hooks.toLowerCase() === d.hook.toLowerCase());
  const pref = ours.find((p) => /oni/i.test(p.name)) ?? ours[0];
  if (!pref) throw new Error(`deployments/${d.chainId}.json: no pool with hooks == hook ${d.hook}`);
  return pref;
}

/** Token order/decimals helper for price conversions. "base" = the ETH-like asset. */
export interface PairMeta {
  token0: Address;
  token1: Address;
  decimals0: number;
  decimals1: number;
  /** true if token0 is the base asset (mWETH) and token1 the quote (mUSDC). */
  baseIsToken0: boolean;
}

export function pairMeta(d: Deployment, pool: PoolEntry): PairMeta {
  const c0 = pool.key.currency0.toLowerCase();
  const c1 = pool.key.currency1.toLowerCase();
  const d0 = d.decimals[c0];
  const d1 = d.decimals[c1];
  if (d0 === undefined || d1 === undefined) {
    throw new Error(`deployments/${d.chainId}.json: unknown decimals for pool tokens (add tokens.{name}.decimals)`);
  }
  // Quote = the 6-decimal stable (mUSDC). If equal decimals, assume token1 is quote.
  const usdc = Object.entries(d.tokens).find(([n]) => /usdc/i.test(n))?.[1]?.toLowerCase();
  const baseIsToken0 = usdc ? usdc === c1 : d1 <= d0;
  return { token0: pool.key.currency0, token1: pool.key.currency1, decimals0: d0, decimals1: d1, baseIsToken0 };
}

/** Parse `--flag value` / `--flag=value` / `--bool` CLI args. */
export function parseArgs(argv = process.argv.slice(2)): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) {
      out[a.slice(2)] = argv[++i]!;
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

/** JSON-lines logger (one object per line; bigint-safe). */
export function log(component: string, event: string, data: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ t: new Date().toISOString(), c: component, e: event, ...data }, (_k, v) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
  process.stdout.write(line + '\n');
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
