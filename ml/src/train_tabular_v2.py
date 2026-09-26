"""tabular-v2: LightGBM on the v1 tabular inputs + edgeSigma, vol5mBps, ret12Bps, ret36Bps, ret900Bps, sgap.

Reads ml/train_kev4b/data/v2/tabular_features.parquet (build_v2.py). Never reads test.
  train  : curated train rows (build_v2.py); early stopping on a train-internal time holdout (latest 15% of train,
           dead-band rows, logloss), then refit on all of train with the best iteration count scaled by 1 / 0.85.
  variants: label design  "deadband" = dead-band rows only, unweighted
                          "weighted" = ALL rows, y = markout > 0, weight min(|markout| / T, 1)  (T = dead-band threshold)
            x a small grid over num_leaves / min_child_samples.
  selection: on VALIDATION (dead-band rows, uncurated, same rows as v1) by TPR at the one-sided threshold with FPR <= 5%.
  threshold: smallest t on the 1e-4 grid with val FPR(p >= t) <= 5%, stored in the JSON as chargeThreshold.
Compares with tabular-v1 (ml/models/tabular-v1.json, scored by the same tree evaluator the keeper uses) and with a v1-inputs
LightGBM retrained in this pipeline. Writes ml/models/tabular-v2.json (format of services/src/model/tabular.ts) and
ml/models/tabular_v2_results.json.

usage: python train_tabular_v2.py
       python train_tabular_v2.py --data ml/train_kev4b/data/v2-fresh --name oniblock1 \
           --results ml/models/oniblock1_results.json      (oniblock1, the production model: fresh-CEX data, build_v2.py --query-lag 3)
"""
import argparse, json, math, hashlib
from pathlib import Path
import numpy as np, pandas as pd
import lightgbm as lgb
from sklearn.metrics import roc_auc_score
from common import MODELS, ece
from build_v2 import OUT, V1_INPUTS, V2_INPUTS

NODE = "tabular-v2.models.oniblock.eth"
FPR_MAX = 0.05
HOLD_FRAC = 0.15
BASE = dict(n_estimators=4000, learning_rate=0.03, subsample=0.8, subsample_freq=1, colsample_bytree=0.8, reg_lambda=1.0, verbose=-1)
GRID = [dict(num_leaves=nl, min_child_samples=mc) for nl in (15, 31, 63) for mc in (100, 300)]


def op_point(p, y, fpr_max=FPR_MAX, t=None):
    """One-sided rule charged = p >= t. If t is None: smallest t on the 1e-4 grid with FPR <= fpr_max."""
    p, y = np.asarray(p, float), np.asarray(y, int)
    if t is None:
        grid = np.round(np.arange(0, 10001) / 1e4, 4)
        neg = np.sort(p[y == 0])
        fpr = (len(neg) - np.searchsorted(neg, grid, side="left")) / len(neg)
        t = float(grid[np.argmax(fpr <= fpr_max)])
    c = p >= t
    tp, fp = int((c & (y == 1)).sum()), int((c & (y == 0)).sum())
    return {"threshold": t, "coverage": round(c.mean(), 4), "pass_rate": round(tp / max(1, c.sum()), 4),
            "fpr": round(fp / max(1, (y == 0).sum()), 4), "tpr": round(tp / max(1, (y == 1).sum()), 4), "charged": int(c.sum())}


def metrics(p, y, t=None):
    return {"auc": round(float(roc_auc_score(y, p)), 4), "brier": round(float(np.mean((p - y) ** 2)), 4),
            "ece": round(float(ece(p, y)), 4), "mean_p": round(float(np.mean(p)), 4), **op_point(p, y, t=t)}


def conv(n):
    if "leaf_value" in n:
        return {"v": round(float(n["leaf_value"]), 10)}
    assert n["decision_type"] == "<=", n["decision_type"]
    assert n.get("missing_type", "None") in ("None", None), n.get("missing_type")  # no NaN in training -> plain <= split
    return {"f": int(n["split_feature"]), "t": float(n["threshold"]), "l": conv(n["left_child"]), "r": conv(n["right_child"])}


def export(booster, name):
    d = booster.dump_model()
    return {"version": 2, "name": name, "model": "lightgbm", "objective": d["objective"], "features": d["feature_names"],
            "trees": [conv(t["tree_structure"]) for t in d["tree_info"]]}


