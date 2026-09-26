"""Zero-shot Jev (typesafe-ai/jev via Vercel AI Gateway /v1/evaluate) on a stratified test subsample.
Uses the SAME typed questions as services/src/model/jev.ts (JEV_QUESTIONS) so the result reflects the production client.
Hard cap on calls (default 500); responses cached by state text in ml/models/jev_cache.json.
The API key is read from <repo>/.env (AI_GATEWAY_API_KEY) and never printed.

usage: python jev_eval.py <n_rows> <v1|v4> <max_calls>
"""
import json, sys, time, os
import numpy as np, pandas as pd, requests
from common import DATA, MODELS, REPO
from states import features_to_state, row_features

URL = "https://ai-gateway.vercel.sh/v1/evaluate"
QUESTIONS_V1 = {
    "toxic": {"type": "boolean",
              "instructions": "Will the next block's arbitrage-direction swaps into this pool be informed flow that is toxic to liquidity providers (the trader profits because the pool price is stale versus the Binance price)?",
              "criteria": {"true": "informed / toxic: a price gap larger than the fee is open and arbitrageurs are likely to close it at LPs expense",
                           "false": "benign: no profitable gap, flow is noise or uninformed"}},
    "regime": {"type": "choice", "instructions": "Classify the flow regime of this pool for the next block.",
               "criteria": {"informed": "informed arbitrage against a stale pool price", "dump": "one-sided uninformed selling or buying without a price gap", "unknown": "no clear signal"}},
}
QUESTIONS_V4 = {
    "toxic": {"type": "boolean",
              "instructions": "Should this pool charge an extra arbitrage fee on the next block? Answer true only if there is profitable, informed arbitrage: the pool price is stale versus the Binance mid by MORE than the base fee (arb_edge_at_base_fee positive), so arbitrageurs will trade toward the Binance mid at liquidity providers expense. The extra fee is proportional to your probability. If arb_edge_at_base_fee is zero or negative there is no profitable arbitrage: the probability must be near 0, because an extra fee would only push ordinary traders to other pools.",
              "criteria": {"true": "profitable arbitrage at the base fee: arb_edge_at_base_fee is positive and arbitrageurs will close the gap at LPs expense",
                           "false": "no profitable arbitrage at the base fee (arb_edge_at_base_fee zero or negative): ordinary flow, charge only the base fee"}},
    "regime": QUESTIONS_V1["regime"],
}
CACHE = MODELS / "jev_cache.json"


def v4_state(f):
    """Port of services/src/features.ts featuresToStateV4 (keeper default since v4, JEV_PROMPT=v4)."""
    from states import _fx
    base = "token1 (ETH)"
    gs = f["gapSign"]
    pool_vs = "above" if gs > 0 else "below" if gs < 0 else "equal to"
    edge = f["gapPips"] - f["baseFee"]
    return "\n".join([
        "Uniswap v4 ETH/USDC pool, per-block snapshot (past data only). The pool charges an extra fee on swaps toward the Binance mid in proportion to the probability that the next block has profitable arbitrage; probability near 0 = only the normal base fee.",
        f"price_gap: pool price is {pool_vs} the Binance mid by {_fx(f['gapPips'] / 1e4, 3)}% ({int(f['gapPips'])} pips).",
        f"base_fee: {_fx(f['baseFee'] / 1e4, 2)}%. Arbitrage toward the Binance mid is profitable only when the gap is larger than the base fee (plus about 0.02% exchange costs).",
        f"arb_edge_at_base_fee: gap minus base fee = {_fx(edge / 1e4, 3)}% ({'positive: arbitrage IS profitable at the base fee' if edge > 0 else 'zero or negative: NO profitable arbitrage at the base fee'}).",
        f"flow_imbalance: {_fx(f['imbalance'], 3)} on [-1,1] (+1 = all recent swaps bought {base}, -1 = all sold).",
        f"recent_swaps: {int(f['nSwaps'])} in last blocks, {_fx(f['arbShare'] * 100, 0)}% moved the pool toward the Binance mid.",
        f"size_to_depth: average swap is {_fx(f['sizeToDepth'] * 100, 3)}% of pool depth.",
        f"cex_volatility: {_fx(f['realizedVolBps'], 2)} bps per interval (stdev of log returns).",
        f"oracle_age: {int(f['attestationAge'])} blocks since last price attestation.",
    ])


