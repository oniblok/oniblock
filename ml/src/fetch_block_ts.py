"""Block timestamps for a list of mainnet blocks via public archive RPCs (batched eth_getBlockByNumber, backoff,
endpoint rotation, checkpointed). Read-only.

usage: python fetch_block_ts.py <blocks.parquet (column block)> <out.parquet>
"""
import sys, concurrent.futures as cf
import numpy as np, pandas as pd
from common import Rpc

RPCS = ["https://eth-mainnet.public.blastapi.io", "https://rpc.mevblocker.io"]
PER_TASK = 2000


def work(blocks):
    rpc = Rpc(RPCS[:], batch=50)
    rpc.i = int(blocks[0]) % len(RPCS)
    res = rpc.batch_call("eth_getBlockByNumber", [[hex(int(b)), False] for b in blocks])
    return [(int(r["number"], 16), int(r["timestamp"], 16)) for r in res]


def main(src, out):
    blocks = np.unique(pd.read_parquet(src).block.to_numpy(np.int64))
    done = pd.read_parquet(out) if __import__("os").path.exists(out) else pd.DataFrame({"block": [], "ts": []})
    todo = np.setdiff1d(blocks, done.block.to_numpy(np.int64))
    print("todo", len(todo), "done", len(done), flush=True)
    parts = [done]
    tasks = [todo[i:i + PER_TASK] for i in range(0, len(todo), PER_TASK)]
    with cf.ThreadPoolExecutor(4) as ex:
        for k, rows in enumerate(ex.map(work, tasks)):
            parts.append(pd.DataFrame(rows, columns=["block", "ts"]))
            if k % 10 == 9 or k == len(tasks) - 1:
                pd.concat(parts).astype("int64").drop_duplicates("block").to_parquet(out, index=False)
                print("saved", k + 1, len(tasks), flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