def summary(name, n_trees, n_features, lag):
    s = (f"{name}: LightGBM gradient-boosted decision trees ({n_trees} trees, binary logistic: p = sigmoid(sum of leaf values)) "
         f"over {n_features} features: pool gap to Binance, edge over the base fee, base fee, arb-direction and absolute flow imbalance, "
         "size to depth, realized volatility, swap count, arb share, gap / fee, log size, edge in sigmas, 5 min volatility, 12 s / 36 s / 15 min "
         "Binance returns and the signed gap. Trained on real mainnet blocks")
    if lag is None:
        return s + "."
    s += f" with the Binance features read ~{lag - 1} s before the block"
    return s + (", so it is meant for a keeper whose post lands first in the block." if lag - 1 <= 2 else ".")


def predict_json(m, X):
    """Same evaluation as services/src/model/tabular.ts predictTabular (go left iff x[f] <= t; p = sigmoid(sum))."""
    X = np.asarray(X, float)
    z = np.zeros(len(X))
    for tree in m["trees"]:
        for i in range(len(X)):
            n = tree
            while "v" not in n:
                n = n["l"] if X[i, n["f"]] <= n["t"] else n["r"]
            z[i] += n["v"]
    return 1 / (1 + np.exp(-z))


def cols(feats):
    return [f"x_{c}" for c in feats]


