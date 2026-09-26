# Oniblock benchmark v2 - markets with routing competition

Generated 2026-09-26T08:25:10.345Z - total runtime 4s (2 runs). Reproduce: `pnpm -C benchmark bench:v2` (quick: `bench:v2:quick`). v1 results are untouched in `results/`. **QUICK MODE: 300 steps, heuristic scorer in the Jev arm; not evidence.**

## CONCLUSION

Plain-language verdicts. Numbers are across-window means over 2 one-hour windows (1 volatile, 1 calm; ETHUSDT + BTCUSDT), in **bps of one pool's starting TVL (~$20,000,000) per hour**, with a 95% bootstrap CI over windows in brackets and the sign count (windows where the difference is > 0 / < 0). YES/NO = the CI excludes 0 in that direction; otherwise INCONCLUSIVE.

**Bottom line.** QUICK MODE (300 steps, 2 windows, heuristic scorer in the Jev arm): a smoke test of the pipeline, not evidence. The narrative below is written for the full run; ignore it here.

**1. Does the fee law help LPs vs the vanilla 0.30% pool next to it, under routing competition?** (competitor LP-HODL minus vanilla LP-HODL in the same market)

- **Oniblock law, constant k = 0.5: NO.** -0.01 [-0.01, -0.01] bps (≈ $-22/h, CI $-27 to $-16) (0+/2- of 2). Volatile windows: **NO** -0.01 [-0.01, -0.01] (0+/1- of 1); calm windows: **NO** -0.01 [-0.01, -0.01] (0+/1- of 1). Versus an all-vanilla world (control pool): -0.01 [-0.01, -0.00] bps.
- **Detox-style gap fee, k = 0.7: NO.** -0.01 [-0.01, -0.01] bps (≈ $-23/h, CI $-27 to $-19) (0+/2- of 2). Volatile windows: **NO** -0.01 [-0.01, -0.01] (0+/1- of 1); calm windows: **NO** -0.01 [-0.01, -0.01] (0+/1- of 1). Versus an all-vanilla world (control pool): -0.01 [-0.01, -0.00] bps.

**2. At what retail cost / market share?** Competitor share of the market's retail volume (50% = parity) and the change in total retail execution cost vs the control market.

- const: share 27.5 [21.9, 33.1]% (volatile 21.9%, calm 33.1%); retail cost vs control 0.09 [0.01, 0.18] bps of retail volume (2+/0- of 2; calm 0.18 [0.18, 0.18]); the vanilla neighbour's LP gains 0.01 [0.00, 0.01] bps TVL vs control (it absorbs the displaced retail); both LPs together vs control 0.00 [0.00, 0.00] bps TVL.
- detox: share 25.8 [21.9, 29.6]% (volatile 21.9%, calm 29.6%); retail cost vs control 0.10 [0.00, 0.21] bps of retail volume (2+/0- of 2; calm 0.21 [0.21, 0.21]); the vanilla neighbour's LP gains 0.01 [0.00, 0.01] bps TVL vs control (it absorbs the displaced retail); both LPs together vs control 0.00 [0.00, 0.00] bps TVL.
- mjev: share 27.9 [21.9, 33.9]% (volatile 21.9%, calm 33.9%); retail cost vs control 0.10 [0.01, 0.18] bps of retail volume (2+/0- of 2; calm 0.18 [0.18, 0.18]); the vanilla neighbour's LP gains 0.01 [0.00, 0.01] bps TVL vs control (it absorbs the displaced retail); both LPs together vs control 0.00 [0.00, 0.00] bps TVL.
  Retail is barely affected in cost (fractions of a bp of volume) because routing lets it avoid the directional fee; the price is paid in market share.

**3. Does model-tuned k beat constant k?** (LP-HODL of the model pool minus the constant-k pool; same prices, same order flow, same starting liquidity)

