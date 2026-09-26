"""Time-based splits of dataset B (recent mainnet) + text states + Kev JSONL exports.

train = oldest 50% of B (by block time), val = next 25%, test = most recent 25% (held out; read once).
Dataset A (HF 2021-2023, optional) is kept separate for pretraining / out-of-period evaluation.
Adds the text state (python port of services/src/features.ts featuresToState, plain-pool wording) to every row.
"""
import json
import numpy as np, pandas as pd
from common import DATA
from states import features_to_state, row_features, heuristic_p, KEV_QUESTION

FEATURES = ["gapPips", "edgePips", "baseFee", "imb_arb", "abs_imbalance", "sizeToDepth", "realizedVolBps", "nSwaps", "arbShare"]


def add_cols(df):
    df = df.copy()
    df["abs_imbalance"] = df.imbalance.abs()
    df["state"] = [features_to_state(row_features(r)) for r in df.to_dict("records")]
    df["p_heuristic"] = [heuristic_p(row_features(r)) for r in df.to_dict("records")]
    df["hour"] = df.ts // 3600
    return df


def kev_record(r):
    q = dict(KEV_QUESTION)
    q["label"] = bool(r["y"])
    return {"state": r["state"], "questions": {"informed": q}}


def write_jsonl(df, path):
    with open(path, "w") as f:
        for r in df.to_dict("records"):
            f.write(json.dumps(kev_record(r)) + "\n")


def main():
    b = add_cols(pd.read_parquet(DATA / "blocks_B26.parquet")).sort_values(["ts", "pool"]).reset_index(drop=True)
    q50, q75 = np.quantile(b.ts, [0.5, 0.75])
    b["split"] = np.where(b.ts < q50, "train", np.where(b.ts < q75, "val", "test"))
    for s in ("train", "val", "test"):
        b[b.split == s].to_parquet(DATA / f"{s}.parquet", index=False)
        print(s, (b.split == s).sum(), pd.to_datetime(b[b.split == s].ts.min(), unit="s"), pd.to_datetime(b[b.split == s].ts.max(), unit="s"), round(b[b.split == s].y.mean(), 4))
    for extra in ("O23", "A"):
        p = DATA / f"blocks_{extra}.parquet"
        if p.exists():
            add_cols(pd.read_parquet(p)).to_parquet(DATA / f"{extra.lower()}_eval.parquet", index=False)
            print("wrote", extra)


if __name__ == "__main__":
    main()
