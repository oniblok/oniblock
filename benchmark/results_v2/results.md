# Oniblock benchmark v2 - markets with routing competition

Generated 2026-09-26T08:25:09.662Z - total runtime 1085s (18 runs). Reproduce: `pnpm -C benchmark bench:v2` (quick: `bench:v2:quick`). v1 results are untouched in `results/`.

## CONCLUSION

Plain-language verdicts. Numbers are across-window means over 12 one-hour windows (6 volatile, 6 calm; ETHUSDT + BTCUSDT), in **bps of one pool's starting TVL (~$20,000,000) per hour**, with a 95% bootstrap CI over windows in brackets and the sign count (windows where the difference is > 0 / < 0). YES/NO = the CI excludes 0 in that direction; otherwise INCONCLUSIVE.

**Bottom line.** Once the keeper lags the arbitrageur by one block and retail can route to a vanilla pool, the fee law is **not a robust LP win**: it helps in volatile hours (detox-style 0.32 [0.02, 0.65] bps/h, constant k 0.04 [-0.12, 0.22]) and costs LPs in quiet hours (-0.21 [-0.23, -0.18] for constant k, 0+/6- of 6) because the directional fee also taxes retail that trades back toward the mid, and that flow leaves for the vanilla pool (the competitor keeps only ~26% of retail). Across all 12 windows the effect is indistinguishable from zero and small in dollars (tens to hundreds of $ per hour on a $20M pool). Model-tuned k is not distinguishable from constant k in any economically meaningful way (heuristic k: +$48/h-scale; Jev k is slightly worse than the heuristic). The calibration gate is the one component that works as designed: it demotes the degraded model most of the time and the honest one rarely.

**1. Does the fee law help LPs vs the vanilla 0.30% pool next to it, under routing competition?** (competitor LP-HODL minus vanilla LP-HODL in the same market)

- **Oniblock law, constant k = 0.5: INCONCLUSIVE.** -0.08 [-0.18, 0.04] bps (≈ $-169/h, CI $-365 to $73) (4+/8- of 12). Volatile windows: **INCONCLUSIVE** 0.04 [-0.12, 0.22] (4+/2- of 6); calm windows: **NO** -0.21 [-0.23, -0.18] (0+/6- of 6). Versus an all-vanilla world (control pool): 0.03 [-0.07, 0.16] bps.
- **Detox-style gap fee, k = 0.7: INCONCLUSIVE.** 0.04 [-0.16, 0.29] bps (≈ $82/h, CI $-315 to $573) (4+/8- of 12). Volatile windows: **YES** 0.32 [0.02, 0.65] (4+/2- of 6); calm windows: **NO** -0.23 [-0.26, -0.21] (0+/6- of 6). Versus an all-vanilla world (control pool): 0.17 [-0.04, 0.40] bps.

**2. At what retail cost / market share?** Competitor share of the market's retail volume (50% = parity) and the change in total retail execution cost vs the control market.

- const: share 26.2 [24.1, 28.2]% (volatile 26.5%, calm 25.9%); retail cost vs control 0.23 [-0.23, 0.64] bps of retail volume (9+/3- of 12; calm 0.59 [0.43, 0.74]); the vanilla neighbour's LP gains 0.12 [0.10, 0.14] bps TVL vs control (it absorbs the displaced retail); both LPs together vs control 0.15 [0.04, 0.28] bps TVL.
- detox: share 23.2 [20.8, 25.7]% (volatile 24.0%, calm 22.3%); retail cost vs control -0.05 [-0.75, 0.55] bps of retail volume (8+/4- of 12; calm 0.67 [0.49, 0.83]); the vanilla neighbour's LP gains 0.12 [0.11, 0.14] bps TVL vs control (it absorbs the displaced retail); both LPs together vs control 0.29 [0.09, 0.53] bps TVL.
- mjev: share 31.3 [29.7, 33.2]% (volatile 29.9%, calm 32.8%); retail cost vs control 0.09 [-0.21, 0.37] bps of retail volume (8+/4- of 12; calm 0.35 [0.21, 0.47]); the vanilla neighbour's LP gains 0.09 [0.08, 0.11] bps TVL vs control (it absorbs the displaced retail); both LPs together vs control 0.11 [0.03, 0.21] bps TVL.
  Retail is barely affected in cost (fractions of a bp of volume) because routing lets it avoid the directional fee; the price is paid in market share.

**3. Does model-tuned k beat constant k?** (LP-HODL of the model pool minus the constant-k pool; same prices, same order flow, same starting liquidity)

- **Jev-tuned k vs constant k: INCONCLUSIVE.** -0.01 [-0.05, 0.02] bps (≈ $-29/h, CI $-99 to $36) (7+/5- of 12). Volatile -0.05 [-0.10, -0.00], calm 0.03 [0.02, 0.03].
- **Heuristic-tuned k vs constant k (no Jev, no fallback confound): YES.** 0.02 [0.00, 0.05] bps (≈ $48/h, CI $1 to $106) (10+/2- of 12). Volatile 0.03 [-0.02, 0.08], calm 0.02 [0.02, 0.02]. Even where the CI excludes 0 the effect is a few $ to tens of $ per hour: the model mostly lowers k in quiet blocks (keeping a little more retail), which is a second-order effect.
- **Jev vs heuristic: NO.** -0.04 [-0.08, -0.01] bps (≈ $-77/h, CI $-155 to $-11) (7+/5- of 12). 
  Jev arm score sources (Jev + gated pools, all base windows): 98.8% exact Jev answers (live or cached for the identical quantized state), 1.2% nearest cached Jev answer (same side, gap within 5 bps, same k bucket), 0.0% heuristic fallback; 1883 live Jev calls in total (budget 400/window). The heuristic arm has no fallback confound by construction.

