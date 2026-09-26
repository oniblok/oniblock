# Mainnet block timing, with and without a cooperating builder (v4 benchmark, LightGBM models)

Generated 2026-09-26T22:16:36.357Z by `benchmark/src/v4/coop4.ts` (sim4.ts mainnet block mode). 6 ETHUSDT one-hour windows (3 volatile, 3 calm; data/windows_v2.json), 3600 s each = 300 blocks of 12 s, $20M full-range TVL per pool. Each Oniblock pool competes with its own vanilla neighbour (same fee tier, same liquidity) for the same routed retail and the same two arbitrageurs; **the vanilla neighbour is the "without this hook" baseline** and every LP number below is Oniblock minus that neighbour.

## What the mainnet block mode simulates

- Time advances in 12 s blocks. In block b (timestamp s) everything acts at s, in this order: settler, keeper (if its post lands in this block), the two arbitrageurs (vs the Binance mid at s), then retail. Nothing trades between blocks. Arbs and retail are in the same anvil block, so retail that follows an arb in the arb direction pays the hook's per-block high-water fee (the fee quote for retail is taken after the arbs on a throw-away copy of the chain, then the real block is mined).
- **realistic** (no builder deal): the keeper reads Binance 13 s before the block it prices and the chain as it is then (pool state and swaps up to block b−1; block b is not built yet); its post lands last in block b and prices block b+1. Model `tabular-v2` (trained on ~11 s-old mids).
- **coop** (cooperating builder): the keeper reads Binance 2 s before block b and the chain after block b−1; the builder puts its post first in block b, so it prices block b. Model `oniblock1` (trained on ~2 s-old mids).
- Keeper: in-process LightGBM (services/src/model/tabular.ts) on the features the live keeper computes (services/src/features.ts computeFeatures: a MidHistory with one CEX read per block, pre-filled from the 30 min before the window; realized vol over its last 120 reads; 20-block swap window; inputs canonicalised to the training orientation), then the keeper's charge gate at the model JSON's `chargeThreshold` (confidence = p ≥ t ? 1 : 0, so k = 0.8·p above the gate and 0 below; pToxic is posted unchanged and graded). Post policy `change` (services/src/postPolicy.ts), heartbeat 4 blocks, stale after 5 blocks, 5% of posts missed.
- Settler: grades every block with arb-direction flow against the Binance mid at the block timestamp, label y = markout at the base fee > max($1, 1 bp of arb volume) (the live settler default and the label the models are trained on; blocks inside the dead band are not graded), posts calibration every 2 blocks once a model has 10 graded blocks. No probation (the hook since PR #5): an allowlisted model sets k from its first attestation, and is demoted to k = kDefault = 0 (a vanilla pool) only while its posted Brier > 0.25.
- Retail: the v4 model (Poisson 0.1 orders/s → 1.2 per block, lognormal size median $400, autocorrelated direction, 5% informed over 30 s), routed per market between the two pools by best execution (optimal split). Keeper gas from the setAttestation receipts; net = gross − keeper gas at 1 gwei (LPs fund the keeper).
- Not modelled: priority fees / bribes other than the break-even payment computed below, arbs that are also builders (the arb here never outbids the keeper), backruns within a block by other searchers, CEX–DEX arbs that trade between blocks on other venues, gas-price volatility, the Chainlink sanity-band gas (see the 110k columns), settler gas. Retail demand does not react to the fee except by routing between the two pools.

## Base fee 0.30% (every pool)

### LP − HODL of the Oniblock pool vs its vanilla neighbour (per hour)

Mean over the 6 windows with a **two-sided 95% Student-t interval over windows** (df = 5) in brackets. The 3 calm windows sit at a near-constant small value for every arm, so the percentile bootstrap over 6 points (report2 `aggWindows`, shown in its own column, labelled "bootstrap") is much too narrow and is not used for any reading. "positive" counts windows with a value > 0 at full precision (a calm value printed as 0.000 can count), split volatile / calm. **The coop arms (C, C0, Ch) are before any payment to the builder** for first position (see the break-even payment below).

| arm | gross bps/h [95% t] | gross $/h | keeper $/h @1 gwei | net bps/h @1 gwei [95% t] | net bps/h: 95% bootstrap (too narrow at n = 6) | net $/h | net bps/h, 110k gas [95% t] | reading (net @1 gwei) | windows positive (net): volatile / calm | posts/h | retail share % | retail cost bps: Oniblock / vanilla | market retail cost vs control bps | mean arb fee: Oniblock / vanilla | arb trades vs vanilla |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R: post lands last in the previous block (no builder deal), mid 13 s old; tabular-v2 + charge gate | 0.179 [-0.051, 0.408] | 358 | 26.9 | 0.165 [-0.056, 0.387] | [0.022, 0.315] | 331 | 0.161 [-0.058, 0.381] | positive in 3/3 volatile, 0/3 calm windows; t-interval includes zero | 3/3 / 0/3 | 141 | 42.3 | 28.4 / 31.4 | -0.55 | 0.619% / 0.300% | 54% |
| R0: as R, gate off (k = 0.8 p) | 0.201 [-0.094, 0.496] | 402 | 31.0 | 0.185 [-0.102, 0.472] | [0.002, 0.382] | 371 | 0.181 [-0.104, 0.465] | positive in 3/3 volatile, 0/3 calm windows; t-interval includes zero | 3/3 / 0/3 | 163 | 37.7 | 28.6 / 31.3 | -0.32 | 0.746% / 0.300% | 48% |
| C: keeper posts first in the block (cooperating builder), mid 2 s old; oniblock1 + charge gate | 0.300 [-0.135, 0.736] | 601 | 23.1 | 0.289 [-0.142, 0.720] | [0.024, 0.618] | 578 | 0.285 [-0.144, 0.714] | positive in 3/3 volatile, 0/3 calm windows; t-interval includes zero | 3/3 / 0/3 | 126 | 43.3 | 28.3 / 31.0 | -0.87 | 0.792% / 0.300% | 51% |
| C0: as C, gate off (k = 0.8 p) | 0.303 [-0.163, 0.769] | 605 | 29.5 | 0.288 [-0.171, 0.746] | [0.011, 0.645] | 576 | 0.283 [-0.173, 0.739] | positive in 3/3 volatile, 0/3 calm windows; t-interval includes zero | 3/3 / 0/3 | 160 | 39.4 | 28.4 / 30.9 | -0.78 | 0.896% / 0.300% | 45% |
| Rh: realistic timing, heuristic scorer (reference) | 0.129 [-0.082, 0.339] | 257 | 29.9 | 0.114 [-0.089, 0.316] | [-0.007, 0.272] | 227 | 0.109 [-0.091, 0.309] | positive in 3/3 volatile, 0/3 calm windows; t-interval includes zero | 3/3 / 0/3 | 156 | 40.4 | 28.9 / 31.4 | -0.23 | 0.586% / 0.300% | 67% |
| Ch: coop timing, heuristic scorer (reference) | 0.288 [-0.156, 0.733] | 576 | 29.7 | 0.273 [-0.164, 0.710] | [0.005, 0.612] | 547 | 0.268 [-0.166, 0.702] | positive in 3/3 volatile, 0/3 calm windows; t-interval includes zero | 3/3 / 0/3 | 162 | 38.3 | 28.2 / 31.1 | -0.70 | 0.864% / 0.300% | 46% |

### By regime: per-window values (bps/h; 3 windows each, so values rather than an interval)

| arm | volatile gross | volatile net @1 gwei | calm gross | calm net @1 gwei |
|---|---|---|---|---|
| R | 0.454, 0.185, 0.437 (mean 0.359) | 0.433, 0.164, 0.416 (mean 0.338) | 0.000, 0.000, -0.003 (mean -0.001) | -0.006, -0.006, -0.008 (mean -0.007) |
| R0 | 0.595, 0.129, 0.516 (mean 0.413) | 0.571, 0.104, 0.492 (mean 0.389) | -0.014, -0.011, -0.011 (mean -0.012) | -0.021, -0.017, -0.018 (mean -0.018) |
| C | 0.994, 0.212, 0.609 (mean 0.605) | 0.978, 0.195, 0.590 (mean 0.588) | -0.004, -0.004, -0.004 (mean -0.004) | -0.010, -0.010, -0.010 (mean -0.010) |
| C0 | 1.070, 0.230, 0.580 (mean 0.627) | 1.048, 0.207, 0.556 (mean 0.604) | -0.030, -0.016, -0.017 (mean -0.021) | -0.036, -0.023, -0.024 (mean -0.028) |
| Rh | 0.199, 0.204, 0.465 (mean 0.290) | 0.180, 0.180, 0.441 (mean 0.267) | -0.043, -0.034, -0.021 (mean -0.032) | -0.050, -0.041, -0.028 (mean -0.040) |
| Ch | 1.002, 0.268, 0.561 (mean 0.611) | 0.980, 0.246, 0.538 (mean 0.588) | -0.041, -0.038, -0.023 (mean -0.034) | -0.048, -0.045, -0.030 (mean -0.041) |

### The model on the sim's own graded blocks (settler labels, all windows pooled)

charged = the probability in force at the block ≥ the model's chargeThreshold (for the gate-off arms this is the same rule applied to their posted p; their k is 0.8·p regardless). pass rate = toxic charged / charged, FPR = benign charged / all benign, coverage = charged / graded, TPR = toxic charged / all toxic.

| arm | model (chargeThreshold) | graded blocks | toxic base rate | charged | pass rate | FPR | coverage | TPR | Brier | keeper decisions charged | volatile pass / FPR / TPR | calm pass / FPR / TPR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | tabular-v2 (0.7951) | 276 | 30.8% | 65 | 93.8% | 2.1% | 23.6% | 71.8% | 0.064 | 22.3% | 93.8% / 6.6% / 71.8% | - / 0.0% / - |
| R0 | tabular-v2 (0.7951) | 268 | 33.6% | 86 | 94.2% | 2.8% | 32.1% | 90.0% | 0.040 | 25.3% | 94.2% / 10.0% / 90.0% | - / 0.0% / - |
| C | oniblock1 (0.8224) | 280 | 31.4% | 73 | 98.6% | 0.5% | 26.1% | 81.8% | 0.026 | 20.3% | 98.6% / 1.6% / 81.8% | - / 0.0% / - |
| C0 | oniblock1 (0.8224) | 257 | 35.0% | 81 | 98.8% | 0.6% | 31.5% | 88.9% | 0.023 | 22.0% | 98.8% / 2.2% / 88.9% | - / 0.0% / - |

### Paired differences (per window, then over windows)

Mean over the 6 windows with a **two-sided 95% Student-t interval over windows** (df = 5) in brackets. The 3 calm windows sit at a near-constant small value for every arm, so the percentile bootstrap over 6 points (report2 `aggWindows`, shown in its own column, labelled "bootstrap") is much too narrow and is not used for any reading. "positive" counts windows with a value > 0 at full precision (a calm value printed as 0.000 can count), split volatile / calm.

| difference | net bps/h @1 gwei [95% t] | 95% bootstrap (too narrow at n = 6) | net $/h | reading | windows positive: volatile / calm | retail share pp | volatile net bps/h, per window | calm net bps/h, per window |
|---|---|---|---|---|---|---|---|---|
| C − R: value of the builder deal (first position + 2 s mid + oniblock1 vs no deal) | 0.123 [-0.105, 0.352] | [0.002, 0.300] | 247 | positive in 3/3 volatile, 0/3 calm windows; t-interval includes zero | 3/3 / 0/3 | 1.0 | 0.544, 0.031, 0.175 (mean 0.250) | -0.004, -0.004, -0.002 (mean -0.003) |
| C − C0: charge gate on vs off (coop) | 0.001 [-0.039, 0.041] | [-0.030, 0.024] | 2 | positive in 1/3 volatile, 3/3 calm windows; t-interval includes zero | 1/3 / 3/3 | 3.8 | -0.070, -0.012, 0.035 (mean -0.016) | 0.026, 0.013, 0.014 (mean 0.018) |
| R − R0: charge gate on vs off (realistic) | -0.020 [-0.096, 0.056] | [-0.078, 0.028] | -40 | positive in 1/3 volatile, 3/3 calm windows; t-interval includes zero | 1/3 / 3/3 | 4.6 | -0.138, 0.060, -0.076 (mean -0.051) | 0.015, 0.011, 0.009 (mean 0.012) |
| C − Ch: oniblock1 vs the heuristic, coop timing | 0.016 [-0.024, 0.055] | [-0.013, 0.040] | 31 | positive in 1/3 volatile, 3/3 calm windows; t-interval includes zero | 1/3 / 3/3 | 5.0 | -0.002, -0.050, 0.053 (mean 0.000) | 0.038, 0.035, 0.020 (mean 0.031) |
| R − Rh: tabular-v2 vs the heuristic, realistic timing | 0.052 [-0.056, 0.160] | [-0.005, 0.137] | 104 | positive in 1/3 volatile, 3/3 calm windows; t-interval includes zero | 1/3 / 3/3 | 1.9 | 0.254, -0.016, -0.025 (mean 0.071) | 0.044, 0.035, 0.020 (mean 0.033) |

### Break-even payment to the builder (arm C)

**Every coop figure in this report (C, C0, Ch, C − R) is BEFORE any payment to the builder.** The most the LPs could pay the builder for first position before the hooked pool stops beating its vanilla neighbour = net LP gain vs vanilla (after keeper gas at 1 gwei); means with 95% t-intervals over windows. Per block if the slot is bought every block: **1.93 [-0.94, 4.80] $/block** (positive in 3/3 volatile, 0/3 calm windows; t-interval includes zero; per window: volatile 6.52, 1.30, 3.94 (mean 3.92), calm -0.07, -0.07, -0.07 (mean -0.07)); per keeper post (post-on-change, 126 posts/h): 3.15 [-1.71, 8.01] $/post; with 110k gas/post: 1.90 [-0.96, 4.76] $/block. A negative value means the hook loses to vanilla even with first position for free. First position is only needed in blocks where the keeper posts. The part of that gain that first position itself buys (C − R, per window, over C's posts): 1.35 [-1.20, 3.90] $/post (positive in 3/3 volatile, 0/3 calm windows; t-interval includes zero). Pool TVL $20M per pool; the gain scales roughly with liquidity.

### Model inputs seen by the keeper (means over decisions)

"demoted 1st / 2nd half" = share of the blocks in each half-hour with k forced to kDefault = 0 by Brier demotion (an allowlisted node with no calibration record is active), per window in the order of the per-run table. "active at s" = first step with the node not at kDefault by the gate.

| arm | decisions/run | mean p | gap > base fee | gap pips | edgeSigma | abs ret12 bps | realizedVol bps | nSwaps (20 blocks) | heuristic fallbacks | active at s | demoted 1st / 2nd half |
|---|---|---|---|---|---|---|---|---|---|---|---|
| R | 283 | 0.317 | 22.4% | 2123 | -12.36 | 5.59 | 8.38 | 17.2 | 0 | 0, 0, 0, 0, 0, 0 | 0%/0%, 0%/0%, 0%/0%, 0%/0%, 0%/0%, 0%/0% |
| R0 | 283 | 0.335 | 25.5% | 2384 | -12.09 | 5.59 | 8.38 | 14.7 | 0 | 0, 0, 0, 0, 0, 0 | 0%/0%, 0%/0%, 0%/0%, 0%/0%, 0%/0%, 0%/0% |
| C | 283 | 0.265 | 22.7% | 2294 | -12.00 | 5.48 | 8.45 | 17.8 | 0 | 0, 0, 0, 0, 0, 0 | 0%/0%, 0%/0%, 0%/0%, 0%/0%, 0%/0%, 0%/0% |
| C0 | 283 | 0.279 | 24.1% | 2419 | -11.88 | 5.48 | 8.45 | 15.2 | 0 | 0, 0, 0, 0, 0, 0 | 0%/0%, 0%/0%, 0%/0%, 0%/0%, 0%/0%, 0%/0% |

### Per run

| arm | window | gross $/h [within-window CI] | net $/h @1 gwei | posts/h | reasons | k predict miss | share % | arb fee Oniblock / vanilla | graded | charged | stale blocks | reverts |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | ETH-vol1 | 908 [-619, 3010] | 866 | 220 | first 1, skip 63, heartbeat 6, p 83, k 74, mid 56 | 0 | 35.6 | 0.471% / 0.300% | 48 | 16 | 1 | 0 |
| R | ETH-vol2 | 369 [-834, 2341] | 328 | 200 | first 1, skip 83, heartbeat 6, p 69, k 41, mid 83 | 0 | 32.8 | 0.632% / 0.300% | 47 | 22 | 0 | 0 |
| R | ETH-vol3 | 874 [-289, 2372] | 831 | 201 | first 1, skip 82, heartbeat 11, p 45, k 50, mid 94 | 0 | 35.9 | 0.753% / 0.300% | 51 | 27 | 1 | 0 |
| R | ETH-calm1 | 0 [-3, 3] | -12 | 74 | first 1, skip 209, heartbeat 73 | 0 | 50.0 | -% / -% | 38 | 0 | 1 | 0 |
| R | ETH-calm2 | 0 [-6, 6] | -12 | 74 | first 1, skip 209, heartbeat 73 | 0 | 50.0 | -% / -% | 47 | 0 | 1 | 0 |
| R | ETH-calm3 | -5 [-15, 0] | -17 | 74 | first 1, skip 209, heartbeat 73 | 0 | 49.7 | -% / -% | 45 | 0 | 1 | 0 |
| R0 | ETH-vol1 | 1189 [-531, 3317] | 1142 | 252 | first 1, mid 102, skip 31, k 148, heartbeat 1 | 0 | 24.8 | 0.613% / 0.300% | 42 | 23 | 0 | 0 |
| R0 | ETH-vol2 | 257 [-967, 2286] | 209 | 237 | first 1, mid 117, k 119, skip 46 | 0 | 26.3 | 0.741% / 0.300% | 41 | 25 | 0 | 0 |
| R0 | ETH-vol3 | 1033 [-210, 2675] | 983 | 229 | first 1, k 88, skip 54, mid 139, heartbeat 1 | 0 | 30.1 | 0.885% / 0.300% | 57 | 38 | 0 | 0 |
| R0 | ETH-calm1 | -27 [-37, -18] | -41 | 85 | first 1, skip 198, mid 25, heartbeat 59 | 0 | 48.1 | -% / -% | 38 | 0 | 0 | 0 |
| R0 | ETH-calm2 | -21 [-32, -11] | -35 | 84 | first 1, mid 26, skip 199, heartbeat 57 | 0 | 48.5 | -% / -% | 46 | 0 | 1 | 0 |
| R0 | ETH-calm3 | -21 [-34, -10] | -35 | 88 | first 1, skip 195, mid 32, heartbeat 55 | 0 | 48.5 | -% / -% | 44 | 0 | 1 | 0 |
| C | ETH-vol1 | 1988 [-374, 5234] | 1955 | 180 | first 1, skip 103, heartbeat 22, p 63, k 27, mid 67 | 0 | 38.6 | 0.736% / 0.300% | 60 | 23 | 0 | 0 |
| C | ETH-vol2 | 425 [-1209, 2815] | 390 | 173 | first 1, skip 110, heartbeat 26, p 32, k 42, mid 72 | 0 | 36.7 | 0.792% / 0.300% | 36 | 17 | 0 | 0 |
| C | ETH-vol3 | 1218 [-151, 3007] | 1181 | 179 | first 1, skip 104, heartbeat 22, p 27, k 17, mid 112 | 0 | 36.2 | 0.848% / 0.300% | 56 | 33 | 0 | 0 |
| C | ETH-calm1 | -9 [-26, 0] | -20 | 74 | first 1, skip 209, heartbeat 73 | 0 | 49.4 | -% / -% | 37 | 0 | 1 | 0 |
| C | ETH-calm2 | -9 [-26, 0] | -20 | 74 | first 1, skip 209, heartbeat 73 | 0 | 49.4 | -% / -% | 46 | 0 | 1 | 0 |
| C | ETH-calm3 | -9 [-26, 0] | -20 | 74 | first 1, skip 209, heartbeat 73 | 0 | 49.4 | -% / -% | 45 | 0 | 1 | 0 |
| C0 | ETH-vol1 | 2140 [-458, 5275] | 2095 | 246 | first 1, mid 134, skip 37, k 111 | 0 | 31.4 | 0.853% / 0.300% | 50 | 28 | 0 | 0 |
| C0 | ETH-vol2 | 460 [-1196, 3080] | 414 | 229 | first 1, skip 54, mid 146, heartbeat 1, k 81 | 0 | 31.2 | 0.902% / 0.300% | 33 | 18 | 0 | 0 |
| C0 | ETH-vol3 | 1159 [-194, 2969] | 1112 | 228 | first 1, skip 55, mid 181, k 46 | 0 | 32.8 | 0.933% / 0.300% | 52 | 35 | 0 | 0 |
| C0 | ETH-calm1 | -60 [-79, -43] | -73 | 85 | first 1, skip 198, mid 26, heartbeat 58 | 0 | 45.9 | -% / -% | 36 | 0 | 0 | 0 |
| C0 | ETH-calm2 | -33 [-53, -17] | -46 | 84 | first 1, mid 26, skip 199, heartbeat 57 | 0 | 47.7 | -% / -% | 45 | 0 | 1 | 0 |
| C0 | ETH-calm3 | -34 [-54, -20] | -47 | 85 | first 1, mid 28, skip 198, heartbeat 56 | 0 | 47.6 | -% / -% | 41 | 0 | 1 | 0 |
| Rh | ETH-vol1 | 398 [-145, 1443] | 359 | 208 | first 1, mid 42, skip 75, k 58, p 103, heartbeat 4 | 0 | 42.8 | 0.317% / 0.300% | - | - | 0 | 0 |
| Rh | ETH-vol2 | 409 [-814, 2392] | 361 | 232 | first 1, mid 108, skip 51, p 6, heartbeat 1, k 116 | 0 | 30.7 | 0.685% / 0.300% | - | - | 0 | 0 |
| Rh | ETH-vol3 | 930 [-281, 2536] | 881 | 227 | first 1, mid 133, skip 56, k 86, p 7 | 0 | 32.8 | 0.756% / 0.300% | - | - | 0 | 0 |
| Rh | ETH-calm1 | -86 [-128, -49] | -100 | 91 | first 1, skip 192, mid 22, heartbeat 53, k 14, p 1 | 0 | 44.0 | -% / -% | - | - | 0 | 0 |
| Rh | ETH-calm2 | -67 [-103, -33] | -81 | 89 | first 1, mid 26, skip 194, heartbeat 54, k 7, p 1 | 0 | 45.2 | -% / -% | - | - | 1 | 0 |
| Rh | ETH-calm3 | -41 [-61, -25] | -56 | 91 | first 1, skip 192, mid 31, heartbeat 52, k 7 | 0 | 47.1 | -% / -% | - | - | 1 | 0 |
| Ch | ETH-vol1 | 2004 [-577, 5151] | 1959 | 244 | first 1, mid 116, skip 39, k 122, p 4, heartbeat 1 | 0 | 30.5 | 0.814% / 0.300% | - | - | 0 | 0 |
| Ch | ETH-vol2 | 537 [-1076, 3038] | 491 | 228 | first 1, skip 55, mid 95, p 8, k 124 | 0 | 31.3 | 0.867% / 0.300% | - | - | 0 | 0 |
| Ch | ETH-vol3 | 1123 [-292, 2975] | 1075 | 227 | first 1, skip 56, mid 147, k 72, p 7 | 0 | 32.4 | 0.910% / 0.300% | - | - | 0 | 0 |
| Ch | ETH-calm1 | -82 [-121, -49] | -96 | 92 | first 1, skip 191, mid 24, heartbeat 51, k 14, p 2 | 0 | 44.3 | -% / -% | - | - | 0 | 0 |
| Ch | ETH-calm2 | -77 [-120, -37] | -90 | 90 | first 1, mid 25, skip 193, heartbeat 54, k 9, p 1 | 0 | 44.5 | -% / -% | - | - | 1 | 0 |
| Ch | ETH-calm3 | -46 [-69, -26] | -60 | 88 | first 1, mid 27, skip 195, heartbeat 53, k 7 | 0 | 46.7 | -% / -% | - | - | 1 | 0 |

## Base fee 0.05% (every pool)

### LP − HODL of the Oniblock pool vs its vanilla neighbour (per hour)

Mean over the 6 windows with a **two-sided 95% Student-t interval over windows** (df = 5) in brackets. The 3 calm windows sit at a near-constant small value for every arm, so the percentile bootstrap over 6 points (report2 `aggWindows`, shown in its own column, labelled "bootstrap") is much too narrow and is not used for any reading. "positive" counts windows with a value > 0 at full precision (a calm value printed as 0.000 can count), split volatile / calm. **The coop arms (C, C0, Ch) are before any payment to the builder** for first position (see the break-even payment below).

| arm | gross bps/h [95% t] | gross $/h | keeper $/h @1 gwei | net bps/h @1 gwei [95% t] | net bps/h: 95% bootstrap (too narrow at n = 6) | net $/h | net bps/h, 110k gas [95% t] | reading (net @1 gwei) | windows positive (net): volatile / calm | posts/h | retail share % | retail cost bps: Oniblock / vanilla | market retail cost vs control bps | mean arb fee: Oniblock / vanilla | arb trades vs vanilla |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R: post lands last in the previous block (no builder deal), mid 13 s old; tabular-v2 + charge gate | 0.058 [-0.040, 0.155] | 115 | 31.7 | 0.042 [-0.050, 0.133] | [-0.010, 0.116] | 83 | 0.037 [-0.053, 0.127] | positive in 3/3 volatile, 0/3 calm windows; t-interval includes zero | 3/3 / 0/3 | 167 | 37.3 | 5.5 / 6.3 | 0.04 | 0.086% / 0.050% | 39% |
| R0: as R, gate off (k = 0.8 p) | 0.075 [-0.051, 0.201] | 150 | 34.5 | 0.058 [-0.061, 0.177] | [-0.010, 0.146] | 116 | 0.053 [-0.064, 0.170] | positive in 3/3 volatile, 0/3 calm windows; t-interval includes zero | 3/3 / 0/3 | 182 | 33.4 | 5.2 / 6.5 | 0.14 | 0.103% / 0.050% | 35% |
| C: keeper posts first in the block (cooperating builder), mid 2 s old; oniblock1 + charge gate | 0.522 [-0.205, 1.249] | 1044 | 30.0 | 0.507 [-0.213, 1.227] | [0.061, 1.045] | 1014 | 0.502 [-0.216, 1.220] | positive in 3/3 volatile, 0/3 calm windows; t-interval includes zero | 3/3 / 0/3 | 164 | 36.5 | 4.9 / 6.2 | -0.19 | 0.357% / 0.050% | 25% |
| C0: as C, gate off (k = 0.8 p) | 0.537 [-0.214, 1.289] | 1075 | 32.0 | 0.521 [-0.223, 1.266] | [0.063, 1.096] | 1043 | 0.516 [-0.226, 1.257] | positive in 3/3 volatile, 0/3 calm windows; t-interval includes zero | 3/3 / 0/3 | 175 | 34.2 | 5.1 / 6.3 | -0.05 | 0.439% / 0.050% | 21% |
| Rh: realistic timing, heuristic scorer (reference) | 0.086 [-0.053, 0.225] | 172 | 37.7 | 0.067 [-0.066, 0.200] | [-0.006, 0.172] | 134 | 0.061 [-0.070, 0.193] | positive in 3/3 volatile, 0/3 calm windows; t-interval includes zero | 3/3 / 0/3 | 202 | 35.8 | 4.9 / 6.5 | 0.04 | 0.107% / 0.050% | 35% |
| Ch: coop timing, heuristic scorer (reference) | 0.549 [-0.212, 1.311] | 1099 | 35.1 | 0.532 [-0.224, 1.288] | [0.063, 1.112] | 1064 | 0.526 [-0.228, 1.280] | positive in 3/3 volatile, 0/3 calm windows; t-interval includes zero | 3/3 / 0/3 | 196 | 35.1 | 4.8 / 6.3 | -0.13 | 0.451% / 0.050% | 20% |

### By regime: per-window values (bps/h; 3 windows each, so values rather than an interval)

| arm | volatile gross | volatile net @1 gwei | calm gross | calm net @1 gwei |
|---|---|---|---|---|
| R | 0.227, 0.087, 0.063 (mean 0.126) | 0.205, 0.063, 0.039 (mean 0.102) | -0.009, -0.012, -0.010 (mean -0.010) | -0.018, -0.020, -0.019 (mean -0.019) |
| R0 | 0.291, 0.121, 0.076 (mean 0.163) | 0.266, 0.097, 0.050 (mean 0.138) | -0.011, -0.014, -0.013 (mean -0.013) | -0.020, -0.023, -0.023 (mean -0.022) |
| C | 1.660, 1.025, 0.477 (mean 1.054) | 1.638, 1.003, 0.454 (mean 1.032) | -0.010, -0.011, -0.010 (mean -0.010) | -0.017, -0.019, -0.017 (mean -0.018) |
| C0 | 1.727, 1.030, 0.501 (mean 1.086) | 1.704, 1.007, 0.477 (mean 1.062) | -0.011, -0.012, -0.012 (mean -0.012) | -0.019, -0.020, -0.020 (mean -0.020) |
| Rh | 0.329, 0.116, 0.099 (mean 0.182) | 0.304, 0.091, 0.072 (mean 0.156) | -0.010, -0.009, -0.010 (mean -0.010) | -0.021, -0.022, -0.021 (mean -0.021) |
| Ch | 1.741, 1.073, 0.514 (mean 1.109) | 1.717, 1.050, 0.490 (mean 1.086) | -0.011, -0.010, -0.011 (mean -0.011) | -0.022, -0.022, -0.022 (mean -0.022) |

### The model on the sim's own graded blocks (settler labels, all windows pooled)

charged = the probability in force at the block ≥ the model's chargeThreshold (for the gate-off arms this is the same rule applied to their posted p; their k is 0.8·p regardless). pass rate = toxic charged / charged, FPR = benign charged / all benign, coverage = charged / graded, TPR = toxic charged / all toxic.

| arm | model (chargeThreshold) | graded blocks | toxic base rate | charged | pass rate | FPR | coverage | TPR | Brier | keeper decisions charged | volatile pass / FPR / TPR | calm pass / FPR / TPR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | tabular-v2 (0.7951) | 189 | 92.1% | 103 | 99.0% | 6.7% | 54.5% | 58.6% | 0.080 | 52.3% | 100.0% / 0.0% / 57.9% | 75.0% / 11.1% / 100.0% |
| R0 | tabular-v2 (0.7951) | 179 | 92.2% | 118 | 98.3% | 14.3% | 65.9% | 70.3% | 0.066 | 54.9% | 99.1% / 14.3% / 69.8% | 75.0% / 14.3% / 100.0% |
| C | oniblock1 (0.8224) | 217 | 91.2% | 158 | 99.4% | 5.3% | 72.8% | 79.3% | 0.053 | 54.6% | 100.0% / 0.0% / 79.1% | 66.7% / 10.0% / 100.0% |
| C0 | oniblock1 (0.8224) | 197 | 92.9% | 165 | 99.4% | 7.1% | 83.8% | 89.6% | 0.036 | 56.5% | 100.0% / 0.0% / 89.5% | 66.7% / 11.1% / 100.0% |

### Paired differences (per window, then over windows)

Mean over the 6 windows with a **two-sided 95% Student-t interval over windows** (df = 5) in brackets. The 3 calm windows sit at a near-constant small value for every arm, so the percentile bootstrap over 6 points (report2 `aggWindows`, shown in its own column, labelled "bootstrap") is much too narrow and is not used for any reading. "positive" counts windows with a value > 0 at full precision (a calm value printed as 0.000 can count), split volatile / calm.

| difference | net bps/h @1 gwei [95% t] | 95% bootstrap (too narrow at n = 6) | net $/h | reading | windows positive: volatile / calm | retail share pp | volatile net bps/h, per window | calm net bps/h, per window |
|---|---|---|---|---|---|---|---|---|
| C − R: value of the builder deal (first position + 2 s mid + oniblock1 vs no deal) | 0.465 [-0.166, 1.097] | [0.070, 0.943] | 931 | positive in 3/3 volatile, 3/3 calm windows; t-interval includes zero | 3/3 / 3/3 | -0.8 | 1.434, 0.940, 0.415 (mean 0.929) | 0.000, 0.001, 0.002 (mean 0.001) |
| C − C0: charge gate on vs off (coop) | -0.014 [-0.043, 0.014] | [-0.036, 0.001] | -29 | positive in 0/3 volatile, 3/3 calm windows; t-interval includes zero | 0/3 / 3/3 | 2.3 | -0.065, -0.004, -0.023 (mean -0.031) | 0.002, 0.002, 0.003 (mean 0.002) |
| R − R0: charge gate on vs off (realistic) | -0.016 [-0.044, 0.012] | [-0.037, 0.001] | -32 | positive in 0/3 volatile, 3/3 calm windows; t-interval includes zero | 0/3 / 3/3 | 3.9 | -0.062, -0.033, -0.011 (mean -0.035) | 0.002, 0.003, 0.004 (mean 0.003) |
| C − Ch: oniblock1 vs the heuristic, coop timing | -0.025 [-0.061, 0.012] | [-0.052, -0.002] | -50 | positive in 0/3 volatile, 3/3 calm windows; t-interval includes zero | 0/3 / 3/3 | 1.4 | -0.079, -0.047, -0.036 (mean -0.054) | 0.004, 0.003, 0.005 (mean 0.004) |
| R − Rh: tabular-v2 vs the heuristic, realistic timing | -0.025 [-0.067, 0.016] | [-0.059, -0.002] | -51 | positive in 0/3 volatile, 3/3 calm windows; t-interval includes zero | 0/3 / 3/3 | 1.6 | -0.099, -0.028, -0.033 (mean -0.053) | 0.004, 0.001, 0.002 (mean 0.002) |

### Break-even payment to the builder (arm C)

**Every coop figure in this report (C, C0, Ch, C − R) is BEFORE any payment to the builder.** The most the LPs could pay the builder for first position before the hooked pool stops beating its vanilla neighbour = net LP gain vs vanilla (after keeper gas at 1 gwei); means with 95% t-intervals over windows. Per block if the slot is bought every block: **3.38 [-1.42, 8.18] $/block** (positive in 3/3 volatile, 0/3 calm windows; t-interval includes zero; per window: volatile 10.92, 6.69, 3.03 (mean 6.88), calm -0.11, -0.12, -0.12 (mean -0.12)); per keeper post (post-on-change, 164 posts/h): 4.32 [-1.96, 10.59] $/post; with 110k gas/post: 3.34 [-1.44, 8.13] $/block. A negative value means the hook loses to vanilla even with first position for free. First position is only needed in blocks where the keeper posts. The part of that gain that first position itself buys (C − R, per window, over C's posts): 4.06 [-1.36, 9.48] $/post (positive in 3/3 volatile, 3/3 calm windows; t-interval includes zero). Pool TVL $20M per pool; the gain scales roughly with liquidity.

### Model inputs seen by the keeper (means over decisions)

"demoted 1st / 2nd half" = share of the blocks in each half-hour with k forced to kDefault = 0 by Brier demotion (an allowlisted node with no calibration record is active), per window in the order of the per-run table. "active at s" = first step with the node not at kDefault by the gate.

| arm | decisions/run | mean p | gap > base fee | gap pips | edgeSigma | abs ret12 bps | realizedVol bps | nSwaps (20 blocks) | heuristic fallbacks | active at s | demoted 1st / 2nd half |
|---|---|---|---|---|---|---|---|---|---|---|---|
| R | 283 | 0.660 | 64.5% | 1041 | 0.82 | 5.59 | 8.38 | 15.9 | 0 | 0, 0, 0, 0, 0, 0 | 0%/0%, 0%/0%, 0%/0%, 0%/0%, 0%/0%, 0%/0% |
| R0 | 283 | 0.667 | 65.1% | 1079 | 0.87 | 5.59 | 8.38 | 13.1 | 0 | 0, 0, 0, 0, 0, 0 | 0%/0%, 0%/0%, 0%/0%, 0%/0%, 0%/0%, 0%/0% |
| C | 283 | 0.638 | 66.4% | 1513 | 1.19 | 5.48 | 8.45 | 14.3 | 0 | 0, 0, 0, 0, 0, 0 | 0%/0%, 0%/0%, 0%/0%, 0%/0%, 0%/0%, 0%/0% |
| C0 | 283 | 0.648 | 67.2% | 1541 | 1.23 | 5.48 | 8.45 | 12.6 | 0 | 0, 0, 0, 0, 0, 0 | 0%/0%, 0%/0%, 0%/0%, 0%/0%, 0%/0%, 0%/0% |

### Per run

| arm | window | gross $/h [within-window CI] | net $/h @1 gwei | posts/h | reasons | k predict miss | share % | arb fee Oniblock / vanilla | graded | charged | stale blocks | reverts |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | ETH-vol1 | 453 [54, 1163] | 409 | 227 | first 1, p 54, skip 56, k 125, mid 46, heartbeat 1 | 0 | 38.4 | 0.080% / 0.050% | 70 | 32 | 1 | 0 |
| R | ETH-vol2 | 174 [-10, 455] | 127 | 225 | first 1, p 38, k 95, skip 58, mid 89, heartbeat 2 | 0 | 36.4 | 0.089% / 0.050% | 57 | 37 | 0 | 0 |
| R | ETH-vol3 | 127 [-1, 278] | 78 | 224 | first 1, p 33, skip 59, k 126, mid 63, heartbeat 1 | 0 | 34.5 | 0.091% / 0.050% | 50 | 30 | 0 | 0 |
| R | ETH-calm1 | -19 [-36, -3] | -35 | 104 | first 1, skip 179, heartbeat 39, k 24, mid 8, p 32 | 0 | 39.8 | -% / 0.050% | 2 | 1 | 1 | 0 |
| R | ETH-calm2 | -24 [-49, -2] | -40 | 106 | first 1, skip 177, p 30, k 27, heartbeat 36, mid 12 | 0 | 34.7 | -% / 0.050% | 5 | 2 | 0 | 0 |
| R | ETH-calm3 | -20 [-35, -7] | -38 | 113 | first 1, skip 170, heartbeat 33, p 42, k 33, mid 4 | 0 | 40.2 | -% / 0.050% | 5 | 1 | 0 | 0 |
| R0 | ETH-vol1 | 583 [91, 1243] | 533 | 262 | first 1, k 181, skip 21, mid 79, heartbeat 1 | 0 | 28.2 | 0.094% / 0.050% | 59 | 35 | 0 | 0 |
| R0 | ETH-vol2 | 242 [30, 526] | 193 | 232 | first 1, k 114, skip 51, mid 115, heartbeat 2 | 0 | 31.6 | 0.114% / 0.050% | 63 | 49 | 0 | 0 |
| R0 | ETH-vol3 | 152 [13, 329] | 100 | 241 | first 1, k 156, skip 42, mid 83, heartbeat 1 | 0 | 33.4 | 0.102% / 0.050% | 47 | 30 | 0 | 0 |
| R0 | ETH-calm1 | -23 [-39, -8] | -40 | 108 | first 1, skip 175, mid 12, heartbeat 34, k 61 | 0 | 37.6 | -% / 0.050% | 2 | 1 | 0 | 0 |
| R0 | ETH-calm2 | -27 [-51, -5] | -46 | 119 | first 1, mid 15, k 69, skip 164, heartbeat 34 | 0 | 32.7 | -% / 0.050% | 4 | 2 | 0 | 0 |
| R0 | ETH-calm3 | -26 [-38, -14] | -47 | 131 | first 1, skip 152, mid 7, k 95, heartbeat 28 | 0 | 36.9 | -% / 0.050% | 4 | 1 | 0 | 0 |
| C | ETH-vol1 | 3320 [225, 7584] | 3277 | 237 | first 1, skip 46, heartbeat 2, p 72, k 81, mid 81 | 0 | 35.2 | 0.280% / 0.050% | 73 | 43 | 0 | 0 |
| C | ETH-vol2 | 2050 [-33, 5908] | 2006 | 221 | first 1, skip 62, k 51, mid 137, heartbeat 1, p 31 | 0 | 32.5 | 0.468% / 0.050% | 64 | 55 | 0 | 0 |
| C | ETH-vol3 | 954 [84, 2246] | 908 | 224 | first 1, skip 59, p 33, k 72, mid 116, heartbeat 2 | 0 | 34.6 | 0.322% / 0.050% | 68 | 57 | 0 | 0 |
| C | ETH-calm1 | -19 [-36, -3] | -34 | 98 | first 1, skip 185, heartbeat 46, k 25, mid 8, p 18 | 0 | 39.9 | -% / 0.050% | 1 | 0 | 1 | 0 |
| C | ETH-calm2 | -22 [-47, -1] | -37 | 101 | first 1, skip 182, p 21, k 24, heartbeat 43, mid 12 | 0 | 35.8 | -% / 0.050% | 6 | 2 | 0 | 0 |
| C | ETH-calm3 | -19 [-35, -6] | -35 | 103 | first 1, skip 180, heartbeat 50, p 21, k 27, mid 4 | 0 | 41.1 | -% / 0.050% | 5 | 1 | 0 | 0 |
| C0 | ETH-vol1 | 3455 [281, 7466] | 3408 | 257 | first 1, mid 113, skip 26, k 143 | 0 | 29.0 | 0.394% / 0.050% | 62 | 50 | 0 | 0 |
| C0 | ETH-vol2 | 2060 [-52, 5915] | 2014 | 232 | first 1, skip 51, k 92, mid 138, heartbeat 1 | 0 | 31.2 | 0.583% / 0.050% | 59 | 55 | 0 | 0 |
| C0 | ETH-vol3 | 1003 [86, 2336] | 953 | 236 | first 1, skip 47, k 105, mid 129, heartbeat 1 | 0 | 34.5 | 0.340% / 0.050% | 65 | 57 | 0 | 0 |
| C0 | ETH-calm1 | -22 [-39, -7] | -38 | 106 | first 1, skip 177, mid 15, heartbeat 37, k 53 | 0 | 38.3 | -% / 0.050% | 1 | 0 | 1 | 0 |
| C0 | ETH-calm2 | -24 [-49, -2] | -41 | 109 | first 1, mid 17, skip 174, k 54, heartbeat 37 | 0 | 34.1 | -% / 0.050% | 5 | 2 | 0 | 0 |
| C0 | ETH-calm3 | -23 [-38, -10] | -40 | 112 | first 1, mid 15, skip 171, heartbeat 38, k 58 | 0 | 38.5 | -% / 0.050% | 5 | 1 | 0 | 0 |
| Rh | ETH-vol1 | 659 [116, 1424] | 608 | 266 | first 1, mid 78, skip 17, k 183, p 4 | 0 | 29.2 | 0.100% / 0.050% | - | - | 0 | 0 |
| Rh | ETH-vol2 | 233 [1, 574] | 182 | 244 | first 1, k 141, skip 39, mid 102 | 0 | 31.6 | 0.111% / 0.050% | - | - | 0 | 0 |
| Rh | ETH-vol3 | 197 [36, 415] | 144 | 248 | first 1, k 182, skip 35, mid 64, p 1 | 0 | 34.0 | 0.110% / 0.050% | - | - | 0 | 0 |
| Rh | ETH-calm1 | -20 [-34, -6] | -43 | 146 | first 1, skip 137, mid 4, heartbeat 12, k 116, p 13 | 0 | 40.3 | -% / 0.050% | - | - | 0 | 0 |
| Rh | ETH-calm2 | -18 [-37, -3] | -43 | 160 | first 1, mid 3, k 135, skip 123, p 13, heartbeat 8 | 0 | 38.7 | -% / 0.050% | - | - | 0 | 0 |
| Rh | ETH-calm3 | -20 [-32, -9] | -43 | 145 | first 1, skip 138, mid 8, k 105, heartbeat 13, p 18 | 0 | 40.7 | -% / 0.050% | - | - | 0 | 0 |
| Ch | ETH-vol1 | 3481 [271, 7713] | 3435 | 254 | first 1, mid 132, skip 29, k 120, p 1 | 0 | 29.5 | 0.412% / 0.050% | - | - | 0 | 0 |
| Ch | ETH-vol2 | 2147 [-18, 6036] | 2099 | 238 | first 1, skip 45, k 99, mid 136, p 2 | 0 | 29.7 | 0.581% / 0.050% | - | - | 0 | 0 |
| Ch | ETH-vol3 | 1029 [41, 2441] | 979 | 238 | first 1, skip 45, k 111, mid 126 | 0 | 33.7 | 0.360% / 0.050% | - | - | 0 | 0 |
| Ch | ETH-calm1 | -22 [-35, -9] | -43 | 144 | first 1, skip 139, mid 7, heartbeat 11, k 116, p 9 | 0 | 39.7 | -% / 0.050% | - | - | 1 | 0 |
| Ch | ETH-calm2 | -20 [-41, -3] | -44 | 157 | first 1, k 129, skip 126, mid 3, p 16, heartbeat 8 | 0 | 37.8 | -% / 0.050% | - | - | 0 | 0 |
| Ch | ETH-calm3 | -22 [-36, -10] | -44 | 146 | first 1, mid 8, skip 137, k 111, p 12, heartbeat 14 | 0 | 40.2 | -% / 0.050% | - | - | 0 | 0 |

Reproduce: `pnpm -C benchmark exec tsx src/v4/coop4.ts --run realistic` and `--run coop` (add `--tier 500` for the 0.05% tier), then `--report-only`. `tsx src/v4/repro4.ts` checks that the 1 s benchmark is deterministic (keepercost4 arm a re-run vs results_v4/keeper-cost/raw-a.json, 84/84 pool totals).
