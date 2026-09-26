"""TabPFN v2 (Prior-Labs/TabPFN-v2-clf, Prior Labs License 1.1 = Apache-2.0 + attribution; not gated) on dataset B.
The package default (v3.5) is gated behind a TABPFN_TOKEN and licensed NON-COMMERCIAL / non-production, so it is not used.
In-context learning: 10,000 random train rows as context, no gradient training. Writes preds_tabpfn_{val,test}.parquet."""
import time, json
import numpy as np, pandas as pd, torch
from tabpfn import TabPFNClassifier
from tabpfn.constants import ModelVersion
import train_tabular as t
from common import DATA, MODELS
from metrics import all_metrics

tr, va, te = (pd.read_parquet(DATA / f"{s}.parquet") for s in ("train", "val", "test"))
rate = tr.y.mean()
dev = "cpu"  # MPS hung in torch.mps.synchronize() on this machine (faulthandler trace); CPU is deterministic
sub = tr.sample(10000, random_state=0)
import os
clf = TabPFNClassifier.create_default_for_version(ModelVersion.V2, device=dev, n_estimators=4, ignore_pretraining_limits=True,
                                                 model_path=os.path.expanduser("~/Library/Caches/tabpfn/tabpfn-v2-classifier-finetuned-zk73skhh.ckpt"))
t0 = time.time(); clf.fit(t.X(sub), sub.y)
pf = lambda d: np.concatenate([clf.predict_proba(t.X(d.iloc[k:k + 2000]))[:, 1] for k in range(0, len(d), 2000)])
res = {}
for split, df in (("val", va.sample(5000, random_state=0)), ("test", te)):
    p = pf(df); lat = t.latency(pf, df, n=30) if split == "test" else 0.0
    t.save("tabpfn", split, df, p, lat)
    res[split] = {**all_metrics(p, df.y.values.astype(float), rate), "latency_ms": lat}
    print(split, res[split], round(time.time() - t0), flush=True)
res["info"] = {"device": dev, "context_rows": 10000, "n_estimators": 4, "weights": "Prior-Labs/TabPFN-v2-clf (Prior Labs License 1.1)", "tabpfn": __import__("tabpfn").__version__}
json.dump(res, open(MODELS / "tabpfn_results.json", "w"), indent=1)
