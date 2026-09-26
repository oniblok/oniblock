"""Dead-band relabel + Kev JSONL export for the training package.

Label noise: ~59% of blocks have |markout| < $1, where the sign is decided by 1 s mid noise.
Dead band: T = max($1, 1 bp of the block's arbitrage-direction USD volume).
  informed (y=1)  iff markout_usd >  T
  benign   (y=0)  iff markout_usd < -T
  rows with |markout_usd| <= T are DROPPED from train/val/test (undecidable).
usage: python kev_export_deadband.py [out_dir=../train_kev4b/data]
"""
import sys, json, hashlib
from pathlib import Path
import numpy as np, pandas as pd
from common import DATA
from make_splits import write_jsonl

def deadband(df):
    T = np.maximum(1.0, 1e-4 * df["arb_vol_usd_t"].to_numpy())
    m = df["markout_usd"].to_numpy()
    keep = np.abs(m) > T
    out = df.loc[keep].copy()
    out["y"] = (out["markout_usd"] > 0).astype(int)
    return out, int(len(df)), int(keep.sum())

def main(out_dir="../train_kev4b/data"):
    out = (Path(__file__).parent / out_dir).resolve(); out.mkdir(parents=True, exist_ok=True)
    stats = {}
    for split, name in (("train","train"),("val","val"),("test","test")):
        df = pd.read_parquet(DATA / f"{split}.parquet")
        f, n0, n1 = deadband(df)
        f = f.sort_values(["ts","pool"])
        write_jsonl(f, out / f"{name}.jsonl")
        stats[name] = {"rows_before": n0, "rows_after": n1, "dropped_pct": round(100*(1-n1/n0),1),
                       "base_rate": round(float(f.y.mean()),4),
                       "from": str(pd.to_datetime(f.ts.min(), unit="s")), "to": str(pd.to_datetime(f.ts.max(), unit="s"))}
        if name == "train":
            write_jsonl(f.sample(min(20000,len(f)), random_state=0).sort_values(["ts","pool"]), out / "train_20k.jsonl")
        if name == "val":
            write_jsonl(f.sample(1000, random_state=0).sort_values(["ts","pool"]), out / "val_1k.jsonl")
        if name == "test":
            write_jsonl(f.sample(3000, random_state=0).sort_values(["ts","pool"]), out / "test_3k.jsonl")
    for p in sorted(out.glob("*.jsonl")):
        stats.setdefault("files", {})[p.name] = {"lines": sum(1 for _ in open(p)), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
    (out.parent / "manifest.json").write_text(json.dumps({"label": "dead-band: y=1 iff markout > max($1, 1bp arb volume); y=0 iff markout < -T; |markout|<=T dropped", **stats}, indent=1))
    print(json.dumps(stats, indent=1))

if __name__ == "__main__":
    main(*sys.argv[1:])
