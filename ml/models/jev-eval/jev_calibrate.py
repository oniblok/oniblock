"""Fit a logit-scale temperature+bias on Jev's val_1k predictions, apply to test_3k.
Same intent as calibrate_checkpoint.py: calibration parameters come from validation only.
"""
import json, math
from pathlib import Path

def load(f):
    rows = json.load(open(Path(f) / "rows.json"))
    return [r["p"][1] for r in rows], [float(r["label"]) for r in rows], rows

def logit(p, e=1e-6):
    p = min(max(p, e), 1 - e)
    return math.log(p / (1 - p))

def sig(z):
    return 1 / (1 + math.exp(-z))

pv, yv, _ = load("/tmp/jev-val")
pt, yt, rows_t = load("/tmp/jev-test")
zv = [logit(p) for p in pv]

# fit a,b minimising NLL of sigmoid(a*z+b) by simple grid + local refine
best, ba, bb = None, 1.0, 0.0
def nll(a, b):
    s = 0.0
    for z, y in zip(zv, yv):
        q = sig(a * z + b)
        q = min(max(q, 1e-9), 1 - 1e-9)
        s -= y * math.log(q) + (1 - y) * math.log(1 - q)
    return s / len(zv)

step_a, step_b = 0.05, 0.05
a, b = 1.0, 0.0
best = nll(a, b)
for _ in range(400):
    improved = False
    for da, db in ((step_a,0),(-step_a,0),(0,step_b),(0,-step_b)):
        v = nll(a+da, b+db)
        if v < best - 1e-9:
            best, a, b = v, a+da, b+db
            improved = True
            break
    if not improved:
        step_a /= 2; step_b /= 2
        if step_a < 1e-4: break

print(f"fitted on val_1k: a={a:.4f} b={b:.4f} (val NLL {best:.4f})")
out = []
for r, p in zip(rows_t, pt):
    q = sig(a * logit(p) + b)
    r2 = dict(r); r2["p"] = [1 - q, q]
    out.append(r2)
d = Path("/tmp/jev-test-calibrated"); d.mkdir(exist_ok=True)
json.dump(out, open(d / "rows.json", "w"))
rep = json.load(open("/tmp/jev-test/report.json"))
rep["calibration"] = {"fitted_on": "val_1k", "a": a, "b": b, "form": "sigmoid(a*logit(p)+b)"}
json.dump(rep, open(d / "report.json", "w"), indent=1)
print("mean p before %.4f after %.4f | test base rate %.4f" % (
    sum(pt)/len(pt), sum(r["p"][1] for r in out)/len(out), sum(yt)/len(yt)))
