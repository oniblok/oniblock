"""Export the val-selected LightGBM model to a compact JSON evaluated by services/src/model/tabular.ts (no native deps).
Also writes parity fixtures (features -> p) so the TS evaluator can be tested against LightGBM's own predictions.
v1 pipeline, kept for reproducibility: reads and writes ml/runs/tabular-v1/ (train_tabular.py's output, gitignored) only.
The repo no longer ships tabular-v1; the production model is oniblock1 (ml/src/train_tabular_v2.py), whose TS parity
fixture is written by ml/src/oniblock1_parity_fixture.py.

JSON: {version, name, features: [...], base: 0, trees: [node...]}; node = {f, t, l, r} (go left iff x[f] <= t)
or {v} (leaf value, raw margin). p = sigmoid(sum of leaves).
"""
import json, pickle, hashlib
import numpy as np, pandas as pd
from common import DATA
from train_tabular import OUT, X

NAME, SRC = "tabular-v1", "lightgbm"  # train_tabular.py run name of the exported model


def conv(n):
    if "leaf_value" in n:
        return {"v": round(float(n["leaf_value"]), 10)}
    assert n["decision_type"] == "<=", n["decision_type"]
    return {"f": int(n["split_feature"]), "t": float(n["threshold"]), "l": conv(n["left_child"]), "r": conv(n["right_child"])}


def main():
    m = pickle.load(open(OUT / f"{SRC}.pkl", "rb"))
    d = m.booster_.dump_model(num_iteration=m.best_iteration_)
    out = {"version": 1, "name": NAME, "model": SRC, "objective": d["objective"],
           "features": d["feature_names"], "trees": [conv(t["tree_structure"]) for t in d["tree_info"]]}
    txt = json.dumps(out, separators=(",", ":"))
    (OUT / f"{NAME}.json").write_text(txt)
    te = pd.read_parquet(DATA / "test.parquet").sample(50, random_state=3)
    fx = [{"features": {k: (int(r[k]) if k in ("gapPips", "gapSign", "nSwaps", "attestationAge", "baseFee") else float(r[k]))
                        for k in ("gapPips", "gapSign", "imbalance", "sizeToDepth", "realizedVolBps", "attestationAge", "nSwaps", "arbShare", "baseFee")},
           "p": float(p)} for r, p in zip(te.to_dict("records"), m.predict_proba(X(te))[:, 1])]
    json.dump(fx, open(OUT / f"{NAME}-parity.json", "w"))
    print("trees", len(out["trees"]), "bytes", len(txt), "sha256", hashlib.sha256(txt.encode()).hexdigest())


if __name__ == "__main__":
    main()