- **Jev-tuned k vs constant k: INCONCLUSIVE.** 0.00 [0.00, 0.00] bps (≈ $0/h, CI $0 to $0) (1+/0- of 2). Volatile 0.00 [0.00, 0.00], calm 0.00 [0.00, 0.00].
- **Heuristic-tuned k vs constant k (no Jev, no fallback confound): INCONCLUSIVE.** 0.00 [0.00, 0.00] bps (≈ $0/h, CI $0 to $0) (1+/0- of 2). Volatile 0.00 [0.00, 0.00], calm 0.00 [0.00, 0.00]. Even where the CI excludes 0 the effect is a few $ to tens of $ per hour: the model mostly lowers k in quiet blocks (keeping a little more retail), which is a second-order effect.
- **Jev vs heuristic: INCONCLUSIVE.** 0.00 [0.00, 0.00] bps (≈ $0/h, CI $0 to $0) (0+/0- of 2). 
  Jev arm score sources (Jev + gated pools, all base windows): 0.0% exact Jev answers (live or cached for the identical quantized state), 0.0% nearest cached Jev answer (same side, gap within 5 bps, same k bucket), 100.0% heuristic fallback; 0 live Jev calls in total (budget 400/window). The heuristic arm has no fallback confound by construction.

**4. Does the calibration gate separate an honest model from a degraded one?** (share of 2nd-half steps with k forced to kDefault; the gated pool's Jev scores are inverted from mid-window)

- **Degraded minus honest demotion share: INCONCLUSIVE.** 20.0 [0.0, 40.0] pp (1+/0- of 2). Degraded model demoted 100.0 [100.0, 100.0]% of 2nd-half steps vs honest 80.0 [60.0, 100.0]% (honest 1st half, incl. the initial probation until 3 labels: 100.0 [100.0, 100.0]%). Volatile: 0.0 [0.0, 0.0] pp; calm: 40.0 [40.0, 40.0] pp (few labels in calm hours, slower detection). The LP value of the gate here is ~0 (gated minus honest pool, 2nd half: -0.00 [-0.00, 0.00] bps) because k itself barely matters (claim 3). **Caveats:** (i) with CEX-mid labels, arb blocks are ~always labelled informed (arbs only trade when profitable), so the gate mostly checks that p is high on arb-direction flow and low otherwise, an easy test that an inverted model fails; (ii) this holds only with the settler marking out against the CEX mid at the swap's block time. With today's settler labelling against the attested (lagged) mid, arb swaps look unprofitable and the honest model is demoted too: n/a.

**What changed vs v1, and why.** (a) Keeper lag: with the keeper attesting the same mid the arb sees (v1 assumption, lag0 variant) the constant-k pool's LP gain roughly doubles in the two variant windows (detox is mixed): n/a. (b) Competition: v1 gave every pool the same retail flow; here the hooked pools keep ~27% of it, which is what turns quiet hours negative. (c) Split swaps: splitting every arb into 5 sub-swaps changes the constant-k pools' LP difference by at most 0.000 bps (per-block anchor works).

**Sanity.** Control market (vanilla vs vanilla): share of pool b 50.00% in every window (range 50.00-50.00%), LP difference 0.0000 bps at most. The fixed-fee competitor IS the control (identical hookless 0.30% pool). Reverts: none in 2 runs.

**Assumptions that remain** (each is a flag; see Setup):

- Keeper posts the mid of the previous 1s step (lag 1), misses 5% of steps; arbitrageurs see the true 1s kline close with no latency beyond a 10% "late" draw. Kline closes stand in for the CEX mid (no spread, no depth); CEX hedging is assumed instant at the mid plus taker fee (1.5 bps / 2.5 bps).
- Retail total demand is fixed (Poisson 0.1/s per market, lognormal median $400, sigma 1.3); elasticity comes only from routing between the two pools of a market (split, optimal split with a 10% minimum leg), with no retail gas, no aggregator fees and perfect quotes. 5% of orders are informed (trade the sign of the next 30s move).
- Full-range liquidity only, one LP per pool, no JIT, no LP re-allocation between pools during the hour; two pools per market (real markets have more venues and fee tiers).
- One hour per window at 1s steps: 12 windows is still a small sample, and the windows are the most volatile / typical-quiet hours of the last 60 days (selection rule in data/windows_v2.json), so the volatile rows are stress tests, not an average day.
- Settler labels arb-direction swaps against the CEX mid at the swap's block time (fetched ex post; `--label-mid attested` = today's services behaviour, see the labelatt variant); calibration posts every 10 steps over the last 20 labelled blocks, minSamples 3.

