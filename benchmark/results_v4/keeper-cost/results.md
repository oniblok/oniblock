# Keeper cost and post-on-change (v4 benchmark, 0.30% tier)

Generated 2026-09-26T18:51:29.801Z by `benchmark/src/v4/keepercost4.ts`. 6 ETHUSDT one-hour windows (3 volatile, 3 calm; data/windows_v2.json), 3600 1 s steps each, heuristic scorer only (no Jev calls), base fee 0.30% on every pool, $20M full-range TVL per pool. Pool = market (d) `aiheur` (the heuristic decides the fee every block; identical to (c) in heuristic mode) vs its vanilla 0.30% neighbour, with routing competition. Everything else is the v4 default (results_v4/heuristic-full); arm a reproduces it exactly.

## What is measured

- **Keeper gas**: gasUsed of every setAttestation receipt on anvil (txs are sent at gasPrice 0; gasUsed does not depend on it). Mean 79762 gas per post (full tx incl. 21k intrinsic). The bench deploys **no Chainlink sanity band**; a mainnet pool with the band does an extra feed read per post, so the ~110k mainnet figure is also shown.
- **Keeper cost on mainnet** = posts per keeper turn × 300 turns/h (one 12 s block each) × gas/post × gas price × ETH (window mean mid, ≈ $2143). For 'every' this is exactly 300 × (1 − miss 5%) posts/h. For 'change' in the 1 s-cadence arms (b, d) it is a **lower bound** (a 12 s block sees more drift than a 1 s step); arms e/f give the keeper one turn per 12 steps and count posts directly.
- **Net LP-HODL vs vanilla** = gross (per hour of replayed data) − mainnet keeper cost, in bps of the Oniblock pool's TVL. **This assumes the LPs (or the pool) fund the keeper.** The vanilla pool pays nothing. CIs are 95% bootstrap over windows (the within-window block-bootstrap CI per run is in the per-run table).
- **Post policy** (services/src/postPolicy.ts, the live keeper's rule): `change` posts when k would move ≥ 500 bps, the JIT window ≥ 5 blocks (never: pJit = 0 in the bench), the mid drifts > 2 bps while k > 0, the model pToxic moves ≥ 1000 bps (10 points; keeps the graded probabilities current while k is pinned), or a heartbeat of staleBlocks − 1 blocks. `last` = the AttestationPosted state in force on-chain; `now` = the k setAttestation would store (demotion + kFromScore + maxKStep replicated from poolConfig and checked against every posted k).

## Lag / block-time approximation: what is and is not modelled

- The simulator is 1 s steps (3 anvil blocks each: keeper, arbs vs the true mid, retail). It was not rewritten.
- **lag 12 (arms c, d)**: the keeper signs mid[t − 12]; arbs trade vs mid[t]. So every swap sees an attested mid 12 s old (the mainnet case "post lands late in block N, prices block N+1"). Keeper and arbs still act every second: the arb gets 12× more (smaller) opportunities per hour than on 12 s blocks and the keeper refreshes k every second.
- **12 s keeper cadence (arms e, f)**: the keeper gets a turn only every 12 steps (one post opportunity per mainnet block) with lag 6, so the attestation in force is 6–17 s old at the arb (mean 11.5 s); stale after 60 steps (5 mainnet blocks, the production STALE_BLOCKS), heartbeat 4 turns. Arbs and retail still act every 1 s step.
- Not modelled: 12 s arb/retail blocks (arbs trade every second), builder/top-of-block ordering or bribes, the keeper tx competing for inclusion (a missed post is the 5% miss draw only), priority fees, gas-price volatility, the Chainlink sanity-band gas (see the 110k column), settler (setCalibration) gas, L2 costs. Retail demand is fixed and does not react to the fee except by routing between the two pools.

## Results by arm (all windows)

| arm | policy | posts/step | mainnet posts/h | keeper USD/h @0.5 / 1 / 2 gwei | keeper @1 gwei, 110k gas | gross LP−HODL vs vanilla bps/h [CI] | gross USD/h | net bps/h @1 gwei [CI] | net USD/h @1 gwei | net @2 gwei | retail share % |
|---|---|---|---|---|---|---|---|---|---|---|---|
| a | every, lag 1 s (v4 default) | 0.951 | 285 | 24.4 / 48.8 / 97.6 | 67.2 | 0.173 [-0.063, 0.482] | 346 | 0.148 [-0.085, 0.456] | 297 | 0.124 | 37.2 |
| b | change, lag 1 s | 0.458 | 137 | 12.3 / 24.5 / 49.0 | 33.5 | 0.143 [-0.068, 0.429] | 286 | 0.131 [-0.075, 0.418] | 261 | 0.118 | 38.5 |
| c | every, lag 12 s | 0.951 | 285 | 24.3 / 48.6 / 97.3 | 67.2 | -0.091 [-0.108, -0.074] | -182 | -0.115 [-0.132, -0.099] | -231 | -0.140 | 40.0 |
| d | change, lag 12 s | 0.397 | 119 | 10.4 / 20.9 / 41.8 | 28.7 | -0.084 [-0.100, -0.069] | -168 | -0.094 [-0.109, -0.080] | -189 | -0.105 | 40.4 |
| e | every, 12 s keeper cadence, lag 6 s | 0.079 | 283 | 24.4 / 48.9 / 97.8 | 66.7 | -0.085 [-0.118, -0.057] | -170 | -0.109 [-0.144, -0.082] | -219 | -0.134 | 40.8 |
| f | change, 12 s keeper cadence, lag 6 s | 0.045 | 161 | 14.7 / 29.4 / 58.8 | 39.9 | -0.085 [-0.116, -0.060] | -171 | -0.100 [-0.133, -0.073] | -200 | -0.115 | 40.8 |

## By regime

| arm | regime | posts/step | mainnet posts/h | keeper USD/h @1 gwei | gross bps/h [CI] | net bps/h @1 gwei [CI] | retail share % | stale steps |
|---|---|---|---|---|---|---|---|---|
| a | volatile | 0.951 | 285 | 55.6 | 0.442 [0.120, 0.845] | 0.414 [0.091, 0.819] | 34.9 | 0 |
| a | calm | 0.951 | 285 | 42.1 | -0.096 [-0.125, -0.082] | -0.117 [-0.146, -0.103] | 39.5 | 0 |
| b | volatile | 0.588 | 176 | 34.4 | 0.376 [0.062, 0.839] | 0.359 [0.044, 0.821] | 36.6 | 6 |
| b | calm | 0.328 | 98 | 14.6 | -0.090 [-0.116, -0.071] | -0.097 [-0.125, -0.078] | 40.3 | 26 |
| c | volatile | 0.951 | 285 | 55.2 | -0.086 [-0.118, -0.063] | -0.114 [-0.147, -0.089] | 40.6 | 0 |
| c | calm | 0.951 | 285 | 42.1 | -0.096 [-0.123, -0.082] | -0.117 [-0.144, -0.103] | 39.5 | 0 |
| d | volatile | 0.467 | 140 | 27.2 | -0.079 [-0.106, -0.061] | -0.093 [-0.121, -0.075] | 40.3 | 11 |
| d | calm | 0.327 | 98 | 14.6 | -0.089 [-0.114, -0.073] | -0.096 [-0.122, -0.081] | 40.4 | 24 |
| e | volatile | 0.079 | 283 | 55.3 | -0.098 [-0.158, -0.042] | -0.126 [-0.186, -0.068] | 39.2 | 0 |
| e | calm | 0.079 | 283 | 42.5 | -0.071 [-0.094, -0.060] | -0.093 [-0.116, -0.081] | 42.3 | 0 |
| f | volatile | 0.062 | 224 | 43.9 | -0.096 [-0.149, -0.045] | -0.118 [-0.172, -0.064] | 39.3 | 0 |
| f | calm | 0.027 | 99 | 14.9 | -0.074 [-0.101, -0.060] | -0.082 [-0.109, -0.068] | 42.4 | 8 |

## Post-on-change saving

- b vs a: 52% fewer posts (48.8 → 24.5 USD/h at 1 gwei), gross LP -0.030 bps/h.
- d vs c: 58% fewer posts (48.6 → 20.9 USD/h at 1 gwei), gross LP 0.007 bps/h.
- f vs e: 43% fewer posts (48.9 → 29.4 USD/h at 1 gwei), gross LP -0.000 bps/h.

## Why the lag matters more than the gas

- arm a: volatile windows, mean fee paid by arbs on the Oniblock pool 0.692% (vanilla 0.30%), arb trades on it 52% of the vanilla pool's; retail share 37.2%.
- arm b: volatile windows, mean fee paid by arbs on the Oniblock pool 0.580% (vanilla 0.30%), arb trades on it 60% of the vanilla pool's; retail share 38.5%.
- arm c: volatile windows, mean fee paid by arbs on the Oniblock pool 0.317% (vanilla 0.30%), arb trades on it 90% of the vanilla pool's; retail share 40.0%.
- arm d: volatile windows, mean fee paid by arbs on the Oniblock pool 0.314% (vanilla 0.30%), arb trades on it 93% of the vanilla pool's; retail share 40.4%.
- arm e: volatile windows, mean fee paid by arbs on the Oniblock pool 0.325% (vanilla 0.30%), arb trades on it 91% of the vanilla pool's; retail share 40.8%.
- arm f: volatile windows, mean fee paid by arbs on the Oniblock pool 0.325% (vanilla 0.30%), arb trades on it 91% of the vanilla pool's; retail share 40.8%.

With a stale attested mid the hook measures the gap against the wrong price: the arb that trades toward the TRUE mid often shows no (or a reversed) gap vs the attested one, so it pays about the base fee and the pool loses its LVR protection, while retail that happens to trade toward the attested mid still pays the surcharge and routes to the vanilla pool.

## Verdict (net of keeper cost, 1 gwei, measured gas)

- arm a (every, lag 1 s (v4 default)): net **INCONCLUSIVE** 0.148 [-0.085, 0.456] bps/h (3+/3- of 6); volatile 0.414 [0.091, 0.819], calm -0.117 [-0.146, -0.103].
- arm b (change, lag 1 s): net **INCONCLUSIVE** 0.131 [-0.075, 0.418] bps/h (3+/3- of 6); volatile 0.359 [0.044, 0.821], calm -0.097 [-0.125, -0.078].
- arm c (every, lag 12 s): net **NO** -0.115 [-0.132, -0.099] bps/h (0+/6- of 6); volatile -0.114 [-0.147, -0.089], calm -0.117 [-0.144, -0.103].
- arm d (change, lag 12 s): net **NO** -0.094 [-0.109, -0.080] bps/h (0+/6- of 6); volatile -0.093 [-0.121, -0.075], calm -0.096 [-0.122, -0.081].
- arm e (every, 12 s keeper cadence, lag 6 s): net **NO** -0.109 [-0.144, -0.082] bps/h (0+/6- of 6); volatile -0.126 [-0.186, -0.068], calm -0.093 [-0.116, -0.081].
- arm f (change, 12 s keeper cadence, lag 6 s): net **NO** -0.100 [-0.133, -0.073] bps/h (0+/6- of 6); volatile -0.118 [-0.172, -0.064], calm -0.082 [-0.109, -0.068].

## Per run

| arm | window | posts | posts/step | reasons | k predict miss | gas/post | keeper gas | sim USD @1 gwei | mainnet USD/h @1 gwei | mainnet bps/h | gross bps/h | gross USD/h [within-window CI] | net bps/h @1 gwei | share % | stale steps | reverts |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| a | ETH-vol1 | 3422 | 0.951 | every 3422 | 0 | 80699 | 276150868 | 620.4 | 51.70 | 0.0259 | 0.845 | 1689 [-201, 4053] | 0.819 | 39.4 | 0 | 0 |
| a | ETH-vol2 | 3422 | 0.951 | every 3422 | 0 | 80595 | 275797032 | 675.4 | 56.29 | 0.0281 | 0.361 | 723 [-860, 3490] | 0.333 | 32.5 | 0 | 0 |
| a | ETH-vol3 | 3422 | 0.951 | every 3422 | 0 | 80635 | 275932314 | 704.5 | 58.71 | 0.0294 | 0.120 | 241 [-415, 1166] | 0.091 | 32.8 | 0 | 0 |
| a | ETH-calm1 | 3422 | 0.951 | every 3422 | 0 | 78826 | 269742848 | 503.9 | 41.99 | 0.0210 | -0.082 | -164 [-262, -76] | -0.103 | 40.2 | 0 | 0 |
| a | ETH-calm2 | 3422 | 0.951 | every 3422 | 0 | 78906 | 270017324 | 505.6 | 42.13 | 0.0211 | -0.125 | -249 [-402, -104] | -0.146 | 37.1 | 0 | 0 |
| a | ETH-calm3 | 3422 | 0.951 | every 3422 | 0 | 78911 | 270032342 | 504.7 | 42.06 | 0.0210 | -0.083 | -165 [-344, -30] | -0.104 | 41.1 | 0 | 0 |
| b | ETH-vol1 | 2271 | 0.631 | first 1, skip 1151, heartbeat 92, p 82, k 1314, mid 782 | 0 | 80972 | 183887129 | 413.1 | 34.43 | 0.0172 | 0.839 | 1677 [-117, 3903] | 0.821 | 40.9 | 5 | 0 |
| b | ETH-vol2 | 1970 | 0.547 | first 1, skip 1452, heartbeat 141, p 75, k 1145, mid 608 | 0 | 80902 | 159376864 | 390.3 | 32.53 | 0.0163 | 0.227 | 454 [-691, 2450] | 0.211 | 33.6 | 7 | 0 |
| b | ETH-vol3 | 2108 | 0.586 | first 1, skip 1314, heartbeat 120, mid 560, k 1376, p 51 | 0 | 80931 | 170602078 | 435.6 | 36.30 | 0.0181 | 0.062 | 124 [-318, 698] | 0.044 | 35.3 | 6 | 0 |
| b | ETH-calm1 | 1144 | 0.318 | first 1, skip 2278, heartbeat 516, mid 11, p 19, k 597 | 0 | 79378 | 90808808 | 169.6 | 14.14 | 0.0071 | -0.071 | -141 [-240, -55] | -0.078 | 41.6 | 29 | 0 |
| b | ETH-calm2 | 1343 | 0.373 | first 1, skip 2079, heartbeat 431, mid 13, k 885, p 13 | 0 | 79399 | 106633331 | 199.7 | 16.64 | 0.0083 | -0.116 | -233 [-388, -88] | -0.125 | 38.1 | 23 | 0 |
| b | ETH-calm3 | 1053 | 0.292 | first 1, skip 2369, heartbeat 556, mid 21, p 17, k 458 | 0 | 79618 | 83837249 | 156.7 | 13.06 | 0.0065 | -0.083 | -166 [-345, -29] | -0.089 | 41.2 | 27 | 0 |
| c | ETH-vol1 | 3422 | 0.951 | every 3422 | 0 | 80002 | 273767268 | 615.1 | 51.26 | 0.0256 | -0.063 | -127 [-243, -23] | -0.089 | 43.5 | 0 | 0 |
| c | ETH-vol2 | 3422 | 0.951 | every 3422 | 0 | 80135 | 274221385 | 671.6 | 55.96 | 0.0280 | -0.077 | -154 [-342, 34] | -0.105 | 40.4 | 0 | 0 |
| c | ETH-vol3 | 3422 | 0.951 | every 3422 | 0 | 80219 | 274510212 | 700.9 | 58.40 | 0.0292 | -0.118 | -236 [-402, -82] | -0.147 | 37.8 | 0 | 0 |
| c | ETH-calm1 | 3422 | 0.951 | every 3422 | 0 | 78820 | 269722404 | 503.9 | 41.99 | 0.0210 | -0.082 | -165 [-261, -78] | -0.103 | 40.1 | 0 | 0 |
| c | ETH-calm2 | 3422 | 0.951 | every 3422 | 0 | 78887 | 269951728 | 505.4 | 42.12 | 0.0211 | -0.123 | -247 [-402, -102] | -0.144 | 37.1 | 0 | 0 |
| c | ETH-calm3 | 3422 | 0.951 | every 3422 | 0 | 78887 | 269952848 | 504.5 | 42.04 | 0.0210 | -0.082 | -164 [-342, -29] | -0.103 | 41.2 | 0 | 0 |
| d | ETH-vol1 | 1780 | 0.494 | first 1, skip 1642, heartbeat 211, k 743, mid 504, p 321 | 0 | 80561 | 143397848 | 322.2 | 26.85 | 0.0134 | -0.061 | -123 [-244, -17] | -0.075 | 42.5 | 14 | 0 |
| d | ETH-vol2 | 1587 | 0.441 | first 1, skip 1835, heartbeat 238, p 230, k 753, mid 365 | 0 | 80556 | 127841609 | 313.1 | 26.09 | 0.0130 | -0.069 | -139 [-308, 34] | -0.082 | 40.8 | 8 | 0 |
| d | ETH-vol3 | 1675 | 0.465 | first 1, skip 1747, heartbeat 229, mid 434, k 803, p 208 | 0 | 80620 | 135037924 | 344.8 | 28.73 | 0.0144 | -0.106 | -213 [-343, -102] | -0.121 | 37.7 | 12 | 0 |
| d | ETH-calm1 | 1148 | 0.319 | first 1, skip 2274, heartbeat 515, mid 11, p 22, k 599 | 0 | 79438 | 91194824 | 170.4 | 14.20 | 0.0071 | -0.073 | -147 [-242, -63] | -0.081 | 41.3 | 24 | 0 |
| d | ETH-calm2 | 1327 | 0.369 | first 1, skip 2095, heartbeat 438, mid 10, k 868, p 10 | 0 | 79381 | 105339143 | 197.2 | 16.44 | 0.0082 | -0.114 | -227 [-374, -91] | -0.122 | 38.4 | 16 | 0 |
| d | ETH-calm3 | 1056 | 0.293 | first 1, skip 2366, heartbeat 552, mid 18, p 11, k 474 | 0 | 79616 | 84074514 | 157.1 | 13.09 | 0.0065 | -0.079 | -158 [-335, -27] | -0.086 | 41.6 | 32 | 0 |
| e | ETH-vol1 | 283 | 0.079 | every 283 | 0 | 80511 | 22784665 | 51.2 | 51.19 | 0.0256 | -0.042 | -85 [-188, 7] | -0.068 | 42.2 | 0 | 0 |
| e | ETH-vol2 | 283 | 0.079 | every 283 | 0 | 81047 | 22936211 | 56.2 | 56.17 | 0.0281 | -0.158 | -315 [-457, -170] | -0.186 | 37.3 | 0 | 0 |
| e | ETH-vol3 | 283 | 0.079 | every 283 | 0 | 81061 | 22940315 | 58.6 | 58.57 | 0.0293 | -0.095 | -190 [-329, -50] | -0.124 | 38.1 | 0 | 0 |
| e | ETH-calm1 | 283 | 0.079 | every 283 | 0 | 80155 | 22683961 | 42.4 | 42.38 | 0.0212 | -0.060 | -120 [-196, -53] | -0.081 | 42.8 | 0 | 0 |
| e | ETH-calm2 | 283 | 0.079 | every 283 | 0 | 80320 | 22730443 | 42.6 | 42.56 | 0.0213 | -0.094 | -189 [-317, -70] | -0.116 | 40.3 | 0 | 0 |
| e | ETH-calm3 | 283 | 0.079 | every 283 | 0 | 80243 | 22708903 | 42.4 | 42.44 | 0.0212 | -0.060 | -120 [-261, -17] | -0.081 | 43.8 | 0 | 0 |
| f | ETH-vol1 | 215 | 0.060 | first 1, skip 68, heartbeat 6, mid 76, p 57, k 75 | 0 | 80841 | 17380814 | 39.0 | 39.05 | 0.0195 | -0.045 | -90 [-195, 6] | -0.064 | 41.9 | 0 | 0 |
| f | ETH-vol2 | 227 | 0.063 | first 1, skip 56, heartbeat 4, p 41, k 80, mid 101 | 0 | 81147 | 18420305 | 45.1 | 45.11 | 0.0226 | -0.149 | -298 [-434, -151] | -0.172 | 37.9 | 0 | 0 |
| f | ETH-vol3 | 229 | 0.064 | first 1, skip 54, heartbeat 6, mid 106, p 34, k 82 | 0 | 81174 | 18588879 | 47.5 | 47.46 | 0.0237 | -0.096 | -191 [-331, -52] | -0.119 | 38.0 | 0 | 0 |
| f | ETH-calm1 | 101 | 0.028 | first 1, skip 182, heartbeat 43, mid 16, k 10, p 31 | 0 | 80829 | 8163715 | 15.3 | 15.25 | 0.0076 | -0.060 | -120 [-198, -51] | -0.068 | 42.9 | 12 | 0 |
| f | ETH-calm2 | 99 | 0.028 | first 1, skip 184, heartbeat 42, mid 20, k 24, p 12 | 0 | 80994 | 8018453 | 15.0 | 15.01 | 0.0075 | -0.101 | -203 [-345, -73] | -0.109 | 40.6 | 0 | 0 |
| f | ETH-calm3 | 96 | 0.027 | first 1, skip 187, heartbeat 45, mid 20, k 15, p 15 | 0 | 81086 | 7784302 | 14.5 | 14.55 | 0.0073 | -0.061 | -122 [-266, -16] | -0.068 | 43.7 | 12 | 0 |

Reproduce: `pnpm -C benchmark exec tsx src/v4/keepercost4.ts` (or per arm: `--arms a,b --port 8800`), then `--report-only`. Single runs with the same knobs: `tsx src/v4/run4.ts --jev heuristic --steps 3600 --b500 false --post change --keeper-lag 12 [--keeper-every 12 --stale-steps 60 --heartbeat 144]`.
