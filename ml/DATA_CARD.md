# Oniblock ML data card

This covers every dataset used or referenced by the Oniblock ML work. The share-ready card for our own dataset is `ml/hf_release/README.md`. Read that one for the full schema, the collection method and the label check. This file records provenance, how each set was used, and what was deferred.

## B. Oniblock informed-flow blocks: primary, built by us

- **Source:** Ethereum mainnet Uniswap v3 `Swap` events.
  - USDC/WETH 0.05 % pool `0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640`: 350,417 swaps.
  - USDC/WETH 0.30 % pool `0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8`: 28,226 swaps.
  - Blocks 25,655,000 to 26,059,900, 2026-07-31 to 2026-09-26.
  - Fetched by `ml/src/fetch_swaps.py` with public RPC `eth_getLogs` (rpc.mevblocker.io, mainnet.gateway.tenderly.co; 2,000-block chunks; retries, backoff and endpoint rotation). Read-only. publicnode.com started returning "archive requests require a personal token" for these ranges and was dropped.
- **CEX mid:** Binance public bulk data (data.binance.vision), ETHUSDT 1 s klines ÷ USDCUSDT 1 m klines, converted by `ml/src/fetch_binance.py`. 2026-09-26 was not yet published, so labelled rows end at 2026-09-25 23:59 UTC.
- **Build:** `ml/src/build_blocks.py` then `ml/src/make_splits.py`. This produces `ml/data/blocks_B26.parquet` and `ml/data/{train,val,test}.parquet`.
  - Features mirror `services/src/features.ts` and the keeper. The keeper observes block t-1 at ts(t) − 12 s; window 20 blocks; vol from 120 per-block mids.
  - The label mirrors `services/src/settler.ts` with `SETTLER_LABEL_MID=cex`: arbitrage-direction swaps of block t, judged against the oracle in force, with net markout vs the Binance mid at ts(t) > 0 after fees.
  - `ml/src/states.py` is a byte-identical Python port of `featuresToState` (the plain-pool wording) and of `scoreHeuristic`. Both were checked against the TypeScript output.
- **Rows:** 174,135 (0.05 %: 154,846; 0.30 %: 19,289). Base rate 0.367.
- **Splits (time-based):**

  | split | rows | UTC range | base rate |
  |---|---|---|---|
  | train | 87,067 | Jul 31 to Sep 2 | 0.383 |
  | validation | 43,534 | Sep 2 to Sep 15 | 0.335 |
  | test | 43,534 | Sep 15 to Sep 25, held out | 0.367 |

- **Label check (C):** we compared labels with the Heimbach, Pahari and Schertenleib (IEEE S&P 2024) searcher addresses (`ml/raw/heimbach_readme.md`). A block counts as a searcher block when a Swap `sender` or `recipient` in it matches one of those addresses. P(informed | searcher block) = 0.690 vs 0.236 otherwise. Cohen's κ = 0.42, agreement 74 %. Two of the 15 addresses are active in 2026 (rsyncsearcher3 dominates). Full numbers are in `ml/data/label_check_B26.json`.
  - We did not fetch `tx.from` for each swap because of the bandwidth limit. The Swap `sender` is the contract that called the pool, which for these searchers is their own contract.
- **Release:** `ml/hf_release/` has parquet splits, the card, `sample.csv` and `manifest.json` with sha256 hashes. Suggested license CC-BY-4.0. It has not been uploaded.
- **Kev training format:** `ml/data/kev/*.jsonl` (subsamples) and `ml/train_kev4b/data/*.jsonl` (full splits). These are Kev `noul` records built from the same state text and question as `services/src/model/kev.ts`.

## A. Hugging Face: `arthurneuron/USDC-WETH-Uniswap-V3-2021-to-2023` (reference; out-of-period work deferred)

- **Id / revision / license:** `arthurneuron/USDC-WETH-Uniswap-V3-2021-to-2023` @ `3ee6dcbeb0233209a80d104edd043e5b079d5ba2` (last modified 2023-11-25). MIT, taken from the card metadata; the README contains only the license header.
- **What it is:** verified from its `download.py` and a full download (`ml/raw/hf_swaps.csv`, 6,174,701 rows, converted to `ml/raw/hf_swaps.parquet`).
  - One row per block for blocks 12,376,729 to 18,572,770, with 21,341 blocks missing.
  - The data comes from Uniswap v3 subgraph snapshots of **pool `0x88e6a0c2…5640` (USDC/WETH 0.05 %)**, queried with `pool(id, block: {number})`.
  - Columns:
    - `USDC` = cumulative `volumeToken0`, **unsigned**, in USDC.
    - `WETH` = cumulative `volumeToken1`, unsigned, in WETH.
    - `Transactions` = cumulative `txCount`, which counts swaps, mints and burns.
    - `Price` = `token0Price` = **USDC per WETH** after the block.
  - Per-block flow is therefore the first difference of the cumulative volume. The direction can only be inferred from the price change (price up = net WETH bought = zeroForOne). 3,123,519 blocks have swap volume.
- **How it was used:** the dataset was fully downloaded, validated and profiled. We drew a random sample of 80,000 active blocks (`ml/raw/A_targets.parquet`) to build a block-aggregated version of the same features and label.
  - Building it needs a block timestamp for every sampled block (archive RPC) and 31 months of Binance 1 s klines (about 2.4 GB). We downloaded 12 of the 31 months before this machine's bandwidth fell to about 50–150 KB/s.
  - Per the user's updated priority, "own dataset first; the HF set is reference only", dataset A was **not** built. So there is no A-trained model and no out-of-period A → B number.
  - It is cited as related work in the release card. The code path is `fetch_block_ts.py` plus a block-aggregate builder, and it can be resumed.
- **Known semantics and limitations if it is used later:**
  - Volumes include both directions within a block, so mixed blocks are ambiguous.
  - There is no liquidity column, so depth has to be proxied from price impact.
  - Before the Merge, block times are random and not 12 s.
  - Binance `USDCUSDT` was delisted from 2022-09-29 to 2023-03-12 during the BUSD auto-conversion. `ml/src/common.py` falls back to 1 / Coinbase USDT-USD hourly for that gap (`ml/raw/binance/coinbase_USDTUSD-1h.parquet`).

## O23: Oct-2023 slice of the 0.05 % pool (partial)

We fetched 70,150 Swap events for blocks 18,369,000 to 18,470,000 (`ml/raw/swaps_O23_0.05.parquet`). The slice overlaps the Heimbach study period and the HF dataset, so it could validate the A-style block-aggregate label against the exact swap-level label. The matching Binance 1 s month (2023-10) did not finish downloading, so the slice was not labelled.

## Licenses of inputs

- On-chain data: public.
- Binance market data: public bulk files, subject to Binance terms. Only derived per-block mids are redistributed.
- Heimbach et al. searcher list: from a public GitHub repo; cite the paper.
- HF dataset A: MIT.
