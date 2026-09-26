# `ml/` — dataset, baselines and the Kev-4B fine-tuning package

Everything needed to (re)build the informed-flow dataset, score baseline models, and fine-tune Kev-4B for the keeper. Nothing here runs on-chain; the keeper consumes the resulting model through `services/src/model/kev.ts`.

## Start here

| I want to… | Go to |
|---|---|
| **Fine-tune Kev-4B** (on any machine with ≥32 GB) | `train_kev4b/README.md` — self-contained guide, time-boxed for a 3–4 h session |
| Get the training data | `train_kev4b.zip` (2 MB) → `cd ml && unzip -o train_kev4b.zip` recreates `train_kev4b/data/*.jsonl` |
| Read the dataset card / publish to Hugging Face | `hf_release/` — README (dataset card), `data/{train,validation,test}.parquet`, `sample.csv`, `manifest.json` |
| See baseline scores | `models/tabular_results.json` (raw labels); the dead-band baselines are in `train_kev4b/README.md` |
| Use the production model | `models/oniblock1.json` (LightGBM, 17 features, Binance read ~2 s before the block) — the only model weights in the repo; the keeper evaluates it in `services/src/model/tabular.ts` |
| Rebuild everything | `src/` (see below) |

## The dataset in one paragraph

174,135 (pool, block) rows from Ethereum mainnet Uniswap v3 USDC/WETH 0.05% and 0.30% pools, Jul 31 – Sep 25 2026, joined with Binance 1-second mids. Features are what a per-block keeper could observe before the block (gap vs CEX, edge vs fee, flow imbalance, size/depth, volatility). The label is whether the block's arbitrage-direction swaps were profitable against Binance after the fee — i.e. informed (toxic) flow that costs LPs. Splits are strictly time-ordered. Labels were checked against the Heimbach et al. (IEEE S&P 2024) CEX-DEX searcher addresses (informed rate 69% with a known searcher vs 24% without). Full details, columns and limitations: `hf_release/README.md`.

**Dead-band labels (recommended, used for training):** 59% of blocks have |markout| < $1 and their sign is price noise. `src/kev_export_deadband.py` keeps only decisive blocks (|markout| > max($1, 1 bp of arb volume)): train 26,925 / val 11,842 / test 12,837. The on-chain calibration gate grades with the same dead band (`SETTLER_DEADBAND_*` in services).

## Rebuild pipeline (`src/`)

```
fetch_swaps.py      Swap events for both pools via public RPC (chunked eth_getLogs, backoff)
fetch_binance.py    Binance ETHUSDT 1s + USDCUSDT 1m klines (data.binance.vision)
fetch_block_ts.py   block timestamps
build_blocks.py     per-block features + markout label  -> data/blocks_B26.parquet
make_splits.py      time-based splits, `state` text (byte-compatible with services/src/features.ts)
export_release.py   -> hf_release/
train_tabular.py    base-rate / heuristic / logreg / LightGBM / XGBoost baselines (v1) -> runs/tabular-v1/ (gitignored; the
                    stored results in models/ are not overwritten; export_tabular.py turns its LightGBM into tabular-v1 JSON there)
build_v2.py         v2 data: past-only CEX features, dead band, curation (--query-lag 3 -> train_kev4b/data/v2-fresh)
train_tabular_v2.py oniblock1 from train_kev4b/data/v2-fresh -> models/oniblock1.json
oniblock1_parity_fixture.py   services/test/fixtures/oniblock1-parity.json (TS evaluator parity)
eval_selective.py   No hook vs Jev vs oniblock1 on test -> models/oniblock1_selective_results.json (Jev inputs: models/jev-eval/)
kev_export_deadband.py  -> train_kev4b/data/*.jsonl (Kev native JSONL, dead-band labels)
jev_eval.py, tabpfn_eval.py   optional model evals (Jev via AI Gateway; TabPFN)
```

Python 3.12 venv: `python3.12 -m venv .venv && .venv/bin/pip install pandas pyarrow numpy scikit-learn lightgbm xgboost requests`.
Raw downloads land in `raw/` (gitignored, ~1 GB); `vendor/` (a Kev checkout used for local experiments) is gitignored too — the fine-tuning guide clones Kev from GitHub.

## Provenance

- Uniswap v3 swaps: public RPC `eth_getLogs`, blocks 25,655,000–26,059,900.
- CEX mids: Binance public market-data files (derived per-block mids are included; raw klines are not redistributed).
- Related dataset (reference only): `arthurneuron/USDC-WETH-Uniswap-V3-2021-to-2023` (HF, MIT, rev `3ee6dcbe`).
- Searcher labels: Heimbach, Pahari, Schertenleib, *Non-Atomic Arbitrage in Decentralized Finance*, IEEE S&P 2024.
