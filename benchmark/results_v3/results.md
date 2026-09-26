# Oniblock benchmark v3 - threshold fee law under routing competition

Generated 2026-09-26T11:26:01.348Z - total runtime 4886s (26 runs: 12 base, 12 b500, 2 split5). Reproduce: `pnpm -C benchmark bench:v3` (quick: `bench:v3:quick`; re-render: `bench:v3 --report-only`). v1 (`results/`) and v2 (`results_v2/`) results are untouched.

## CONCLUSION

Plain-language verdicts. Numbers are across-window means over 12 one-hour windows (6 volatile, 6 calm; ETHUSDT + BTCUSDT; the same frozen windows as v2), in **bps of one pool's starting TVL (~$20,000,000) per hour**, with a 95% bootstrap CI over windows in brackets and the sign count (windows > 0 / < 0). YES/NO = the CI excludes 0 in that direction; otherwise INCONCLUSIVE. Main tier: every pool (hooked and vanilla) at base fee 0.30%, threshold 0.33%; the "b500" tier repeats all 12 windows with base fee 0.05% on every pool (threshold 0.08%).

**Bottom line.** **Calm hours are essentially fixed** (the loss shrinks from $-413/h to $-12/h): with the threshold the hooked pool charges exactly the base fee whenever the gap is below 0.33%, i.e. it is a vanilla pool in quiet markets (calm-window LP difference vs vanilla: threshold law -0.01 [-0.01, -0.00] bps/h, 0+/2- of 6, vs -0.21 [-0.23, -0.18] for the v2 law; retail share 49.7% vs 25.9%). Volatile-hour gains are **NOT kept** (volatile: -0.03 [-0.05, -0.01] vs v2 law 0.04 [-0.12, 0.22]). Over all 12 windows the threshold law with constant k is **NO** vs the vanilla pool next to it (-0.02 [-0.03, -0.01] bps (≈ $-37/h, CI $-61 to $-16)). Model-tuned k (Jev only above the threshold, or the heuristic) vs constant k: Jev 0.00 [-0.00, 0.01] bps, heuristic 0.00 [0.00, 0.01] bps. The keeper consulted Jev on only 10.7% of steps (the rest were rule-v1 posts below the threshold).

**Why.** Competing arbitrageurs keep every pool inside its no-trade band (gap ≈ base fee + CEX taker fee ≈ 0.32%), so a new 1 s move opens a gap only a little above the 0.33% threshold. The v2 law charged k on the WHOLE gap (volatile-hour mean arb fee on the v2-law pool 6,054 pips) and so earned more per arb but lost ~48 pp of retail share; the threshold law charges k only on the excess (mean arb fee 3,131 pips, 34% of volatile-hour arbs pay exactly the base fee) and keeps retail parity (49.4% share). The result is a pool that behaves almost exactly like its vanilla neighbour: the calm-hour loss is gone, but so is most of the volatile-hour gain.

**1. Are calm hours fixed?** (competitor LP-HODL minus vanilla LP-HODL in the same market, calm windows)

- old (vanilla vs v2 law (no threshold), constant k = 0.5 (reference)): **NO** -0.21 [-0.23, -0.18] bps/h (0+/6- of 6); retail share 25.9 [23.1, 29.0]%; arbs paying exactly base fee -%.
- tconst (vanilla vs threshold law, constant k = 0.5): **NO** -0.01 [-0.01, -0.00] bps/h (0+/2- of 6); retail share 49.7 [49.3, 50.0]%; arbs paying exactly base fee 0%.
- theur (vanilla vs threshold law, heuristic k (gated keeper)): **NO** -0.01 [-0.01, -0.00] bps/h (0+/2- of 6); retail share 49.7 [49.4, 50.0]%; arbs paying exactly base fee 0%.
- tjev (vanilla vs threshold law, Jev k, Jev called only above threshold): **NO** -0.00 [-0.01, -0.00] bps/h (0+/2- of 6); retail share 49.8 [49.5, 50.0]%; arbs paying exactly base fee 0%.

**2. Are volatile-hour gains kept?** (volatile windows)

- old: **INCONCLUSIVE** 0.04 [-0.12, 0.22] bps/h (4+/2- of 6); share 26.5%; arbs paying exactly base 1%.
- tconst: **NO** -0.03 [-0.05, -0.01] bps/h (0+/6- of 6); share 49.0%; arbs paying exactly base 34%.
- theur: **NO** -0.02 [-0.03, -0.01] bps/h (0+/6- of 6); share 49.8%; arbs paying exactly base 33%.
- tjev: **NO** -0.02 [-0.03, -0.01] bps/h (1+/5- of 6); share 49.7%; arbs paying exactly base 33%.
- **Threshold law minus v2 law, same constant k (paired per window, volatile): NO.** -0.18 [-0.36, -0.01] bps (≈ $-355/h, CI $-722 to $-26) (2+/4- of 6). Calm: 0.10 [0.08, 0.11]; all: -0.04 [-0.17, 0.06] (8+/4- of 12).

**3. Overall: does the LP beat the vanilla pool next to it under routing competition?** (all windows)

- **v2 law (no threshold), constant k = 0.5 (reference): INCONCLUSIVE.** -0.08 [-0.18, 0.04] bps (≈ $-169/h, CI $-367 to $70) (4+/8- of 12). Volatile 0.04 [-0.12, 0.22], calm -0.21 [-0.23, -0.18]. Versus an all-vanilla world (control pool): 0.03 [-0.07, 0.16] bps.
- **threshold law, constant k = 0.5: NO.** -0.02 [-0.03, -0.01] bps (≈ $-37/h, CI $-61 to $-16) (0+/8- of 12). Volatile -0.03 [-0.05, -0.01], calm -0.01 [-0.01, -0.00]. Versus an all-vanilla world (control pool): -0.01 [-0.01, -0.00] bps.
- **threshold law, heuristic k (gated keeper): NO.** -0.01 [-0.02, -0.00] bps (≈ $-23/h, CI $-36 to $-10) (0+/8- of 12). Volatile -0.02 [-0.03, -0.01], calm -0.01 [-0.01, -0.00]. Versus an all-vanilla world (control pool): -0.00 [-0.01, -0.00] bps.
- **threshold law, Jev k, Jev called only above threshold: NO.** -0.01 [-0.02, -0.00] bps (≈ $-23/h, CI $-40 to $-8) (1+/7- of 12). Volatile -0.02 [-0.03, -0.01], calm -0.00 [-0.01, -0.00]. Versus an all-vanilla world (control pool): -0.00 [-0.01, 0.00] bps.

**4. Jev-gated k vs constant k vs heuristic k** (LP-HODL difference between hooked pools, same prices / flow / liquidity; all three use the threshold law)

- **Jev k (Jev only above threshold) minus constant k: INCONCLUSIVE.** 0.00 [-0.00, 0.01] bps (≈ $8/h, CI $-1 to $18) (6+/2- of 12). Volatile 0.01 [-0.00, 0.02], calm 0.00 [0.00, 0.00].
- **Heuristic k minus constant k: YES.** 0.00 [0.00, 0.01] bps (≈ $7/h, CI $1 to $14) (8+/0- of 12). Volatile 0.01 [0.00, 0.01], calm 0.00 [0.00, 0.00].
- **Jev minus heuristic: INCONCLUSIVE.** 0.00 [-0.00, 0.00] bps (≈ $1/h, CI $-5 to $7) (5+/3- of 12). 
  **Jev call share:** the Jev pool's keeper posted 36673 rule-v1 attestations and consulted the model on 4391 steps (10.7% of attestation steps; volatile 15.8%, calm 5.6%). Jev + gated pools together: 8804 model scores, of which 98.2% exact Jev answers (live or cached), 1.8% nearest cached Jev answer, 0.0% heuristic fallback; 1368 live Jev calls in total across the 12 base runs (budget 400/run) vs 1883 in v2.

