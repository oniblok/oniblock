"""Probabilistic-forecast metrics with cluster (hour) bootstrap CIs."""
import numpy as np
from sklearn.metrics import roc_auc_score

EPS = 1e-6


def brier(p, y):
    return float(np.mean((p - y) ** 2))


def logloss(p, y):
    p = np.clip(p, EPS, 1 - EPS)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def ece(p, y, bins=10):
    edges = np.linspace(0, 1, bins + 1)
    idx = np.clip((np.asarray(p) * bins).astype(int), 0, bins - 1)  # same binning as train_kev4b/score_kev.py
    e = 0.0
    for b in range(bins):
        m = idx == b
        if m.any():
            e += m.mean() * abs(p[m].mean() - y[m].mean())
    return float(e)


def auc(p, y):
    return float(roc_auc_score(y, p)) if 0 < y.mean() < 1 else float("nan")


def reliability(p, y, bins=10):
    edges = np.linspace(0, 1, bins + 1)
    idx = np.clip((np.asarray(p) * bins).astype(int), 0, bins - 1)  # same binning as train_kev4b/score_kev.py
    rows = []
    for b in range(bins):
        m = idx == b
        rows.append({"bin": f"{edges[b]:.1f}-{edges[b+1]:.1f}", "n": int(m.sum()),
                     "mean_p": float(p[m].mean()) if m.any() else None, "freq_y": float(y[m].mean()) if m.any() else None})
    return rows


def all_metrics(p, y, ref_rate):
    """ref_rate: base rate of the training labels (the 'base-rate predictor')."""
    b = brier(p, y)
    bref = brier(np.full_like(p, ref_rate, dtype=float), y)
    return {"brier": b, "logloss": logloss(p, y), "ece": ece(p, y), "auc": auc(p, y), "bss": 1 - b / bref}


def bootstrap(p, y, clusters, ref_rate, n=500, seed=0):
    """Cluster bootstrap (resample whole clusters, e.g. hours) -> 95% CI per metric."""
    rng = np.random.default_rng(seed)
    uc, inv = np.unique(clusters, return_inverse=True)
    groups = [np.flatnonzero(inv == k) for k in range(len(uc))]
    out = {k: [] for k in ("brier", "logloss", "ece", "auc", "bss")}
    for _ in range(n):
        pick = rng.integers(0, len(groups), len(groups))
        ix = np.concatenate([groups[k] for k in pick])
        m = all_metrics(p[ix], y[ix], ref_rate)
        for k, v in m.items():
            out[k].append(v)
    return {k: (float(np.nanpercentile(v, 2.5)), float(np.nanpercentile(v, 97.5))) for k, v in out.items()}


def paired_diff(p1, p2, y, clusters, n=500, seed=0, metric=brier):
    """95% CI of metric(p1) - metric(p2) under the same cluster resamples."""
    rng = np.random.default_rng(seed)
    uc, inv = np.unique(clusters, return_inverse=True)
    groups = [np.flatnonzero(inv == k) for k in range(len(uc))]
    d = []
    for _ in range(n):
        ix = np.concatenate([groups[k] for k in rng.integers(0, len(groups), len(groups))])
        d.append(metric(p1[ix], y[ix]) - metric(p2[ix], y[ix]))
    return float(np.mean(d)), float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))