**4. Does the calibration gate separate an honest model from a degraded one?** (share of 2nd-half steps with k forced to kDefault; the gated pool's Jev scores are inverted from mid-window)

- **Degraded minus honest demotion share: YES.** 50.8 [34.4, 65.9] pp (11+/0- of 12). Degraded model demoted 60.8 [43.1, 77.0]% of 2nd-half steps vs honest 10.0 [0.0, 23.7]% (honest 1st half, incl. the initial probation until 10 labels: 43.8 [32.1, 56.3]%). Volatile: 66.5 [43.1, 80.6] pp; calm: 35.2 [18.3, 50.6] pp (few labels in calm hours, slower detection). The LP value of the gate here is ~0 (gated minus honest pool, 2nd half: -0.01 [-0.02, 0.01] bps) because k itself barely matters (claim 3). **Caveats:** (i) with CEX-mid labels, arb blocks are ~always labelled informed (arbs only trade when profitable), so the gate mostly checks that p is high on arb-direction flow and low otherwise, an easy test that an inverted model fails; (ii) this holds only with the settler marking out against the CEX mid at the swap's block time. With today's settler labelling against the attested (lagged) mid, arb swaps look unprofitable and the honest model is demoted too: ETH-vol1: heuristic model demoted 0% -> 100% of 2nd-half steps, "informed" base rate on arb blocks 100% -> 0%; BTC-vol1: heuristic model demoted 0% -> 57% of 2nd-half steps, "informed" base rate on arb blocks 100% -> 34%.

**What changed vs v1, and why.** (a) Keeper lag: with the keeper attesting the same mid the arb sees (v1 assumption, lag0 variant) the constant-k pool's LP gain roughly doubles in the two variant windows (detox is mixed): ETH-vol1: const 0.44 -> 0.90 bps, detox 1.06 -> 1.17 bps; const-pool arb profit $990 -> $672; BTC-vol1: const 0.06 -> 0.11 bps, detox 0.38 -> 0.31 bps; const-pool arb profit $231 -> $170. (b) Competition: v1 gave every pool the same retail flow; here the hooked pools keep ~26% of it, which is what turns quiet hours negative. (c) Split swaps: splitting every arb into 5 sub-swaps changes the constant-k pools' LP difference by at most 0.000 bps (per-block anchor works).

**Sanity.** Control market (vanilla vs vanilla): share of pool b 50.00% in every window (range 50.00-50.00%), LP difference 0.0000 bps at most. The fixed-fee competitor IS the control (identical hookless 0.30% pool). Reverts: none in 18 runs.

**Assumptions that remain** (each is a flag; see Setup):

- Keeper posts the mid of the previous 1s step (lag 1), misses 5% of steps; arbitrageurs see the true 1s kline close with no latency beyond a 10% "late" draw. Kline closes stand in for the CEX mid (no spread, no depth); CEX hedging is assumed instant at the mid plus taker fee (1.5 bps / 2.5 bps).
- Retail total demand is fixed (Poisson 0.1/s per market, lognormal median $400, sigma 1.3); elasticity comes only from routing between the two pools of a market (split, optimal split with a 10% minimum leg), with no retail gas, no aggregator fees and perfect quotes. 5% of orders are informed (trade the sign of the next 30s move).
- Full-range liquidity only, one LP per pool, no JIT, no LP re-allocation between pools during the hour; two pools per market (real markets have more venues and fee tiers).
- One hour per window at 1s steps: 12 windows is still a small sample, and the windows are the most volatile / typical-quiet hours of the last 60 days (selection rule in data/windows_v2.json), so the volatile rows are stress tests, not an average day.
- Settler labels arb-direction swaps against the CEX mid at the swap's block time (fetched ex post; `--label-mid attested` = today's services behaviour, see the labelatt variant); calibration posts every 20 steps over the last 50 labelled blocks, minSamples 10.

## Setup

Fresh anvil per run (`--prune-history`), `contracts/script/bench/DeployBenchV2.s.sol`: one OniblockHook, six markets = 12 v4 pools with identical full-range liquidity (~$20,000,000 per pool at the start, L scaled per asset) and the same initial price. Markets: **control** (vanilla 0.30% vs vanilla 0.30% (control; = fixed-fee competitor)); **detox** (vanilla vs Detox-style gap fee, k = 0.7); **const** (vanilla vs Oniblock law, constant k = 0.5); **mjev** (vanilla vs Oniblock law, Jev-tuned k (gated)); **mheur** (vanilla vs Oniblock law, heuristic-tuned k (gated)); **gated** (vanilla vs Oniblock law, Jev k degraded in 2nd half (gate arm)). Hooked pools: base fee 0.30%, feeMax 1%, conservativeFee 0.50%, stale after 5 steps, model pools kMin 0.2 / kMax 0.8 / kDefault 0.5, Brier gate 0.25, minSamples 10.

