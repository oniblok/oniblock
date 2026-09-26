---
license: cc-by-4.0
language: en
pretty_name: Oniblock informed-flow blocks (Uniswap v3 USDC/WETH, mainnet, Aug-Sep 2026)
task_categories:
  - tabular-classification
  - text-classification
tags:
  - defi
  - uniswap
  - lvr
  - cex-dex-arbitrage
  - calibration
  - ethereum
size_categories:
  - 100K<n<1M
configs:
  - config_name: default
    data_files:
      - split: train
        path: data/train.parquet
      - split: validation
        path: data/validation.parquet
      - split: test
        path: data/test.parquet
---

# Oniblock informed-flow blocks

This is a block-level, labelled dataset for one question: **will the arbitrage-direction flow in this block be informed?** "Informed" means the swaps that move the pool toward the CEX price are profitable against the Binance mid at swap time, after paying the pool fee. That is the LVR / CEX-DEX arbitrage definition.

Every row is one (pool, block) pair from the Ethereum-mainnet Uniswap v3 **USDC/WETH 0.05 %** and **0.30 %** pools, in blocks where at least one swap moved the pool toward the Binance mid. The features describe what a per-block keeper could observe at the previous block. The label is computed ex post from the block's swaps.

It was built for Oniblock / ReceiptHook (ETHGlobal Tokyo 2026), a Uniswap v4 hook that sets an arbitrage-direction fee from a calibrated per-block `p_toxic` score. The label definition matches the project's settler (`services/src/settler.ts`, `SETTLER_LABEL_MID=cex`). The features and the `state` text match its keeper (`services/src/features.ts`).

## At a glance

| split | rows | time range (UTC) | blocks | base rate (y=1) |
|---|---|---|---|---|
| train | 87,067 | 2026-07-31 19:41 to 2026-09-02 00:09 | 25,655,001 to 25,885,927 | 0.383 |
| validation | 43,534 | 2026-09-02 00:09 to 2026-09-15 00:45 | 25,885,928 to 25,979,361 | 0.335 |
| test | 43,534 | 2026-09-15 00:46 to 2026-09-25 23:59 | 25,979,368 to 26,057,903 | 0.367 |

- Pools: 0.05 % pool `0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640` (154,846 rows, base rate 0.359) and 0.30 % pool `0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8` (19,289 rows, base rate 0.434).
- Source events: 350,417 swaps (0.05 %) and 28,226 swaps (0.30 %).
- The splits are strictly time-ordered: the oldest 50 %, the next 25 % and the most recent 25 %. There is no shuffling, so there is no look-ahead across splits.
- `sample.csv` holds 200 random training rows without the `state` column. `manifest.json` has row counts and sha256 hashes.

## How it was collected

1. **Swaps.** We pulled Uniswap v3 `Swap` events for both pools with public mainnet RPC `eth_getLogs` (rpc.mevblocker.io and mainnet.gateway.tenderly.co, 2,000-block chunks, retries and backoff). They cover blocks 25,655,000 to 26,059,900. Block timestamps come from the logs' `blockTimestamp` field.
2. **CEX mid.** Binance public bulk data (data.binance.vision): ETHUSDT **1 s** kline closes divided by USDCUSDT 1 m closes, which gives USDC per ETH and corrects for the USDC/USDT basis. The lookup follows the project's `midAt`: the close of the latest kline whose open time is ≤ t.
3. **Keeper view.** The keeper observes block t-1 at `obs = ts(t) - 12 s`:
   - `pool_price_obs`: the pool price after the last swap at or before t-1.
   - `cex_mid_obs`: the mid at `obs`.
   - Window features over blocks t-20 .. t-1.
   - `realizedVolBps` over the last 120 mids sampled every 12 s.
4. **Label.** A swap in block t is *arbitrage-direction* if it moves the pool, from its pre-swap price, toward `cex_mid_obs`. This is the hook's `isArbDir` against the attested oracle. Then:
   - `markout_usd` = Σ over those swaps of (swapper USDC delta + swapper WETH delta × `cex_mid_t`), where `cex_mid_t` is the mid at ts(t). The fee is already inside the executed amounts.
   - `y = 1` iff `markout_usd > 0`.

