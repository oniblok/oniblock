"""v2 training data: past-only CEX features + 'kev2' text states + dead band + train curation + soft targets.

Inputs : ml/hf_release/data/{train,validation,test}.parquet (one row per (pool, block); t_obs = ts - 12),
         Binance 1 s klines under ml/raw/binance/ (common.Mids).
Outputs: ml/train_kev4b/data/v2/ (gitignored)
  train.jsonl val.jsonl test.jsonl          Kev JSONL, dead-band rows, sorted by (ts, pool); train is curated
  train_20k.jsonl val_1k.jsonl test_3k.jsonl EXACTLY the (pool, block) rows of the v1 subsets (verified row by row)
  train_soft.jsonl                          train.jsonl + soft target {"true": q, "false": 1-q} in the question
  tabular_features.parquet                  every row of every split: ids, label columns, curation flags,
                                            keeper Features (rounded like features.ts), tabular-v2 inputs
  manifest.json                             counts, verification, soft-target stats, sha256
Features (names = services/src/features.ts Features fields; canonical orientation baseIsToken0 = false):
  edgePips   = gapPips - baseFee
  edgeSigma  = round((gapPips - baseFee) / max(realizedVolBps * 100, 1), 4)       (realizedVolBps rounded to 3 dp)
  vol5mBps   = round(Mids.vol_bps(t_obs, n=25, step=12), 4)
  retHBps    = round(ln(mid(t_obs) / mid(t_obs - H)) * 1e4 * gapSign, 4), H = 12, 36, 900 s
               (mid = USDC per ETH; for baseIsToken0 = false, dir = +gapSign => positive = the gap widened)
  missing data -> 0 (keeper: history too short -> 0). round(x, d) = JS Math.round(x * 10^d) / 10^d.
Train curation: drop (a) rows whose previous slot was missed (ts(t) - ts(t-1) >= 24 s, t-1 known from any pool's row),
  (b) all copies of kev2 state strings that occur in train with conflicting labels. val / test are not curated.
Soft target: q = clip(0.5 y + 0.5 oof, 0.02, 0.98); oof = out-of-fold LightGBM p on curated train from 5 contiguous
  time-blocked folds, tabular-v2 inputs, dead-band rows (inner early stopping on the last 10% of each fold's train).

Fresh-CEX variant (--query-lag S, default 12 = the dataset's cex_mid_obs convention): the keeper reads Binance at
  t_obs = ts - S (Mids.mid(t) = close of the 1 s kline opening at t, known at t + 1, so the snapshot age at the block is S - 1 s;
  S = 0 would leak the label's mid). For S != 12 every CEX-dependent feature is recomputed at t_obs from pool_price_obs and
  Mids: gapPips = floor(|M - P| / P * 1e6), gapSign = sign(M - P), realizedVolBps = Mids.vol_bps(t_obs) (n = 120, 12 s), then
  edgePips / edgeSigma / vol5mBps / retHBps as above. Pool-side features, labels, dead band, curation rule, val / test rows and
  subset rows are unchanged (verified against v1 / the v2 key files). The parity fixture is only written for S = 12.

usage: python build_v2.py [--query-lag 12] [--out DIR] [--no-fixture]
       python build_v2.py --query-lag 3 --out ml/train_kev4b/data/v2-fresh      (age 2 s: keeper posts first in the block)
"""
import argparse, json, hashlib, os
from pathlib import Path
import numpy as np, pandas as pd
from common import ML, REPO, Mids
from build_blocks import tags_for
from kev_export_deadband import deadband
from states import features_to_state, features_to_state_kev2, KEV_QUESTION

SRC = ML / "hf_release" / "data"
V1 = ML / "train_kev4b" / "data"
OUT = V1 / "v2"
SPLITS = (("train", "train"), ("validation", "val"), ("test", "test"))
FIXTURE = REPO / "services" / "test" / "fixtures" / "kev2-state-parity.json"
SUBSETS = {"train": ("train_20k", 20000), "val": ("val_1k", 1000), "test": ("test_3k", 3000)}

V1_INPUTS = ["gapPips", "edgePips", "baseFee", "imb_arb", "abs_imbalance", "sizeToDepth", "realizedVolBps", "nSwaps", "arbShare",
             "gap_over_fee", "log_size"]