## Setup

Fresh anvil per run (`--prune-history`), `contracts/script/bench/DeployBenchV2.s.sol`: one OniblockHook, six markets = 12 v4 pools with identical full-range liquidity (~$20,000,000 per pool at the start, L scaled per asset) and the same initial price. Markets: **control** (vanilla 0.30% vs vanilla 0.30% (control; = fixed-fee competitor)); **detox** (vanilla vs Detox-style gap fee, k = 0.7); **const** (vanilla vs Oniblock law, constant k = 0.5); **mjev** (vanilla vs Oniblock law, Jev-tuned k (gated)); **mheur** (vanilla vs Oniblock law, heuristic-tuned k (gated)); **gated** (vanilla vs Oniblock law, Jev k degraded in 2nd half (gate arm)). Hooked pools: base fee 0.30%, feeMax 1%, conservativeFee 0.50%, stale after 5 steps, model pools kMin 0.2 / kMax 0.8 / kDefault 0.5, Brier gate 0.25, minSamples 3.

Each 1s step = 3 blocks: (A) keeper attests mid[t-1] (missed with p=0.05), settler posts calibration every 10 steps; (B) two competing arbitrageurs (CEX taker 1.5/2.5 bps, gas $0.6/$0.3 per tx, random priority, 10% late each, min profit $0.5) trade each pool to their no-trade band vs the TRUE mid[t] at the hook-quoted fee; (C) retail orders (identical across markets) routed per market by best execution. LP-HODL = LP position incl. uncollected fees minus the initial deposit held, both at the true mid. Within-window CIs: circular block bootstrap over 1-minute buckets (block 8); across-window CIs: bootstrap over windows (10,000 resamples).

## Per-window results (base variant)

LP difference = competitor LP-HODL minus the vanilla pool in the same market, bps of per-pool TVL (95% within-window CI in USD). Share = competitor share of market retail volume. Retail cost vs control = bps of market retail volume.

| window | vol 1m bps | market | LP diff bps | LP diff USD [CI] | share | retail cost vs ctl | comp arbs / vanilla arbs | comp arb profit / vanilla (USD) | mean comp arb fee | mean comp k |
|---|---|---|---|---|---|---|---|---|---|---|
| ETH-vol1 | 56.96 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 0 / 0 | 0 / 0 | - | - |
| ETH-vol1 | 56.96 | detox | -0.01 | -27 [-27, -27] | 21.9% | 0.00 | 0 / 0 | 0 / 0 | - | 7,000 |
| ETH-vol1 | 56.96 | const | -0.01 | -27 [-27, -27] | 21.9% | 0.01 | 0 / 0 | 0 / 0 | - | 5,000 |
| ETH-vol1 | 56.96 | mjev | -0.01 | -27 [-27, -27] | 21.9% | 0.01 | 0 / 0 | 0 / 0 | - | 5,000 |
| ETH-vol1 | 56.96 | mheur | -0.01 | -27 [-27, -27] | 21.9% | 0.01 | 0 / 0 | 0 / 0 | - | 5,000 |
| ETH-vol1 | 56.96 | gated | -0.01 | -27 [-27, -27] | 21.9% | 0.01 | 0 / 0 | 0 / 0 | - | 5,000 |
| BTC-calm1 | 1.62 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 0 / 0 | 0 / 0 | - | - |
| BTC-calm1 | 1.62 | detox | -0.01 | -19 [-19, -19] | 29.6% | 0.21 | 0 / 0 | 0 / 0 | - | 7,000 |
| BTC-calm1 | 1.62 | const | -0.01 | -16 [-16, -16] | 33.1% | 0.18 | 0 / 0 | 0 / 0 | - | 5,000 |
| BTC-calm1 | 1.62 | mjev | -0.01 | -15 [-15, -15] | 33.9% | 0.18 | 0 / 0 | 0 / 0 | - | 4,457 |
| BTC-calm1 | 1.62 | mheur | -0.01 | -15 [-15, -15] | 33.9% | 0.18 | 0 / 0 | 0 / 0 | - | 4,457 |
| BTC-calm1 | 1.62 | gated | -0.01 | -16 [-16, -16] | 33.1% | 0.18 | 0 / 0 | 0 / 0 | - | 5,000 |

