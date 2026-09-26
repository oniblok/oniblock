/**
 * /api/feed: everything the live screen needs in one poll.
 *
 *  - rows: the latest swaps on the Oniblock pool (hook Receipt events) with the attestation in force, the fee
 *    charged vs the base fee, the trader label and, once the next attestation lands, the swapper's markout.
 *  - chart: LP P&L vs the attested CEX mid per block bucket, Oniblock pool vs the vanilla pool next to it.
 *    LP P&L of a swap = −(swapper markout at the next attested mid), the settler's convention. Event data only,
 *    so it works on public RPCs without archive state.
 */
import 'server-only';
import type { Address, Hex } from 'viem';
import type { FeedBucket, FeedJson, FeedRow, Trader } from '../types';
import { ctx, nameOf, tryRead, type Ctx } from './chain';
import { devAccount } from './devkeys';
import { rootEnv } from './env';
import { firstAfter, inForce, loadStore, order, readConfig, type Att } from './live';
import { priceX96ToMid, Q96, sqrtPriceX96ToMid } from './shared';
import { swapEnabled, SWAP_LIMITS } from './swap';

const fromCache = new Map<string, Address>();
const tsCache = new Map<number, number>();

function traders(c: Ctx): Map<string, Trader> {
  const m = new Map<string, Trader>();
  const add = (a: string | undefined, t: Trader) => a && m.set(a.toLowerCase(), t);
  if (c.sel.isDev) {
    add(devAccount('arb').address, 'arb');
    add(devAccount('retail').address, 'retail');
    add(devAccount('swapper').address, 'demo');
  }
  add(rootEnv('ARB_ADDR'), 'arb');
  add(rootEnv('RETAIL_ADDR'), 'retail');
  add(rootEnv('SWAPPER_ADDR'), 'demo');
  return m;
}

