"""Build the block-level labelled dataset from individual Uniswap v3 Swap events + Binance 1s mids.

One row per (pool, target block t) in which at least one swap was in the arbitrage direction. Mirrors the keeper /
settler pipeline (services/src/keeper.ts, features.ts, settler.ts):

  keeper observes block t-1 at time  obs = ts(t) - 12 s:
     pool price P_obs  = pool price after the last swap at or before block t-1 (= price before t's first swap)
     oracle   M_obs    = Binance mid at obs (ETHUSDT 1s close / USDCUSDT 1m close; midAt semantics)
     features over the last 20 blocks (t-20 .. t-1): imbalance, nSwaps, arbShare, sizeToDepth; realized vol of the
     last 120 per-block (12 s) mids; attestationAge = 1 (a keeper that posts every block); baseFee = pool fee.
  label for block t (settler, SETTLER_LABEL_MID=cex):
     arb-direction swap: moves the pool toward M_obs (the mid the hook would have been attested for block t):
        isArbDir = (poolX96 > oracleX96) == zeroForOne, pool price taken just before the swap
     markout_usd = sum over t's arb-direction swaps of (swapper USDC delta + swapper WETH delta * M_t),
        M_t = Binance mid at ts(t); fees are inside the executed amounts
     y = 1 ("informed") iff markout_usd > 0.

usage: python build_blocks.py <tag> <pool> [<pool> ...]     (reads ml/raw/swaps_<tag>_<pool>.parquet)
"""
import sys
import numpy as np, pandas as pd
from common import DATA, RAW, Mids, WINDOW_BLOCKS, BLOCK_SECONDS

FEE = {"0.05": 500, "0.30": 3000}
POOL_ADDR = {"0.05": "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640", "0.30": "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8"}
Q96 = float(2 ** 96)

SEARCHERS = {  # Heimbach, Pahari, Schertenleib (IEEE S&P 2024), searcher mapping (ml/raw/heimbach_readme.md + notebook)
    "0xa69babef1ca67a37ffaf7a485dfff3382056e78c": "beaversearcher1",
    "0xa57bd00134b2850b2a1c55860c9e9ea100fdd6cf": "beaversearcher2",
    "0x57c1e0c2adf6eecdb135bcf9ec5f23b319be2c94": "builder1searcher",
    "0x9507c04b10486547584c37bcbd931b2a4fee9a41": "jumpsearcher",
    "0x0087bb802d9c0e343f00510000729031ce00bf27": "rsyncsearcher1",
    "0x280027dd00ee0050d3f9d168efd6b40090009246": "rsyncsearcher2",
    "0x51c72848c68a965f66fa7a88855f9f7784502a7f": "rsyncsearcher3",
    "0xf8b721bff6bf7095a0e10791ce8f998baa254fd0": "mantasearcher",
    "0xe8cfad4c75a5e1caf939fd80afcf837dde340a69": "searcher1",
    "0x00000000008c4fb1c916e0c88fd4cc402d935e7d": "searcher2",
    "0xd7f3fbe8c72a961a5515203eada59750437fa762": "searcher3",
    "0x000000000dfde7deaf24138722987c9a6991e2d4": "searcher4",
    "0x98c3d3183c4b8a650614ad179a1a98be0a8d6b8e": "searcher5",
    "0x5050e08626c499411b5d0e0b5af0e83d3fd82edf": "bot2",
    "0xbeefbabeea323f07c59926295205d3b7a17e8638": "bot4",
}


def tags_for(ts_min, ts_max):
    days = pd.date_range(pd.to_datetime(ts_min - 7200, unit="s").normalize(), pd.to_datetime(ts_max, unit="s").normalize(), freq="D")
    months = sorted({d.strftime("%Y-%m") for d in days})
    return months + [d.strftime("%Y-%m-%d") for d in days]


