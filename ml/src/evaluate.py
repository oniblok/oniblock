"""Collect all test predictions and compute the RESULTS tables (ml/models/eval_results.json + markdown snippets).

Panels:
  full   : the whole test split (43,534 rows)          -> tabular models + heuristic + base rate
  sub3k  : ml/data/kev/test_3000 (random 3,000 rows)   -> + Kev-0.8B zero-shot / fine-tuned
  jev175 : stratified 175-row subsample, inverse-probability weighted -> + Jev (v1 prompt, v4 production prompt)
CIs: 95% cluster bootstrap over UTC hours (500 resamples). Reference rate for Brier skill = train base rate.
"""
import json
import numpy as np, pandas as pd
from sklearn.metrics import roc_auc_score
from common import DATA, MODELS

EPS = 1e-6


def wm(p, y, w, rate):
    w = w / w.sum()
    b = float(np.sum(w * (p - y) ** 2)); bref = float(np.sum(w * (rate - y) ** 2))
    pc = np.clip(p, EPS, 1 - EPS)
    ll = float(-np.sum(w * (y * np.log(pc) + (1 - y) * np.log(1 - pc))))
    idx = np.clip((p * 10).astype(int), 0, 9)
    ece = float(sum(abs(np.sum(w[idx == k] * (p[idx == k] - y[idx == k]))) for k in range(10)))
    auc = float(roc_auc_score(y, p, sample_weight=w)) if 0 < y.mean() < 1 else float("nan")
    return {"brier": b, "logloss": ll, "ece": ece, "auc": auc, "bss": 1 - b / bref}


def boot(p, y, w, hours, rate, n=500, seed=0):
    rng = np.random.default_rng(seed)
    uh, inv = np.unique(hours, return_inverse=True)
    groups = [np.flatnonzero(inv == k) for k in range(len(uh))]
    res = []
    for _ in range(n):
        ix = np.concatenate([groups[k] for k in rng.integers(0, len(groups), len(groups))])
        res.append(wm(p[ix], y[ix], w[ix], rate))
    return {k: [float(np.nanpercentile([r[k] for r in res], 2.5)), float(np.nanpercentile([r[k] for r in res], 97.5))] for k in res[0]}


def paired(pa, pb, y, w, hours, n=500, seed=1):
    """Brier(a) - Brier(b) with 95% cluster-bootstrap CI (negative = a better)."""
    rng = np.random.default_rng(seed)
    uh, inv = np.unique(hours, return_inverse=True)
    groups = [np.flatnonzero(inv == k) for k in range(len(uh))]
    d = []
    for _ in range(n):
        ix = np.concatenate([groups[k] for k in rng.integers(0, len(groups), len(groups))])
        ww = w[ix] / w[ix].sum()
        d.append(float(np.sum(ww * (pa[ix] - y[ix]) ** 2) - np.sum(ww * (pb[ix] - y[ix]) ** 2)))
    ww = w / w.sum()
    return [float(np.sum(ww * (pa - y) ** 2) - np.sum(ww * (pb - y) ** 2)), float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))]


def reliability(p, y, w):
    idx = np.clip((p * 10).astype(int), 0, 9)
    out = []
    for k in range(10):
        m = idx == k
        out.append({"bin": f"{k/10:.1f}-{(k+1)/10:.1f}", "n": int(m.sum()), "mean_p": float(np.average(p[m], weights=w[m])) if m.any() else None,
                    "freq_y": float(np.average(y[m], weights=w[m])) if m.any() else None})
    return out


def load_preds(name, split="test"):
    f = MODELS / f"preds_{name}_{split}.parquet"
    return pd.read_parquet(f) if f.exists() else None


def main():
    test = pd.read_parquet(DATA / "test.parquet")
    rate = float(pd.read_parquet(DATA / "train.parquet").y.mean())
    test["hour"] = test.ts // 3600
    key = ["pool", "block"]
    models = ["baserate", "heuristic", "logreg", "lightgbm", "xgboost", "tabpfn", "logreg+o23", "lightgbm+o23", "xgboost+o23",
              "kev08b_zeroshot", "kev08b_ft", "kev08b_ft_ts"]
    df = test[key + ["y", "hour"]].copy()
    lat = {}
    for m in models:
        p = load_preds(m)
        if p is None:
            continue
        df = df.merge(p[key + ["p"]].rename(columns={"p": m}), on=key, how="left")
        lat[m] = float(p.latency_ms.median())
    for v in ("v1", "v4"):
        f = MODELS / f"jev_{v}_test_preds.parquet"
        if f.exists():
            j = pd.read_parquet(f)
            df = df.merge(j[key + ["p_jev", "w"]].rename(columns={"p_jev": f"jev_{v}", "w": f"w_jev_{v}"}), on=key, how="left")
            lat[f"jev_{v}"] = float(j.latency_ms.median())
    sub3k = pd.read_parquet(DATA / "kev" / "test_3000.keys.parquet")[key]
    df["in_sub3k"] = df.set_index(key).index.isin(sub3k.set_index(key).index)
    have = [m for m in models + ["jev_v1", "jev_v4"] if m in df]
    res = {"train_rate": rate, "latency_ms": lat, "panels": {}}
    panels = {
        "full": (df, np.ones(len(df)), [m for m in have if not m.startswith(("kev", "jev")) and df[m].notna().all()]),
        "sub3k": (df[df.in_sub3k], np.ones(int(df.in_sub3k.sum())), [m for m in have if not m.startswith("jev") and df.loc[df.in_sub3k, m].notna().all()]),
    }
    if "w_jev_v1" in df:
        jj = df[df.jev_v1.notna()]
        panels["jev175"] = (jj, jj.w_jev_v1.to_numpy(), [m for m in have if jj[m].notna().all()])
    for name, (d, w, ms) in panels.items():
        y = d.y.to_numpy(float); h = d.hour.to_numpy()
        P = {"n": len(d), "base_rate": float(np.average(y, weights=w)), "models": {}}
        best = min(ms, key=lambda m: wm(d[m].to_numpy(float), y, w, rate)["brier"])
        for m in ms:
            p = d[m].to_numpy(float)
            P["models"][m] = {**wm(p, y, w, rate), "ci95": boot(p, y, w, h, rate), "brier_minus_best": paired(p, d[best].to_numpy(float), y, w, h),
                              "reliability": reliability(p, y, w), "latency_ms": lat.get(m)}
        P["best_brier"] = best
        res["panels"][name] = P
        print(f"== {name} n={len(d)} base={P['base_rate']:.3f} best={best}")
        for m in ms:
            r = P["models"][m]
            print(f"  {m:18s} brier {r['brier']:.4f} [{r['ci95']['brier'][0]:.4f},{r['ci95']['brier'][1]:.4f}] ll {r['logloss']:.4f} ece {r['ece']:.4f} auc {r['auc']:.4f} bss {r['bss']:+.3f}  dBrier-vs-best {r['brier_minus_best'][0]:+.4f} [{r['brier_minus_best'][1]:+.4f},{r['brier_minus_best'][2]:+.4f}] lat {r['latency_ms']}")
    json.dump(res, open(MODELS / "eval_results.json", "w"), indent=1)


if __name__ == "__main__":
    main()
