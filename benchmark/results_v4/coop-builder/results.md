# Mainnet block timing, with and without a cooperating builder (v4 benchmark, LightGBM models)

Generated 2026-09-26T21:09:48.778Z by `benchmark/src/v4/coop4.ts` (sim4.ts mainnet block mode). 6 ETHUSDT one-hour windows (3 volatile, 3 calm; data/windows_v2.json), 3600 s each = 300 blocks of 12 s, $20M full-range TVL per pool. Each Oniblock pool competes with its own vanilla neighbour (same fee tier, same liquidity) for the same routed retail and the same two arbitrageurs; **the vanilla neighbour is the "without this hook" baseline** and every LP number below is Oniblock minus that neighbour.

## What the mainnet block mode simulates

- Time advances in 12 s blocks. In block b (timestamp s) everything acts at s, in this order: settler, keeper (if its post lands in this block), the two arbitrageurs (vs the Binance mid at s), then retail. Nothing trades between blocks. Arbs and retail are in the same anvil block, so retail that follows an arb in the arb direction pays the hook's per-block high-water fee (the fee quote for retail is taken after the arbs on a throw-away copy of the chain, then the real block is mined).
- **realistic** (no builder deal): the keeper reads Binance 13 s before the block it prices and the chain as it is then (pool state and swaps up to block b−1; block b is not built yet); its post lands last in block b and prices block b+1. Model `tabular-v2` (trained on ~11 s-old mids).
- **coop** (cooperating builder): the keeper reads Binance 2 s before block b and the chain after block b−1; the builder puts its post first in block b, so it prices block b. Model `oniblock1` (trained on ~2 s-old mids).
- Keeper: in-process LightGBM (services/src/model/tabular.ts) on the features the live keeper computes (services/src/features.ts computeFeatures: a MidHistory with one CEX read per block, pre-filled from the 30 min before the window; realized vol over its last 120 reads; 20-block swap window; inputs canonicalised to the training orientation), then the keeper's charge gate at the model JSON's `chargeThreshold` (confidence = p ≥ t ? 1 : 0, so k = 0.8·p above the gate and 0 below; pToxic is posted unchanged and graded). Post policy `change` (services/src/postPolicy.ts), heartbeat 4 blocks, stale after 5 blocks, 5% of posts missed.
- Settler: grades every block with arb-direction flow against the Binance mid at the block timestamp, label y = markout at the base fee > max($1, 1 bp of arb volume) (the live settler default and the label the models are trained on; blocks inside the dead band are not graded), posts calibration every 2 blocks; a model is demoted to k = kDefault = 0 (a vanilla pool) until it has 10 graded blocks or while its Brier > 0.25.
- Retail: the v4 model (Poisson 0.1 orders/s → 1.2 per block, lognormal size median $400, autocorrelated direction, 5% informed over 30 s), routed per market between the two pools by best execution (optimal split). Keeper gas from the setAttestation receipts; net = gross − keeper gas at 1 gwei (LPs fund the keeper).
- Not modelled: priority fees / bribes other than the break-even payment computed below, arbs that are also builders (the arb here never outbids the keeper), backruns within a block by other searchers, CEX–DEX arbs that trade between blocks on other venues, gas-price volatility, the Chainlink sanity-band gas (see the 110k columns), settler gas. Retail demand does not react to the fee except by routing between the two pools.

## Base fee 0.30% (every pool)

### LP − HODL of the Oniblock pool vs its vanilla neighbour (per hour; 95% bootstrap CI over the 6 windows)

| arm | gross bps/h [CI] | gross $/h | keeper $/h @1 gwei | net bps/h @1 gwei [CI] | net $/h | net bps/h, 110k gas | verdict (net) | windows +/− | posts/h | retail share % | retail cost bps: Oniblock / vanilla | market retail cost vs control bps | mean arb fee: Oniblock / vanilla | arb trades vs vanilla |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R: post lands last in the previous block (no builder deal), mid 13 s old; tabular-v2 + charge gate | 0.043 [-0.109, 0.230] | 85 | 26.0 | 0.030 [-0.124, 0.217] | 59 | 0.026 | INCONCLUSIVE | 2/4 | 137 | 43.4 | 28.7 / 31.4 | -0.52 | 0.508% / 0.300% | 60% |
| R0: as R, gate off (k = 0.8 p) | 0.065 [-0.125, 0.302] | 130 | 28.9 | 0.051 [-0.142, 0.261] | 102 | 0.046 | INCONCLUSIVE | 2/4 | 152 | 40.1 | 29.0 / 31.4 | -0.33 | 0.584% / 0.300% | 54% |
| C: keeper posts first in the block (cooperating builder), mid 2 s old; oniblock1 + charge gate | 0.156 [-0.003, 0.365] | 313 | 22.4 | 0.145 [-0.011, 0.350] | 290 | 0.141 | INCONCLUSIVE | 2/4 | 123 | 43.7 | 28.5 / 31.0 | -0.83 | 0.670% / 0.300% | 57% |
| C0: as C, gate off (k = 0.8 p) | 0.168 [-0.014, 0.376] | 335 | 27.0 | 0.154 [-0.023, 0.358] | 308 | 0.149 | INCONCLUSIVE | 2/4 | 148 | 40.7 | 28.6 / 30.8 | -0.79 | 0.738% / 0.300% | 53% |
| Rh: realistic timing, heuristic scorer (reference) | 0.022 [-0.119, 0.224] | 43 | 27.4 | 0.008 [-0.132, 0.207] | 16 | 0.004 | INCONCLUSIVE | 1/5 | 145 | 42.3 | 29.6 / 31.1 | -0.26 | 0.457% / 0.300% | 73% |
| Ch: coop timing, heuristic scorer (reference) | 0.150 [-0.022, 0.352] | 299 | 27.9 | 0.136 [-0.031, 0.333] | 271 | 0.131 | INCONCLUSIVE | 3/3 | 153 | 39.9 | 28.2 / 31.1 | -0.71 | 0.720% / 0.300% | 54% |