Each 1s step = 3 blocks: (A) keeper attests mid[t-1] (missed with p=0.05), settler posts calibration every 20 steps; (B) two competing arbitrageurs (CEX taker 1.5/2.5 bps, gas $0.6/$0.3 per tx, random priority, 10% late each, min profit $0.5) trade each pool to their no-trade band vs the TRUE mid[t] at the hook-quoted fee; (C) retail orders (identical across markets) routed per market by best execution. LP-HODL = LP position incl. uncollected fees minus the initial deposit held, both at the true mid. Within-window CIs: circular block bootstrap over 1-minute buckets (block 8); across-window CIs: bootstrap over windows (10,000 resamples).

## Per-window results (base variant)

LP difference = competitor LP-HODL minus the vanilla pool in the same market, bps of per-pool TVL (95% within-window CI in USD). Share = competitor share of market retail volume. Retail cost vs control = bps of market retail volume.

| window | vol 1m bps | market | LP diff bps | LP diff USD [CI] | share | retail cost vs ctl | comp arbs / vanilla arbs | comp arb profit / vanilla (USD) | mean comp arb fee | mean comp k |
|---|---|---|---|---|---|---|---|---|---|---|
| ETH-vol1 | 56.96 | control | -0.00 | 0 [0, 0] | 50.0% | 0.00 | 131 / 131 | 1,291 / 1,291 | 3,000 | - |
| ETH-vol1 | 56.96 | detox | 1.06 | 2,112 [-575, 5,135] | 27.4% | -1.68 | 65 / 131 | 827 / 1,289 | 8,967 | 7,000 |
| ETH-vol1 | 56.96 | const | 0.44 | 884 [-479, 2,479] | 30.4% | -0.70 | 85 / 136 | 990 / 1,317 | 5,813 | 5,000 |
| ETH-vol1 | 56.96 | mjev | 0.32 | 639 [-508, 2,060] | 33.6% | -0.72 | 89 / 134 | 1,002 / 1,313 | 5,262 | 3,746 |
| ETH-vol1 | 56.96 | mheur | 0.49 | 990 [-322, 2,603] | 35.6% | -0.95 | 82 / 132 | 993 / 1,316 | 5,770 | 3,466 |
| ETH-vol1 | 56.96 | gated | 0.31 | 616 [-530, 2,002] | 30.7% | -0.67 | 87 / 136 | 992 / 1,317 | 5,344 | 4,696 |
| ETH-vol2 | 51.51 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 103 / 103 | 512 / 512 | 3,000 | - |
| ETH-vol2 | 51.51 | detox | 0.24 | 475 [-1,350, 3,757] | 22.1% | 0.05 | 39 / 95 | 279 / 492 | 9,276 | 7,000 |
| ETH-vol2 | 51.51 | const | 0.00 | 4 [-958, 1,553] | 25.1% | 0.00 | 50 / 96 | 340 / 491 | 6,057 | 5,000 |
| ETH-vol2 | 51.51 | mjev | 0.01 | 13 [-813, 1,312] | 30.4% | -0.04 | 52 / 96 | 357 / 495 | 5,648 | 3,439 |
| ETH-vol2 | 51.51 | mheur | 0.17 | 336 [-692, 2,103] | 28.9% | -0.03 | 56 / 95 | 353 / 495 | 6,247 | 3,495 |
| ETH-vol2 | 51.51 | gated | -0.04 | -82 [-903, 1,219] | 26.0% | -0.25 | 51 / 96 | 354 / 493 | 5,658 | 4,953 |
| ETH-vol3 | 34.52 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 77 / 77 | 451 / 451 | 3,000 | - |
| ETH-vol3 | 34.52 | detox | 0.46 | 921 [-388, 2,552] | 23.4% | -1.15 | 39 / 80 | 298 / 491 | 9,773 | 7,000 |
| ETH-vol3 | 34.52 | const | 0.10 | 205 [-341, 851] | 27.4% | -0.69 | 51 / 83 | 343 / 494 | 6,238 | 5,000 |
| ETH-vol3 | 34.52 | mjev | 0.03 | 50 [-368, 571] | 28.8% | -0.70 | 51 / 81 | 338 / 501 | 5,606 | 4,005 |
| ETH-vol3 | 34.52 | mheur | 0.05 | 100 [-406, 757] | 30.7% | -0.97 | 52 / 84 | 313 / 497 | 5,783 | 3,855 |
| ETH-vol3 | 34.52 | gated | 0.11 | 217 [-342, 884] | 26.2% | -0.35 | 49 / 78 | 350 / 499 | 6,102 | 4,400 |
| ETH-calm1 | 2.28 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 0 / 0 | 0 / 0 | - | - |
| ETH-calm1 | 2.28 | detox | -0.27 | -542 [-724, -383] | 17.6% | 0.90 | 0 / 0 | 0 / 0 | - | 7,000 |
| ETH-calm1 | 2.28 | const | -0.23 | -466 [-610, -325] | 22.1% | 0.83 | 0 / 0 | 0 / 0 | - | 5,000 |
| ETH-calm1 | 2.28 | mjev | -0.18 | -353 [-458, -257] | 29.1% | 0.54 | 0 / 0 | 0 / 0 | - | 2,825 |
| ETH-calm1 | 2.28 | mheur | -0.18 | -364 [-474, -257] | 28.3% | 0.60 | 0 / 0 | 0 / 0 | - | 3,041 |
| ETH-calm1 | 2.28 | gated | -0.22 | -450 [-601, -317] | 22.9% | 0.90 | 0 / 0 | 0 / 0 | - | 4,949 |
| ETH-calm2 | 2.28 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 2 / 2 | 6 / 6 | 3,000 | - |
| ETH-calm2 | 2.28 | detox | -0.25 | -505 [-674, -354] | 20.6% | 0.40 | 0 / 3 | 0 / 8 | - | 7,000 |
| ETH-calm2 | 2.28 | const | -0.24 | -480 [-667, -318] | 23.2% | 0.49 | 0 / 4 | 0 / 10 | - | 5,000 |
| ETH-calm2 | 2.28 | mjev | -0.19 | -377 [-508, -245] | 30.3% | 0.33 | 0 / 4 | 0 / 10 | - | 2,581 |
| ETH-calm2 | 2.28 | mheur | -0.20 | -405 [-569, -249] | 28.5% | 0.37 | 0 / 4 | 0 / 11 | - | 2,854 |
| ETH-calm2 | 2.28 | gated | -0.22 | -438 [-629, -269] | 24.8% | 0.16 | 0 / 3 | 0 / 8 | - | 4,897 |
| ETH-calm3 | 2.28 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 1 / 1 | 3 / 3 | 3,000 | - |
| ETH-calm3 | 2.28 | detox | -0.23 | -462 [-696, -277] | 23.5% | 0.41 | 0 / 1 | 0 / 3 | - | 7,000 |
| ETH-calm3 | 2.28 | const | -0.21 | -411 [-623, -233] | 26.6% | 0.26 | 0 / 1 | 0 / 3 | - | 5,000 |
| ETH-calm3 | 2.28 | mjev | -0.14 | -285 [-450, -155] | 34.1% | 0.04 | 0 / 1 | 0 / 3 | - | 2,633 |
| ETH-calm3 | 2.28 | mheur | -0.15 | -302 [-486, -151] | 33.0% | 0.08 | 0 / 1 | 0 / 3 | - | 2,798 |
| ETH-calm3 | 2.28 | gated | -0.19 | -386 [-585, -211] | 27.9% | 0.35 | 0 / 1 | 0 / 3 | - | 4,636 |
| BTC-vol1 | 36.04 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 84 / 84 | 345 / 345 | 3,000 | - |
| BTC-vol1 | 36.04 | detox | 0.38 | 765 [-662, 3,179] | 21.6% | -0.26 | 44 / 87 | 208 / 361 | 9,736 | 7,000 |
| BTC-vol1 | 36.04 | const | 0.06 | 118 [-581, 1,207] | 25.5% | 0.45 | 56 / 90 | 231 / 375 | 6,266 | 5,000 |
| BTC-vol1 | 36.04 | mjev | -0.02 | -32 [-539, 736] | 27.2% | 0.24 | 60 / 90 | 243 / 372 | 5,545 | 3,757 |
| BTC-vol1 | 36.04 | mheur | 0.10 | 194 [-581, 1,468] | 26.9% | 0.16 | 56 / 90 | 246 / 367 | 6,182 | 3,724 |
| BTC-vol1 | 36.04 | gated | -0.06 | -116 [-640, 642] | 24.0% | 0.47 | 57 / 89 | 237 / 372 | 5,629 | 4,806 |
| BTC-vol2 | 25.35 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 36 / 36 | 129 / 129 | 3,000 | - |
| BTC-vol2 | 25.35 | detox | -0.18 | -355 [-896, 531] | 17.4% | 1.24 | 11 / 40 | 75 / 134 | 9,251 | 7,000 |
| BTC-vol2 | 25.35 | const | -0.24 | -480 [-831, -13] | 20.2% | 1.54 | 14 / 38 | 82 / 138 | 6,057 | 5,000 |
| BTC-vol2 | 25.35 | mjev | -0.15 | -296 [-624, 185] | 28.3% | 0.93 | 21 / 39 | 89 / 133 | 5,305 | 3,098 |
| BTC-vol2 | 25.35 | mheur | -0.17 | -342 [-693, 81] | 24.6% | 1.08 | 20 / 38 | 80 / 130 | 5,836 | 3,278 |
| BTC-vol2 | 25.35 | gated | -0.19 | -371 [-716, 128] | 24.5% | 1.50 | 19 / 38 | 85 / 136 | 5,331 | 4,615 |
| BTC-vol3 | 22.43 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 30 / 30 | 107 / 107 | 3,000 | - |
| BTC-vol3 | 22.43 | detox | -0.06 | -124 [-496, 401] | 32.1% | -2.79 | 8 / 30 | 43 / 117 | 8,792 | 7,000 |
| BTC-vol3 | 22.43 | const | -0.14 | -285 [-487, -40] | 30.2% | -1.38 | 13 / 29 | 61 / 112 | 5,894 | 5,000 |
| BTC-vol3 | 22.43 | mjev | -0.17 | -342 [-459, -234] | 30.9% | -0.72 | 16 / 27 | 81 / 109 | 4,257 | 2,716 |
| BTC-vol3 | 22.43 | mheur | -0.14 | -281 [-462, -81] | 31.7% | -1.01 | 15 / 29 | 67 / 112 | 5,268 | 3,091 |
| BTC-vol3 | 22.43 | gated | -0.17 | -343 [-466, -229] | 31.3% | -1.89 | 12 / 26 | 73 / 105 | 4,153 | 4,123 |
| BTC-calm1 | 1.62 | control | -0.00 | 0 [0, 0] | 50.0% | 0.00 | 0 / 0 | 0 / 0 | - | - |
| BTC-calm1 | 1.62 | detox | -0.19 | -373 [-482, -260] | 28.0% | 0.62 | 0 / 0 | 0 / 0 | - | 7,000 |
| BTC-calm1 | 1.62 | const | -0.16 | -320 [-412, -225] | 31.2% | 0.51 | 0 / 0 | 0 / 0 | - | 5,000 |
| BTC-calm1 | 1.62 | mjev | -0.11 | -216 [-275, -156] | 37.4% | 0.31 | 0 / 0 | 0 / 0 | - | 2,641 |
| BTC-calm1 | 1.62 | mheur | -0.11 | -222 [-286, -156] | 37.1% | 0.31 | 0 / 0 | 0 / 0 | - | 2,684 |
| BTC-calm1 | 1.62 | gated | -0.15 | -301 [-405, -200] | 32.3% | 0.49 | 0 / 0 | 0 / 0 | - | 4,595 |
| BTC-calm2 | 1.62 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 0 / 0 | 0 / 0 | - | - |
| BTC-calm2 | 1.62 | detox | -0.27 | -530 [-725, -371] | 17.9% | 0.93 | 0 / 0 | 0 / 0 | - | 7,000 |
| BTC-calm2 | 1.62 | const | -0.23 | -462 [-617, -322] | 22.2% | 0.84 | 0 / 0 | 0 / 0 | - | 5,000 |
| BTC-calm2 | 1.62 | mjev | -0.17 | -339 [-476, -234] | 29.8% | 0.53 | 0 / 0 | 0 / 0 | - | 2,657 |
| BTC-calm2 | 1.62 | mheur | -0.18 | -370 [-531, -239] | 28.0% | 0.58 | 0 / 0 | 0 / 0 | - | 2,921 |
| BTC-calm2 | 1.62 | gated | -0.20 | -406 [-554, -285] | 25.1% | 0.99 | 0 / 0 | 0 / 0 | - | 4,668 |
| BTC-calm3 | 1.62 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 0 / 0 | 0 / 0 | - | - |
| BTC-calm3 | 1.62 | detox | -0.20 | -398 [-511, -309] | 26.4% | 0.73 | 0 / 0 | 0 / 0 | - | 7,000 |
| BTC-calm3 | 1.62 | const | -0.17 | -337 [-419, -263] | 30.1% | 0.59 | 0 / 0 | 0 / 0 | - | 5,000 |
| BTC-calm3 | 1.62 | mjev | -0.12 | -237 [-350, -153] | 36.1% | 0.35 | 0 / 0 | 0 / 0 | - | 2,917 |
| BTC-calm3 | 1.62 | mheur | -0.12 | -240 [-346, -155] | 36.0% | 0.36 | 0 / 0 | 0 / 0 | - | 2,911 |
| BTC-calm3 | 1.62 | gated | -0.16 | -315 [-412, -224] | 31.4% | 0.56 | 0 / 0 | 0 / 0 | - | 4,644 |