**5. Retail share and cost** (competitor share of the market's retail volume, 50% = parity; market retail cost vs the control market, bps of retail volume)

- old: share 26.2 [24.1, 28.3]% (volatile 26.5%, calm 25.9%); retail cost vs control 0.23 [-0.23, 0.66] bps (calm 0.59 [0.43, 0.74]); both LPs of the market together vs control 0.15 [0.04, 0.28] bps TVL.
- tconst: share 49.4 [48.7, 49.9]% (volatile 49.0%, calm 49.7%); retail cost vs control -0.05 [-0.14, 0.03] bps (calm -0.07 [-0.20, 0.00]); both LPs of the market together vs control 0.00 [-0.00, 0.01] bps TVL.
- theur: share 49.7 [49.3, 50.1]% (volatile 49.8%, calm 49.7%); retail cost vs control -0.03 [-0.14, 0.07] bps (calm -0.07 [-0.21, 0.00]); both LPs of the market together vs control 0.00 [-0.00, 0.01] bps TVL.
- tjev: share 49.7 [49.2, 50.2]% (volatile 49.7%, calm 49.8%); retail cost vs control -0.03 [-0.11, 0.06] bps (calm -0.02 [-0.05, 0.00]); both LPs of the market together vs control 0.00 [-0.00, 0.01] bps TVL.

**6. Does the calibration gate still separate an honest model from a degraded one?** (share of 2nd-half steps with the model node demoted; the gated pool's Jev scores are inverted from mid-window; only above-threshold blocks are graded)

- **Degraded minus honest demotion share: YES.** 30.8 [9.4, 53.4] pp (6+/1- of 12). Degraded demoted 75.6 [56.2, 91.9]% vs honest 44.8 [19.8, 72.2]% (volatile windows: degraded 68.0 [48.1, 85.2]% vs honest 13.9 [0.0, 41.7]%; the honest all-window share is inflated by calm windows in which no block is ever graded, so both nodes stay on probation — unseasoned, k = kDefault — which the metric counts as demoted). Volatile 54.1 [20.0, 83.7] pp, calm 7.6 [0.0, 22.8] pp. Graded blocks per window: honest 44 (volatile 79, calm 8), degraded 44 (the gated keeper only produces gradeable blocks when the gap is above the threshold, so calm hours give the gate little or no evidence and the node stays unseasoned — i.e. at kDefault, which is harmless below the threshold). LP value of the gate: -0.00 [-0.00, 0.00] bps (gated minus honest pool, 2nd half).

**7. Realistic ETH/USDC tier: base fee 0.05% on both pools, threshold 0.08% (b500 variant, all 12 windows)**

- old: all **YES** 0.06 [0.01, 0.14] bps/h (6+/6- of 12); volatile 0.15 [0.07, 0.25], calm -0.02 [-0.03, -0.02]; share 33.4% (calm 32.9%); arbs paying exactly base 5%.
- tconst: all **INCONCLUSIVE** 0.01 [-0.00, 0.02] bps/h (5+/7- of 12); volatile 0.03 [0.01, 0.04], calm -0.01 [-0.01, -0.00]; share 47.6% (calm 47.2%); arbs paying exactly base 17%.
- theur: all **INCONCLUSIVE** 0.01 [-0.00, 0.03] bps/h (5+/7- of 12); volatile 0.03 [0.01, 0.05], calm -0.01 [-0.01, -0.00]; share 47.1% (calm 47.2%); arbs paying exactly base 15%.
- tjev: all **INCONCLUSIVE** 0.01 [-0.00, 0.02] bps/h (5+/7- of 12); volatile 0.03 [0.01, 0.04], calm -0.01 [-0.01, -0.00]; share 47.8% (calm 47.6%); arbs paying exactly base 14%.
- Threshold minus v2 law (paired): -0.07 [-0.13, -0.02] (volatile -0.14 [-0.22, -0.07], calm 0.00 [0.00, 0.01]). Jev k - const k -0.00 [-0.00, 0.00]; heuristic k - const k 0.00 [0.00, 0.01]; Jev consulted on 45.4% of steps; gate separation 50.8 [38.7, 61.9] pp.

**Sanity.** Control market (vanilla vs vanilla): share of pool b 50.00% (range 50.00-50.00%), LP difference 0.0000 bps at most, over all 26 runs. Split swaps (split5 variant, every arb split into 5 sub-swaps): the old / threshold constant-k pools' LP difference changes by at most 0.001 bps. Reverts: none in 26 runs.

**Assumptions that remain** (as in v2, plus the v3 keeper):

- Keeper posts the mid of the previous 1s step (lag 1), misses 5% of steps; arbitrageurs see the true 1s kline close (10% "late" draw); kline closes stand in for the CEX mid; CEX taker 1.5 bps / 2.5 bps, gas $0.6 / $0.3.
- Retail demand fixed (Poisson 0.1/s per market, lognormal median $400, sigma 1.3); elasticity only via routing between the two pools of a market (split, 10% minimum leg), no retail gas / aggregator fees; 5% informed orders.
- Full-range liquidity, one LP per pool, no JIT, no LP re-allocation; two pools per market.
- v3 keeper gate: below threshold minus 100 pips (vs the mid it attests) the keeper posts rule-v1 (p = 0.10, c = 1.0); rule-v1 is allowlisted but never graded, so it is unseasoned and pins k to kDefault. Model pools therefore use maxKStepBps = 6000 so one above-threshold attestation can reach the model's k (with v2's 1000 the rule posts would keep k near kDefault). Settler labels: CEX mid at the swap's block time (--label-mid true); calibration every 20 steps over the last 50 graded blocks, minSamples 10.
- 12 one-hour windows (most volatile / typical-quiet hours of the last 60 days, data/windows_v2.json): small sample; volatile rows are stress tests.

## Setup

Fresh anvil per run (`--prune-history`), `contracts/script/bench/DeployBenchV3.s.sol`: one OniblockHook, six markets = 12 v4 pools with identical full-range liquidity (~$20,000,000 per pool) and the same initial price. Markets: **control** (vanilla vs vanilla (control; = fixed-fee competitor)); **old** (vanilla vs v2 law (no threshold), constant k = 0.5 (reference)); **tconst** (vanilla vs threshold law, constant k = 0.5); **theur** (vanilla vs threshold law, heuristic k (gated keeper)); **tjev** (vanilla vs threshold law, Jev k, Jev called only above threshold); **tgated** (vanilla vs threshold law, Jev k degraded in 2nd half (gate arm)). Hooked pools: baseFee = the vanilla fee tier, feeMax 1%, conservativeFee = base + 0.20%, stale after 5 steps; threshold arms arbThresholdPips = base + 300 pips (old = 0); model pools kMin 0.2 / kMax 0.8 / kDefault 0.5, maxKStep 0.6, Brier gate 0.25, minSamples 10. Fee law (arb direction, live price on the arb side of the mid): fee = min(base + k * max(0, gapHW - arbThresholdPips), feeMax).

Each 1s step = 3 blocks: (A) keeper attests mid[t-1] (missed with p=0.05; model pools: rule-v1 below threshold, else Jev / heuristic), settler posts calibration every 20 steps; (B) two competing arbitrageurs trade each pool to their no-trade band vs the TRUE mid[t] at the hook-quoted fee; (C) retail orders (identical across markets) routed per market by best execution. LP-HODL marked at the true mid. Within-window CIs: circular block bootstrap over 1-minute buckets; across-window CIs: bootstrap over windows.

## Per-window results (base fee 0.30%, threshold 0.33%)

| window | vol 1m bps | market | LP diff bps | LP diff USD [CI] | share | retail cost vs ctl | comp arbs / vanilla arbs | arbs at base fee | mean comp arb fee | mean comp k |
|---|---|---|---|---|---|---|---|---|---|---|
| ETH-vol1 | 56.96 | control | -0.00 | 0 [0, 0] | 50.0% | 0.00 | 131 / 131 | - | 3,000 | - |
| ETH-vol1 | 56.96 | old | 0.44 | 884 [-493, 2,422] | 30.4% | -0.70 | 85 / 136 | 0% | 5,813 | 5,000 |
| ETH-vol1 | 56.96 | tconst | -0.00 | -1 [-68, 54] | 50.3% | -0.03 | 126 / 132 | 60% | 3,060 | 5,000 |
| ETH-vol1 | 56.96 | theur | -0.00 | -2 [-60, 53] | 50.8% | -0.04 | 124 / 133 | 59% | 3,058 | 4,986 |
| ETH-vol1 | 56.96 | tjev | 0.00 | 4 [-48, 56] | 51.0% | -0.04 | 125 / 134 | 58% | 3,074 | 5,069 |
| ETH-vol1 | 56.96 | tgated | -0.00 | -6 [-56, 45] | 50.4% | -0.06 | 126 / 133 | 57% | 3,061 | 5,009 |
| ETH-vol2 | 51.51 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 103 / 103 | - | 3,000 | - |
| ETH-vol2 | 51.51 | old | 0.00 | 4 [-927, 1,636] | 25.1% | 0.00 | 50 / 96 | 0% | 6,057 | 5,000 |
| ETH-vol2 | 51.51 | tconst | -0.05 | -96 [-182, -10] | 48.2% | 0.01 | 94 / 105 | 34% | 3,123 | 5,000 |
| ETH-vol2 | 51.51 | theur | -0.03 | -53 [-113, 10] | 48.9% | 0.18 | 94 / 103 | 31% | 3,126 | 4,915 |
| ETH-vol2 | 51.51 | tjev | -0.04 | -84 [-175, 2] | 48.2% | 0.04 | 89 / 103 | 33% | 3,165 | 5,100 |
| ETH-vol2 | 51.51 | tgated | -0.05 | -99 [-188, -10] | 47.6% | 0.16 | 88 / 101 | 33% | 3,142 | 5,015 |
| ETH-vol3 | 34.52 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 77 / 77 | - | 3,000 | - |
| ETH-vol3 | 34.52 | old | 0.10 | 205 [-380, 877] | 27.4% | -0.69 | 51 / 83 | 0% | 6,238 | 5,000 |
| ETH-vol3 | 34.52 | tconst | -0.03 | -64 [-159, 26] | 50.3% | -0.24 | 69 / 78 | 25% | 3,164 | 5,000 |
| ETH-vol3 | 34.52 | theur | -0.03 | -59 [-150, 20] | 50.8% | -0.33 | 69 / 78 | 26% | 3,166 | 4,975 |
| ETH-vol3 | 34.52 | tjev | -0.01 | -29 [-107, 49] | 51.2% | -0.32 | 70 / 78 | 23% | 3,217 | 5,112 |
| ETH-vol3 | 34.52 | tgated | -0.03 | -61 [-150, 22] | 50.3% | -0.24 | 69 / 78 | 25% | 3,152 | 4,966 |
| ETH-calm1 | 2.28 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 0 / 0 | - | - | - |
| ETH-calm1 | 2.28 | old | -0.23 | -466 [-621, -332] | 22.1% | 0.83 | 0 / 0 | -% | - | 5,000 |
| ETH-calm1 | 2.28 | tconst | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 0 / 0 | -% | - | 5,000 |
| ETH-calm1 | 2.28 | theur | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 0 / 0 | -% | - | 5,000 |
| ETH-calm1 | 2.28 | tjev | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 0 / 0 | -% | - | 5,000 |
| ETH-calm1 | 2.28 | tgated | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 0 / 0 | -% | - | 5,000 |
| ETH-calm2 | 2.28 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 2 / 2 | - | 3,000 | - |
| ETH-calm2 | 2.28 | old | -0.24 | -480 [-658, -314] | 23.2% | 0.49 | 0 / 4 | -% | - | 5,000 |
| ETH-calm2 | 2.28 | tconst | -0.02 | -45 [-102, 0] | 48.8% | 0.00 | 1 / 3 | 0% | 3,535 | 5,000 |
| ETH-calm2 | 2.28 | theur | -0.02 | -43 [-95, 0] | 48.9% | -0.00 | 1 / 3 | 0% | 3,535 | 4,849 |
| ETH-calm2 | 2.28 | tjev | -0.02 | -38 [-87, 0] | 49.1% | 0.00 | 1 / 3 | 0% | 3,407 | 4,951 |
| ETH-calm2 | 2.28 | tgated | -0.02 | -45 [-97, 0] | 48.8% | 0.00 | 1 / 3 | 0% | 3,535 | 5,000 |
| ETH-calm3 | 2.28 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 1 / 1 | - | 3,000 | - |
| ETH-calm3 | 2.28 | old | -0.21 | -411 [-638, -236] | 26.6% | 0.26 | 0 / 1 | -% | - | 5,000 |
| ETH-calm3 | 2.28 | tconst | -0.01 | -25 [-72, 0] | 49.3% | -0.41 | 0 / 1 | -% | - | 5,000 |
| ETH-calm3 | 2.28 | theur | -0.01 | -23 [-67, 0] | 49.5% | -0.41 | 0 / 1 | -% | - | 4,879 |
| ETH-calm3 | 2.28 | tjev | -0.01 | -13 [-38, 0] | 49.4% | -0.10 | 1 / 1 | 0% | 3,274 | 4,919 |
| ETH-calm3 | 2.28 | tgated | -0.01 | -13 [-39, 0] | 49.4% | -0.10 | 1 / 1 | 0% | 3,274 | 4,926 |
| BTC-vol1 | 36.04 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 84 / 84 | - | 3,000 | - |
| BTC-vol1 | 36.04 | old | 0.06 | 118 [-583, 1,270] | 25.5% | 0.45 | 56 / 90 | 0% | 6,266 | 5,000 |
| BTC-vol1 | 36.04 | tconst | -0.07 | -131 [-216, -54] | 46.6% | 0.06 | 82 / 89 | 27% | 3,152 | 5,000 |
| BTC-vol1 | 36.04 | theur | -0.03 | -54 [-99, -17] | 48.2% | 0.13 | 84 / 88 | 24% | 3,142 | 4,871 |
| BTC-vol1 | 36.04 | tjev | -0.03 | -51 [-108, -6] | 48.2% | 0.07 | 82 / 89 | 24% | 3,169 | 5,069 |
| BTC-vol1 | 36.04 | tgated | -0.01 | -24 [-65, 8] | 49.5% | 0.00 | 80 / 88 | 21% | 3,195 | 5,072 |
| BTC-vol2 | 25.35 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 36 / 36 | - | 3,000 | - |
| BTC-vol2 | 25.35 | old | -0.24 | -480 [-835, 37] | 20.2% | 1.54 | 14 / 38 | 0% | 6,057 | 5,000 |
| BTC-vol2 | 25.35 | tconst | -0.02 | -43 [-111, 24] | 48.9% | 0.18 | 35 / 39 | 14% | 3,155 | 5,000 |
| BTC-vol2 | 25.35 | theur | -0.00 | -4 [-55, 45] | 49.7% | 0.28 | 37 / 38 | 14% | 3,157 | 4,930 |
| BTC-vol2 | 25.35 | tjev | -0.00 | -1 [-71, 75] | 49.9% | 0.31 | 36 / 38 | 14% | 3,207 | 5,062 |
| BTC-vol2 | 25.35 | tgated | -0.00 | -9 [-77, 68] | 49.7% | 0.08 | 36 / 38 | 14% | 3,156 | 4,966 |
| BTC-vol3 | 22.43 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 30 / 30 | - | 3,000 | - |
| BTC-vol3 | 22.43 | old | -0.14 | -285 [-479, -43] | 30.2% | -1.38 | 13 / 29 | 8% | 5,894 | 5,000 |
| BTC-vol3 | 22.43 | tconst | -0.02 | -37 [-107, 6] | 50.0% | -0.15 | 26 / 29 | 46% | 3,129 | 5,000 |
| BTC-vol3 | 22.43 | theur | -0.02 | -33 [-100, 7] | 50.0% | -0.18 | 26 / 29 | 46% | 3,117 | 4,938 |
| BTC-vol3 | 22.43 | tjev | -0.03 | -62 [-140, 3] | 49.4% | -0.28 | 25 / 30 | 48% | 3,134 | 5,016 |
| BTC-vol3 | 22.43 | tgated | -0.02 | -50 [-121, 9] | 49.2% | -0.22 | 26 / 30 | 46% | 3,120 | 4,987 |
| BTC-calm1 | 1.62 | control | -0.00 | 0 [0, 0] | 50.0% | 0.00 | 0 / 0 | - | - | - |
| BTC-calm1 | 1.62 | old | -0.16 | -320 [-415, -223] | 31.2% | 0.51 | 0 / 0 | -% | - | 5,000 |
| BTC-calm1 | 1.62 | tconst | -0.00 | 0 [0, 0] | 50.0% | 0.00 | 0 / 0 | -% | - | 5,000 |
| BTC-calm1 | 1.62 | theur | -0.00 | 0 [0, 0] | 50.0% | 0.00 | 0 / 0 | -% | - | 5,000 |
| BTC-calm1 | 1.62 | tjev | -0.00 | 0 [0, 0] | 50.0% | 0.00 | 0 / 0 | -% | - | 5,000 |
| BTC-calm1 | 1.62 | tgated | -0.00 | 0 [0, 0] | 50.0% | 0.00 | 0 / 0 | -% | - | 5,000 |
| BTC-calm2 | 1.62 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 0 / 0 | - | - | - |
| BTC-calm2 | 1.62 | old | -0.23 | -462 [-628, -326] | 22.2% | 0.84 | 0 / 0 | -% | - | 5,000 |
| BTC-calm2 | 1.62 | tconst | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 0 / 0 | -% | - | 5,000 |
| BTC-calm2 | 1.62 | theur | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 0 / 0 | -% | - | 5,000 |
| BTC-calm2 | 1.62 | tjev | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 0 / 0 | -% | - | 5,000 |
| BTC-calm2 | 1.62 | tgated | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 0 / 0 | -% | - | 5,000 |
| BTC-calm3 | 1.62 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 0 / 0 | - | - | - |
| BTC-calm3 | 1.62 | old | -0.17 | -337 [-422, -265] | 30.1% | 0.59 | 0 / 0 | -% | - | 5,000 |
| BTC-calm3 | 1.62 | tconst | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 0 / 0 | -% | - | 5,000 |
| BTC-calm3 | 1.62 | theur | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 0 / 0 | -% | - | 5,000 |
| BTC-calm3 | 1.62 | tjev | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 0 / 0 | -% | - | 5,000 |
| BTC-calm3 | 1.62 | tgated | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 0 / 0 | -% | - | 5,000 |

## Per-window results (b500: base fee 0.05%, threshold 0.08%)

| window | vol 1m bps | market | LP diff bps | LP diff USD [CI] | share | retail cost vs ctl | comp arbs / vanilla arbs | arbs at base fee | mean comp arb fee | mean comp k |
|---|---|---|---|---|---|---|---|---|---|---|
| ETH-vol1 | 56.96 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 369 / 369 | - | 500 | - |
| ETH-vol1 | 56.96 | old | 0.36 | 726 [265, 1,231] | 35.9% | -0.63 | 258 / 369 | 7% | 1,130 | 5,000 |
| ETH-vol1 | 56.96 | tconst | 0.05 | 108 [48, 178] | 49.8% | -0.51 | 341 / 366 | 46% | 587 | 5,000 |
| ETH-vol1 | 56.96 | theur | 0.08 | 151 [71, 256] | 48.0% | -0.53 | 336 / 365 | 43% | 622 | 5,512 |
| ETH-vol1 | 56.96 | tjev | 0.05 | 98 [40, 167] | 48.4% | -0.39 | 339 / 363 | 46% | 585 | 4,999 |
| ETH-vol1 | 56.96 | tgated | 0.05 | 101 [46, 167] | 48.8% | -0.42 | 337 / 365 | 45% | 589 | 5,007 |
| ETH-vol2 | 51.51 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 219 / 219 | - | 500 | - |
| ETH-vol2 | 51.51 | old | 0.19 | 373 [62, 851] | 35.7% | -0.26 | 144 / 225 | 8% | 1,233 | 5,000 |
| ETH-vol2 | 51.51 | tconst | 0.04 | 77 [11, 156] | 48.8% | -0.42 | 196 / 219 | 32% | 634 | 5,000 |
| ETH-vol2 | 51.51 | theur | 0.05 | 97 [22, 197] | 48.8% | -0.38 | 185 / 220 | 30% | 684 | 5,410 |
| ETH-vol2 | 51.51 | tjev | 0.04 | 87 [27, 168] | 48.7% | -0.18 | 196 / 219 | 32% | 639 | 5,182 |
| ETH-vol2 | 51.51 | tgated | 0.04 | 82 [15, 165] | 49.1% | -0.39 | 195 / 219 | 31% | 642 | 5,075 |
| ETH-vol3 | 34.52 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 185 / 185 | - | 500 | - |
| ETH-vol3 | 34.52 | old | 0.13 | 259 [49, 493] | 32.7% | -0.18 | 114 / 195 | 3% | 1,265 | 5,000 |
| ETH-vol3 | 34.52 | tconst | 0.03 | 54 [12, 110] | 47.6% | -0.37 | 163 / 186 | 32% | 644 | 5,000 |
| ETH-vol3 | 34.52 | theur | 0.03 | 65 [18, 125] | 45.8% | -0.22 | 157 / 185 | 31% | 692 | 5,364 |
| ETH-vol3 | 34.52 | tjev | 0.03 | 53 [21, 90] | 47.2% | -0.30 | 161 / 186 | 32% | 645 | 5,241 |
| ETH-vol3 | 34.52 | tgated | 0.03 | 53 [14, 104] | 45.9% | -0.31 | 162 / 185 | 31% | 639 | 5,080 |
| ETH-calm1 | 2.28 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 3 / 3 | - | 500 | - |
| ETH-calm1 | 2.28 | old | -0.02 | -42 [-56, -28] | 32.2% | 0.53 | 0 / 4 | -% | - | 5,000 |
| ETH-calm1 | 2.28 | tconst | -0.01 | -14 [-26, -5] | 46.4% | 0.04 | 0 / 4 | -% | - | 5,000 |
| ETH-calm1 | 2.28 | theur | -0.01 | -15 [-26, -6] | 46.2% | 0.04 | 0 / 4 | -% | - | 5,017 |
| ETH-calm1 | 2.28 | tjev | -0.00 | -6 [-11, -1] | 48.5% | 0.02 | 1 / 4 | 0% | 813 | 5,002 |
| ETH-calm1 | 2.28 | tgated | -0.00 | -6 [-11, -1] | 48.7% | 0.01 | 1 / 4 | 0% | 813 | 4,833 |
| ETH-calm2 | 2.28 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 8 / 8 | - | 500 | - |
| ETH-calm2 | 2.28 | old | -0.03 | -53 [-70, -36] | 32.7% | 0.43 | 0 / 13 | -% | - | 5,000 |
| ETH-calm2 | 2.28 | tconst | -0.01 | -26 [-44, -9] | 45.8% | -0.02 | 1 / 12 | 0% | 1,074 | 5,000 |
| ETH-calm2 | 2.28 | theur | -0.01 | -26 [-44, -10] | 45.8% | -0.01 | 1 / 12 | 0% | 1,088 | 5,053 |
| ETH-calm2 | 2.28 | tjev | -0.01 | -25 [-43, -9] | 46.1% | 0.00 | 1 / 12 | 0% | 927 | 5,159 |
| ETH-calm2 | 2.28 | tgated | -0.01 | -26 [-45, -9] | 45.8% | -0.03 | 1 / 12 | 0% | 1,074 | 4,944 |
| ETH-calm3 | 2.28 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 7 / 7 | - | 500 | - |
| ETH-calm3 | 2.28 | old | -0.03 | -52 [-74, -35] | 32.5% | 0.74 | 0 / 12 | -% | - | 5,000 |
| ETH-calm3 | 2.28 | tconst | -0.01 | -14 [-30, -2] | 46.7% | 0.17 | 3 / 10 | 0% | 980 | 5,000 |
| ETH-calm3 | 2.28 | theur | -0.01 | -14 [-30, -3] | 46.4% | 0.18 | 3 / 10 | 0% | 995 | 5,044 |
| ETH-calm3 | 2.28 | tjev | -0.01 | -15 [-34, -3] | 46.1% | 0.18 | 3 / 10 | 0% | 993 | 5,079 |
| ETH-calm3 | 2.28 | tgated | -0.01 | -14 [-29, -2] | 46.8% | 0.17 | 3 / 10 | 0% | 980 | 4,823 |
| BTC-vol1 | 36.04 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 162 / 162 | - | 500 | - |
| BTC-vol1 | 36.04 | old | 0.15 | 290 [40, 694] | 36.7% | -0.62 | 108 / 166 | 4% | 1,313 | 5,000 |
| BTC-vol1 | 36.04 | tconst | 0.03 | 51 [12, 95] | 49.3% | -0.41 | 147 / 170 | 22% | 668 | 5,000 |
| BTC-vol1 | 36.04 | theur | 0.03 | 54 [15, 103] | 49.5% | -0.53 | 136 / 166 | 24% | 696 | 5,319 |
| BTC-vol1 | 36.04 | tjev | 0.03 | 53 [5, 111] | 50.2% | -0.54 | 147 / 171 | 22% | 655 | 5,001 |
| BTC-vol1 | 36.04 | tgated | 0.03 | 58 [10, 117] | 49.7% | -0.52 | 143 / 171 | 20% | 681 | 5,045 |
| BTC-vol2 | 25.35 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 109 / 109 | - | 500 | - |
| BTC-vol2 | 25.35 | old | 0.06 | 112 [-18, 319] | 33.0% | 0.49 | 63 / 112 | 8% | 1,333 | 5,000 |
| BTC-vol2 | 25.35 | tconst | 0.01 | 28 [-6, 64] | 47.9% | 0.25 | 92 / 119 | 14% | 712 | 5,000 |
| BTC-vol2 | 25.35 | theur | 0.02 | 31 [-10, 84] | 46.6% | 0.36 | 87 / 120 | 14% | 773 | 5,315 |
| BTC-vol2 | 25.35 | tjev | 0.01 | 24 [-12, 70] | 48.2% | 0.21 | 90 / 119 | 17% | 697 | 5,169 |
| BTC-vol2 | 25.35 | tgated | 0.01 | 25 [-11, 72] | 48.6% | 0.23 | 91 / 119 | 16% | 708 | 5,104 |
| BTC-vol3 | 22.43 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 82 / 82 | - | 500 | - |
| BTC-vol3 | 22.43 | old | 0.02 | 34 [-47, 129] | 29.3% | 0.48 | 41 / 85 | 2% | 1,380 | 5,000 |
| BTC-vol3 | 22.43 | tconst | -0.00 | -10 [-32, 13] | 45.3% | 0.05 | 66 / 91 | 26% | 696 | 5,000 |
| BTC-vol3 | 22.43 | theur | -0.00 | -1 [-36, 32] | 43.8% | -0.00 | 63 / 85 | 24% | 750 | 5,220 |
| BTC-vol3 | 22.43 | tjev | -0.00 | -8 [-32, 13] | 45.2% | 0.20 | 62 / 85 | 23% | 702 | 5,071 |
| BTC-vol3 | 22.43 | tgated | -0.01 | -16 [-38, 6] | 44.2% | 0.06 | 60 / 87 | 23% | 695 | 5,069 |
| BTC-calm1 | 1.62 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 3 / 3 | - | 500 | - |
| BTC-calm1 | 1.62 | old | -0.01 | -30 [-42, -17] | 36.3% | 0.25 | 0 / 3 | -% | - | 5,000 |
| BTC-calm1 | 1.62 | tconst | -0.00 | -8 [-19, -1] | 48.1% | -0.20 | 0 / 3 | -% | - | 5,000 |
| BTC-calm1 | 1.62 | theur | -0.00 | -5 [-14, 1] | 48.7% | -0.18 | 1 / 3 | 0% | 859 | 5,019 |
| BTC-calm1 | 1.62 | tjev | -0.00 | -5 [-14, 1] | 48.8% | -0.18 | 1 / 3 | 0% | 899 | 5,033 |
| BTC-calm1 | 1.62 | tgated | -0.00 | -8 [-17, -1] | 48.2% | -0.21 | 0 / 3 | -% | - | 4,920 |
| BTC-calm2 | 1.62 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 7 / 7 | - | 500 | - |
| BTC-calm2 | 1.62 | old | -0.03 | -53 [-66, -39] | 29.5% | 0.09 | 0 / 10 | -% | - | 5,000 |
| BTC-calm2 | 1.62 | tconst | -0.01 | -15 [-27, -4] | 46.8% | -0.26 | 2 / 9 | 0% | 867 | 5,000 |
| BTC-calm2 | 1.62 | theur | -0.01 | -15 [-27, -5] | 46.7% | -0.26 | 2 / 9 | 0% | 863 | 5,027 |
| BTC-calm2 | 1.62 | tjev | -0.01 | -15 [-29, -4] | 47.0% | -0.04 | 3 / 10 | 0% | 855 | 5,042 |
| BTC-calm2 | 1.62 | tgated | -0.01 | -13 [-25, -2] | 47.6% | -0.04 | 3 / 10 | 0% | 858 | 4,786 |
| BTC-calm3 | 1.62 | control | 0.00 | 0 [0, 0] | 50.0% | 0.00 | 3 / 3 | - | 500 | - |
| BTC-calm3 | 1.62 | old | -0.02 | -36 [-50, -22] | 34.0% | 0.54 | 0 / 5 | -% | - | 5,000 |
| BTC-calm3 | 1.62 | tconst | -0.00 | -4 [-9, 0] | 49.2% | -0.02 | 1 / 4 | 0% | 948 | 5,000 |
| BTC-calm3 | 1.62 | theur | -0.00 | -4 [-9, 0] | 49.2% | -0.02 | 1 / 4 | 0% | 948 | 4,989 |
| BTC-calm3 | 1.62 | tjev | -0.00 | -5 [-10, 0] | 49.0% | -0.02 | 1 / 4 | 0% | 948 | 4,944 |
| BTC-calm3 | 1.62 | tgated | -0.00 | -4 [-10, 0] | 49.1% | -0.03 | 1 / 4 | 0% | 948 | 4,768 |

## Across-window aggregates

| tier | group | market | LP diff vs vanilla (bps) | signs | comp vs control pool | market LP vs control | share % | retail cost vs ctl (bps vol) | arbs at base % |
|---|---|---|---|---|---|---|---|---|---|
| base | all | control | -0.00 [-0.00, 0.00] | 0+/0- of 12 | -0.00 [-0.00, 0.00] | 0.00 [0.00, 0.00] | 50.0 [50.0, 50.0] | 0.00 [0.00, 0.00] | - |
| base | all | old | -0.08 [-0.18, 0.04] | 4+/8- of 12 | 0.03 [-0.07, 0.16] | 0.15 [0.04, 0.28] | 26.2 [24.1, 28.3] | 0.23 [-0.23, 0.66] | 1 |
| base | all | tconst | -0.02 [-0.03, -0.01] | 0+/8- of 12 | -0.01 [-0.01, -0.00] | 0.00 [-0.00, 0.01] | 49.4 [48.7, 49.9] | -0.05 [-0.14, 0.03] | 29 |
| base | all | theur | -0.01 [-0.02, -0.00] | 0+/8- of 12 | -0.00 [-0.01, -0.00] | 0.00 [-0.00, 0.01] | 49.7 [49.3, 50.1] | -0.03 [-0.14, 0.07] | 28 |
| base | all | tjev | -0.01 [-0.02, -0.00] | 1+/7- of 12 | -0.00 [-0.01, 0.00] | 0.00 [-0.00, 0.01] | 49.7 [49.2, 50.2] | -0.03 [-0.11, 0.06] | 25 |
| base | all | tgated | -0.01 [-0.02, -0.00] | 0+/8- of 12 | -0.01 [-0.01, -0.00] | 0.00 [-0.01, 0.01] | 49.6 [49.1, 49.9] | -0.03 [-0.10, 0.03] | 25 |
| base | volatile | control | -0.00 [-0.00, 0.00] | 0+/0- of 6 | -0.00 [-0.00, 0.00] | 0.00 [0.00, 0.00] | 50.0 [50.0, 50.0] | 0.00 [0.00, 0.00] | - |
| base | volatile | old | 0.04 [-0.12, 0.22] | 4+/2- of 6 | 0.16 [0.00, 0.35] | 0.29 [0.12, 0.49] | 26.5 [23.6, 29.0] | -0.13 [-0.85, 0.65] | 1 |
| base | volatile | tconst | -0.03 [-0.05, -0.01] | 0+/6- of 6 | -0.01 [-0.02, -0.01] | 0.00 [-0.01, 0.01] | 49.0 [47.9, 50.0] | -0.03 [-0.14, 0.08] | 34 |
| base | volatile | theur | -0.02 [-0.03, -0.01] | 0+/6- of 6 | -0.01 [-0.01, 0.00] | 0.00 [-0.01, 0.01] | 49.8 [49.0, 50.5] | 0.01 [-0.17, 0.17] | 33 |
| base | volatile | tjev | -0.02 [-0.03, -0.01] | 1+/5- of 6 | -0.01 [-0.02, 0.00] | 0.01 [-0.01, 0.02] | 49.7 [48.7, 50.6] | -0.04 [-0.21, 0.13] | 33 |
| base | volatile | tgated | -0.02 [-0.03, -0.01] | 0+/6- of 6 | -0.01 [-0.02, 0.00] | 0.00 [-0.01, 0.01] | 49.4 [48.6, 50.1] | -0.05 [-0.17, 0.07] | 33 |
| base | calm | control | -0.00 [-0.00, 0.00] | 0+/0- of 6 | -0.00 [-0.00, 0.00] | 0.00 [0.00, 0.00] | 50.0 [50.0, 50.0] | 0.00 [0.00, 0.00] | - |
| base | calm | old | -0.21 [-0.23, -0.18] | 0+/6- of 6 | -0.10 [-0.11, -0.09] | 0.01 [0.01, 0.01] | 25.9 [23.1, 29.0] | 0.59 [0.43, 0.74] | - |
| base | calm | tconst | -0.01 [-0.01, -0.00] | 0+/2- of 6 | -0.00 [-0.01, -0.00] | -0.00 [-0.00, 0.00] | 49.7 [49.3, 50.0] | -0.07 [-0.20, 0.00] | 0 |
| base | calm | theur | -0.01 [-0.01, -0.00] | 0+/2- of 6 | -0.00 [-0.01, -0.00] | -0.00 [-0.00, 0.00] | 49.7 [49.4, 50.0] | -0.07 [-0.21, 0.00] | 0 |
| base | calm | tjev | -0.00 [-0.01, -0.00] | 0+/2- of 6 | -0.00 [-0.00, -0.00] | 0.00 [-0.00, 0.00] | 49.8 [49.5, 50.0] | -0.02 [-0.05, 0.00] | 0 |
| base | calm | tgated | -0.00 [-0.01, -0.00] | 0+/2- of 6 | -0.00 [-0.01, -0.00] | 0.00 [-0.00, 0.00] | 49.7 [49.3, 50.0] | -0.02 [-0.05, 0.00] | 0 |
| b500 | all | control | 0.00 [0.00, 0.00] | 0+/0- of 12 | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 50.0 [50.0, 50.0] | 0.00 [0.00, 0.00] | - |
| b500 | all | old | 0.06 [0.01, 0.14] | 6+/6- of 12 | 0.08 [0.02, 0.15] | 0.10 [0.04, 0.17] | 33.4 [32.0, 34.7] | 0.15 [-0.11, 0.40] | 5 |
| b500 | all | tconst | 0.01 [-0.00, 0.02] | 5+/7- of 12 | 0.01 [0.00, 0.03] | 0.02 [0.01, 0.03] | 47.6 [46.8, 48.4] | -0.14 [-0.28, -0.00] | 17 |
| b500 | all | theur | 0.01 [-0.00, 0.03] | 5+/7- of 12 | 0.02 [0.00, 0.03] | 0.02 [0.01, 0.04] | 47.1 [46.2, 48.1] | -0.13 [-0.28, 0.02] | 15 |
| b500 | all | tjev | 0.01 [-0.00, 0.02] | 5+/7- of 12 | 0.01 [0.00, 0.02] | 0.02 [0.01, 0.03] | 47.8 [47.0, 48.5] | -0.09 [-0.22, 0.04] | 14 |
| b500 | all | tgated | 0.01 [-0.00, 0.02] | 5+/7- of 12 | 0.01 [0.00, 0.03] | 0.02 [0.01, 0.03] | 47.7 [46.8, 48.6] | -0.12 [-0.26, 0.01] | 15 |
| b500 | volatile | control | 0.00 [0.00, 0.00] | 0+/0- of 6 | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 50.0 [50.0, 50.0] | 0.00 [0.00, 0.00] | - |
| b500 | volatile | old | 0.15 [0.07, 0.25] | 6+/0- of 6 | 0.17 [0.09, 0.26] | 0.19 [0.11, 0.28] | 33.9 [31.7, 35.8] | -0.12 [-0.48, 0.25] | 5 |
| b500 | volatile | tconst | 0.03 [0.01, 0.04] | 5+/1- of 6 | 0.03 [0.02, 0.04] | 0.04 [0.03, 0.04] | 48.1 [46.9, 49.2] | -0.23 [-0.44, 0.00] | 29 |
| b500 | volatile | theur | 0.03 [0.01, 0.05] | 5+/1- of 6 | 0.04 [0.02, 0.06] | 0.04 [0.03, 0.06] | 47.1 [45.4, 48.5] | -0.22 [-0.45, 0.06] | 27 |
| b500 | volatile | tjev | 0.03 [0.01, 0.04] | 5+/1- of 6 | 0.03 [0.02, 0.04] | 0.03 [0.02, 0.04] | 48.0 [46.6, 49.1] | -0.17 [-0.38, 0.06] | 28 |
| b500 | volatile | tgated | 0.03 [0.01, 0.04] | 5+/1- of 6 | 0.03 [0.02, 0.04] | 0.04 [0.02, 0.04] | 47.7 [46.0, 49.1] | -0.22 [-0.43, 0.00] | 28 |
| b500 | calm | control | 0.00 [0.00, 0.00] | 0+/0- of 6 | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 50.0 [50.0, 50.0] | 0.00 [0.00, 0.00] | - |
| b500 | calm | old | -0.02 [-0.03, -0.02] | 0+/6- of 6 | -0.01 [-0.01, -0.01] | 0.01 [0.01, 0.01] | 32.9 [31.2, 34.5] | 0.43 [0.25, 0.60] | - |
| b500 | calm | tconst | -0.01 [-0.01, -0.00] | 0+/6- of 6 | -0.00 [-0.00, -0.00] | 0.00 [0.00, 0.00] | 47.2 [46.3, 48.1] | -0.05 [-0.16, 0.07] | 0 |
| b500 | calm | theur | -0.01 [-0.01, -0.00] | 0+/6- of 6 | -0.00 [-0.00, -0.00] | 0.00 [0.00, 0.00] | 47.2 [46.2, 48.2] | -0.04 [-0.16, 0.07] | 0 |
| b500 | calm | tjev | -0.01 [-0.01, -0.00] | 0+/6- of 6 | -0.00 [-0.00, -0.00] | 0.00 [0.00, 0.00] | 47.6 [46.6, 48.5] | -0.01 [-0.09, 0.08] | 0 |
| b500 | calm | tgated | -0.01 [-0.01, -0.00] | 0+/6- of 6 | -0.00 [-0.00, -0.00] | 0.00 [0.00, 0.00] | 47.7 [46.8, 48.6] | -0.02 [-0.11, 0.07] | 0 |

## Model, keeper gate and calibration gate per run

| run | thr - old (bps) | Jev k - const k (bps) | heur k - const k | Jev - heur | Jev consulted (steps) / rule-v1 | live Jev calls | honest demoted 1st/2nd | degraded demoted 1st/2nd | graded blocks honest / degraded | gated - honest LP 2nd half |
|---|---|---|---|---|---|---|---|---|---|---|
| ETH-vol1:base | -0.57 | 0.00 | 0.00 | 0.00 | 358 / 3064 | 212 | 22% / 0% | 22% / 53% | 98 / 100 | -0.01 |
| ETH-vol1:b500 | -0.32 | -0.00 | 0.02 | -0.03 | 1640 / 1782 | 396 | 48% / 52% | 48% / 100% | 302 / 302 | 0.00 |
| ETH-vol1:split5 | -0.57 | 0.01 | 0.00 | 0.00 | 360 / 3062 | 107 | 22% / 0% | 22% / 53% | 99 / 101 | -0.01 |
| ETH-vol2:base | -0.10 | -0.01 | 0.00 | -0.01 | 645 / 2777 | 273 | 32% / 0% | 32% / 80% | 105 / 107 | -0.01 |
| ETH-vol2:b500 | -0.17 | 0.00 | 0.01 | -0.01 | 1894 / 1528 | 394 | 33% / 17% | 33% / 94% | 230 / 236 | -0.00 |
| ETH-vol3:base | -0.27 | 0.01 | 0.00 | 0.01 | 629 / 2793 | 180 | 89% / 0% | 89% / 89% | 76 / 77 | -0.01 |
| ETH-vol3:b500 | -0.12 | -0.00 | 0.01 | -0.01 | 1634 / 1788 | 398 | 26% / 16% | 26% / 82% | 202 / 195 | 0.00 |
| ETH-calm1:base | 0.11 | 0.00 | 0.00 | 0.00 | 0 / 3422 | 0 | 100% / 100% | 100% / 100% | 0 / 0 | 0.00 |
| ETH-calm1:b500 | 0.00 | 0.00 | -0.00 | 0.00 | 1298 / 2124 | 229 | 41% / 0% | 41% / 18% | 62 / 62 | -0.00 |
| ETH-calm2:base | 0.10 | 0.00 | 0.00 | 0.00 | 818 / 2604 | 106 | 100% / 54% | 100% / 100% | 34 / 36 | -0.00 |
| ETH-calm2:b500 | 0.00 | 0.00 | 0.00 | -0.00 | 1528 / 1894 | 210 | 88% / 0% | 88% / 81% | 62 / 62 | -0.00 |
| ETH-calm3:base | 0.09 | 0.01 | 0.00 | 0.01 | 326 / 3096 | 54 | 83% / 0% | 83% / 0% | 16 / 16 | 0.00 |
| ETH-calm3:b500 | 0.01 | -0.00 | -0.00 | -0.00 | 1760 / 1662 | 195 | 78% / 0% | 78% / 62% | 67 / 69 | 0.00 |
| BTC-vol1:base | -0.25 | 0.02 | 0.02 | 0.01 | 809 / 2613 | 264 | 23% / 83% | 23% / 62% | 102 / 102 | 0.01 |
| BTC-vol1:b500 | -0.13 | -0.00 | -0.00 | 0.00 | 1745 / 1677 | 391 | 66% / 49% | 66% / 90% | 202 / 198 | 0.00 |
| BTC-vol1:split5 | -0.25 | 0.02 | 0.00 | 0.02 | 846 / 2576 | 156 | 23% / 0% | 23% / 83% | 103 / 104 | 0.01 |
| BTC-vol2:base | 0.09 | 0.01 | 0.01 | -0.00 | 446 / 2976 | 156 | 33% / 0% | 33% / 28% | 58 / 61 | -0.00 |
| BTC-vol2:b500 | -0.05 | -0.00 | 0.00 | -0.01 | 1750 / 1672 | 358 | 42% / 37% | 42% / 88% | 160 / 176 | 0.00 |
| BTC-vol3:base | 0.04 | -0.01 | 0.00 | -0.01 | 360 / 3062 | 123 | 74% / 0% | 74% / 96% | 33 / 30 | 0.01 |
| BTC-vol3:b500 | -0.03 | -0.00 | 0.00 | -0.00 | 1794 / 1628 | 400 | 30% / 46% | 30% / 96% | 124 / 121 | -0.00 |
| BTC-calm1:base | 0.08 | 0.00 | 0.00 | 0.00 | 0 / 3422 | 0 | 100% / 100% | 100% / 100% | 0 / 0 | 0.00 |
| BTC-calm1:b500 | 0.00 | 0.00 | 0.00 | 0.00 | 738 / 2684 | 218 | 82% / 0% | 82% / 61% | 41 / 51 | -0.00 |
| BTC-calm2:base | 0.11 | 0.00 | 0.00 | 0.00 | 0 / 3422 | 0 | 100% / 100% | 100% / 100% | 0 / 0 | 0.00 |
| BTC-calm2:b500 | 0.01 | 0.00 | -0.00 | 0.00 | 1773 / 1649 | 253 | 54% / 0% | 54% / 43% | 80 / 80 | 0.00 |
| BTC-calm3:base | 0.08 | 0.00 | 0.00 | 0.00 | 0 / 3422 | 0 | 100% / 100% | 100% / 100% | 0 / 0 | 0.00 |
| BTC-calm3:b500 | 0.00 | -0.00 | -0.00 | -0.00 | 1100 / 2322 | 119 | 30% / 0% | 30% / 10% | 53 / 54 | 0.00 |

## Runs

| run | steps | runtime s | txs | reverts | missed posts | arb wins (A/B) | retail orders / USD | Jev sources |
|---|---|---|---|---|---|---|---|---|
| ETH-vol1:base | 3600 | 104 | 22824 | 0 | 178 | 791/725 | 347 / 297,551 | {"jev":211,"jev-cache":497,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":1} |
| ETH-vol1:b500 | 3600 | 864 | 25094 | 0 | 178 | 2355/1822 | 347 / 297,551 | {"jev":395,"jev-cache":2120,"jev-nearest":769,"heuristic":0,"heuristic-paced":11,"heuristic-jev-failed":1} |
| ETH-vol1:split5 | 3600 | 62 | 22818 | 0 | 178 | 791/725 | 347 / 297,551 | {"jev":107,"jev-cache":604,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |
| ETH-vol2:base | 3600 | 138 | 22283 | 0 | 178 | 646/483 | 347 / 297,551 | {"jev":273,"jev-cache":1023,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |
| ETH-vol2:b500 | 3600 | 184 | 23245 | 0 | 178 | 1320/1136 | 347 / 297,551 | {"jev":394,"jev-cache":2648,"jev-nearest":801,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |
| ETH-vol3:base | 3600 | 89 | 21864 | 0 | 178 | 421/456 | 347 / 297,551 | {"jev":180,"jev-cache":1061,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |
| ETH-vol3:b500 | 3600 | 182 | 22940 | 0 | 178 | 1123/941 | 347 / 297,551 | {"jev":398,"jev-cache":2367,"jev-nearest":469,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |
| ETH-calm1:base | 3600 | 17 | 21032 | 0 | 178 | 0/0 | 347 / 293,467 | {"jev":0,"jev-cache":0,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |
| ETH-calm1:b500 | 3600 | 106 | 21298 | 0 | 178 | 19/9 | 347 / 293,467 | {"jev":229,"jev-cache":2367,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |
| ETH-calm2:base | 3600 | 56 | 21066 | 0 | 178 | 24/0 | 347 / 293,467 | {"jev":106,"jev-cache":1595,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |
| ETH-calm2:b500 | 3600 | 96 | 21141 | 0 | 178 | 53/28 | 347 / 293,467 | {"jev":210,"jev-cache":2875,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |
| ETH-calm3:base | 3600 | 38 | 21324 | 0 | 178 | 9/0 | 347 / 297,551 | {"jev":54,"jev-cache":598,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |
| ETH-calm3:b500 | 3600 | 96 | 21169 | 0 | 178 | 64/14 | 347 / 297,551 | {"jev":195,"jev-cache":3313,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |
| BTC-vol1:base | 3600 | 115 | 22195 | 0 | 178 | 525/471 | 347 / 297,551 | {"jev":264,"jev-cache":1213,"jev-nearest":159,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |
| BTC-vol1:b500 | 3600 | 185 | 22713 | 0 | 178 | 953/896 | 347 / 297,551 | {"jev":391,"jev-cache":2358,"jev-nearest":799,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |
| BTC-vol1:split5 | 3600 | 96 | 22173 | 0 | 178 | 527/466 | 347 / 297,551 | {"jev":156,"jev-cache":1496,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |
| BTC-vol2:base | 3600 | 76 | 21694 | 0 | 178 | 259/162 | 347 / 297,551 | {"jev":156,"jev-cache":730,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |
| BTC-vol2:b500 | 3600 | 164 | 22117 | 0 | 178 | 596/634 | 347 / 297,551 | {"jev":358,"jev-cache":2867,"jev-nearest":412,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |
| BTC-vol3:base | 3600 | 87 | 21612 | 0 | 178 | 192/131 | 347 / 297,551 | {"jev":123,"jev-cache":560,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |
| BTC-vol3:b500 | 3600 | 767 | 21820 | 0 | 178 | 516/373 | 347 / 297,551 | {"jev":277,"jev-cache":2628,"jev-nearest":599,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":123} |
| BTC-calm1:base | 3600 | 18 | 21068 | 0 | 178 | 0/0 | 347 / 297,551 | {"jev":0,"jev-cache":0,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |
| BTC-calm1:b500 | 3600 | 484 | 21276 | 0 | 178 | 17/6 | 347 / 297,551 | {"jev":156,"jev-cache":1545,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":62} |
| BTC-calm2:base | 3600 | 18 | 21043 | 0 | 178 | 0/0 | 347 / 293,467 | {"jev":0,"jev-cache":0,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |
| BTC-calm2:b500 | 3600 | 557 | 21224 | 0 | 178 | 53/19 | 347 / 293,467 | {"jev":195,"jev-cache":3293,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":58} |
| BTC-calm3:base | 3600 | 18 | 21065 | 0 | 178 | 0/0 | 347 / 297,551 | {"jev":0,"jev-cache":0,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0} |
| BTC-calm3:b500 | 3600 | 269 | 21414 | 0 | 178 | 13/18 | 347 / 297,551 | {"jev":94,"jev-cache":2081,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":25} |

Charts: `chart-lp.svg` / `chart-lp-b500.svg` (LP difference vs vanilla per window and market), `chart-share.svg` (competitor retail share, base tier).