V2_INPUTS = V1_INPUTS + ["edgeSigma", "vol5mBps", "ret12Bps", "ret36Bps", "ret900Bps", "sgap"]
FEATURE_FIELDS = ["gapPips", "gapSign", "imbalance", "sizeToDepth", "realizedVolBps", "attestationAge", "nSwaps", "arbShare", "baseFee",
                  "edgePips", "edgeSigma", "vol5mBps", "ret12Bps", "ret36Bps", "ret900Bps"]
INT_FIELDS = {"gapPips", "gapSign", "attestationAge", "nSwaps", "baseFee", "edgePips"}
LGB_PARAMS = dict(n_estimators=3000, learning_rate=0.03, num_leaves=31, min_child_samples=200, subsample=0.8, subsample_freq=1,
                  colsample_bytree=0.8, reg_lambda=1.0, verbose=-1)


def jround(x, d):
    """services/src/features.ts round(): Math.round(x * 10^d) / 10^d (Math.round = floor(v + 0.5))."""
    f = 10.0 ** d
    return np.floor(np.asarray(x, float) * f + 0.5) / f


def cex_snapshot(df, mids, lag):
    """gapPips, gapSign, realizedVolBps with the CEX read at ts - lag (build_blocks.py formulas; lag 12 = the dataset columns)."""
    obs = df.ts.to_numpy(np.int64) - lag
    P = df.pool_price_obs.to_numpy(float)
    M = mids.mid(obs)
    return pd.DataFrame({"gapPips": np.floor(np.abs(M - P) / P * 1e6), "gapSign": np.sign(M - P), "realizedVolBps": mids.vol_bps(obs)},
                        index=df.index)


def keeper_features(df, mids, lag=12):
    """Keeper Features (features.ts names + rounding) for every row; canonical orientation (baseIsToken0 = false)."""
    obs = df.ts.to_numpy(np.int64) - lag
    cex = df if lag == 12 else cex_snapshot(df, mids, lag)
    assert np.isfinite(cex[["gapPips", "gapSign", "realizedVolBps"]].to_numpy(float)).all(), "missing CEX data at t_obs"
    gs = cex.gapSign.to_numpy(float)
    F = pd.DataFrame(index=df.index)
    F["gapPips"] = cex.gapPips.astype(int)
    F["gapSign"] = cex.gapSign.astype(int)
    F["imbalance"] = jround(df.imbalance, 4)
    F["sizeToDepth"] = jround(df.sizeToDepth, 6)
    F["realizedVolBps"] = jround(cex.realizedVolBps, 3)
    F["attestationAge"] = df.attestationAge.astype(int)
    F["nSwaps"] = df.nSwaps.astype(int)
    F["arbShare"] = jround(df.arbShare, 3)
    F["baseFee"] = df.baseFee.astype(int)
    F["edgePips"] = F.gapPips - F.baseFee
    F["edgeSigma"] = jround(F.edgePips.to_numpy(float) / np.maximum(F.realizedVolBps.to_numpy() * 100, 1.0), 4)
    v5 = mids.vol_bps(obs, n=25, step=12)
    F["vol5mBps"] = jround(np.nan_to_num(v5, nan=0.0), 4)
    m0 = mids.mid(obs)
    miss = {"vol5m_nan": int(np.isnan(v5).sum()), "mid_obs_nan": int(np.isnan(m0).sum())}
    for h in (12, 36, 900):
        mh = mids.mid(obs - h)
        r = np.log(m0 / mh) * 1e4 * gs
        miss[f"ret{h}_nan"] = int((~np.isfinite(r)).sum())
        F[f"ret{h}Bps"] = jround(np.where(np.isfinite(r), r, 0.0), 4) + 0.0  # + 0.0: no -0 in the frame
    F["edgeSigma"] = F.edgeSigma + 0.0
    return F, miss


def tabular_inputs(F):
    """services/src/model/tabular.ts tabularInputs (v2 order), from keeper Features (plain pool: fee = baseFee)."""
    fee = np.maximum(1, F.baseFee.to_numpy(float))
    g = F.gapPips.to_numpy(float)
    X = pd.DataFrame(index=F.index)
    X["gapPips"] = g
    X["edgePips"] = g - fee
    X["baseFee"] = F.baseFee.astype(float)
    X["imb_arb"] = np.where(F.gapSign < 0, F.imbalance, -F.imbalance)
    X["abs_imbalance"] = F.imbalance.abs()
    X["sizeToDepth"] = F.sizeToDepth
    X["realizedVolBps"] = F.realizedVolBps
    X["nSwaps"] = F.nSwaps.astype(float)
    X["arbShare"] = F.arbShare
    X["gap_over_fee"] = g / fee
    X["log_size"] = np.log10(F.sizeToDepth.to_numpy(float) + 1e-9)
    for c in ("edgeSigma", "vol5mBps", "ret12Bps", "ret36Bps", "ret900Bps"):
        X[c] = F[c].astype(float)
    X["sgap"] = F.gapSign.to_numpy(float) * g
    return X[V2_INPUTS]