def api_key():
    for line in open(REPO / ".env"):
        if line.startswith("AI_GATEWAY_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("AI_GATEWAY_API_KEY missing")


def stratified_subsample(test, n, seed=0):
    """Stratify by label x gap bucket (so rare informed blocks and large gaps are represented); weights recorded."""
    t = test.copy()
    t["gb"] = pd.cut(t.edgePips, [-1e9, -300, -100, 0, 100, 1e9], labels=False)
    t["stratum"] = t.y.astype(str) + "_" + t.gb.astype(str)
    counts = t.stratum.value_counts()
    per = max(1, n // len(counts))
    parts = []
    for s, c in counts.items():
        parts.append(t[t.stratum == s].sample(min(c, per), random_state=seed))
    sub = pd.concat(parts)
    if len(sub) < n:
        rest = t.drop(sub.index)
        sub = pd.concat([sub, rest.sample(min(len(rest), n - len(sub)), random_state=seed)])
    sub = sub.iloc[:n].copy()
    # inverse-probability weights to recover population metrics
    sub["w"] = sub.stratum.map(counts) / sub.stratum.map(sub.stratum.value_counts())
    return sub


def main(n=175, prompt="v1", max_calls=175):
    test = pd.read_parquet(DATA / "test.parquet")
    sub = stratified_subsample(test, n, seed=1)
    QUESTIONS = QUESTIONS_V1 if prompt == "v1" else QUESTIONS_V4
    cache = json.load(open(CACHE)) if CACHE.exists() else {}
    key = api_key()
    s = requests.Session()
    calls = 0
    ps, lat = [], []
    for _, r in sub.iterrows():
        st = features_to_state(row_features(r)) if prompt == "v1" else v4_state(row_features(r))
        ck = st if prompt == "v1" else "v4|" + st
        if ck not in cache:
            if calls >= max_calls:
                ps.append(np.nan); lat.append(np.nan); continue
            for att in range(4):
                t0 = time.time()
                try:
                    resp = s.post(URL, headers={"authorization": f"Bearer {key}", "content-type": "application/json"},
                                  json={"model": "typesafe-ai/jev", "state": st, "questions": QUESTIONS}, timeout=20)
                    dt = (time.time() - t0) * 1000
                    calls += 1
                    if resp.ok:
                        a = resp.json()["answers"]
                        cache[ck] = {"p": a["toxic"]["probability"], "cls": a.get("regime", {}).get("choice"), "latency_ms": dt}
                        break
                except Exception:
                    pass
                time.sleep(1 + att)
            if calls % 25 == 0:
                json.dump(cache, open(CACHE, "w"))
                print("calls", calls, flush=True)
        c = cache.get(ck)
        ps.append(c["p"] if c else np.nan); lat.append(c["latency_ms"] if c else np.nan)
    json.dump(cache, open(CACHE, "w"))
    sub["p_jev"] = ps
    sub["latency_ms"] = lat
    sub[["pool", "block", "y", "w", "stratum", "p_jev", "latency_ms"]].to_parquet(MODELS / f"jev_{prompt}_test_preds.parquet", index=False)
    print("done calls", calls, "answered", int(np.isfinite(sub.p_jev).sum()), "of", len(sub))


if __name__ == "__main__":
    # budget: <= 500 calls in total across runs (150 v1 calls were spent on an earlier, discarded 500-row draw)
    main(int(sys.argv[1]), sys.argv[2], int(sys.argv[3]))