## Columns

| column | meaning |
|---|---|
| `split` | train / validation / test (time-based) |
| `pool`, `pool_address`, `fee_pips`, `baseFee` | fee tier ("0.05"/"0.30"), pool address, fee in pips (500 / 3000) |
| `block`, `ts` | target block t and its unix timestamp |
| `pool_price_obs`, `cex_mid_obs`, `cex_mid_t` | pool price (USDC per WETH) seen by the keeper, Binance mid at observation, Binance mid at ts(t) |
| `gapPips` | ⌊\|mid − pool\| / pool × 1e6⌋, the same as the contract's `gapPips` on priceX96 |
| `gapSign` | +1 if the pool's token1/token0 price is above the oracle (ETH cheap in the pool), −1 below |
| `edgePips` | `gapPips − fee_pips` |
| `imbalance` | net token0 (USDC) buy pressure over the last 20 blocks, on [−1, 1] (features.ts) |
| `imb_arb`, `abs_imbalance` | orientation-free imbalance: + means recent flow pushed in the arbitrage direction; \|imbalance\| |
| `sizeToDepth` | mean \|amount0\| per swap in the window ÷ virtual token0 depth (L·2^96/sqrtPriceX96) |
| `realizedVolBps` | stdev of log returns of the last 120 per-block (12 s) Binance mids, bps |
| `attestationAge` | 1 (a keeper posting every block) |
| `nSwaps`, `arbShare` | swaps in the window, and the share that moved the pool toward the oracle in force at the time |
| `n_swaps_t`, `n_arb_swaps_t`, `arb_vol_usd_t`, `vol_usd_t` | block t's swap count, arbitrage-direction count, arbitrage-direction and total USDC volume (label side, **not** features) |
| `p_open_t`, `p_close_t` | pool price before / after block t (label side) |
| `markout_usd`, `fee_usd` | net markout of t's arbitrage-direction swaps vs `cex_mid_t` (USD), and the fee they paid (label side) |
| `searcher_arb`, `searcher_any` | a Swap `sender`/`recipient` in t (arbitrage-direction swaps only / any swap) matches a Heimbach et al. searcher address |
| `y` | label: 1 = informed (arbitrage-direction markout > 0 after the fee) |
| `p_heuristic` | the project's deterministic heuristic score (services/src/model/heuristic.ts), for reference |
| `state` | natural-language state exactly as the keeper feeds Jev / Kev (featuresToState, plain-pool wording) |

Only the columns before `n_swaps_t` (plus `state`) are available at prediction time. The label-side columns leak the answer, so do not train on them.

## Label check against known CEX-DEX searchers

Heimbach, Pahari and Schertenleib (2024) publish a mapping of known non-atomic (CEX-DEX) arbitrage searcher addresses. We flag a block when an arbitrage-direction swap's `sender` or `recipient` is one of those addresses (15 addresses, 2 of them active here: `rsyncsearcher3` in 105,163 swap-side hits, `searcher5` in 308).

| | rows | searcher share | P(y=1 \| searcher) | P(y=1 \| other) | share of informed blocks with a searcher | Cohen's κ | agreement |
|---|---|---|---|---|---|---|---|
| all | 174,135 | 0.289 | **0.690** | 0.236 | 0.544 | 0.42 | 0.743 |
| 0.05 % pool | 154,846 | 0.275 | 0.679 | 0.238 | 0.520 | 0.40 | 0.740 |
| 0.30 % pool | 19,289 | 0.408 | 0.747 | 0.217 | 0.703 | 0.53 | 0.768 |
| arbitrage volume ≥ $50k | 20,358 | 0.603 | 0.868 | 0.738 | – | – | – |

