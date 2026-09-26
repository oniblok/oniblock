"""Selective-metric evaluation on the held-out test split: No hook vs Jev vs oniblock1.

The hook charges a premium on a block iff p > t, else it behaves as a vanilla pool.
  pass rate = toxic charged / charged   FPR = benign charged / all benign
  coverage  = charged / all             TPR = toxic charged / all toxic
Thresholds never see the scored day: Jev's is chosen on validation (FPR <= 5%); oniblock1's is walk-forward, each
test day using the trailing 7 days of labelled blocks (FPR <= 5%), as the settler publishes it live.

usage: python eval_selective.py   (writes ml/models/oniblock1_selective_results.json)
"""
import json, sys
from pathlib import Path
import numpy as np, pandas as pd
from sklearn.metrics import roc_auc_score

ML = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).parent))
from train_tabular_v2 import predict_json  # noqa: E402

FPR_MAX, WINDOW_DAYS, BOOT = 0.05, 7, 1000


def threshold(p, y, fmax=FPR_MAX):
    neg = np.sort(p[y == 0])[::-1]
    return float(neg[int(np.floor(fmax * len(neg)))]) + 1e-12


def metrics(c, y, p=None):
    tp, fp = int((c & (y == 1)).sum()), int((c & (y == 0)).sum())
    out = {"n": int(len(y)), "coverage": float(c.mean()), "pass_rate": tp / int(c.sum()) if c.sum() else None,
           "fpr": fp / int((y == 0).sum()), "tpr": tp / int((y == 1).sum())}
    if p is not None:
        out["auc"] = float(roc_auc_score(y, p))
    return out


def day_boot(c, y, day, seed=0):
    rng, days = np.random.default_rng(seed), np.unique(day)
    idx = {d: np.flatnonzero(day == d) for d in days}
    stats = []
    for _ in range(BOOT):
        s = np.concatenate([idx[d] for d in rng.choice(days, len(days))])
        m = metrics(c[s], y[s])
        stats.append((m["pass_rate"], m["fpr"], m["tpr"]))
    lo, hi = np.percentile(np.array(stats, float), [2.5, 97.5], axis=0)
    return {k: [float(lo[i]), float(hi[i])] for i, k in enumerate(("pass_rate", "fpr", "tpr"))}


def jev():
    ev = ML / "models/jev-eval"
    rows = lambda f: json.load(open(ev / f / "rows.json"))
    raw, cal, val = rows("jev-test"), rows("jev-test-calibrated"), rows("jev-val")
    yr, pr = np.array([r["label"] for r in raw]), np.array([r["p"][1] for r in raw])
    yc, pc = np.array([r["label"] for r in cal]), np.array([r["p"][1] for r in cal])
    c = json.load(open(ev / "jev-test-calibrated/report.json"))["calibration"]
    pv = np.clip(np.array([r["p"][1] for r in val]), 1e-6, 1 - 1e-6)
    pv = 1 / (1 + np.exp(-(c["a"] * np.log(pv / (1 - pv)) + c["b"])))
    t = threshold(pv, np.array([r["label"] for r in val]))
    return {
        "jev_deployed_no_gate_test_3k": {**metrics(np.ones(len(yr), bool), yr, pr), "note": "k = 0.8 p: premium on every block"},
        "jev_calibrated_gate_test_3k": {**metrics(pc > t, yc, pc), "threshold": t},
    }


def oniblock1():
    m = json.load(open(ML / "models/oniblock1.json"))
    d = pd.read_parquet(ML / "train_kev4b/data/v2-fresh/tabular_features.parquet")
    d = d[d.in_deadband & d.split.isin(["val", "test"])].copy()
    d["p"] = predict_json(m, d[[f"x_{f}" for f in m["features"]]].to_numpy(float))
    d["day"] = d.ts // 86400
    te = d[d.split == "test"].copy()
    k3 = pd.read_parquet(ML / "train_kev4b/data/v2-fresh/test_3k_keys.parquet")
    te["in_3k"] = te.set_index(["pool", "block"]).index.isin(k3.set_index(["pool", "block"]).index)
    parts = []
    for day, g in te.groupby("day"):
        w = d[(d.day < day) & (d.day >= day - WINDOW_DAYS)]
        parts.append(g.assign(c=g.p > threshold(w.p.to_numpy(), w.y.to_numpy())))
    r = pd.concat(parts)
    out = {}
    for name, sel in (("full_test", np.ones(len(r), bool)), ("test_3k", r.in_3k.to_numpy())):
        s = r[sel]
        c, y, day = s.c.to_numpy(), s.y.to_numpy(), s.day.to_numpy()
        out[f"oniblock1_rolling_{name}"] = {**metrics(c, y, s.p.to_numpy()), "ci95": day_boot(c, y, day)}
    fixed = r.p.to_numpy() >= float(m["chargeThreshold"])
    out["oniblock1_fixed_threshold_full_test"] = {**metrics(fixed, r.y.to_numpy()), "threshold": float(m["chargeThreshold"])}
    return out


if __name__ == "__main__":
    res = {"definition": __doc__.split("usage:")[0].strip(), "no_hook": {"coverage": 0.0, "fpr": 0.0, "tpr": 0.0}, **jev(), **oniblock1()}
    out = ML / "models/oniblock1_selective_results.json"
    out.write_text(json.dumps(res, indent=1))
    for k, v in res.items():
        if isinstance(v, dict):
            print(k, {x: (round(y, 4) if isinstance(y, float) else y) for x, y in v.items() if x != "ci95"})
