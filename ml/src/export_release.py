"""Export the share-ready Hugging Face dataset package (not uploaded) to ml/hf_release/."""
import json, hashlib
import pandas as pd
from common import DATA, ML

OUT = ML / "hf_release"
COLS = ["split", "pool", "pool_address", "fee_pips", "block", "ts", "pool_price_obs", "cex_mid_obs", "cex_mid_t",
        "gapPips", "gapSign", "edgePips", "imbalance", "imb_arb", "abs_imbalance", "sizeToDepth", "realizedVolBps",
        "attestationAge", "nSwaps", "arbShare", "baseFee", "n_swaps_t", "n_arb_swaps_t", "arb_vol_usd_t", "vol_usd_t",
        "p_open_t", "p_close_t", "markout_usd", "fee_usd", "searcher_arb", "searcher_any", "y", "p_heuristic", "state"]


def main():
    (OUT / "data").mkdir(parents=True, exist_ok=True)
    man = {}
    for s in ("train", "validation", "test"):
        src = "val" if s == "validation" else s
        d = pd.read_parquet(DATA / f"{src}.parquet")[COLS]
        d["split"] = s
        p = OUT / "data" / f"{s}.parquet"
        d.to_parquet(p, index=False)
        man[s] = {"rows": len(d), "sha256": hashlib.sha256(p.read_bytes()).hexdigest(), "base_rate": round(float(d.y.mean()), 4),
                  "from": str(pd.to_datetime(d.ts.min(), unit="s")), "to": str(pd.to_datetime(d.ts.max(), unit="s")),
                  "blocks": [int(d.block.min()), int(d.block.max())]}
        if s == "train":
            d.sample(200, random_state=0).sort_values("block").drop(columns=["state"]).to_csv(OUT / "sample.csv", index=False)
    json.dump(man, open(OUT / "manifest.json", "w"), indent=1)
    print(json.dumps(man, indent=1))


if __name__ == "__main__":
    main()