## Across-window aggregates

| group | market | LP diff vs vanilla (bps) | signs | comp vs control pool | vanilla vs control pool | market LP vs control | share % | retail cost vs ctl (bps vol) |
|---|---|---|---|---|---|---|---|---|
| all | control | 0.00 [0.00, 0.00] | 0+/0- of 2 | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 50.0 [50.0, 50.0] | 0.00 [0.00, 0.00] |
| all | detox | -0.01 [-0.01, -0.01] | 0+/2- of 2 | -0.01 [-0.01, -0.00] | 0.01 [0.00, 0.01] | 0.00 [0.00, 0.00] | 25.8 [21.9, 29.6] | 0.10 [0.00, 0.21] |
| all | const | -0.01 [-0.01, -0.01] | 0+/2- of 2 | -0.01 [-0.01, -0.00] | 0.01 [0.00, 0.01] | 0.00 [0.00, 0.00] | 27.5 [21.9, 33.1] | 0.09 [0.01, 0.18] |
| all | mjev | -0.01 [-0.01, -0.01] | 0+/2- of 2 | -0.01 [-0.01, -0.00] | 0.01 [0.00, 0.01] | 0.00 [0.00, 0.00] | 27.9 [21.9, 33.9] | 0.10 [0.01, 0.18] |
| all | mheur | -0.01 [-0.01, -0.01] | 0+/2- of 2 | -0.01 [-0.01, -0.00] | 0.01 [0.00, 0.01] | 0.00 [0.00, 0.00] | 27.9 [21.9, 33.9] | 0.10 [0.01, 0.18] |
| all | gated | -0.01 [-0.01, -0.01] | 0+/2- of 2 | -0.01 [-0.01, -0.00] | 0.01 [0.00, 0.01] | 0.00 [0.00, 0.00] | 27.5 [21.9, 33.1] | 0.09 [0.01, 0.18] |
| volatile | control | 0.00 [0.00, 0.00] | 0+/0- of 1 | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 50.0 [50.0, 50.0] | 0.00 [0.00, 0.00] |
| volatile | detox | -0.01 [-0.01, -0.01] | 0+/1- of 1 | -0.01 [-0.01, -0.01] | 0.01 [0.01, 0.01] | 0.00 [0.00, 0.00] | 21.9 [21.9, 21.9] | 0.00 [0.00, 0.00] |
| volatile | const | -0.01 [-0.01, -0.01] | 0+/1- of 1 | -0.01 [-0.01, -0.01] | 0.01 [0.01, 0.01] | 0.00 [0.00, 0.00] | 21.9 [21.9, 21.9] | 0.01 [0.01, 0.01] |
| volatile | mjev | -0.01 [-0.01, -0.01] | 0+/1- of 1 | -0.01 [-0.01, -0.01] | 0.01 [0.01, 0.01] | 0.00 [0.00, 0.00] | 21.9 [21.9, 21.9] | 0.01 [0.01, 0.01] |
| volatile | mheur | -0.01 [-0.01, -0.01] | 0+/1- of 1 | -0.01 [-0.01, -0.01] | 0.01 [0.01, 0.01] | 0.00 [0.00, 0.00] | 21.9 [21.9, 21.9] | 0.01 [0.01, 0.01] |
| volatile | gated | -0.01 [-0.01, -0.01] | 0+/1- of 1 | -0.01 [-0.01, -0.01] | 0.01 [0.01, 0.01] | 0.00 [0.00, 0.00] | 21.9 [21.9, 21.9] | 0.01 [0.01, 0.01] |
| calm | control | 0.00 [0.00, 0.00] | 0+/0- of 1 | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 50.0 [50.0, 50.0] | 0.00 [0.00, 0.00] |
| calm | detox | -0.01 [-0.01, -0.01] | 0+/1- of 1 | -0.00 [-0.00, -0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 29.6 [29.6, 29.6] | 0.21 [0.21, 0.21] |
| calm | const | -0.01 [-0.01, -0.01] | 0+/1- of 1 | -0.00 [-0.00, -0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 33.1 [33.1, 33.1] | 0.18 [0.18, 0.18] |
| calm | mjev | -0.01 [-0.01, -0.01] | 0+/1- of 1 | -0.00 [-0.00, -0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 33.9 [33.9, 33.9] | 0.18 [0.18, 0.18] |
| calm | mheur | -0.01 [-0.01, -0.01] | 0+/1- of 1 | -0.00 [-0.00, -0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 33.9 [33.9, 33.9] | 0.18 [0.18, 0.18] |
| calm | gated | -0.01 [-0.01, -0.01] | 0+/1- of 1 | -0.00 [-0.00, -0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 33.1 [33.1, 33.1] | 0.18 [0.18, 0.18] |

## Model and gate per window

| window | Jev k - const k (bps TVL) [within CI USD] | heur k - const k | Jev - heur | honest demoted 1st/2nd half | degraded demoted 1st/2nd half | honest seasoned at step | gated - honest LP, 2nd half (bps) | Jev calls / fallback |
|---|---|---|---|---|---|---|---|---|
| ETH-vol1 | 0.00 [0, 0] | 0.00 | 0.00 | 100% / 100% | 100% / 100% | never | 0.00 | 0 / 100.0% |
| BTC-calm1 | 0.00 [0, 0] | 0.00 | 0.00 | 100% / 60% | 100% / 100% | 240 | -0.00 | 0 / 100.0% |

## Variants (ETH-vol1, BTC-vol1)

split5 = every arb split into 5 sub-swaps in one tx (tests the per-block anchor). lag0 = the v1 assumption: keeper attests the same mid the arb sees, never misses. labelatt = the settler labels arb-direction swaps against the attested (lagged) mid in force, as services/src/settler.ts does today (MARKOUT_HORIZON=0), instead of the CEX mid at the swap's block time.

| window | variant | market | LP diff bps (base) | (variant) | share (base) | (variant) | mean arb fee (base) | (variant) | comp arb profit USD (base) | (variant) |
|---|---|---|---|---|---|---|---|---|---|---|

| run | Jev k - const k (bps) | heur k - const k (bps) | honest (Jev) demoted 1st/2nd half | heuristic demoted 1st/2nd | degraded demoted 2nd half | label base rate, arb blocks (Jev pool) |
|---|---|---|---|---|---|---|
| ETH-vol1:base | 0.00 | 0.00 | 100% / 100% | 100% / 100% | 100% | 0% of 0 |

## Runs

| run | steps | runtime s | txs | reverts | missed posts | arb wins (A/B) | retail orders / USD | Jev sources |
|---|---|---|---|---|---|---|---|---|
| ETH-vol1:base | 300 | 2 | 1684 | 0 | 15 | 0/0 | 29 / 15,852 | {"jev":0,"jev-cache":0,"jev-nearest":0,"heuristic":570,"heuristic-paced":0,"heuristic-jev-failed":0} |
| BTC-calm1:base | 300 | 2 | 1729 | 0 | 15 | 0/0 | 29 / 15,852 | {"jev":0,"jev-cache":0,"jev-nearest":0,"heuristic":570,"heuristic-paced":0,"heuristic-jev-failed":0} |

Charts: `chart-lp.svg` (LP difference vs vanilla per window), `chart-share.svg` (competitor retail share), `chart-retail.svg` (market retail cost vs control).
