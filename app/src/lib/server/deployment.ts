/**
 * deployments/<chainId>.json (+ optional <chainId>.ens.json) and abis/*.json, read at request time so
 * a redeploy (demo-local.sh) or regenerated ABIs are picked up without rebuilding the app.
 * Files are re-parsed only when their mtime changes.
 */
import 'server-only';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Abi, Address, Hex } from 'viem';
import { ABIS_DIR, DEPLOYMENTS_DIR } from './env';

const cache = new Map<string, { m: number; v: unknown }>();
function readJson<T>(file: string): T {
  const m = statSync(file).mtimeMs;
  const c = cache.get(file);
  if (c && c.m === m) return c.v as T;
  const v = JSON.parse(readFileSync(file, 'utf8')) as T;
  cache.set(file, { m, v });
  return v;
}

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export interface PoolInfo {
  name: string;
  poolId: Hex;
  key: PoolKey;
  hooked: boolean;
}

export interface TokenInfo {
  symbol: string;
  address: Address;
  decimals: number;
}

export interface Deployment {
  file: string;
  mtime: number;
  chainId: number;
  hook: Address;
  poolManager: Address;
  stateView?: Address;
  roleOracle?: Address;
  roleOracleType?: string;
  splitSwapRouter?: Address;
  quoter?: Address;
  settler?: Address;
  attestor?: Address;
  deployer?: Address;
  deployBlock: number;
  token0: TokenInfo;
  token1: TokenInfo;
  /** true if token0 is the base asset (ETH-like), token1 the quote (USD-like). */
  baseIsToken0: boolean;
  oniblock: PoolInfo;
  vanilla?: PoolInfo;
  /** Extra name -> namehash pairs if the deployment file carries them (e.g. allowlisted model nodes). */
  names: Record<string, Hex>;
  raw: Record<string, unknown>;
}

export function deploymentFile(chainId: number): string {
  return process.env.DEPLOYMENTS_FILE ?? path.join(DEPLOYMENTS_DIR, `${chainId}.json`);
}

/** Collect any {name: 0x..32 bytes} pairs whose key looks like an ENS name, recursively. */
function collectNames(o: unknown, out: Record<string, Hex>, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 4) return;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (typeof v === 'string' && /\.eth$/.test(k) && /^0x[0-9a-fA-F]{64}$/.test(v)) out[k] = v as Hex;
    else if (typeof v === 'object') collectNames(v, out, depth + 1);
  }
}