### By regime (net bps/h @1 gwei [CI])

| arm | volatile gross | volatile net | calm gross | calm net |
|---|---|---|---|---|
| R | 0.086 [-0.226, 0.461] | 0.066 [-0.246, 0.440] | -0.001 [-0.003, 0.000] | -0.007 [-0.008, -0.006] |
| R0 | 0.141 [-0.299, 0.556] | 0.119 [-0.321, 0.534] | -0.010 [-0.011, -0.010] | -0.017 [-0.018, -0.017] |
| C | 0.317 [0.003, 0.621] | 0.300 [-0.014, 0.603] | -0.004 [-0.004, -0.004] | -0.010 [-0.010, -0.010] |
| C0 | 0.354 [0.010, 0.604] | 0.333 [-0.011, 0.584] | -0.019 [-0.025, -0.015] | -0.025 [-0.031, -0.021] |
| Rh | 0.073 [-0.207, 0.485] | 0.053 [-0.228, 0.463] | -0.030 [-0.037, -0.019] | -0.037 [-0.044, -0.026] |
| Ch | 0.331 [0.036, 0.578] | 0.309 [0.015, 0.556] | -0.032 [-0.037, -0.021] | -0.038 [-0.044, -0.028] |

### The model on the sim's own graded blocks (settler labels, all windows pooled)

charged = the probability in force at the block ≥ the model's chargeThreshold (for the gate-off arms this is the same rule applied to their posted p; their k is 0.8·p regardless). pass rate = toxic charged / charged, FPR = benign charged / all benign, coverage = charged / graded, TPR = toxic charged / all toxic.

| arm | model (chargeThreshold) | graded blocks | toxic base rate | charged | pass rate | FPR | coverage | TPR | Brier | keeper decisions charged | volatile pass / FPR / TPR | calm pass / FPR / TPR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | tabular-v2 (0.7951) | 277 | 31.4% | 66 | 90.9% | 3.2% | 23.8% | 69.0% | 0.072 | 21.6% | 90.9% / 10.0% / 69.0% | - / 0.0% / - |
| R0 | tabular-v2 (0.7951) | 267 | 34.1% | 86 | 91.9% | 4.0% | 32.2% | 86.8% | 0.052 | 24.3% | 91.9% / 14.0% / 86.8% | - / 0.0% / - |
| C | oniblock1 (0.8224) | 283 | 33.2% | 80 | 97.5% | 1.1% | 28.3% | 83.0% | 0.029 | 20.3% | 97.5% / 3.3% / 83.0% | - / 0.0% / - |
| C0 | oniblock1 (0.8224) | 266 | 35.3% | 85 | 97.6% | 1.2% | 32.0% | 88.3% | 0.027 | 22.2% | 97.6% / 4.1% / 88.3% | - / 0.0% / - |

### Paired differences (per window, then bootstrap over windows)

| difference | net bps/h @1 gwei [CI] | net $/h | windows +/− | retail share pp | volatile net bps/h [CI] | calm net bps/h [CI] |
|---|---|---|---|---|---|---|
| C − R: value of the builder deal (first position + 2 s mid + oniblock1 vs no deal) | 0.115 [0.024, 0.218] | 231 | 3/3 | 0.3 | 0.234 [0.163, 0.307] | -0.003 [-0.004, -0.002] |
| C − C0: charge gate on vs off (coop) | -0.009 [-0.052, 0.017] | -18 | 4/2 | 3.0 | -0.033 [-0.115, 0.019] | 0.015 [0.012, 0.021] |
| R − R0: charge gate on vs off (realistic) | -0.021 [-0.082, 0.032] | -42 | 4/2 | 3.3 | -0.053 [-0.140, 0.076] | 0.010 [0.008, 0.012] |
| C − Ch: oniblock1 vs the heuristic, coop timing | 0.009 [-0.019, 0.035] | 19 | 4/2 | 3.9 | -0.009 [-0.046, 0.047] | 0.028 [0.018, 0.034] |
| R − Rh: tabular-v2 vs the heuristic, realistic timing | 0.022 [-0.005, 0.050] | 43 | 4/2 | 1.1 | 0.013 [-0.023, 0.081] | 0.030 [0.018, 0.038] |