def feat_dict(r):
    return {k: (int(r[k]) if k in INT_FIELDS else float(r[k])) for k in FEATURE_FIELDS}


def kev_record(state, y, q=None):
    qq = dict(KEV_QUESTION)
    qq["label"] = bool(y)
    if q is not None:
        qq["target"] = {"true": float(q), "false": float(1 - q)}
    return {"state": state, "questions": {"informed": qq}}


def write_jsonl(df, path, soft=False):
    """Atomic: write <path>.tmp, then rename (a watcher may start on the file as soon as it exists)."""
    tmp = Path(str(path) + ".tmp")
    with open(tmp, "w") as f:
        for s, y, q in zip(df.state_v2, df.y, df.q if soft else [None] * len(df)):
            f.write(json.dumps(kev_record(s, y, q)) + "\n")
    os.replace(tmp, path)


def read_v1(path):
    out = []
    for line in open(path):
        r = json.loads(line)
        out.append((r["state"], r["questions"]["informed"]["label"]))
    return out


def missed_slot_flags(all_rows, rows):
    """Per row of `rows`: 1 = previous slot confirmed missed (ts(t) - ts(t-1) >= 24 s, block t-1 is some row of either
    pool), 0 = confirmed not missed (t-1 known and 12 s back, or an earlier known block b' with ts(t) - ts(b') = 12 (t - b')),
    -1 = ambiguous (some slot between the nearest earlier known block and t was missed; which one is unknown)."""
    bt = all_rows[["block", "ts"]].drop_duplicates().sort_values("block")
    assert bt.block.is_unique, "block -> ts must be unique across pools"
    B, T = bt.block.to_numpy(np.int64), bt.ts.to_numpy(np.int64)
    b, t = rows.block.to_numpy(np.int64), rows.ts.to_numpy(np.int64)
    j = np.searchsorted(B, b, side="left") - 1  # nearest known block < t
    ok = j >= 0
    bp, tp = B[np.clip(j, 0, None)], T[np.clip(j, 0, None)]
    adjacent = ok & (bp == b - 1)
    flag = np.full(len(rows), -1)
    flag[adjacent & (t - tp >= 24)] = 1
    flag[adjacent & (t - tp == 12)] = 0
    flag[~adjacent & ok & (t - tp == 12 * (b - bp))] = 0
    return flag


def oof_predictions(X, y, ts, k=5):
    import lightgbm as lgb
    order = np.argsort(ts, kind="stable")
    folds = np.array_split(order, k)
    oof = np.full(len(y), np.nan)
    iters = []
    for i, te in enumerate(folds):
        tr = np.sort(np.concatenate([f for j, f in enumerate(folds) if j != i]))
        tr = tr[np.argsort(ts[tr], kind="stable")]
        cut = int(len(tr) * 0.9)
        fit, hold = tr[:cut], tr[cut:]
        m = lgb.LGBMClassifier(**LGB_PARAMS)
        m.fit(X.iloc[fit], y[fit], eval_set=[(X.iloc[hold], y[hold])], eval_metric="binary_logloss",
              callbacks=[lgb.early_stopping(100, verbose=False)])
        oof[te] = m.predict_proba(X.iloc[te], num_iteration=m.best_iteration_)[:, 1]
        iters.append(int(m.best_iteration_))
    return oof, iters