export function loadDeployment(chainId: number): Deployment {
  const file = deploymentFile(chainId);
  if (!existsSync(/*turbopackIgnore: true*/ file)) {
    throw new Error(`deployment file not found: ${file} (run scripts/demo-local.sh or contracts/script/DeployLocal.s.sol)`);
  }
  const raw = readJson<Record<string, unknown>>(file);
  const tokensRaw = (raw.tokens ?? {}) as Record<string, { address: Address; decimals: number; symbol?: string } | Address>;
  const tokens: TokenInfo[] = Object.entries(tokensRaw).map(([sym, v]) =>
    typeof v === 'string'
      ? { symbol: sym, address: v, decimals: /usdc/i.test(sym) ? 6 : 18 }
      : { symbol: v.symbol ?? sym, address: v.address, decimals: Number(v.decimals) },
  );
  const poolsRaw = (raw.pools ?? {}) as Record<string, { poolId: Hex; key: PoolKey }>;
  const hook = raw.hook as Address;
  const pools: PoolInfo[] = Object.entries(poolsRaw).map(([name, p]) => ({
    name,
    poolId: p.poolId,
    key: { ...p.key, fee: Number(p.key.fee), tickSpacing: Number(p.key.tickSpacing) },
    hooked: p.key.hooks.toLowerCase() === hook.toLowerCase(),
  }));
  const oniblock = pools.find((p) => p.hooked && /oni/i.test(p.name)) ?? pools.find((p) => p.hooked);
  if (!oniblock) throw new Error(`${file}: no pool uses the hook ${hook}`);
  const vanilla = pools.find((p) => !p.hooked);
  const find = (a: Address) => tokens.find((t) => t.address.toLowerCase() === a.toLowerCase());
  const token0 = find(oniblock.key.currency0) ?? { symbol: 'token0', address: oniblock.key.currency0, decimals: 18 };
  const token1 = find(oniblock.key.currency1) ?? { symbol: 'token1', address: oniblock.key.currency1, decimals: 18 };
  // Quote = the USD-like token (lower decimals / "usd" in the symbol); same rule as services/config.ts pairMeta.
  const usd = tokens.find((t) => /usd/i.test(t.symbol));
  const baseIsToken0 =
    typeof raw.wethIsToken0 === 'boolean'
      ? raw.wethIsToken0
      : usd
        ? usd.address.toLowerCase() === token1.address.toLowerCase()
        : token1.decimals <= token0.decimals;
  const names: Record<string, Hex> = {};
  collectNames(raw, names);
  return {
    file,
    mtime: statSync(/*turbopackIgnore: true*/ file).mtimeMs,
    chainId: Number(raw.chainId ?? chainId),
    hook,
    poolManager: raw.poolManager as Address,
    stateView: raw.stateView as Address | undefined,
    roleOracle: raw.roleOracle as Address | undefined,
    roleOracleType: raw.roleOracleType as string | undefined,
    splitSwapRouter: (raw.splitSwapRouter ?? raw.splitRouter) as Address | undefined,
    quoter: raw.quoter as Address | undefined,
    settler: raw.settler as Address | undefined,
    attestor: raw.attestor as Address | undefined,
    deployer: raw.deployer as Address | undefined,
    deployBlock: Number(raw.deployBlock ?? raw.startBlock ?? 0),
    token0,
    token1,
    baseIsToken0,
    oniblock,
    vanilla,
    names,
    raw,
  };
}

// ------------------------------------------------------------------------------------------ ENS

export interface EnsDeployment {
  file: string;
  name?: string;
  owner?: Address;
  registry?: Address;
  resolver?: Address;
  roleOracle?: Address;
  universalResolver?: Address;
  quoterLabelId?: Hex;
  roleQuoter?: Hex;
  settlerLabelId?: Hex;
  roleSettler?: Hex;
  /** ENSIP-10 wildcard resolver on live.<name> (EnsSetup `add-live`), when deployed. */
  liveResolver?: Address;
  /** live.<name> and its namehash as EnsSetup `add-live` writes them (also under namehashes["live.<name>"]). */
  liveName?: string;
  liveNode?: Hex;
  namehashes: Record<string, Hex>;
}

/**
 * ENS_DEPLOYMENT_FILE, else deployments/<chainId>.ens.json, else (fork only)
 * deployments/<chainId>.anvil-fork.ens.json. Local 31337 has no ENS.
 */
export function loadEnsDeployment(chainId: number, isFork: boolean): EnsDeployment | undefined {
  const cands = [
    process.env.ENS_DEPLOYMENT_FILE,
    path.join(DEPLOYMENTS_DIR, `${chainId}.ens.json`),
    isFork ? path.join(DEPLOYMENTS_DIR, `${chainId}.anvil-fork.ens.json`) : undefined,
  ].filter(Boolean) as string[];
  for (const f of cands) {
    if (!existsSync(f)) continue;
    const j = readJson<EnsDeployment>(f);
    if (!j.namehashes) continue;
    return { ...j, file: f };
  }
  return undefined;
}

// ------------------------------------------------------------------------------------------ ABIs

export function abi(name: string): Abi {
  const f = path.join(ABIS_DIR, `${name}.json`);
  const j = readJson<unknown>(f);
  // forge artifacts ({abi: [...]}) or bare arrays
  return (Array.isArray(j) ? j : (j as { abi: Abi }).abi) as Abi;
}