def fit(tr, feats, variant, hp):
    """Early stopping on the latest HOLD_FRAC of train (dead-band rows), refit on all train with the scaled best iteration."""
    if variant == "deadband":
        tr = tr[tr.in_deadband]
        w = np.ones(len(tr))
    else:
        w = np.minimum(np.abs(tr.markout_usd.to_numpy()) / tr["T"].to_numpy(), 1.0)
    cut = np.quantile(tr.ts, 1 - HOLD_FRAC)
    a, h = (tr.ts < cut).to_numpy(), (tr.ts >= cut).to_numpy() & tr.in_deadband.to_numpy()
    X, y = tr[cols(feats)].to_numpy(float), tr.y.to_numpy()
    m = lgb.LGBMClassifier(**{**BASE, **hp})
    m.fit(X[a], y[a], sample_weight=w[a], eval_set=[(X[h], y[h])], eval_metric="binary_logloss",
          callbacks=[lgb.early_stopping(150, verbose=False)])
    n = max(20, int(round(m.best_iteration_ / (1 - HOLD_FRAC))))
    full = lgb.LGBMClassifier(**{**BASE, **hp, "n_estimators": n})
    full.fit(pd.DataFrame(X, columns=feats), y, sample_weight=w)
    return full, int(m.best_iteration_), n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, default=OUT, help="build_v2.py output directory (tabular_features.parquet)")
    ap.add_argument("--name", default="tabular-v2", help="model name; writes ml/models/<name>.json, node <name>.models.oniblock.eth")
    ap.add_argument("--results", type=Path, default=None, help="results JSON (default ml/models/tabular_v2_results.json)")
    a = ap.parse_args()
    name = a.name
    node = NODE if name == "tabular-v2" else f"{name}.models.oniblock.eth"
    results = a.results or MODELS / "tabular_v2_results.json"
    data = a.data.resolve()
    man = json.load(open(data / "manifest.json")) if (data / "manifest.json").exists() else {}
    lag = man.get("cex_query_lag_s")
    F = pd.read_parquet(data / "tabular_features.parquet")
    tr = F[(F.split == "train") & ~F.curated_out].sort_values(["ts", "pool"])
    va = F[(F.split == "val") & F.in_deadband].sort_values(["ts", "pool"])
    assert len(va) == 11842
    yv = va.y.to_numpy()
    res = {"validation_rows": len(va), "val_base_rate": round(float(yv.mean()), 4), "train_rows_all": len(tr),
           "train_rows_deadband": int(tr.in_deadband.sum()), "runs": []}

    v1 = json.load(open(MODELS / "tabular-v1.json"))
    assert v1["features"] == V1_INPUTS
    p_v1 = predict_json(v1, va[cols(V1_INPUTS)].to_numpy())
    res["tabular-v1 (shipped json)"] = metrics(p_v1, yv)
    print("tabular-v1", res["tabular-v1 (shipped json)"], flush=True)

    best = None
    for feats, fname in ((V1_INPUTS, "v1-inputs"), (V2_INPUTS, "v2-inputs")):
        for variant in ("deadband", "weighted"):
            for hp in GRID:
                m, es, n = fit(tr, feats, variant, hp)
                p = m.predict_proba(va[cols(feats)].to_numpy(float))[:, 1]
                r = {"inputs": fname, "variant": variant, **hp, "early_stop_iter": es, "n_trees": n, **metrics(p, yv)}
                res["runs"].append(r)
                print(json.dumps(r), flush=True)
                if fname == "v2-inputs" and (best is None or (r["tpr"], r["auc"]) > (best[0]["tpr"], best[0]["auc"])):
                    best = (r, m, p)
    r, m, p = best
    runs = pd.DataFrame(res["runs"])
    res["best_per_inputs_variant"] = (runs.sort_values(["tpr", "auc"], ascending=False).groupby(["inputs", "variant"]).head(1)
                                      .to_dict("records"))
    res["selected"] = r
    out = export(m.booster_, name)
    assert out["features"] == V2_INPUTS, out["features"]
    pj = predict_json(out, va[cols(V2_INPUTS)].to_numpy())
    res["json_parity_max_abs_diff_val"] = float(np.max(np.abs(pj - p)))
    assert res["json_parity_max_abs_diff_val"] < 1e-7
    opv = op_point(pj, yv)
    out.update({
        "node": node,
        "chargeThreshold": opv["threshold"],
        "notes": {
            "summary": summary(name, len(out["trees"]), len(out["features"]), lag),
            "inputs": "tabular.ts tabularInputs order: v1 11 inputs, then edgeSigma, vol5mBps, ret12Bps, ret36Bps, ret900Bps "
                      "(the keeper Features fields as given), sgap = gapSign * gapPips",
            "orientation": "canonical training orientation (baseIsToken0 = false): gapSign +1 = ETH cheaper in the pool than on Binance; "
                           "imb_arb = gapSign < 0 ? imbalance : -imbalance; retHBps positive = the gap widened. The keeper canonicalises "
                           "gapSign / imbalance before scoring.",
            "chargeThreshold": "one-sided rule: charge iff p >= chargeThreshold; smallest 1e-4 grid value with validation FPR <= 5% "
                               "(dead-band validation rows)",
            "label": "dead band y = markout > max($1, 1 bp arb volume); training variant " + r["variant"],
            "validation": {k: r[k] for k in ("auc", "brier", "ece", "threshold", "coverage", "pass_rate", "fpr", "tpr")},
            "hyperparameters": {**BASE, "num_leaves": r["num_leaves"], "min_child_samples": r["min_child_samples"], "n_estimators": r["n_trees"]},
        },
    })
    if lag is not None:
        out["notes"]["cexSnapshot"] = (f"trained on CEX features read at block ts - {lag} s (Binance snapshot age {lag - 1} s at the block: "
                                       f"gapPips, gapSign, realizedVolBps, edgePips, edgeSigma, vol5mBps, retHBps); pool-side features "
                                       f"unchanged. Only valid when the keeper's Binance read is that fresh.")
    txt = json.dumps(out, separators=(",", ":"))
    (MODELS / f"{name}.json").write_text(txt)
    res[f"{name}.json"] = {"trees": len(out["trees"]), "bytes": len(txt), "sha256": hashlib.sha256(txt.encode()).hexdigest(),
                              "chargeThreshold": opv["threshold"]}
    imp = pd.Series(m.booster_.feature_importance("gain"), index=V2_INPUTS)
    res["importance_gain_pct"] = (100 * imp / imp.sum()).round(2).sort_values(ascending=False).to_dict()
    json.dump(res, open(results, "w"), indent=1)
    print("SELECTED", json.dumps(r)); print("v1", json.dumps(res["tabular-v1 (shipped json)"]))
    print(json.dumps(res["best_per_inputs_variant"], indent=0)); print(res[f"{name}.json"]); print(res["importance_gain_pct"])


if __name__ == "__main__":
    main()