### Break-even payment to the builder (arm C)

The most the LPs could pay the builder for first position before the hooked pool stops beating its vanilla neighbour = net LP gain vs vanilla (after keeper gas at 1 gwei). Per block if the slot is bought every block: **0.97 [-0.07, 2.33] $/block** (volatile 2.00 [-0.09, 4.02], calm -0.07 [-0.07, -0.07]); per keeper post (post-on-change, 123 posts/h): 1.60 [-0.25, 4.02] $/post; with 110k gas/post: 0.94 [-0.10, 2.30] $/block. A negative value means the hook loses to vanilla even with first position for free. First position is only needed in blocks where the keeper posts. The part of that gain that first position itself buys (C − R, per window, over C's posts): 1.31 [0.24, 2.51] $/post. Pool TVL $20M per pool; the gain scales roughly with liquidity.

### Model inputs seen by the keeper (means over decisions)

| arm | decisions/run | mean p | gap > base fee | gap pips | edgeSigma | abs ret12 bps | realizedVol bps | nSwaps (20 blocks) | heuristic fallbacks | seasoned at s | demoted 1st / 2nd half |
|---|---|---|---|---|---|---|---|---|---|---|---|
| R | 283 | 0.313 | 21.8% | 2064 | -12.43 | 5.59 | 8.38 | 18.0 | 0 | 528, 624, 1248, 864, 744, 600 | 2%/0%, 3%/0%, 6%/0%, 4%/0%, 3%/0%, 3%/0% |
| R0 | 283 | 0.328 | 24.4% | 2299 | -12.21 | 5.59 | 8.38 | 16.3 | 0 | 528, 624, 1248, 864, 744, 600 | 2%/0%, 3%/0%, 6%/0%, 4%/0%, 3%/0%, 3%/0% |
| C | 283 | 0.264 | 22.7% | 2258 | -12.06 | 5.48 | 8.45 | 18.2 | 0 | 432, 600, 1248, 864, 744, 576 | 2%/0%, 3%/0%, 6%/0%, 4%/0%, 3%/0%, 3%/0% |
| C0 | 283 | 0.278 | 24.0% | 2369 | -11.96 | 5.48 | 8.45 | 16.2 | 0 | 432, 600, 1248, 864, 744, 576 | 2%/0%, 3%/0%, 6%/0%, 4%/0%, 3%/0%, 3%/0% |

### Per run

| arm | window | gross $/h [within-window CI] | net $/h @1 gwei | posts/h | reasons | k predict miss | share % | arb fee Oniblock / vanilla | graded | charged | stale blocks | reverts |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | ETH-vol1 | 48 [-747, 1033] | 8 | 208 | first 1, skip 75, heartbeat 7, p 90, k 62, mid 48 | 0 | 38.0 | 0.407% / 0.300% | 52 | 17 | 1 | 0 |
| R | ETH-vol2 | -452 [-858, -69] | -491 | 194 | first 1, skip 89, heartbeat 7, p 73, k 40, mid 73 | 0 | 34.3 | 0.385% / 0.300% | 46 | 21 | 0 | 0 |
| R | ETH-vol3 | 921 [-236, 2407] | 879 | 196 | first 1, skip 87, heartbeat 13, p 54, k 37, mid 91 | 0 | 38.3 | 0.732% / 0.300% | 49 | 28 | 1 | 0 |
| R | ETH-calm1 | 0 [-3, 3] | -12 | 74 | first 1, skip 209, heartbeat 73 | 0 | 50.0 | -% / -% | 38 | 0 | 1 | 0 |
| R | ETH-calm2 | 0 [-6, 6] | -12 | 74 | first 1, skip 209, heartbeat 73 | 0 | 50.0 | -% / -% | 47 | 0 | 1 | 0 |
| R | ETH-calm3 | -5 [-15, 0] | -17 | 74 | first 1, skip 209, heartbeat 73 | 0 | 49.7 | -% / -% | 45 | 0 | 1 | 0 |
| R0 | ETH-vol1 | 332 [-743, 1846] | 287 | 236 | first 1, skip 47, heartbeat 6, p 14, k 134, mid 81 | 0 | 28.0 | 0.512% / 0.300% | 45 | 24 | 0 | 0 |
| R0 | ETH-vol2 | -597 [-1058, -180] | -642 | 221 | first 1, skip 62, heartbeat 5, p 17, k 95, mid 103 | 0 | 30.6 | 0.392% / 0.300% | 42 | 24 | 0 | 0 |
| R0 | ETH-vol3 | 1111 [-98, 2736] | 1067 | 206 | first 1, skip 77, heartbeat 11, p 37, mid 116, k 41 | 0 | 36.5 | 0.849% / 0.300% | 54 | 38 | 0 | 0 |
| R0 | ETH-calm1 | -23 [-35, -11] | -36 | 83 | first 1, skip 200, heartbeat 62, mid 20 | 0 | 48.4 | -% / -% | 38 | 0 | 0 | 0 |
| R0 | ETH-calm2 | -20 [-31, -10] | -33 | 81 | first 1, skip 202, heartbeat 60, mid 20 | 0 | 48.6 | -% / -% | 45 | 0 | 1 | 0 |
| R0 | ETH-calm3 | -20 [-34, -7] | -34 | 86 | first 1, skip 197, heartbeat 58, mid 27 | 0 | 48.6 | -% / -% | 43 | 0 | 1 | 0 |
| C | ETH-vol1 | 653 [-634, 2721] | 621 | 176 | first 1, skip 107, heartbeat 23, p 65, k 25, mid 62 | 0 | 39.3 | 0.618% / 0.300% | 60 | 25 | 0 | 0 |
| C | ETH-vol2 | 6 [-1210, 1561] | -28 | 168 | first 1, skip 115, heartbeat 27, p 33, k 41, mid 66 | 0 | 37.8 | 0.566% / 0.300% | 40 | 21 | 0 | 0 |
| C | ETH-vol3 | 1242 [-107, 3024] | 1206 | 172 | first 1, skip 111, heartbeat 24, p 26, k 15, mid 106 | 0 | 37.0 | 0.825% / 0.300% | 55 | 34 | 0 | 0 |
| C | ETH-calm1 | -9 [-26, 0] | -20 | 74 | first 1, skip 209, heartbeat 73 | 0 | 49.4 | -% / -% | 37 | 0 | 1 | 0 |
| C | ETH-calm2 | -9 [-26, 0] | -20 | 74 | first 1, skip 209, heartbeat 73 | 0 | 49.4 | -% / -% | 46 | 0 | 1 | 0 |
| C | ETH-calm3 | -9 [-26, 0] | -20 | 74 | first 1, skip 209, heartbeat 73 | 0 | 49.4 | -% / -% | 45 | 0 | 1 | 0 |
| C0 | ETH-vol1 | 893 [-675, 3325] | 851 | 234 | first 1, skip 49, heartbeat 6, p 6, k 97, mid 124 | 0 | 32.4 | 0.694% / 0.300% | 50 | 28 | 0 | 0 |
| C0 | ETH-vol2 | 20 [-1190, 1726] | -22 | 212 | first 1, skip 71, heartbeat 11, p 3, k 78, mid 119 | 0 | 33.9 | 0.617% / 0.300% | 38 | 22 | 0 | 0 |
| C0 | ETH-vol3 | 1208 [-138, 2998] | 1169 | 191 | first 1, skip 92, heartbeat 19, p 8, mid 134, k 29 | 0 | 35.8 | 0.902% / 0.300% | 55 | 35 | 0 | 0 |
| C0 | ETH-calm1 | -50 [-73, -27] | -62 | 82 | first 1, skip 201, heartbeat 62, mid 19 | 0 | 46.6 | -% / -% | 37 | 0 | 0 | 0 |
| C0 | ETH-calm2 | -32 [-52, -16] | -44 | 83 | first 1, skip 200, heartbeat 60, mid 22 | 0 | 47.8 | -% / -% | 44 | 0 | 1 | 0 |
| C0 | ETH-calm3 | -30 [-51, -14] | -43 | 83 | first 1, skip 200, heartbeat 59, mid 23 | 0 | 47.9 | -% / -% | 42 | 0 | 1 | 0 |
| Rh | ETH-vol1 | -117 [-243, -14] | -154 | 196 | first 1, skip 87, heartbeat 8, p 116, k 45, mid 26 | 0 | 45.3 | 0.300% / 0.300% | - | - | 0 | 0 |
| Rh | ETH-vol2 | -414 [-649, -196] | -456 | 204 | first 1, skip 79, heartbeat 9, p 29, k 103, mid 62 | 0 | 35.9 | 0.334% / 0.300% | - | - | 0 | 0 |
| Rh | ETH-vol3 | 970 [-235, 2559] | 926 | 204 | first 1, skip 79, heartbeat 11, p 16, k 65, mid 111 | 0 | 35.1 | 0.736% / 0.300% | - | - | 0 | 0 |
| Rh | ETH-calm1 | -75 [-123, -33] | -89 | 89 | first 1, skip 194, heartbeat 56, mid 17, k 14, p 1 | 0 | 44.8 | -% / -% | - | - | 0 | 0 |
| Rh | ETH-calm2 | -65 [-101, -30] | -79 | 86 | first 1, skip 197, heartbeat 57, mid 20, k 7, p 1 | 0 | 45.3 | -% / -% | - | - | 1 | 0 |
| Rh | ETH-calm3 | -38 [-59, -19] | -53 | 89 | first 1, skip 194, heartbeat 55, mid 26, k 7 | 0 | 47.3 | -% / -% | - | - | 1 | 0 |
| Ch | ETH-vol1 | 757 [-741, 2989] | 714 | 234 | first 1, skip 49, heartbeat 6, p 12, k 112, mid 103 | 0 | 32.8 | 0.684% / 0.300% | - | - | 0 | 0 |
| Ch | ETH-vol2 | 72 [-1059, 1622] | 30 | 213 | first 1, skip 70, heartbeat 7, p 16, k 112, mid 77 | 0 | 34.7 | 0.602% / 0.300% | - | - | 0 | 0 |
| Ch | ETH-vol3 | 1155 [-219, 2975] | 1113 | 206 | first 1, skip 77, heartbeat 11, p 17, k 57, mid 120 | 0 | 35.0 | 0.873% / 0.300% | - | - | 0 | 0 |
| Ch | ETH-calm1 | -72 [-116, -34] | -85 | 88 | first 1, skip 195, heartbeat 56, mid 17, k 12, p 2 | 0 | 45.0 | -% / -% | - | - | 0 | 0 |
| Ch | ETH-calm2 | -75 [-119, -36] | -88 | 89 | first 1, skip 194, heartbeat 57, mid 21, k 9, p 1 | 0 | 44.6 | -% / -% | - | - | 1 | 0 |
| Ch | ETH-calm3 | -42 [-67, -20] | -55 | 86 | first 1, skip 197, heartbeat 56, mid 22, k 7 | 0 | 47.0 | -% / -% | - | - | 1 | 0 |

## Base fee 0.05% (every pool)

### LP − HODL of the Oniblock pool vs its vanilla neighbour (per hour; 95% bootstrap CI over the 6 windows)

| arm | gross bps/h [CI] | gross $/h | keeper $/h @1 gwei | net bps/h @1 gwei [CI] | net $/h | net bps/h, 110k gas | verdict (net) | windows +/− | posts/h | retail share % | retail cost bps: Oniblock / vanilla | market retail cost vs control bps | mean arb fee: Oniblock / vanilla | arb trades vs vanilla |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R: post lands last in the previous block (no builder deal), mid 13 s old; tabular-v2 + charge gate | 0.029 [0.009, 0.052] | 59 | 30.9 | 0.014 [-0.002, 0.032] | 28 | 0.009 | INCONCLUSIVE | 3/3 | 164 | 45.2 | 5.3 / 6.5 | 0.05 | 0.063% / 0.050% | 92% |
| R0: as R, gate off (k = 0.8 p) | 0.047 [0.013, 0.086] | 94 | 32.5 | 0.031 [0.002, 0.065] | 62 | 0.026 | YES | 3/3 | 173 | 42.6 | 4.9 / 6.7 | 0.08 | 0.070% / 0.050% | 89% |
| C: keeper posts first in the block (cooperating builder), mid 2 s old; oniblock1 + charge gate | 0.261 [0.056, 0.511] | 522 | 29.9 | 0.246 [0.046, 0.482] | 492 | 0.240 | YES | 3/3 | 166 | 44.4 | 4.8 / 6.4 | -0.25 | 0.146% / 0.050% | 79% |
| C0: as C, gate off (k = 0.8 p) | 0.273 [0.057, 0.537] | 546 | 30.9 | 0.258 [0.046, 0.511] | 515 | 0.252 | YES | 3/3 | 171 | 43.1 | 4.9 / 6.4 | -0.13 | 0.168% / 0.050% | 74% |
| Rh: realistic timing, heuristic scorer (reference) | 0.044 [0.002, 0.093] | 87 | 32.4 | 0.027 [-0.008, 0.072] | 55 | 0.022 | INCONCLUSIVE | 2/4 | 172 | 43.3 | 5.1 / 6.6 | 0.09 | 0.066% / 0.050% | 89% |
| Ch: coop timing, heuristic scorer (reference) | 0.281 [0.062, 0.539] | 563 | 31.3 | 0.266 [0.051, 0.528] | 531 | 0.260 | YES | 3/3 | 174 | 42.6 | 4.9 / 6.4 | -0.12 | 0.174% / 0.050% | 73% |

### By regime (net bps/h @1 gwei [CI])

| arm | volatile gross | volatile net | calm gross | calm net |
|---|---|---|---|---|
| R | 0.059 [0.053, 0.067] | 0.036 [0.033, 0.044] | 0.000 [0.000, 0.000] | -0.009 [-0.010, -0.008] |
| R0 | 0.094 [0.078, 0.118] | 0.071 [0.054, 0.094] | 0.000 [0.000, 0.000] | -0.009 [-0.010, -0.008] |
| C | 0.522 [0.336, 0.749] | 0.500 [0.314, 0.727] | -0.000 [-0.001, 0.000] | -0.008 [-0.009, -0.008] |
| C0 | 0.546 [0.341, 0.793] | 0.523 [0.318, 0.770] | -0.000 [-0.001, 0.000] | -0.008 [-0.009, -0.008] |
| Rh | 0.087 [0.014, 0.148] | 0.063 [-0.008, 0.124] | 0.000 [0.000, 0.000] | -0.008 [-0.009, -0.008] |
| Ch | 0.563 [0.371, 0.801] | 0.540 [0.348, 0.779] | -0.000 [-0.001, 0.000] | -0.008 [-0.008, -0.008] |

### The model on the sim's own graded blocks (settler labels, all windows pooled)

charged = the probability in force at the block ≥ the model's chargeThreshold (for the gate-off arms this is the same rule applied to their posted p; their k is 0.8·p regardless). pass rate = toxic charged / charged, FPR = benign charged / all benign, coverage = charged / graded, TPR = toxic charged / all toxic.

| arm | model (chargeThreshold) | graded blocks | toxic base rate | charged | pass rate | FPR | coverage | TPR | Brier | keeper decisions charged | volatile pass / FPR / TPR | calm pass / FPR / TPR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | tabular-v2 (0.7951) | 198 | 91.9% | 111 | 98.2% | 12.5% | 56.1% | 59.9% | 0.078 | 42.3% | 98.1% / 22.2% / 58.0% | 100.0% / 0.0% / 100.0% |
| R0 | tabular-v2 (0.7951) | 192 | 91.1% | 126 | 97.6% | 17.6% | 65.6% | 70.3% | 0.071 | 44.6% | 97.5% / 30.0% / 68.9% | 100.0% / 0.0% / 100.0% |
| C | oniblock1 (0.8224) | 226 | 92.9% | 165 | 99.4% | 6.3% | 73.0% | 78.1% | 0.055 | 45.2% | 99.4% / 11.1% / 77.2% | 100.0% / 0.0% / 100.0% |
| C0 | oniblock1 (0.8224) | 201 | 94.0% | 166 | 99.4% | 8.3% | 82.6% | 87.3% | 0.038 | 46.5% | 99.4% / 20.0% / 86.7% | 100.0% / 0.0% / 100.0% |

### Paired differences (per window, then bootstrap over windows)

| difference | net bps/h @1 gwei [CI] | net $/h | windows +/− | retail share pp | volatile net bps/h [CI] | calm net bps/h [CI] |
|---|---|---|---|---|---|---|
| C − R: value of the builder deal (first position + 2 s mid + oniblock1 vs no deal) | 0.232 [0.047, 0.463] | 464 | 6/0 | -0.8 | 0.464 [0.281, 0.695] | 0.001 [0.000, 0.001] |
| C − C0: charge gate on vs off (coop) | -0.012 [-0.026, -0.001] | -23 | 3/3 | 1.3 | -0.023 [-0.043, -0.004] | 0.000 [0.000, 0.000] |
| R − R0: charge gate on vs off (realistic) | -0.017 [-0.036, -0.002] | -34 | 3/3 | 2.6 | -0.034 [-0.061, -0.010] | 0.000 [0.000, 0.000] |
| C − Ch: oniblock1 vs the heuristic, coop timing | -0.020 [-0.037, -0.005] | -40 | 2/4 | 1.8 | -0.040 [-0.052, -0.033] | 0.000 [-0.000, 0.001] |
| R − Rh: tabular-v2 vs the heuristic, realistic timing | -0.014 [-0.046, 0.016] | -27 | 1/5 | 1.9 | -0.027 [-0.092, 0.041] | -0.000 [-0.001, -0.000] |

### Break-even payment to the builder (arm C)

The most the LPs could pay the builder for first position before the hooked pool stops beating its vanilla neighbour = net LP gain vs vanilla (after keeper gas at 1 gwei). Per block if the slot is bought every block: **1.64 [0.30, 3.21] $/block** (volatile 3.33 [2.10, 4.85], calm -0.05 [-0.06, -0.05]); per keeper post (post-on-change, 166 posts/h): 2.11 [0.35, 4.19] $/post; with 110k gas/post: 1.60 [0.28, 3.23] $/block. A negative value means the hook loses to vanilla even with first position for free. First position is only needed in blocks where the keeper posts. The part of that gain that first position itself buys (C − R, per window, over C's posts): 2.03 [0.44, 3.96] $/post. Pool TVL $20M per pool; the gain scales roughly with liquidity.

### Model inputs seen by the keeper (means over decisions)

| arm | decisions/run | mean p | gap > base fee | gap pips | edgeSigma | abs ret12 bps | realizedVol bps | nSwaps (20 blocks) | heuristic fallbacks | seasoned at s | demoted 1st / 2nd half |
|---|---|---|---|---|---|---|---|---|---|---|---|
| R | 283 | 0.599 | 56.7% | 919 | -0.08 | 5.59 | 8.38 | 21.2 | 0 | 528, 696, 1032, -, -, - | 2%/0%, 3%/0%, 5%/0%, 8%/8%, 8%/8%, 8%/8% |
| R0 | 283 | 0.605 | 57.4% | 957 | -0.04 | 5.59 | 8.38 | 19.3 | 0 | 528, 696, 1032, -, -, - | 2%/0%, 3%/0%, 5%/0%, 8%/8%, 8%/8%, 8%/8% |
| C | 283 | 0.568 | 59.1% | 1335 | 0.23 | 5.48 | 8.45 | 19.4 | 0 | 456, 648, 960, -, -, - | 2%/0%, 3%/0%, 4%/0%, 8%/8%, 8%/8%, 8%/8% |
| C0 | 283 | 0.573 | 59.6% | 1353 | 0.25 | 5.48 | 8.45 | 18.4 | 0 | 456, 648, 960, -, -, - | 2%/0%, 3%/0%, 4%/0%, 8%/8%, 8%/8%, 8%/8% |

### Per run

| arm | window | gross $/h [within-window CI] | net $/h @1 gwei | posts/h | reasons | k predict miss | share % | arb fee Oniblock / vanilla | graded | charged | stale blocks | reverts |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | ETH-vol1 | 107 [21, 227] | 65 | 216 | first 1, p 65, skip 67, k 110, mid 38, heartbeat 2 | 0 | 41.2 | 0.067% / 0.050% | 72 | 32 | 1 | 0 |
| R | ETH-vol2 | 111 [-13, 279] | 66 | 218 | first 1, p 63, skip 65, heartbeat 4, k 81, mid 69 | 0 | 42.0 | 0.076% / 0.050% | 60 | 38 | 0 | 0 |
| R | ETH-vol3 | 134 [16, 281] | 88 | 213 | first 1, p 67, skip 70, heartbeat 3, k 98, mid 44 | 0 | 38.3 | 0.083% / 0.050% | 51 | 33 | 0 | 0 |
| R | ETH-calm1 | 0 [-1, 1] | -16 | 101 | first 1, skip 182, heartbeat 44, p 56 | 0 | 50.0 | 0.050% / 0.050% | 3 | 2 | 1 | 0 |
| R | ETH-calm2 | 0 [0, 0] | -18 | 113 | first 1, skip 170, p 78, heartbeat 34 | 0 | 50.0 | 0.050% / 0.050% | 6 | 3 | 0 | 0 |
| R | ETH-calm3 | 0 [0, 0] | -19 | 125 | first 1, skip 158, heartbeat 28, p 96 | 0 | 50.0 | 0.050% / 0.050% | 6 | 3 | 0 | 0 |
| R0 | ETH-vol1 | 235 [24, 536] | 188 | 250 | first 1, p 25, skip 33, k 151, mid 72, heartbeat 1 | 0 | 31.7 | 0.079% / 0.050% | 62 | 35 | 0 | 0 |
| R0 | ETH-vol2 | 174 [22, 354] | 128 | 224 | first 1, p 28, skip 59, heartbeat 4, k 97, mid 94 | 0 | 37.4 | 0.097% / 0.050% | 66 | 50 | 0 | 0 |
| R0 | ETH-vol3 | 156 [25, 330] | 108 | 226 | first 1, p 45, skip 57, heartbeat 3, k 117, mid 60 | 0 | 36.5 | 0.091% / 0.050% | 49 | 33 | 0 | 0 |
| R0 | ETH-calm1 | 0 [-1, 1] | -16 | 101 | first 1, skip 182, heartbeat 44, p 56 | 0 | 50.0 | 0.050% / 0.050% | 3 | 2 | 1 | 0 |
| R0 | ETH-calm2 | 0 [0, 0] | -18 | 113 | first 1, skip 170, p 78, heartbeat 34 | 0 | 50.0 | 0.050% / 0.050% | 6 | 3 | 0 | 0 |
| R0 | ETH-calm3 | 0 [0, 0] | -19 | 125 | first 1, skip 158, heartbeat 28, p 96 | 0 | 50.0 | 0.050% / 0.050% | 6 | 3 | 0 | 0 |
| C | ETH-vol1 | 1498 [16, 4024] | 1454 | 239 | first 1, skip 44, heartbeat 3, p 82, k 78, mid 75 | 0 | 38.7 | 0.217% / 0.050% | 79 | 47 | 0 | 0 |
| C | ETH-vol2 | 672 [-48, 1892] | 629 | 219 | first 1, skip 64, p 61, heartbeat 1, k 44, mid 112 | 0 | 38.8 | 0.241% / 0.050% | 64 | 53 | 0 | 0 |
| C | ETH-vol3 | 963 [95, 2254] | 917 | 221 | first 1, skip 62, p 71, heartbeat 1, k 54, mid 94 | 0 | 39.4 | 0.268% / 0.050% | 68 | 57 | 0 | 0 |
| C | ETH-calm1 | -1 [-4, 0] | -15 | 95 | first 1, skip 188, heartbeat 47, p 47 | 0 | 49.4 | 0.050% / 0.050% | 3 | 2 | 1 | 0 |
| C | ETH-calm2 | 0 [0, 0] | -16 | 107 | first 1, skip 176, p 65, heartbeat 41 | 0 | 50.0 | 0.050% / 0.050% | 6 | 3 | 0 | 0 |
| C | ETH-calm3 | 0 [0, 0] | -17 | 117 | first 1, skip 166, heartbeat 37, p 79 | 0 | 50.0 | 0.050% / 0.050% | 6 | 3 | 0 | 0 |
| C0 | ETH-vol1 | 1585 [9, 4173] | 1540 | 248 | first 1, skip 35, heartbeat 3, p 17, k 132, mid 95 | 0 | 32.9 | 0.294% / 0.050% | 62 | 48 | 0 | 0 |
| C0 | ETH-vol2 | 682 [-72, 1951] | 636 | 230 | first 1, skip 53, p 30, heartbeat 1, k 85, mid 113 | 0 | 37.4 | 0.281% / 0.050% | 59 | 53 | 0 | 0 |
| C0 | ETH-vol3 | 1011 [106, 2354] | 964 | 230 | first 1, skip 53, p 41, heartbeat 1, k 82, mid 105 | 0 | 39.1 | 0.280% / 0.050% | 65 | 57 | 0 | 0 |
| C0 | ETH-calm1 | -1 [-4, 0] | -15 | 95 | first 1, skip 188, heartbeat 47, p 47 | 0 | 49.4 | 0.050% / 0.050% | 3 | 2 | 1 | 0 |
| C0 | ETH-calm2 | 0 [0, 0] | -16 | 107 | first 1, skip 176, p 65, heartbeat 41 | 0 | 50.0 | 0.050% / 0.050% | 6 | 3 | 0 | 0 |
| C0 | ETH-calm3 | 0 [0, 0] | -17 | 117 | first 1, skip 166, heartbeat 37, p 79 | 0 | 50.0 | 0.050% / 0.050% | 6 | 3 | 0 | 0 |
| Rh | ETH-vol1 | 297 [48, 662] | 249 | 251 | first 1, skip 32, p 27, heartbeat 2, k 159, mid 62 | 0 | 32.5 | 0.082% / 0.050% | - | - | 0 | 0 |
| Rh | ETH-vol2 | 29 [-36, 91] | -16 | 220 | first 1, p 49, skip 63, heartbeat 6, k 101, mid 63 | 0 | 39.6 | 0.069% / 0.050% | - | - | 0 | 0 |
| Rh | ETH-vol3 | 197 [42, 415] | 146 | 238 | first 1, p 54, skip 45, k 135, mid 48 | 0 | 37.7 | 0.098% / 0.050% | - | - | 0 | 0 |
| Rh | ETH-calm1 | 0 [-1, 1] | -15 | 98 | first 1, skip 185, heartbeat 41, p 56 | 0 | 50.0 | 0.050% / 0.050% | - | - | 1 | 0 |
| Rh | ETH-calm2 | 0 [-2, 2] | -17 | 111 | first 1, skip 172, p 81, heartbeat 29 | 0 | 50.0 | 0.050% / 0.050% | - | - | 1 | 0 |
| Rh | ETH-calm3 | 0 [0, 0] | -17 | 112 | first 1, skip 171, p 82, heartbeat 29 | 0 | 50.0 | 0.050% / 0.050% | - | - | 0 | 0 |
| Ch | ETH-vol1 | 1603 [-36, 4239] | 1558 | 247 | first 1, skip 36, p 19, heartbeat 2, k 109, mid 116 | 0 | 33.2 | 0.298% / 0.050% | - | - | 0 | 0 |
| Ch | ETH-vol2 | 742 [-35, 2141] | 695 | 235 | first 1, skip 48, p 32, heartbeat 2, k 83, mid 117 | 0 | 36.1 | 0.294% / 0.050% | - | - | 0 | 0 |
| Ch | ETH-vol3 | 1034 [57, 2450] | 986 | 233 | first 1, skip 50, p 46, k 76, mid 110 | 0 | 37.1 | 0.301% / 0.050% | - | - | 0 | 0 |
| Ch | ETH-calm1 | -1 [-4, 0] | -16 | 101 | first 1, skip 182, heartbeat 38, p 62 | 0 | 49.4 | 0.050% / 0.050% | - | - | 1 | 0 |
| Ch | ETH-calm2 | 0 [0, 0] | -17 | 114 | first 1, p 86, skip 169, heartbeat 27 | 0 | 50.0 | 0.050% / 0.050% | - | - | 0 | 0 |
| Ch | ETH-calm3 | 0 [0, 0] | -17 | 113 | first 1, skip 170, p 85, heartbeat 27 | 0 | 50.0 | 0.050% / 0.050% | - | - | 0 | 0 |

Reproduce: `pnpm -C benchmark exec tsx src/v4/coop4.ts --run realistic` and `--run coop` (add `--tier 500` for the 0.05% tier), then `--report-only`. The 1 s benchmark is unchanged: `tsx src/v4/repro4.ts` checks that keepercost4 arm a still reproduces results_v4/heuristic-full (84/84 pool totals).
