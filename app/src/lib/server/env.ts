/**
 * Server-only environment: repo paths, chain selection, RPC. Mirrors services/src/config.ts
 * (CHAIN = local | fork | sepolia) without importing it (that module loads dotenv at import time).
 *
 * Secrets: SEPOLIA_RPC_ALCHEMY (preferred for every call) / SEPOLIA_RPC_HTTPS (public; wide eth_getLogs first) and, for the public Swap button, SWAPPER_PK / *_ADDR labels are read from the
 * root .env on demand (rootEnv). Nothing from
 * .env is ever sent to the browser.
 */
import 'server-only';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defineChain, http, type Chain, type Transport } from 'viem';
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
  /** Max eth_getLogs block range of the main provider (Alchemy free tier: 10); wider queries are split. */
  logsSpan?: number;
  /** Public endpoint tried first for wide eth_getLogs, before splitting on the main provider. */
  logsRpcUrl?: string;
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
      // Same routing as services/src/config.ts: Alchemy (if set) for every call; wide eth_getLogs try the public
      // endpoint first and fall back to SEPOLIA_LOGS_SPAN-block pieces on Alchemy (free tier caps getLogs at 10 blocks).
      const alchemy = rootEnv('SEPOLIA_RPC_ALCHEMY');
      const pub = rootEnv('SEPOLIA_RPC_HTTPS');
      const rpc = alchemy ?? pub;
      if (!rpc) throw new Error('CHAIN=sepolia but neither SEPOLIA_RPC_ALCHEMY nor SEPOLIA_RPC_HTTPS is set');
      return { name, chain: sepolia, rpcUrl: rpc, logsSpan: alchemy ? Number(rootEnv('SEPOLIA_LOGS_SPAN') ?? 10) : undefined, logsRpcUrl: alchemy ? pub : undefined, isDev: false };
    }
    default:
      return { name: 'local', chain: foundry, rpcUrl: process.env.LOCAL_RPC ?? 'http://127.0.0.1:8545', isDev: true };
  }
}

/** http transport for the chain. With `logsSpan` set (SEPOLIA_LOGS_SPAN, e.g. 10 on Alchemy free tier), wide eth_getLogs are split. */
export function rpcTransport(sel: ChainSel, opts: Parameters<typeof http>[1] = { retryCount: 5, retryDelay: 500 }): Transport {
  const main = http(sel.rpcUrl, opts);
  if (!sel.logsSpan) return main;
  const span = sel.logsSpan;
  // eth_getLogs: the public endpoint first (wide ranges allowed); if it refuses (rate limit), split on the main provider.
  const pub = sel.logsRpcUrl ? http(sel.logsRpcUrl, { retryCount: 1, retryDelay: 300, timeout: 15_000 }) : undefined;
  return ((args: Parameters<Transport>[0]) => {
    const m = main(args);
    const request = m.request as unknown as (r: { method: string; params?: unknown }) => Promise<unknown>;
    const pubReq = pub ? (pub(args).request as unknown as (r: { method: string; params?: unknown }) => Promise<unknown>) : undefined;
    const getLogs = async (req: { method: string; params?: unknown }) => {
      const q = (req.params as [Record<string, unknown>] | undefined)?.[0];
      const lo = typeof q?.fromBlock === 'string' && q.fromBlock.startsWith('0x') ? BigInt(q.fromBlock) : undefined;
      const hi = typeof q?.toBlock === 'string' && q.toBlock.startsWith('0x') ? BigInt(q.toBlock) : undefined;
      if (lo !== undefined && hi !== undefined && hi - lo < BigInt(span)) return request(req); // narrow: main provider directly
      if (pubReq) {
        try {
          return await pubReq(req);
        } catch {
          /* fall through to the split query on the main provider */
        }
      }
      return chunkedGetLogs(request, req, span);
    };
    return { ...m, request: ((req: { method: string; params?: unknown }) => (req.method === 'eth_getLogs' ? getLogs(req) : request(req))) as unknown as typeof m.request };
  }) as Transport;
}

/** eth_getLogs over [from, to] split into `span`-block pieces (Alchemy free tier: 10), a few in flight at a time. */
async function chunkedGetLogs(request: (r: { method: string; params?: unknown }) => Promise<unknown>, req: { method: string; params?: unknown }, span: number): Promise<unknown> {
  const p = (req.params as [Record<string, unknown>])?.[0];
  const hex = (v: unknown) => (typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v) ? BigInt(v) : undefined);
  const from = hex(p?.fromBlock);
  const to = hex(p?.toBlock);
  if (!p || from === undefined || to === undefined || to - from < BigInt(span) || p.blockHash) return request(req);
  const parts: [bigint, bigint][] = [];
  for (let a = from; a <= to; a += BigInt(span)) parts.push([a, a + BigInt(span) - 1n > to ? to : a + BigInt(span) - 1n]);
  const out: unknown[][] = new Array(parts.length);
  let next = 0;
  const worker = async () => {
    while (next < parts.length) {
      const i = next++;
      const [a, b] = parts[i]!;
      out[i] = (await request({ method: 'eth_getLogs', params: [{ ...p, fromBlock: `0x${a.toString(16)}`, toBlock: `0x${b.toString(16)}` }] })) as unknown[];
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, parts.length) }, worker));
  return out.flat();
}
