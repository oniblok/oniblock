/**
 * Server-only environment: repo paths, chain selection, RPC. Mirrors services/src/config.ts
 * (CHAIN = local | fork | sepolia) without importing it (that module loads dotenv at import time).
 *
 * Secrets: SEPOLIA_RPC_HTTPS (reads) and, for the public Swap button, SWAPPER_PK / *_ADDR labels are read from the
 * root .env on demand (rootEnv). Nothing from
 * .env is ever sent to the browser.
 */
import 'server-only';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defineChain, type Chain } from 'viem';
import { foundry, sepolia } from 'viem/chains';

export const ROOT = process.env.ONIBLOCK_ROOT ?? path.resolve(process.cwd(), '..');
export const DEPLOYMENTS_DIR = path.join(ROOT, 'deployments');
export const ABIS_DIR = path.join(ROOT, 'abis');
export const RUNTIME_DIR = path.join(ROOT, '.runtime');
export const KEEPER_FLAGS_FILE = process.env.KEEPER_FLAGS_FILE ?? path.join(RUNTIME_DIR, 'keeper-flags.json');

export type ChainName = 'local' | 'fork' | 'sepolia';

/** Read a single whitelisted key from the root .env without loading the rest into process.env. */
export function rootEnv(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  const f = path.join(ROOT, '.env');
  if (!existsSync(f)) return undefined;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && m[1] === key) return m[2]!.replace(/^['"]|['"]$/g, '');
  }
  return undefined;
}

export interface ChainSel {
  name: ChainName;
  chain: Chain;
  rpcUrl: string;
  /** anvil (local or fork): dev controls allowed, anvil default keys usable server-side. */
  isDev: boolean;
}

export function chainSel(): ChainSel {
  const name = (process.env.CHAIN ?? 'local') as ChainName;
  switch (name) {
    case 'fork': {
      const id = Number(process.env.FORK_CHAIN_ID ?? 11155111);
      return {
        name,
        chain: defineChain({ ...sepolia, id, name: `sepolia-fork-${id}` }),
        rpcUrl: process.env.FORK_RPC ?? process.env.LOCAL_RPC ?? 'http://127.0.0.1:8545',
        isDev: true,
      };
    }
    case 'sepolia': {
      const rpc = rootEnv('SEPOLIA_RPC_HTTPS');
      if (!rpc) throw new Error('CHAIN=sepolia but SEPOLIA_RPC_HTTPS is not set');
      return { name, chain: sepolia, rpcUrl: rpc, isDev: false };
    }
    default:
      return { name: 'local', chain: foundry, rpcUrl: process.env.LOCAL_RPC ?? 'http://127.0.0.1:8545', isDev: true };
  }
}
