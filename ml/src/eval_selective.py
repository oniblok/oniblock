"""Selective-metric evaluation on the held-out test split: No hook vs Jev vs oniblock1 (= Kev v1 weights).

The hook charges a premium on a block iff p >= t, else it behaves as a vanilla pool.
  pass rate = toxic charged / charged   FPR = benign charged / all benign
  coverage  = charged / all             TPR = toxic charged / all toxic
Target for the production model: pass rate >= 75% and FPR < 7%.
Thresholds never see the scored rows. Jev's gate is chosen on validation (FPR <= 5%). oniblock1 (Kev v1 LoRA,
test_3k scored post-temperature T = 1.1225) is reported two ways: (a) the fixed charge gate 0.8175, chosen on the
temperature-corrected val_1k (FPR <= 5%); (b) walk-forward, each test day re-picking t on the trailing 7 days of
labelled rows available before it (val_1k + earlier test_3k days, FPR <= 5%, >= 100 benign labels in the window,
else the fixed gate). The rolling windows are thin (1k/3k subsets, a few hundred benign labels each).
CIs: 95% day-block bootstrap (resample whole days).
The teacher LightGBM (generates Kev v2's soft targets; not deployed) is kept for reference, walk-forward on the
full test split as before.

usage: python eval_selective.py   (writes ml/models/selective_results.json)
"""
import json, sys
from pathlib import Path
import numpy as np, pandas as pd
from sklearn.metrics import roc_auc_score

ML = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).parent))
from train_tabular_v2 import predict_json  # noqa: E402

FPR_MAX, WINDOW_DAYS, BOOT, MIN_BENIGN = 0.05, 7, 1000, 100
KEV1_GATE = 0.8175  # oniblock1 charge gate: charges 22/453 = 4.86% of T-corrected val_1k benign


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
    lo, hi = np.nanpercentile(np.array(stats, float), [2.5, 97.5], axis=0)
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
    day = (pd.read_parquet(ML / "train_kev4b/data/v2/test_3k_keys.parquet").ts // 86400).to_numpy()  # same row order
    return {
        "jev_deployed_no_gate_test_3k": {**metrics(np.ones(len(yr), bool), yr, pr), "note": "k = 0.8 p: premium on every block"},
        "jev_calibrated_gate_test_3k": {**metrics(pc > t, yc, pc), "threshold": t, "ci95": day_boot(pc > t, yc, day)},
    }


def kev1():
    """oniblock1 = Kev v1 LoRA. Row order of test_3k / val_1k = the v2 key files (pool, block, ts)."""
    ev, keys = ML / "models/kev08b-v1/eval", ML / "train_kev4b/data/v2"
    te, va = json.load(open(ev / "test/rows.json")), json.load(open(ev / "val/rows.json"))
    T = te[0]["inference_temperature"]  # test rows are post-temperature; val rows were scored at T = 1
    assert {r["inference_temperature"] for r in va} == {1.0}
    lv = np.array([r["logits"] for r in va])
    v = pd.read_parquet(keys / "val_1k_keys.parquet").assign(
        y=[r["label"] for r in va], p=1 / (1 + np.exp(-(lv[:, 1] - lv[:, 0]) / T)), split="val")
    t_ = pd.read_parquet(keys / "test_3k_keys.parquet").assign(
        y=[r["label"] for r in te], p=[r["p"][1] for r in te], split="test")
    d = pd.concat([v, t_], ignore_index=True)
    d["day"] = d.ts // 86400
    v, t_ = d[d.split == "val"], d[d.split == "test"].copy()
    yv, pv = v.y.to_numpy(), v.p.to_numpy()
    lo, hi = threshold(pv, yv) - 1e-12, np.sort(pv[yv == 0])[::-1][int(np.floor(FPR_MAX * (yv == 0).sum())) - 1]
    assert lo < KEV1_GATE <= hi, "gate must charge exactly the val-chosen benign set"
    y, p, day = t_.y.to_numpy(), t_.p.to_numpy(), t_.day.to_numpy()
    c = p >= KEV1_GATE
    out = {"oniblock1_kev1_fixed_gate_test_3k": {
        **metrics(c, y, p), "threshold": KEV1_GATE, "inference_temperature": T,
        "val_1k_fpr": float(((pv >= KEV1_GATE) & (yv == 0)).sum() / (yv == 0).sum()), "ci95": day_boot(c, y, day),
        "gate_sensitivity": {f"t={x:.5f}": {k: metrics(p >= x, y)[k] for k in ("pass_rate", "fpr", "coverage", "tpr")}
                             for x in (lo + 1e-9, hi)},
        "note": "any t in (lo, hi] charges the same 22/453 T-corrected val_1k benign blocks"}}
    parts, log = [], []
    for dd, g in t_.groupby("day"):
        w = d[(d.day < dd) & (d.day >= dd - WINDOW_DAYS)]
        nb = int((w.y == 0).sum())
        th = threshold(w.p.to_numpy(), w.y.to_numpy()) if nb >= MIN_BENIGN else KEV1_GATE
        parts.append(g.assign(c=g.p >= th))
        log.append({"day": int(dd), "window_rows": len(w), "window_benign": nb, "threshold": th,
                    "fallback": nb < MIN_BENIGN})
    r = pd.concat(parts)
    c, y, day = r.c.to_numpy(), r.y.to_numpy(), r.day.to_numpy()
    out["oniblock1_kev1_rolling_test_3k"] = {
        **metrics(c, y, r.p.to_numpy()), "ci95": day_boot(c, y, day), "windows": log,
        "note": f"walk-forward: trailing {WINDOW_DAYS} days of val_1k + earlier test_3k, FPR <= {FPR_MAX}, "
                f">= {MIN_BENIGN} benign else fixed gate; thin windows (1k/3k subsets)"}
    return out


def teacher_lightgbm():
    """Teacher LightGBM: generates Kev v2's soft targets; not deployed."""
    path = ML / "models/teacher-lightgbm.json"
    m = json.load(open(path if path.exists() else ML / "models/oniblock1.json"))
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
        out[f"teacher_lightgbm_rolling_{name}"] = {**metrics(c, y, s.p.to_numpy()), "ci95": day_boot(c, y, day)}
    fixed = r.p.to_numpy() >= float(m["chargeThreshold"])
    out["teacher_lightgbm_fixed_threshold_full_test"] = {**metrics(fixed, r.y.to_numpy()), "threshold": float(m["chargeThreshold"])}
    return out


if __name__ == "__main__":
    res = {"definition": __doc__.split("usage:")[0].strip(), "no_hook": {"coverage": 0.0, "fpr": 0.0, "tpr": 0.0},
           **jev(), **kev1(), **teacher_lightgbm()}
    out = ML / "models/selective_results.json"
    out.write_text(json.dumps(res, indent=1))
    for k, v in res.items():
        if isinstance(v, dict):
            print(k, {x: (round(y, 4) if isinstance(y, float) else y) for x, y in v.items() if x not in ("ci95", "windows", "gate_sensitivity")})
            if "ci95" in v:
                print("   ci95", {x: [round(a, 4) for a in y] for x, y in v["ci95"].items()})