def edge_cases():
    """Hand-made Features for the kev2 parity fixture: gapSign 0, zero / negative edge, realizedVolBps 0, missing history
    (-> 0), -0 and tiny negatives (toFixed '-0.00'), toFixed ties, large values, hook fee fields (kev2 ignores them),
    baseIsToken0 = true wording."""
    base = {"gapPips": 250, "gapSign": 1, "imbalance": 0.1234, "sizeToDepth": 0.000123, "realizedVolBps": 2.345, "attestationAge": 1,
            "nSwaps": 12, "arbShare": 0.5, "baseFee": 500}
    def mk(bt0=False, **kw):
        f = {**base, **kw}
        f.setdefault("edgePips", f["gapPips"] - f["baseFee"])
        f.setdefault("edgeSigma", float(jround(f["edgePips"] / max(f["realizedVolBps"] * 100, 1.0), 4)) + 0.0)
        for k in ("vol5mBps", "ret12Bps", "ret36Bps", "ret900Bps"):
            f.setdefault(k, 1.2345)
        return f, bt0
    return [
        mk(gapPips=0, gapSign=0, ret12Bps=0.0, ret36Bps=0.0, ret900Bps=0.0),                  # gapSign 0 -> dir 0 -> trend 0
        mk(gapPips=500, baseFee=500),                                                            # zero edge -> "+0.00"
        mk(gapPips=3100, baseFee=3000, realizedVolBps=0.0),                                      # vol 0 -> max(.,1): edge / 1
        mk(gapPips=12, baseFee=3000, realizedVolBps=0.0),                                        # vol 0, negative edge
        mk(realizedVolBps=0.0, vol5mBps=0.0, ret12Bps=0.0, ret36Bps=0.0, ret900Bps=0.0, nSwaps=0, arbShare=0.0,
           imbalance=0.0, sizeToDepth=0.0),                                                      # missing history -> 0
        mk(ret12Bps=-0.0, ret36Bps=-0.001, ret900Bps=0.001, vol5mBps=0.004, edgeSigma=-0.0),  # -0 / "-0.00"
        mk(ret12Bps=0.125, ret36Bps=-0.125, ret900Bps=1.005, vol5mBps=2.675, edgeSigma=0.005),  # toFixed ties / binary
        mk(ret12Bps=-0.005, ret36Bps=10.995, ret900Bps=-999.9999, vol5mBps=123.4567, edgeSigma=-12345.6789),
        mk(gapPips=9999, gapSign=-1, baseFee=100, edgeSigma=4.0, ret900Bps=-250.5),
        mk(arbFeePips=900, kBps=2500, arbThresholdPips=100),                                   # hook fields ignored by kev2
        mk(arbFeePips=700, kBps=500),
        mk(bt0=True),                                                                            # token0 (ETH) wording
        mk(bt0=True, gapSign=-1, imbalance=-0.9999, ret12Bps=-3.14159),
    ]


def write_parity_fixture(tabf, n_train=150, n_val=100):
    """services/test/fixtures/kev2-state-parity.json: real rows (canonical baseIsToken0 = false) + edge cases."""
    rows = []
    for split, n in (("train", n_train), ("val", n_val)):
        part = tabf[tabf.split == split].sample(n, random_state=11)
        for r, st in zip(part[[f"f_{k}" for k in FEATURE_FIELDS]].rename(columns=lambda c: c[2:]).to_dict("records"), part.state_v2):
            f = feat_dict(r)
            assert features_to_state_kev2(f) == st
            rows.append({"features": f, "baseIsToken0": False, "expected": st})
    for f, bt0 in edge_cases():
        rows.append({"features": f, "baseIsToken0": bt0, "expected": features_to_state_kev2(f, bt0)})
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps(rows, indent=1) + "\n")
    return {"path": str(FIXTURE.relative_to(REPO)), "real_rows": n_train + n_val, "edge_cases": len(rows) - n_train - n_val}


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--query-lag", type=int, default=12, help="keeper CEX read at ts - S (snapshot age S - 1 s); 12 = dataset v2")
    ap.add_argument("--out", type=Path, default=OUT, help="output directory (default ml/train_kev4b/data/v2)")
    ap.add_argument("--no-fixture", action="store_true", help="do not write the kev2 parity fixture")
    a = ap.parse_args()
    lag, out = a.query_lag, a.out.resolve()
    assert lag >= 1, "query lag 0 reads the kline that closes at the block timestamp (label leak)"
    build(lag, out, fixture=(lag == 12 and not a.no_fixture))


