"""Tabular baselines on dataset B: base rate, services heuristic (port), logistic regression, LightGBM, XGBoost, TabPFN.
Model selection / early stopping on val only. Latency = single-row predict wall time (median over 200 rows).
This is the v1 pipeline, kept for reproducibility: a re-run writes the test (and val) predictions preds_<name>_<split>.parquet,
the fitted models <name>.pkl and tabular_results.json to ml/runs/tabular-v1/ (gitignored), never over the stored results
in ml/models/ (which ml/src/evaluate.py reads). The repo ships no v1 weights; the only tree model left is
teacher-lightgbm (ml/src/train_tabular_v2.py; not a production model: oniblock1 is the Kev System One LLM).

usage: python train_tabular.py [--no-tabpfn] [--train-extra o23]
"""
import sys, time, json, pickle
import numpy as np, pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
import lightgbm as lgb
import xgboost as xgb
from common import DATA, ML
from make_splits import FEATURES
from metrics import all_metrics


OUT = ML / "runs" / "tabular-v1"


def X(df):
    x = df[FEATURES].astype(float).copy()
    x["gap_over_fee"] = df.gapPips / df.baseFee
    x["log_size"] = np.log10(df.sizeToDepth + 1e-9)
    return x


def latency(fn, df, n=200):
    xs = [df.iloc[[i]] for i in range(min(n, len(df)))]
    ts = []
    for r in xs:
        t0 = time.perf_counter(); fn(r); ts.append((time.perf_counter() - t0) * 1000)
    return float(np.median(ts))


def save(name, split, df, p, lat):
    pd.DataFrame({"pool": df.pool.values, "block": df.block.values, "y": df.y.values, "p": np.asarray(p, float), "latency_ms": lat}).to_parquet(OUT / f"preds_{name}_{split}.parquet", index=False)


def main(argv):
    OUT.mkdir(parents=True, exist_ok=True)
    tr, va, te = (pd.read_parquet(DATA / f"{s}.parquet") for s in ("train", "val", "test"))
    tag = ""
    if "--train-extra" in argv:
        extra = argv[argv.index("--train-extra") + 1]
        ex = pd.read_parquet(DATA / f"{extra}_eval.parquet")
        tr = pd.concat([ex, tr]); tag = f"+{extra}"
    rate = tr.y.mean()
    res = {}

    def run(name, predict, fitted=None):
        for split, df in (("val", va), ("test", te)):
            p = predict(df)
            lat = latency(predict, df) if split == "test" else 0.0
            save(name + tag, split, df, p, lat)
            res[f"{name}{tag}/{split}"] = {**all_metrics(np.asarray(p), df.y.values.astype(float), rate), "latency_ms": lat}
        print(name + tag, json.dumps(res[f"{name}{tag}/val"]), flush=True)
        if fitted is not None:
            pickle.dump(fitted, open(OUT / f"{name}{tag}.pkl", "wb"))

    if not tag:
        run("baserate", lambda d: np.full(len(d), rate))
        run("heuristic", lambda d: d.p_heuristic.values)

    lr = make_pipeline(StandardScaler(), LogisticRegression(C=1.0, max_iter=2000)).fit(X(tr), tr.y)
    run("logreg", lambda d: lr.predict_proba(X(d))[:, 1], lr)

    gbm = lgb.LGBMClassifier(n_estimators=2000, learning_rate=0.03, num_leaves=31, min_child_samples=200, subsample=0.8, subsample_freq=1,
                             colsample_bytree=0.8, reg_lambda=1.0, verbose=-1)
    gbm.fit(X(tr), tr.y, eval_set=[(X(va), va.y)], eval_metric="binary_logloss", callbacks=[lgb.early_stopping(100, verbose=False)])
    run("lightgbm", lambda d: gbm.predict_proba(X(d))[:, 1], gbm)

    xg = xgb.XGBClassifier(n_estimators=2000, learning_rate=0.03, max_depth=5, subsample=0.8, colsample_bytree=0.8, min_child_weight=50,
                           eval_metric="logloss", early_stopping_rounds=100, n_jobs=8)
    xg.fit(X(tr), tr.y, eval_set=[(X(va), va.y)], verbose=False)
    run("xgboost", lambda d: xg.predict_proba(X(d))[:, 1], xg)

    if "--no-tabpfn" not in argv and not tag:
        from tabpfn import TabPFNClassifier
        import torch
        dev = "mps" if torch.backends.mps.is_available() else "cpu"
        sub = tr.sample(min(len(tr), 10000), random_state=0)  # TabPFN context: 10k rows (in-context learning, no gradient training)
        t0 = time.time()
        clf = TabPFNClassifier(device=dev, n_estimators=4, ignore_pretraining_limits=True)
        clf.fit(X(sub), sub.y)
        def pf(d):
            out = []
            for k in range(0, len(d), 5000):
                out.append(clf.predict_proba(X(d.iloc[k:k + 5000]))[:, 1])
            return np.concatenate(out)
        for split, df in (("val", va), ("test", te)):
            p = pf(df)
            lat = latency(pf, df, n=30) if split == "test" else 0.0
            save("tabpfn", split, df, p, lat)
            res[f"tabpfn/{split}"] = {**all_metrics(p, df.y.values.astype(float), rate), "latency_ms": lat}
        print("tabpfn", json.dumps(res["tabpfn/val"]), "device", dev, "secs", round(time.time() - t0), flush=True)
        res["tabpfn_info"] = {"device": dev, "context_rows": len(sub), "n_estimators": 4}
    json.dump(res, open(OUT / f"tabular_results{tag}.json", "w"), indent=1)


if __name__ == "__main__":
    main(sys.argv[1:])