## Across-window aggregates

| group | market | LP diff vs vanilla (bps) | signs | comp vs control pool | vanilla vs control pool | market LP vs control | share % | retail cost vs ctl (bps vol) |
|---|---|---|---|---|---|---|---|---|
| all | control | -0.00 [-0.00, 0.00] | 0+/0- of 12 | -0.00 [-0.00, 0.00] | 0.00 [-0.00, 0.00] | 0.00 [0.00, 0.00] | 50.0 [50.0, 50.0] | 0.00 [0.00, 0.00] |
| all | detox | 0.04 [-0.16, 0.29] | 4+/8- of 12 | 0.17 [-0.04, 0.40] | 0.12 [0.11, 0.14] | 0.29 [0.09, 0.53] | 23.2 [20.8, 25.7] | -0.05 [-0.75, 0.55] |
| all | const | -0.08 [-0.18, 0.04] | 4+/8- of 12 | 0.03 [-0.07, 0.16] | 0.12 [0.10, 0.14] | 0.15 [0.04, 0.28] | 26.2 [24.1, 28.2] | 0.23 [-0.23, 0.64] |
| all | mjev | -0.07 [-0.14, 0.01] | 3+/9- of 12 | 0.02 [-0.06, 0.11] | 0.09 [0.08, 0.11] | 0.11 [0.03, 0.21] | 31.3 [29.7, 33.2] | 0.09 [-0.21, 0.37] |
| all | mheur | -0.04 [-0.14, 0.08] | 4+/8- of 12 | 0.06 [-0.05, 0.18] | 0.09 [0.08, 0.11] | 0.15 [0.04, 0.28] | 30.8 [28.7, 32.9] | 0.05 [-0.34, 0.40] |
| all | gated | -0.10 [-0.17, -0.00] | 2+/10- of 12 | 0.01 [-0.07, 0.12] | 0.11 [0.09, 0.13] | 0.12 [0.03, 0.23] | 27.3 [25.5, 29.1] | 0.19 [-0.33, 0.64] |
| volatile | control | -0.00 [-0.00, 0.00] | 0+/0- of 6 | -0.00 [-0.00, 0.00] | 0.00 [-0.00, 0.00] | 0.00 [0.00, 0.00] | 50.0 [50.0, 50.0] | 0.00 [0.00, 0.00] |
| volatile | detox | 0.32 [0.02, 0.65] | 4+/2- of 6 | 0.44 [0.15, 0.78] | 0.13 [0.10, 0.15] | 0.57 [0.27, 0.90] | 24.0 [20.5, 28.0] | -0.76 [-1.85, 0.25] |
| volatile | const | 0.04 [-0.12, 0.22] | 4+/2- of 6 | 0.16 [0.00, 0.35] | 0.13 [0.10, 0.16] | 0.29 [0.12, 0.49] | 26.5 [23.6, 29.0] | -0.13 [-0.81, 0.63] |
| volatile | mjev | 0.00 [-0.11, 0.14] | 3+/3- of 6 | 0.11 [-0.02, 0.25] | 0.11 [0.08, 0.14] | 0.22 [0.07, 0.37] | 29.9 [28.3, 31.7] | -0.17 [-0.60, 0.38] |
| volatile | mheur | 0.08 [-0.08, 0.27] | 4+/2- of 6 | 0.19 [0.03, 0.36] | 0.11 [0.08, 0.14] | 0.30 [0.13, 0.47] | 29.7 [27.1, 32.5] | -0.29 [-0.83, 0.39] |
| volatile | gated | -0.01 [-0.13, 0.13] | 2+/4- of 6 | 0.11 [-0.02, 0.27] | 0.12 [0.09, 0.15] | 0.23 [0.07, 0.40] | 27.1 [24.9, 29.4] | -0.20 [-1.02, 0.62] |
| calm | control | -0.00 [-0.00, 0.00] | 0+/0- of 6 | -0.00 [-0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 50.0 [50.0, 50.0] | 0.00 [0.00, 0.00] |
| calm | detox | -0.23 [-0.26, -0.21] | 0+/6- of 6 | -0.11 [-0.12, -0.10] | 0.12 [0.11, 0.14] | 0.01 [0.01, 0.01] | 22.3 [19.2, 25.5] | 0.67 [0.49, 0.83] |
| calm | const | -0.21 [-0.23, -0.18] | 0+/6- of 6 | -0.10 [-0.11, -0.09] | 0.11 [0.09, 0.12] | 0.01 [0.01, 0.01] | 25.9 [23.1, 28.9] | 0.59 [0.43, 0.74] |
| calm | mjev | -0.15 [-0.17, -0.13] | 0+/6- of 6 | -0.07 [-0.08, -0.06] | 0.08 [0.07, 0.09] | 0.01 [0.00, 0.01] | 32.8 [30.4, 35.4] | 0.35 [0.21, 0.47] |
| calm | mheur | -0.16 [-0.18, -0.13] | 0+/6- of 6 | -0.08 [-0.09, -0.06] | 0.08 [0.07, 0.10] | 0.01 [0.00, 0.01] | 31.8 [29.0, 34.9] | 0.38 [0.25, 0.52] |
| calm | gated | -0.19 [-0.21, -0.17] | 0+/6- of 6 | -0.09 [-0.10, -0.08] | 0.10 [0.09, 0.11] | 0.01 [0.01, 0.01] | 27.4 [24.7, 30.3] | 0.57 [0.34, 0.80] |

## Model and gate per window

| window | Jev k - const k (bps TVL) [within CI USD] | heur k - const k | Jev - heur | honest demoted 1st/2nd half | degraded demoted 1st/2nd half | honest seasoned at step | gated - honest LP, 2nd half (bps) | Jev calls / fallback |
|---|---|---|---|---|---|---|---|---|
| ETH-vol1 | -0.15 [-820, 41] | 0.01 | -0.16 | 76% / 28% | 76% / 100% | 800 | 0.01 | 399 / 0.0% |
| ETH-vol2 | -0.02 [-299, 170] | 0.15 | -0.16 | 76% / 0% | 76% / 77% | 580 | -0.03 | 293 / 0.0% |
| ETH-vol3 | -0.08 [-409, 8] | -0.06 | -0.02 | 42% / 72% | 42% / 82% | 760 | 0.08 | 183 / 0.0% |
| ETH-calm1 | 0.03 [24, 83] | 0.02 | 0.00 | 39% / 0% | 39% / 26% | 700 | -0.02 | 0 / 0.0% |
| ETH-calm2 | 0.02 [21, 84] | 0.02 | 0.01 | 16% / 0% | 16% / 0% | 280 | -0.02 | 1 / 0.0% |
| ETH-calm3 | 0.03 [32, 90] | 0.03 | 0.00 | 24% / 0% | 24% / 39% | 440 | -0.02 | 0 / 0.0% |
| BTC-vol1 | -0.09 [-571, 97] | 0.02 | -0.11 | 80% / 20% | 80% / 100% | 520 | -0.03 | 347 / 0.0% |
| BTC-vol2 | 0.05 [-21, 238] | 0.04 | 0.01 | 51% / 0% | 51% / 74% | 640 | -0.02 | 302 / 0.0% |
| BTC-vol3 | -0.04 [-276, 56] | -0.00 | -0.04 | 22% / 0% | 22% / 86% | 400 | -0.01 | 342 / 0.2% |
| BTC-calm1 | 0.02 [29, 71] | 0.02 | 0.00 | 27% / 0% | 27% / 44% | 480 | -0.02 | 0 / 0.0% |
| BTC-calm2 | 0.03 [37, 82] | 0.02 | 0.01 | 27% / 0% | 27% / 37% | 480 | -0.01 | 6 / 0.0% |
| BTC-calm3 | 0.02 [27, 65] | 0.02 | 0.00 | 47% / 0% | 47% / 66% | 840 | -0.02 | 10 / 0.0% |

## Variants (ETH-vol1, BTC-vol1)

split5 = every arb split into 5 sub-swaps in one tx (tests the per-block anchor). lag0 = the v1 assumption: keeper attests the same mid the arb sees, never misses. labelatt = the settler labels arb-direction swaps against the attested (lagged) mid in force, as services/src/settler.ts does today (MARKOUT_HORIZON=0), instead of the CEX mid at the swap's block time.

| window | variant | market | LP diff bps (base) | (variant) | share (base) | (variant) | mean arb fee (base) | (variant) | comp arb profit USD (base) | (variant) |
|---|---|---|---|---|---|---|---|---|---|---|
| ETH-vol1 | split5 | detox | 1.06 | 1.06 | 27.4% | 27.4% | 8,967 | 8,967 | 827 | 827 |
| ETH-vol1 | split5 | const | 0.44 | 0.44 | 30.4% | 30.4% | 5,813 | 5,813 | 990 | 991 |
| ETH-vol1 | split5 | mjev | 0.32 | 0.39 | 33.6% | 33.2% | 5,262 | 5,467 | 1,002 | 1000 |
| ETH-vol1 | split5 | mheur | 0.49 | 0.55 | 35.6% | 34.8% | 5,770 | 6,039 | 993 | 962 |
| ETH-vol1 | split5 | gated | 0.31 | 0.38 | 30.7% | 30.4% | 5,344 | 5,548 | 992 | 990 |
| ETH-vol1 | lag0 | detox | 1.06 | 1.17 | 27.4% | 28.6% | 8,967 | 10,000 | 827 | 814 |
| ETH-vol1 | lag0 | const | 0.44 | 0.90 | 30.4% | 29.1% | 5,813 | 7,552 | 990 | 672 |
| ETH-vol1 | lag0 | mjev | 0.32 | 1.07 | 33.6% | 34.5% | 5,262 | 7,415 | 1,002 | 703 |
| ETH-vol1 | lag0 | mheur | 0.49 | 1.09 | 35.6% | 32.9% | 5,770 | 8,494 | 993 | 669 |
| ETH-vol1 | lag0 | gated | 0.31 | 1.01 | 30.7% | 30.9% | 5,344 | 7,547 | 992 | 709 |
| ETH-vol1 | labelatt | detox | 1.06 | 1.06 | 27.4% | 27.4% | 8,967 | 8,967 | 827 | 827 |
| ETH-vol1 | labelatt | const | 0.44 | 0.44 | 30.4% | 30.4% | 5,813 | 5,813 | 990 | 990 |
| ETH-vol1 | labelatt | mjev | 0.32 | 0.31 | 33.6% | 39.8% | 5,262 | 4,516 | 1,002 | 1,145 |
| ETH-vol1 | labelatt | mheur | 0.49 | 0.44 | 35.6% | 30.4% | 5,770 | 5,813 | 993 | 990 |
| ETH-vol1 | labelatt | gated | 0.31 | 0.24 | 30.7% | 34.4% | 5,344 | 4,594 | 992 | 1,123 |
| BTC-vol1 | split5 | detox | 0.38 | 0.38 | 21.6% | 21.6% | 9,736 | 9,736 | 208 | 208 |
| BTC-vol1 | split5 | const | 0.06 | 0.06 | 25.5% | 25.5% | 6,266 | 6,266 | 231 | 231 |
| BTC-vol1 | split5 | mjev | -0.02 | 0.04 | 27.2% | 26.4% | 5,545 | 5,622 | 243 | 260 |
| BTC-vol1 | split5 | mheur | 0.10 | 0.16 | 26.9% | 26.4% | 6,182 | 6,552 | 246 | 250 |
| BTC-vol1 | split5 | gated | -0.06 | 0.01 | 24.0% | 23.0% | 5,629 | 5,671 | 237 | 259 |
| BTC-vol1 | lag0 | detox | 0.38 | 0.31 | 21.6% | 22.6% | 9,736 | 10,000 | 208 | 193 |
| BTC-vol1 | lag0 | const | 0.06 | 0.11 | 25.5% | 29.9% | 6,266 | 7,098 | 231 | 170 |
| BTC-vol1 | lag0 | mjev | -0.02 | 0.07 | 27.2% | 29.0% | 5,545 | 6,379 | 243 | 181 |
| BTC-vol1 | lag0 | mheur | 0.10 | 0.19 | 26.9% | 31.8% | 6,182 | 7,784 | 246 | 172 |
| BTC-vol1 | lag0 | gated | -0.06 | 0.05 | 24.0% | 27.3% | 5,629 | 6,606 | 237 | 176 |
| BTC-vol1 | labelatt | detox | 0.38 | 0.38 | 21.6% | 21.6% | 9,736 | 9,736 | 208 | 208 |
| BTC-vol1 | labelatt | const | 0.06 | 0.06 | 25.5% | 25.5% | 6,266 | 6,266 | 231 | 231 |
| BTC-vol1 | labelatt | mjev | -0.02 | -0.07 | 27.2% | 27.7% | 5,545 | 5,170 | 243 | 240 |
| BTC-vol1 | labelatt | mheur | 0.10 | 0.07 | 26.9% | 27.1% | 6,182 | 6,266 | 246 | 231 |
| BTC-vol1 | labelatt | gated | -0.06 | -0.09 | 24.0% | 23.7% | 5,629 | 5,387 | 237 | 240 |

| run | Jev k - const k (bps) | heur k - const k (bps) | honest (Jev) demoted 1st/2nd half | heuristic demoted 1st/2nd | degraded demoted 2nd half | label base rate, arb blocks (Jev pool) |
|---|---|---|---|---|---|---|
| ETH-vol1:base | -0.15 | 0.01 | 76% / 28% | 20% / 0% | 100% | 100% of 89 |
| ETH-vol1:split5 | -0.07 | 0.05 | 91% / 28% | 20% / 0% | 100% | 100% of 89 |
| ETH-vol1:lag0 | 0.14 | 0.16 | 22% / 20% | 20% / 0% | 87% | 100% of 105 |
| ETH-vol1:labelatt | -0.18 | 0.00 | 24% / 0% | 100% / 100% | 79% | 13% of 97 |
| BTC-vol1:base | -0.09 | 0.02 | 80% / 20% | 53% / 0% | 100% | 100% of 60 |
| BTC-vol1:split5 | -0.04 | 0.08 | 72% / 38% | 80% / 0% | 99% | 100% of 60 |
| BTC-vol1:lag0 | -0.05 | 0.05 | 63% / 26% | 58% / 0% | 99% | 100% of 62 |
| BTC-vol1:labelatt | -0.15 | 0.01 | 83% / 3% | 100% / 57% | 98% | 47% of 60 |

## Runs

| run | steps | runtime s | txs | reverts | missed posts | arb wins (A/B) | retail orders / USD | Jev sources |
|---|---|---|---|---|---|---|---|---|
| ETH-vol1:base | 3600 | 174 | 21594 | 0 | 178 | 693/646 | 347 / 297,551 | {"jev":398,"jev-cache":5609,"jev-nearest":835,"heuristic":0,"heuristic-paced":1,"heuristic-jev-failed":1} |
| ETH-vol1:split5 | 3600 | 19 | 21617 | 0 | 178 | 688/648 | 347 / 297,551 | {"jev":1,"jev-cache":5400,"jev-nearest":1442,"heuristic":0,"heuristic-paced":1,"heuristic-jev-failed":0} |
| ETH-vol1:lag0 | 3600 | 19 | 22553 | 0 | 0 | 721/654 | 347 / 297,551 | {"jev":0,"jev-cache":3836,"jev-nearest":3194,"heuristic":0,"heuristic-paced":170,"heuristic-jev-failed":0} |
| ETH-vol1:labelatt | 3600 | 18 | 21623 | 0 | 178 | 707/654 | 347 / 297,551 | {"jev":0,"jev-cache":3742,"jev-nearest":3095,"heuristic":0,"heuristic-paced":7,"heuristic-jev-failed":0} |
| ETH-vol2:base | 3600 | 141 | 21188 | 0 | 178 | 513/419 | 347 / 297,551 | {"jev":292,"jev-cache":6551,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":1} |
| ETH-vol3:base | 3600 | 87 | 21065 | 0 | 178 | 376/426 | 347 / 297,551 | {"jev":183,"jev-cache":6661,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |
| ETH-calm1:base | 3600 | 18 | 20546 | 0 | 178 | 0/0 | 347 / 293,467 | {"jev":0,"jev-cache":6844,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |
| ETH-calm2:base | 3600 | 18 | 20726 | 0 | 178 | 20/2 | 347 / 293,467 | {"jev":1,"jev-cache":6843,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |
| ETH-calm3:base | 3600 | 18 | 20793 | 0 | 178 | 7/0 | 347 / 297,551 | {"jev":0,"jev-cache":6844,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |
| BTC-vol1:base | 3600 | 156 | 21149 | 0 | 178 | 484/403 | 347 / 297,551 | {"jev":347,"jev-cache":6497,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |
| BTC-vol1:split5 | 3600 | 38 | 21143 | 0 | 178 | 490/401 | 347 / 297,551 | {"jev":53,"jev-cache":5787,"jev-nearest":997,"heuristic":0,"heuristic-paced":7,"heuristic-jev-failed":0} |
| BTC-vol1:lag0 | 3600 | 18 | 22031 | 0 | 0 | 499/390 | 347 / 297,551 | {"jev":0,"jev-cache":5707,"jev-nearest":1464,"heuristic":0,"heuristic-paced":29,"heuristic-jev-failed":0} |
| BTC-vol1:labelatt | 3600 | 18 | 21139 | 0 | 178 | 477/411 | 347 / 297,551 | {"jev":0,"jev-cache":5887,"jev-nearest":937,"heuristic":0,"heuristic-paced":20,"heuristic-jev-failed":0} |
| BTC-vol2:base | 3600 | 138 | 20731 | 0 | 178 | 175/175 | 347 / 297,551 | {"jev":302,"jev-cache":6542,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |
| BTC-vol3:base | 3600 | 148 | 20812 | 0 | 178 | 156/109 | 347 / 297,551 | {"jev":342,"jev-cache":6372,"jev-nearest":114,"heuristic":0,"heuristic-paced":16,"heuristic-jev-failed":0} |
| BTC-calm1:base | 3600 | 17 | 20801 | 0 | 178 | 0/0 | 347 / 297,551 | {"jev":0,"jev-cache":6844,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |
| BTC-calm2:base | 3600 | 20 | 20670 | 0 | 178 | 0/0 | 347 / 293,467 | {"jev":6,"jev-cache":6838,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |
| BTC-calm3:base | 3600 | 22 | 20719 | 0 | 178 | 0/0 | 347 / 297,551 | {"jev":10,"jev-cache":6834,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |

Charts: `chart-lp.svg` (LP difference vs vanilla per window), `chart-share.svg` (competitor retail share), `chart-retail.svg` (market retail cost vs control).