def build(lag, OUT, fixture=True):
    OUT.mkdir(parents=True, exist_ok=True)
    raw = {name: pd.read_parquet(SRC / f"{split}.parquet") for split, name in SPLITS}
    allr = pd.concat(raw.values(), ignore_index=True)
    tg = tags_for(int(allr.ts.min()) - 1000, int(allr.ts.max()))
    mids = Mids(tg, tg)
    man = {"spec": "/tmp/ml-research/SPEC_v2.md (state format kev2, features, dead band)", "splits": {}, "verify_v1": {}}
    if lag != 12:
        man["cex_query_lag_s"] = lag
        man["cex_snapshot_age_s"] = lag - 1
        # method check: the recomputation at lag 12 must reproduce the dataset's CEX columns exactly
        chk = {}
        for name in raw:
            c = cex_snapshot(raw[name], mids, 12)
            chk[name] = {k: bool(np.array_equal(c[k].to_numpy(float), raw[name][k].to_numpy(float))) for k in c.columns}
            assert all(chk[name].values()), (name, chk[name])
        man["recompute_at_lag12_equals_dataset"] = chk
    frames, tab = {}, []
    for split, name in SPLITS:
        df = raw[name]
        F, miss = keeper_features(df, mids, lag)
        T = np.maximum(1.0, 1e-4 * df.arb_vol_usd_t.to_numpy())
        recs = [feat_dict(r) for r in F.to_dict("records")]
        v1s = [features_to_state(r) for r in recs]
        if lag == 12:
            assert v1s == df.state.tolist(), f"{name}: v1 state re-render mismatch"
        else:
            man.setdefault("fresh_vs_lag12", {})[name] = {
                "v1_state_lines_changed_rows": int(sum(a != b for a, b in zip(v1s, df.state))),
                "gapSign_changed": int((F.gapSign.to_numpy() != df.gapSign.to_numpy()).sum()),
                "gapPips_changed": int((F.gapPips.to_numpy() != df.gapPips.to_numpy()).sum())}
        st = [features_to_state_kev2(r) for r in recs]
        X = tabular_inputs(F)
        fr = pd.concat([df[["pool", "block", "ts", "markout_usd", "arb_vol_usd_t"]], F.add_prefix("f_"), X.add_prefix("x_")], axis=1)
        fr["split"] = name
        fr["T"] = T
        fr["in_deadband"] = np.abs(df.markout_usd.to_numpy()) > T
        fr["y"] = (df.markout_usd > 0).astype(int)
        fr["state_v1"] = df.state.to_numpy()
        fr["state_v2"] = st
        fr["missed_slot"] = missed_slot_flags(allr, df)
        fr["curated_out"] = False
        frames[name] = fr
        man["splits"][name] = {"rows": len(df), "missing_mid_data": miss}

    # dead band (same rows / order as v1), subsets, verification against the v1 JSONL files
    db = {}
    for split, name in SPLITS:
        f, n0, n1 = deadband(raw[name])
        f = f.sort_values(["ts", "pool"])
        d = frames[name].loc[f.index]
        assert (d.y.to_numpy() == f.y.to_numpy()).all()
        db[name] = d
        sub_name, n = SUBSETS[name]
        sub = f.sample(min(n, len(f)), random_state=0).sort_values(["ts", "pool"])
        subs = frames[name].loc[sub.index]
        ver = {}
        for fname, part in ((f"{name}.jsonl", d), (f"{sub_name}.jsonl", subs)):
            v1 = read_v1(V1 / fname)
            same_n = len(v1) == len(part)
            lab = same_n and all(bool(a[1]) == bool(b) for a, b in zip(v1, part.y))
            txt = same_n and all(a[0] == b for a, b in zip(v1, part.state_v1))
            if lag == 12:
                first8 = same_n and all(a[0] == "\n".join(b.split("\n")[:8]) for a, b in zip(v1, part.state_v2))
            else:  # fresh CEX lines differ from v1; instead the rows must be the v2 rows (same (pool, block) keys, same order)
                first8 = True
                if fname != f"{name}.jsonl":
                    k2 = pd.read_parquet(V1 / "v2" / f"{sub_name}_keys.parquet")
                    keys_eq = bool((k2.to_numpy() == part[["pool", "block", "ts"]].to_numpy()).all()) if len(k2) == len(part) else False
                    assert keys_eq, f"{sub_name}: subset keys differ from v2"
            ver[fname] = {"v1_lines": len(v1), "v2_rows": len(part), "labels_equal": bool(lab), "v1_state_equal": bool(txt)}
            if lag == 12:
                ver[fname]["kev2_first8_lines_equal_v1"] = bool(first8)
            elif fname != f"{name}.jsonl":
                ver[fname]["keys_equal_v2_subset_keys"] = True
            assert same_n and lab and txt and first8, (fname, ver[fname])
        man["verify_v1"].update(ver)
        write_jsonl(subs, OUT / f"{sub_name}.jsonl")
        subs[["pool", "block", "ts"]].to_parquet(OUT / f"{sub_name}_keys.parquet", index=False)
        man["splits"][name].update({"deadband_rows": int(n1), "base_rate_deadband": round(float(d.y.mean()), 4)})
        if name != "train":
            write_jsonl(d, OUT / f"{name}.jsonl")

    # train curation
    d = db["train"]
    grp = d.groupby("state_v2").y.agg(["nunique", "size"])
    conflict_states = set(grp.index[grp["nunique"] > 1])
    g1 = d.groupby("state_v1").y.agg(["nunique", "size"])
    drop_conf = d.state_v2.isin(conflict_states).to_numpy()
    drop_slot = (d.missed_slot == 1).to_numpy()
    keep = ~(drop_conf | drop_slot)
    fall = frames["train"]
    man["curation_train"] = {
        "deadband_rows": int(len(d)),
        "missed_slot_confirmed_deadband": int(drop_slot.sum()),
        "missed_slot_confirmed_all_rows": int((fall.missed_slot == 1).sum()),
        "missed_slot_ambiguous_kept_deadband": int((d.missed_slot == -1).sum()),
        "missed_slot_ambiguous_kept_all_rows": int((fall.missed_slot == -1).sum()),
        "conflicting_kev2_states": len(conflict_states), "rows_with_conflicting_kev2_state": int(drop_conf.sum()),
        "conflicting_v1_states_for_reference": int((g1["nunique"] > 1).sum()),
        "duplicate_kev2_states": int((grp["size"] > 1).sum()),
        "dropped_total": int((~keep).sum()), "rows_after": int(keep.sum()),
        "crash_regime_rows": "kept (not curated)",
    }
    fall.loc[d.index[~keep], "curated_out"] = True
    fall.loc[fall.missed_slot == 1, "curated_out"] = True  # also for the all-rows (weighted) training variant
    trc = d.loc[keep].copy()
    man["splits"]["train"]["rows_after_curation"] = int(len(trc))
    man["splits"]["train"]["base_rate_curated"] = round(float(trc.y.mean()), 4)
    sub20 = pd.read_parquet(OUT / "train_20k_keys.parquet")
    k20 = set(zip(sub20.pool, sub20.block))
    man["curation_train"]["train_20k_rows_that_curation_would_drop"] = int(sum((p, b) in k20 for p, b in zip(d.pool[~keep], d.block[~keep])))
    write_jsonl(trc, OUT / "train.jsonl")

    # soft targets (OOF LightGBM on curated train, 5 contiguous time folds)
    Xc = trc[[f"x_{c}" for c in V2_INPUTS]].copy(); Xc.columns = V2_INPUTS
    oof, iters = oof_predictions(Xc, trc.y.to_numpy(), trc.ts.to_numpy())
    trc["oof"] = oof
    trc["q"] = np.clip(0.5 * trc.y + 0.5 * oof, 0.02, 0.98)
    from sklearn.metrics import roc_auc_score
    man["soft_target"] = {"rule": "q = clip(0.5 y + 0.5 oof, 0.02, 0.98)", "fold_best_iterations": iters,
                          "oof_auc": round(float(roc_auc_score(trc.y, oof)), 4), "oof_brier": round(float(np.mean((oof - trc.y) ** 2)), 4),
                          "mean_q": round(float(trc.q.mean()), 4), "mean_y": round(float(trc.y.mean()), 4),
                          "corr_q_y": round(float(np.corrcoef(trc.q, trc.y)[0, 1]), 4),
                          "mean_q_y1": round(float(trc.q[trc.y == 1].mean()), 4), "mean_q_y0": round(float(trc.q[trc.y == 0].mean()), 4)}
    write_jsonl(trc, OUT / "train_soft.jsonl", soft=True)

    # tabular feature frame (all rows, all splits)
    tabf = pd.concat([frames[n] for _, n in SPLITS])
    oof_map = dict(zip(zip(trc.pool, trc.block), trc.oof))
    tabf["oof"] = [oof_map.get((p, b), np.nan) if s == "train" else np.nan for p, b, s in zip(tabf.pool, tabf.block, tabf.split)]
    tabf.drop(columns=["state_v1"]).to_parquet(OUT / "tabular_features.parquet", index=False)
    tabf.drop(columns=["state_v1", "state_v2"]).to_csv(OUT / "tabular_features.csv.gz", index=False)

    if fixture:
        man["parity_fixture"] = write_parity_fixture(tabf)
    man["files"] = {p.name: {"lines": sum(1 for _ in open(p)), "sha256": sha(p)} for p in sorted(OUT.glob("*.jsonl"))}
    (OUT / "manifest.json").write_text(json.dumps(man, indent=1))
    print(json.dumps({k: v for k, v in man.items() if k != "files"}, indent=1))
    print(json.dumps(man["files"], indent=1))


if __name__ == "__main__":
    main()
