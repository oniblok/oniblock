/** Shared helpers: paths, minimal batched JSON-RPC client, seeded PRNG, stats (block bootstrap). */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Abi } from 'viem';

const here = dirname(fileURLToPath(import.meta.url));
export const BENCH_DIR = resolve(here, '..');
export const ROOT = resolve(BENCH_DIR, '..');
export const DATA_DIR = resolve(BENCH_DIR, 'data');
export const RESULTS_DIR = resolve(BENCH_DIR, 'results');
export const CONTRACTS_DIR = resolve(ROOT, 'contracts');
export const ABIS_DIR = resolve(ROOT, 'abis');

/** ABIs are read at runtime from ../abis so a regenerated hook ABI is picked up without code changes. */
export function loadAbi(name: string): Abi {
  const raw = JSON.parse(readFileSync(resolve(ABIS_DIR, `${name}.json`), 'utf8'));
  return (Array.isArray(raw) ? raw : raw.abi) as Abi;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString().slice(11, 19), event, ...data }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

// ------------------------------------------------------------------------------------------------ JSON-RPC

export class RpcError extends Error {
  constructor(
    public method: string,
    public data: unknown,
  ) {
    super(`${method}: ${JSON.stringify(data)}`);
  }
}

/** Tiny JSON-RPC client with request batching (one HTTP round trip per batch). */
export class Rpc {
  private id = 1;
  constructor(readonly url: string) {}

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const [r] = await this.batch<T>([[method, params]]);
    return r!;
  }

  /** Executes a batch; throws on transport errors, returns results in order (throws on the first RPC error). */
  async batch<T = unknown>(reqs: [string, unknown[]][]): Promise<T[]> {
    const res = await this.batchSettled<T>(reqs);
    return res.map((r, i) => {
      if ('error' in r) throw new RpcError(reqs[i]![0], r.error);
      return r.result;
    });
  }

  async batchSettled<T = unknown>(reqs: [string, unknown[]][]): Promise<({ result: T } | { error: unknown })[]> {
    if (!reqs.length) return [];
    const body = reqs.map(([method, params]) => ({ jsonrpc: '2.0', id: this.id++, method, params }));
    const r = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = (await r.json()) as { id: number; result?: T; error?: unknown }[];
    const byId = new Map(j.map((x) => [x.id, x]));
    return body.map((b) => {
      const x = byId.get(b.id);
      if (!x) return { error: 'missing response' };
      return x.error !== undefined ? { error: x.error } : { result: x.result as T };
    });
  }
}

// ------------------------------------------------------------------------------------------------ PRNG

/** mulberry32 */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function poisson(lambda: number, u: () => number): number {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= u();
  } while (p > L);
  return k - 1;
}

export function lognormal(median: number, u: () => number, sigma = 0.8): number {
  const z = Math.sqrt(-2 * Math.log(Math.max(1e-12, u()))) * Math.cos(2 * Math.PI * u());
  return median * Math.exp(sigma * z);
}

// ------------------------------------------------------------------------------------------------ stats

export interface CI {
  est: number;
  lo: number;
  hi: number;
}

/**
 * Circular moving-block bootstrap of the SUM of a per-block series (block length `len`), `B` resamples.
 * Returns the point estimate (actual sum) and the 2.5% / 97.5% percentiles of the resampled sums.
 */
export function blockBootstrapSum(x: number[], opts: { B?: number; len?: number; seed?: number } = {}): CI {
  const n = x.length;
  const est = x.reduce((a, b) => a + b, 0);
  if (n < 2) return { est, lo: est, hi: est };
  const B = opts.B ?? 2000;
  const len = Math.max(1, Math.min(n, opts.len ?? Math.max(10, Math.round(Math.sqrt(n)))));
  const u = rng(opts.seed ?? 12345);
  const nb = Math.ceil(n / len);
  const sums: number[] = new Array(B);
  for (let b = 0; b < B; b++) {
    let s = 0;
    let taken = 0;
    for (let k = 0; k < nb; k++) {
      const start = Math.floor(u() * n);
      for (let j = 0; j < len && taken < n; j++, taken++) s += x[(start + j) % n]!;
    }
    sums[b] = s;
  }
  sums.sort((a, b) => a - b);
  return { est, lo: sums[Math.floor(0.025 * B)]!, hi: sums[Math.floor(0.975 * B)]! };
}

export const round = (x: number, d = 2) => {
  const f = 10 ** d;
  return Math.round(x * f) / f;
};