def build_pool(tag, pool, mids=None):
    sw = pd.read_parquet(RAW / f"swaps_{tag}_{pool}.parquet")
    fee = FEE[pool]
    sw = sw.sort_values(["block", "log_index"]).reset_index(drop=True)
    a0 = sw.amount0.astype(float).to_numpy()  # pool perspective, USDC raw (6 dp)
    a1 = sw.amount1.astype(float).to_numpy()  # pool perspective, WETH raw (18 dp)
    sq = sw.sqrtPriceX96.astype(float).to_numpy() / Q96
    L = sw.liquidity.astype(float).to_numpy()
    blk = sw.block.to_numpy(np.int64)
    ts = sw.ts.to_numpy(np.int64)
    p_after = 1e12 / sq ** 2              # USDC per WETH after the swap
    p_before = np.r_[np.nan, p_after[:-1]]
    depth0_after = L / sq                 # virtual token0 depth (raw USDC) = L * 2^96 / sqrtPriceX96
    zfo = a0 > 0                          # swapper sold token0 (USDC) -> bought WETH
    su, sw_eth = -a0 / 1e6, -a1 / 1e18    # swapper deltas

    # block timestamps: every target block has swaps -> ts known; obs time = ts(t) - 12 s
    if mids is None:
        mids = Mids(tags_for(ts.min(), ts.max()), tags_for(ts.min(), ts.max()))
    m_obs_swap = mids.mid(ts - BLOCK_SECONDS)   # oracle in force for each swap's block (keeper mid at t-1)
    m_now_swap = mids.mid(ts)
    arb = np.where(zfo, p_before < m_obs_swap, p_before > m_obs_swap) & np.isfinite(p_before) & np.isfinite(m_obs_swap)
    # (pool ETH cheaper than oracle -> arb buys ETH = sells USDC = zeroForOne)

    df = pd.DataFrame({"block": blk, "ts": ts, "a0abs": np.abs(a0), "signed0": np.where(zfo, -np.abs(a0), np.abs(a0)), "arb": arb,
                       "mk": np.where(arb, su + sw_eth * m_now_swap, 0.0), "fee_usd": np.where(arb, np.where(zfo, np.abs(a0) / 1e6, np.abs(a1) / 1e18 * m_now_swap) * fee / 1e6, 0.0),
                       "vol_usd": np.abs(a0) / 1e6, "arb_vol_usd": np.where(arb, np.abs(a0) / 1e6, 0.0),
                       "p_before": p_before, "p_after": p_after, "depth0": depth0_after,
                       "searcher": np.where(arb, sw.sender.str.lower().isin(SEARCHERS) | sw.recipient.str.lower().isin(SEARCHERS), False),
                       "searcher_any": sw.sender.str.lower().isin(SEARCHERS) | sw.recipient.str.lower().isin(SEARCHERS)})
    g = df.groupby("block", sort=True)
    B = pd.DataFrame({
        "ts": g.ts.first(), "n": g.size(), "abs0": g.a0abs.sum(), "signed0": g.signed0.sum(), "n_arb": g.arb.sum(),
        "markout_usd": g.mk.sum(), "fee_usd": g.fee_usd.sum(), "vol_usd": g.vol_usd.sum(), "arb_vol_usd": g.arb_vol_usd.sum(),
        "p_open": g.p_before.first(), "p_close": g.p_after.last(), "depth0_close": g.depth0.last(),
        "searcher": g.searcher.any(), "searcher_any": g.searcher_any.any(),
    })
    # per-block count of arb-direction swaps by the block's own oracle (for arbShare in later windows)
    blocks = B.index.to_numpy(np.int64)
    # rolling window sums over the previous 20 blocks (by block number, not by row)
    cs = lambda col: np.r_[0, np.cumsum(B[col].to_numpy(float))]
    c_n, c_abs, c_sig, c_arb = cs("n"), cs("abs0"), cs("signed0"), cs("n_arb")
    t = blocks
    hi = np.searchsorted(blocks, t - 1, side="right")                 # blocks <= t-1
    lo = np.searchsorted(blocks, t - 1 - WINDOW_BLOCKS, side="right")  # blocks <= t-21
    nS = c_n[hi] - c_n[lo]; tot = c_abs[hi] - c_abs[lo]; sig = c_sig[hi] - c_sig[lo]; na = c_arb[hi] - c_arb[lo]
    prev = hi - 1                                                       # last block with swaps <= t-1
    ok = prev >= 0
    P_obs = np.where(ok, B.p_close.to_numpy()[np.clip(prev, 0, None)], np.nan)
    depth0 = np.where(ok, B.depth0_close.to_numpy()[np.clip(prev, 0, None)], np.nan)
    obs = B.ts.to_numpy(np.int64) - BLOCK_SECONDS
    M_obs = mids.mid(obs)
    M_t = mids.mid(B.ts.to_numpy(np.int64))
    gap = np.abs(M_obs - P_obs) / P_obs * 1e6
    out = pd.DataFrame({
        "pool": pool, "pool_address": POOL_ADDR[pool], "fee_pips": fee, "block": t, "ts": B.ts.to_numpy(np.int64),
        "pool_price_obs": P_obs, "cex_mid_obs": M_obs, "cex_mid_t": M_t,
        "gapPips": np.floor(gap), "gapSign": np.sign(M_obs - P_obs),  # +1: pool price (token1/token0) above oracle = ETH cheap in pool
        "imbalance": np.where(tot > 0, sig / np.where(tot > 0, tot, 1), 0.0),
        "sizeToDepth": np.where((nS > 0) & (depth0 > 0), tot / np.maximum(nS, 1) / depth0, 0.0),
        "realizedVolBps": mids.vol_bps(obs),
        "attestationAge": 1, "nSwaps": nS.astype(int), "arbShare": np.where(nS > 0, na / np.maximum(nS, 1), 0.0), "baseFee": fee,
        "n_swaps_t": B.n.to_numpy(), "n_arb_swaps_t": B.n_arb.to_numpy(), "arb_vol_usd_t": B.arb_vol_usd.to_numpy(), "vol_usd_t": B.vol_usd.to_numpy(),
        "markout_usd": B.markout_usd.to_numpy(), "fee_usd": B.fee_usd.to_numpy(),
        "searcher_arb": B.searcher.to_numpy(), "searcher_any": B.searcher_any.to_numpy(),
        "p_open_t": B.p_open.to_numpy(), "p_close_t": B.p_close.to_numpy(),
    })
    # orientation-free derived features (ETH may be token0 or token1 in other pools)
    arb_buys_token0 = out.pool_price_obs > out.cex_mid_obs    # pool ETH expensive -> arb sells ETH (token1) for USDC (token0)
    out["imb_arb"] = np.where(arb_buys_token0, out.imbalance, -out.imbalance)
    out["edgePips"] = out.gapPips - fee
    out["y"] = (out.markout_usd > 0).astype(int)
    keep = (out.n_arb_swaps_t > 0) & np.isfinite(out.gapPips) & np.isfinite(out.cex_mid_t) & np.isfinite(out.realizedVolBps)
    print(tag, pool, "blocks with swaps", len(out), "labelled", int(keep.sum()), "base rate", round(out.y[keep].mean(), 4), flush=True)
    return out[keep].reset_index(drop=True)


if __name__ == "__main__":
    tag, pools = sys.argv[1], sys.argv[2:]
    parts = [build_pool(tag, p) for p in pools]
    df = pd.concat(parts).sort_values(["block", "pool"]).reset_index(drop=True)
    df.to_parquet(DATA / f"blocks_{tag}.parquet", index=False)
    print("wrote", DATA / f"blocks_{tag}.parquet", len(df))
