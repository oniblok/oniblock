"""Export Kev (System One `noul`) JSONL files from the splits.

  ml/data/kev/train_<n>.jsonl   random subsample of the train split (all of it with n=all)
  ml/data/kev/val_1000.jsonl     random val subsample (temperature fit / checkpoint choice)
  ml/data/kev/test_3000.jsonl    random test subsample (read once; the same rows are scored for every model)
  ml/data/kev/*.keys.parquet     (pool, block, y) in file order, to join predictions back
usage: python kev_export.py [n_train=3000]
"""
import sys
import pandas as pd
from common import DATA
from make_splits import write_jsonl

OUT = DATA / "kev"


def export(df, name):
    OUT.mkdir(parents=True, exist_ok=True)
    write_jsonl(df, OUT / f"{name}.jsonl")
    df[["pool", "block", "y"]].to_parquet(OUT / f"{name}.keys.parquet", index=False)
    print(name, len(df), round(df.y.mean(), 4))


def main(n_train="3000"):
    tr, va, te = (pd.read_parquet(DATA / f"{s}.parquet") for s in ("train", "val", "test"))
    trs = tr if n_train == "all" else tr.sample(int(n_train), random_state=0).sort_values(["ts", "pool"])
    export(trs, f"train_{n_train}")
    export(va.sample(1000, random_state=0).sort_values(["ts", "pool"]), "val_1000")
    export(te.sample(3000, random_state=0).sort_values(["ts", "pool"]), "test_3000")


if __name__ == "__main__":
    main(*sys.argv[1:])
