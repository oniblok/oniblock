"""Parity fixture for services/src/model/tabular.ts: real rows of the oniblock1 data (keeper Features + the model inputs)
and oniblock1's p from the Python tree evaluator (train_tabular_v2.py predict_json, checked against LightGBM itself at
export). services/test/models-kev-tabular.test.ts reproduces the inputs and p from the Features to 1e-9.

Rows: 100 drawn from all splits of ml/train_kev4b/data/v2-fresh/tabular_features.parquet (build_v2.py --query-lag 3): 70 at
random, 30 from the top 5% of p (so the charged region p >= chargeThreshold is covered). Canonical orientation.

usage: python oniblock1_parity_fixture.py
"""
import json
import numpy as np, pandas as pd
from common import ML, MODELS, REPO
from build_v2 import FEATURE_FIELDS, INT_FIELDS, V2_INPUTS
from train_tabular_v2 import predict_json

DATA = ML / "train_kev4b" / "data" / "v2-fresh" / "tabular_features.parquet"
OUT = REPO / "services" / "test" / "fixtures" / "oniblock1-parity.json"


def main():
    m = json.load(open(MODELS / "oniblock1.json"))
    assert m["features"] == V2_INPUTS, m["features"]
    d = pd.read_parquet(DATA).sort_values(["ts", "pool"]).reset_index(drop=True)
    rng = np.random.default_rng(1)
    pool = d.iloc[rng.choice(len(d), 20000, replace=False)]
    p = predict_json(m, pool[[f"x_{c}" for c in V2_INPUTS]].to_numpy(float))
    top = np.flatnonzero(p >= np.quantile(p, 0.95))
    pick = np.concatenate([rng.choice(len(pool), 70, replace=False), rng.choice(top, 30, replace=False)])
    rows = []
    for i in pick:
        r = pool.iloc[i]
        rows.append({
            "features": {k: (int(r[f"f_{k}"]) if k in INT_FIELDS else float(r[f"f_{k}"])) for k in FEATURE_FIELDS},
            "x": [float(r[f"x_{c}"]) for c in V2_INPUTS],
            "p": float(p[i]),
        })
    OUT.write_text(json.dumps({"model": m["name"], "inputs": V2_INPUTS, "rows": rows}, separators=(",", ":")))
    ps = [r["p"] for r in rows]
    print(OUT, len(rows), "p range", min(ps), max(ps), "charged", sum(x >= m["chargeThreshold"] for x in ps))


if __name__ == "__main__":
    main()
