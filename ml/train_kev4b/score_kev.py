"""Score a kev.benchmark output folder with Oniblock's metrics (the same definitions as ml/RESULTS.md).

    python score_kev.py runs/oniblock-kev4b-test [--train-rate 0.5946] [--adapter runs/oniblock-kev4b]

Reads <folder>/rows.json (written by `python -m kev.benchmark --data ... --out <folder>`; for our `noul` question,
row["p"] = [P(false), P(true)] and row["label"] = 0/1) and <folder>/report.json (latency). It prints and writes
<folder>/oniblock_metrics.json with: n, base rate, Brier, log loss, ECE (10 equal-width bins) + reliability table,
AUC, Brier skill vs the training base rate (0.5946 = train split), 95% bootstrap CIs, and median/p95 latency.
With --adapter it also writes the ENS `model-hash`: sha256 over the sorted list of "<sha256>  <path>" lines of every
*.safetensors / *.pt / *.bin file in the adapter folder (the same recipe as README Step 6).
Only needs Python 3 + numpy.
"""
import argparse, hashlib, json
from pathlib import Path
import numpy as np


def auc(p, y):
    order = np.argsort(p, kind="mergesort")
    ranks = np.empty(len(p)); ranks[order] = np.arange(1, len(p) + 1)
    # average ranks for ties
    _, inv, cnt = np.unique(p, return_inverse=True, return_counts=True)
    sums = np.bincount(inv, weights=ranks); ranks = (sums / cnt)[inv]
    n1 = y.sum(); n0 = len(y) - n1
    return float((ranks[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)) if n1 and n0 else float("nan")


def metrics(p, y, rate):
    eps = 1e-6
    b = float(np.mean((p - y) ** 2))
    bref = float(np.mean((rate - y) ** 2))
    pc = np.clip(p, eps, 1 - eps)
    ll = float(-np.mean(y * np.log(pc) + (1 - y) * np.log(1 - pc)))
    idx = np.clip((p * 10).astype(int), 0, 9)
    ece = float(sum((idx == k).mean() * abs(p[idx == k].mean() - y[idx == k].mean()) for k in range(10) if (idx == k).any()))
    return {"brier": b, "logloss": ll, "ece": ece, "auc": auc(p, y), "bss_vs_train_rate": 1 - b / bref}


def model_hash(adapter):
    files = sorted(f for f in Path(adapter).rglob("*") if f.suffix in (".safetensors", ".pt", ".bin") and f.is_file())
    lines = "".join(f"{hashlib.sha256(f.read_bytes()).hexdigest()}  ./{f.relative_to(adapter)}\n" for f in files)
    return hashlib.sha256(lines.encode()).hexdigest(), lines


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--train-rate", type=float, default=0.5946)
    ap.add_argument("--adapter")
    ap.add_argument("--boot", type=int, default=1000)
    a = ap.parse_args()
    rows = json.load(open(Path(a.folder) / "rows.json"))
    rows = [r for r in rows if r["question"] == "informed"]
    p = np.array([r["p"][r["keys"].index("true")] for r in rows], float)
    y = np.array([r["label"] for r in rows], float)
    out = {"n": len(y), "base_rate": float(y.mean()), **metrics(p, y, a.train_rate)}
    rng = np.random.default_rng(0)
    bs = [metrics(p[i], y[i], a.train_rate) for i in (rng.integers(0, len(y), len(y)) for _ in range(a.boot))]
    out["ci95"] = {k: [float(np.nanpercentile([m[k] for m in bs], 2.5)), float(np.nanpercentile([m[k] for m in bs], 97.5))] for k in bs[0]}
    idx = np.clip((p * 10).astype(int), 0, 9)
    out["reliability"] = [{"bin": f"{k/10:.1f}-{(k+1)/10:.1f}", "n": int((idx == k).sum()),
                           "mean_p": float(p[idx == k].mean()) if (idx == k).any() else None,
                           "freq_y": float(y[idx == k].mean()) if (idx == k).any() else None} for k in range(10)]
    rep = Path(a.folder) / "report.json"
    if rep.exists():
        out["latency_ms"] = json.load(open(rep)).get("latency_ms")
    if a.adapter:
        h, lines = model_hash(a.adapter)
        out["model_hash_sha256"] = h
        out["model_hash_files"] = lines.splitlines()
    json.dump(out, open(Path(a.folder) / "oniblock_metrics.json", "w"), indent=1)
    print(json.dumps({k: v for k, v in out.items() if k not in ("reliability", "model_hash_files")}, indent=1))


if __name__ == "__main__":
    main()