export async function getFeed(opts: { rows?: number; windowBlocks?: number; buckets?: number } = {}): Promise<FeedJson> {
  const c = await ctx();
  const o = order(c);
  const headBlk = await c.pc.getBlock();
  const head = Number(headBlk.number);
  const s = await loadStore(c, head);
  const cfg = await readConfig(c);
  const atts: Att[] = [...s.atts].sort((a, b) => a.mined - b.mined);
  const d0 = 10 ** c.d.token0.decimals;
  const d1 = 10 ** c.d.token1.decimals;
  const bIs0 = c.d.baseIsToken0;
  const human = (a0: bigint, a1: bigint) => ({ base: bIs0 ? Number(a0) / d0 : Number(a1) / d1, quote: bIs0 ? Number(a1) / d1 : Number(a0) / d0 });
  const valueAt = (a0: bigint, a1: bigint, midX96: bigint) => {
    const h = human(a0, a1);
    return h.base * priceX96ToMid(midX96, o) + h.quote;
  };
  /** swapper markout at the next attested mid (null if none yet) */
  const markout = (block: number, a0: bigint, a1: bigint) => {
    const nx = firstAfter(atts, block);
    return nx ? valueAt(a0, a1, nx.midX96) : null;
  };

  // ------------------------------------------------------------------ rows
  const nRows = opts.rows ?? 60;
  const rcpts = [...s.rcpts].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex).slice(-nRows);
  const newTx = [...new Set(rcpts.map((r) => r.tx))].filter((h) => !fromCache.has(h));
  const newBlocks = [...new Set(rcpts.map((r) => r.block))].filter((b) => !tsCache.has(b));
  await Promise.all([
    ...newTx.map((h) => c.pc.getTransaction({ hash: h }).then((t) => fromCache.set(h, t.from)).catch(() => undefined)),
    ...newBlocks.map((b) => c.pc.getBlock({ blockNumber: BigInt(b) }).then((x) => tsCache.set(b, Number(x.timestamp))).catch(() => undefined)),
  ]);
  const who = traders(c);
  const rows: FeedRow[] = rcpts.map((r) => {
    const a = inForce(atts, r.block);
    const h = human(r.a0, r.a1);
    const mid = a ? priceX96ToMid(a.midX96, o) : null;
    // what the swapper paid, in quote units (quote leg when no attested mid yet)
    const usd = h.base < 0 && mid !== null ? -h.base * mid : Math.abs(h.quote);
    const p = a?.p ?? null;
    const conf = a?.conf ?? null;
    const from = fromCache.get(r.tx) ?? '0x';
    return {
      tx: r.tx,
      logIndex: r.logIndex,
      block: r.block,
      ts: tsCache.get(r.block) ?? Number(headBlk.timestamp) - (head - r.block) * 12,
      side: h.base > 0 ? 'buy' : 'sell',
      baseAmount: Math.abs(h.base),
      quoteAmount: Math.abs(h.quote),
      usd,
      feePips: r.fee,
      baseFeePips: cfg.baseFee,
      feeUsd: (usd * r.fee) / 1e6,
      extraUsd: (usd * Math.max(0, r.fee - cfg.baseFee)) / 1e6,
      arbDir: r.arbDir,
      stale: r.stale,
      gapPips: r.gap,
      kBps: r.k,
      pToxicBps: p,
      confidenceBps: conf,
      score: r.arbDir && !r.stale && p !== null && conf !== null ? (p * conf) / 1e8 : 0,
      model: nameOf(c, r.node) ?? null,
      trader: who.get(from.toLowerCase()) ?? null,
      from,
      markoutUsd: markout(r.block, r.a0, r.a1),
    };
  });

  // ------------------------------------------------------------------ chart
  const W = opts.windowBlocks ?? Number(process.env.APP_FEED_WINDOW ?? (c.sel.isDev ? 240 : 300));
  const B = opts.buckets ?? 40;
  const start = Math.max(c.d.deployBlock, head - W + 1);
  const span = Math.max(1, head - start + 1);
  const size = Math.max(1, Math.ceil(span / B));
  const buckets: FeedBucket[] = [];
  for (let b = start; b <= head; b += size) buckets.push({ fromBlock: b, toBlock: Math.min(head, b + size - 1), oni: 0, van: 0, oniCum: 0, vanCum: 0, swaps: 0 });
  const put = (tag: 'oni' | 'van', block: number, lp: number) => {
    const i = Math.floor((block - start) / size);
    const bk = buckets[i];
    if (!bk) return;
    bk[tag] += lp;
    if (tag === 'oni') bk.swaps++;
  };
  for (const [tag, pool] of [['oni', c.d.oniblock], ['van', c.d.vanilla]] as const) {
    if (!pool) continue;
    for (const w of s.swaps[pool.poolId] ?? []) {
      if (w.block < start) continue;
      const m = markout(w.block, w.a0, w.a1) ?? (inForce(atts, w.block) ? valueAt(w.a0, w.a1, inForce(atts, w.block)!.midX96) : null);
      if (m !== null) put(tag, w.block, -m);
    }
  }
  let oc = 0;
  let vc = 0;
  for (const bk of buckets) {
    oc += bk.oni;
    vc += bk.van;
    bk.oniCum = oc;
    bk.vanCum = vc;
  }

  // ------------------------------------------------------------------ market + model now
  const id = c.d.oniblock.poolId;
  const [ps, q0, q1, s0, liq] = await Promise.all([
    tryRead<readonly [Record<string, unknown>, Record<string, unknown>, boolean]>(c, 'poolState', [id]),
    tryRead<readonly [number, boolean, number, boolean]>(c, 'quoteFee', [c.d.oniblock.key, true]),
    tryRead<readonly [number, boolean, number, boolean]>(c, 'quoteFee', [c.d.oniblock.key, false]),
    c.pc.readContract({ address: c.d.stateView!, abi: c.stateViewAbi, functionName: 'getSlot0', args: [id] }) as Promise<readonly [bigint]>,
    c.pc.readContract({ address: c.d.stateView!, abi: c.stateViewAbi, functionName: 'getLiquidity', args: [id] }) as Promise<bigint>,
  ]);
  const st = ps?.[0] ?? {};
  const oracleX96 = BigInt((st.oracleMidX96 as bigint | undefined) ?? 0n);
  const sqrtP = s0[0];
  const r0 = sqrtP > 0n ? Number((liq * Q96) / sqrtP) / d0 : 0;
  const r1 = Number((liq * sqrtP) / Q96) / d1;
  const dq = (q?: readonly [number, boolean, number, boolean]) => ({ feePips: Number(q?.[0] ?? cfg.baseFee), arbDir: !!q?.[1] });
  const z = dq(q0);
  const nz = dq(q1);
  const n = (x: unknown) => Number(x ?? 0);

  const explorer = c.sel.name === 'sepolia' ? 'https://sepolia.etherscan.io' : null;
  return JSON.parse(
    JSON.stringify({
      chain: { name: c.sel.name, chainId: c.d.chainId, block: head, ts: Number(headBlk.timestamp), explorer, ensName: c.ens?.name ?? null },
      pair: { base: bIs0 ? c.d.token0.symbol : c.d.token1.symbol, quote: bIs0 ? c.d.token1.symbol : c.d.token0.symbol, baseIsToken0: bIs0 },
      baseFeePips: cfg.baseFee,
      vanillaFeePips: c.d.vanilla?.key.fee ?? null,
      model: {
        name: nameOf(c, st.modelNode as Hex | undefined) ?? null,
        pToxicBps: n(st.pToxicBps),
        confidenceBps: n(st.confidenceBps),
        kBps: n(st.kBps),
        stale: !!ps?.[2],
        lastAttestBlock: n(st.lastAttestBlock),
      },
      market: {
        oracleMid: oracleX96 > 0n ? priceX96ToMid(oracleX96, o) : null,
        poolMid: sqrtPriceX96ToMid(sqrtP, o),
        reserveBase: bIs0 ? r0 : r1,
        reserveQuote: bIs0 ? r1 : r0,
        sellBase: bIs0 ? z : nz,
        buyBase: bIs0 ? nz : z,
      },
      chart: { buckets, oniTotal: oc, vanTotal: vc, windowBlocks: span },
      rows,
      swapEnabled: swapEnabled(c),
      swapLimits: SWAP_LIMITS,
    } satisfies FeedJson, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  );
}
