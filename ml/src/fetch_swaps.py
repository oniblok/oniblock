"""Fetch Uniswap v3 Swap events for USDC/WETH pools over a block range via public mainnet RPC (eth_getLogs, chunked,
retries/backoff, endpoint rotation). Read-only.

usage: python fetch_swaps.py <tag> <fromBlock> <toBlock> <pool=0.05|0.30> ...
Output: ml/raw/swaps_<tag>_<pool>.parquet with pool-perspective amounts (v3 Swap event convention: positive = paid INTO
the pool by the swapper), sqrtPriceX96 after the swap, liquidity, tick, sender/recipient, tx hash, log index, block
timestamp (from the log's blockTimestamp field when the node provides it).
"""
import sys, concurrent.futures as cf
import pandas as pd
from common import RAW, Rpc

POOLS = {"0.05": "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640", "0.30": "0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8"}
SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
RPCS = ["https://rpc.mevblocker.io", "https://mainnet.gateway.tenderly.co"]
CHUNK = 2000


def s256(h):
    v = int(h, 16)
    return v - (1 << 256) if v >= 1 << 255 else v


def s24(v):
    v &= (1 << 24) - 1
    return v - (1 << 24) if v >= 1 << 23 else v


def get_chunk(rpc, addr, a, b):
    try:
        return rpc.call("eth_getLogs", [{"address": addr, "topics": [SWAP_TOPIC], "fromBlock": hex(a), "toBlock": hex(b)}])
    except RuntimeError as e:
        if b - a < 50:
            raise
        m = (a + b) // 2
        return get_chunk(rpc, addr, a, m) + get_chunk(rpc, addr, m + 1, b)


def decode(logs):
    rows = []
    for l in logs:
        d = l["data"][2:]
        w = [d[i:i + 64] for i in range(0, len(d), 64)]
        rows.append({
            "block": int(l["blockNumber"], 16),
            "ts": int(l["blockTimestamp"], 16) if l.get("blockTimestamp") else -1,
            "tx_index": int(l["transactionIndex"], 16),
            "log_index": int(l["logIndex"], 16),
            "tx": l["transactionHash"],
            "sender": "0x" + l["topics"][1][-40:],
            "recipient": "0x" + l["topics"][2][-40:],
            "amount0": str(s256(w[0])),
            "amount1": str(s256(w[1])),
            "sqrtPriceX96": str(int(w[2], 16)),
            "liquidity": str(int(w[3], 16)),
            "tick": s24(int(w[4], 16)),
        })
    return rows


def main(tag, a, b, pools):
    for pool in pools:
        addr = POOLS[pool]
        out = RAW / f"swaps_{tag}_{pool}.parquet"
        if out.exists():
            print("exists", out); continue
        rngs = [(x, min(b, x + CHUNK - 1)) for x in range(a, b + 1, CHUNK)]
        rows = []
        with cf.ThreadPoolExecutor(3) as ex:
            futs = {ex.submit(get_chunk, Rpc(RPCS), addr, x, y): (x, y) for x, y in rngs}
            for k, f in enumerate(cf.as_completed(futs)):
                rows += decode(f.result())
                if k % 10 == 0:
                    print(pool, k, len(rngs), len(rows), flush=True)
        df = pd.DataFrame(rows).sort_values(["block", "log_index"]).reset_index(drop=True)
        df.to_parquet(out, index=False)
        print("wrote", out, len(df), flush=True)


if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4:])