Blocks touched by a known searcher are about 2.9× as likely to be labelled informed. Agreement is moderate (κ ≈ 0.42), not perfect, for three reasons:
- The address list is from 2023 and covers only a few of today's searchers.
- Many informed blocks are small, non-searcher trades that happened to beat the mid.
- Some searcher trades lose against the 1 s mid, because of hedging, inventory or mid noise.

## Limitations

- **Mid noise.** A 1 s Binance close is a proxy for the price an arbitrageur hedges at. For small gaps the label is sensitive to it. Binance ETHUSDT may also lead or lag other venues.
- **Keeper timing is approximate.** Observation is modelled as ts(t) − 12 s. A missed slot makes the true previous block older.
- **The label counts every arbitrage-direction swap, retail included.** Tiny swaps in the arbitrage direction count the same as large arbitrages, so this is the settler's definition rather than a searcher-intent label.
- **v3 pools, not a hooked v4 pool.** The fee is the static tier, so there is no directional fee or k in the features (plain-pool `state` wording).
- **One pair, one short, recent period** (8 weeks). Regimes such as volatility, gas and builder market structure change.
- USDC/USDT basis correction uses 1 m resolution.

## Related datasets and references

- **arthurneuron/USDC-WETH-Uniswap-V3-2021-to-2023** (Hugging Face, MIT, revision `3ee6dcbeb0233209a80d104edd043e5b079d5ba2`). It holds per-block snapshots of the same 0.05 % pool (cumulative USDC/WETH volume, cumulative tx count and `token0Price` from the Uniswap v3 subgraph), blocks 12,376,729 to 18,572,770. It inspired the block-level framing and is used in the project as an optional out-of-period reference. Its volumes are cumulative and unsigned, so flow direction must be inferred from price changes.
- L. Heimbach, V. Pahari, E. Schertenleib. *Non-Atomic Arbitrage in Decentralized Finance.* IEEE S&P 2024. Searcher address mapping: github.com/liobaheimbach/Non-Atomic-Arbitrage-in-Decentralized-Finance.
- Milionis, Moallemi, Roughgarden, Zhang. *Automated Market Making and Loss-Versus-Rebalancing* (2022), for the LVR definition.

## Recommended label: dead band (what the training package uses)

59% of rows have |markout_usd| < $1: in those blocks the sign of the label is decided by 1-second Binance noise, not by any real edge. For training and for grading a model, apply a dead band:

- `T = max($1, 1 bp of arb_vol_usd_t)`
- `y = 1` (informed) iff `markout_usd > T`; `y = 0` (benign) iff `markout_usd < -T`
- rows with `|markout_usd| <= T` are **undecidable**: drop them from training and do not grade a model on them.

Effect on this dataset: train 87,067 -> 26,925 rows (base rate 0.383 -> 0.595), validation 43,534 -> 11,842 (0.557), test 43,534 -> 12,837 (0.610). The base rate rises because decisive blocks are mostly real arbitrage. The raw `y` column (markout > 0) is kept so you can choose another threshold; `markout_usd` and `arb_vol_usd_t` are included for that reason. The script is `ml/src/kev_export_deadband.py`.

## License and terms

We suggest **CC-BY-4.0** for this derived dataset. On-chain data is public. The CEX mids are derived from Binance's public market-data files; check Binance's terms before any commercial redistribution of the raw klines, which are not included here (only derived per-block mids are). Searcher labels come from Heimbach et al. Please cite them.

## Citation

```bibtex
@misc{oniblock_informed_flow_2026,
  title  = {Oniblock informed-flow blocks: Uniswap v3 USDC/WETH arbitrage-direction markout labels},
  year   = {2026},
  note   = {ETHGlobal Tokyo 2026, Oniblock / ReceiptHook}
}
@inproceedings{heimbach2024nonatomic,
  title = {Non-Atomic Arbitrage in Decentralized Finance},
  author = {Heimbach, Lioba and Pahari, Vabuk and Schertenleib, Eric},
  booktitle = {IEEE Symposium on Security and Privacy (SP)}, year = {2024}
}
```
