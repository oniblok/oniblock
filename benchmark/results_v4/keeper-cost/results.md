# Keeper cost and post-on-change (v4 benchmark, 0.30% tier)

Generated 2026-09-26T22:16:38.391Z by `benchmark/src/v4/keepercost4.ts`. 6 ETHUSDT one-hour windows (3 volatile, 3 calm; data/windows_v2.json), 3600 1 s steps each, heuristic scorer only (no Jev calls), base fee 0.30% on every pool, $20M full-range TVL per pool. Pool = market (d) `aiheur` (the heuristic decides the fee every block; identical to (c) in heuristic mode) vs its vanilla 0.30% neighbour, with routing competition. Everything else is the v4 default config (results_v4/heuristic-full). results_v4/heuristic-full predates PR #5 (the hook's sample-minimum probation, removed since: its model pools sat at kDefault for the first 200–240 steps of every window), so arm a no longer reproduces it; `src/v4/repro4.ts` instead checks that arm a is deterministic (a re-run matches raw-a.json exactly).

## What is measured

- **Keeper gas**: gasUsed of every setAttestation receipt on anvil (txs are sent at gasPrice 0; gasUsed does not depend on it). Mean 80114 gas per post (full tx incl. 21k intrinsic). The bench deploys **no Chainlink sanity band**; a mainnet pool with the band does an extra feed read per post, so the ~110k mainnet figure is also shown.
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
| a | every, lag 1 s (v4 default) | 0.951 | 285 | 24.5 / 49.0 / 98.1 | 67.2 | 0.171 [-0.064, 0.479] | 342 | 0.146 [-0.086, 0.453] | 293 | 0.122 | 36.9 |
| b | change, lag 1 s | 0.460 | 138 | 12.4 / 24.7 / 49.4 | 33.7 | 0.141 [-0.068, 0.427] | 282 | 0.129 [-0.076, 0.416] | 258 | 0.116 | 38.3 |
| c | every, lag 12 s | 0.951 | 285 | 24.4 / 48.8 / 97.7 | 67.2 | -0.093 [-0.110, -0.077] | -186 | -0.117 [-0.134, -0.101] | -235 | -0.142 | 39.7 |
| d | change, lag 12 s | 0.399 | 120 | 10.5 / 21.1 / 42.2 | 28.8 | -0.090 [-0.105, -0.075] | -180 | -0.100 [-0.115, -0.085] | -201 | -0.111 | 40.0 |
| e | every, 12 s keeper cadence, lag 6 s | 0.079 | 283 | 24.6 / 49.1 / 98.2 | 66.7 | -0.086 [-0.120, -0.058] | -172 | -0.111 [-0.146, -0.083] | -221 | -0.135 | 40.6 |
| f | change, 12 s keeper cadence, lag 6 s | 0.045 | 163 | 15.0 / 29.9 / 59.9 | 40.5 | -0.087 [-0.118, -0.060] | -173 | -0.102 [-0.136, -0.074] | -203 | -0.116 | 40.7 |

## By regime

| arm | regime | posts/step | mainnet posts/h | keeper USD/h @1 gwei | gross bps/h [CI] | net bps/h @1 gwei [CI] | retail share % | stale steps |
|---|---|---|---|---|---|---|---|---|
| a | volatile | 0.951 | 285 | 55.8 | 0.439 [0.119, 0.843] | 0.411 [0.090, 0.817] | 34.5 | 0 |
| a | calm | 0.951 | 285 | 42.3 | -0.097 [-0.125, -0.083] | -0.119 [-0.146, -0.104] | 39.4 | 0 |
| b | volatile | 0.592 | 178 | 34.8 | 0.373 [0.061, 0.837] | 0.356 [0.043, 0.820] | 36.3 | 5 |
| b | calm | 0.328 | 98 | 14.7 | -0.091 [-0.117, -0.072] | -0.098 [-0.125, -0.080] | 40.2 | 27 |
| c | volatile | 0.951 | 285 | 55.4 | -0.089 [-0.120, -0.065] | -0.117 [-0.149, -0.091] | 40.1 | 0 |
| c | calm | 0.951 | 285 | 42.2 | -0.097 [-0.124, -0.082] | -0.118 [-0.145, -0.103] | 39.4 | 0 |
| d | volatile | 0.470 | 141 | 27.5 | -0.090 [-0.108, -0.062] | -0.104 [-0.122, -0.076] | 39.6 | 14 |
| d | calm | 0.327 | 98 | 14.6 | -0.089 [-0.114, -0.075] | -0.097 [-0.122, -0.082] | 40.4 | 24 |
| e | volatile | 0.079 | 283 | 55.6 | -0.100 [-0.161, -0.043] | -0.128 [-0.189, -0.069] | 39.0 | 0 |
| e | calm | 0.079 | 283 | 42.7 | -0.072 [-0.095, -0.060] | -0.093 [-0.116, -0.081] | 42.2 | 0 |
| f | volatile | 0.063 | 228 | 44.8 | -0.099 [-0.153, -0.046] | -0.121 [-0.176, -0.066] | 39.0 | 0 |
| f | calm | 0.028 | 99 | 15.1 | -0.075 [-0.102, -0.061] | -0.082 [-0.109, -0.068] | 42.3 | 8 |

## Post-on-change saving

- b vs a: 52% fewer posts (49.0 → 24.7 USD/h at 1 gwei), gross LP -0.030 bps/h.
- d vs c: 58% fewer posts (48.8 → 21.1 USD/h at 1 gwei), gross LP 0.003 bps/h.
- f vs e: 42% fewer posts (49.1 → 29.9 USD/h at 1 gwei), gross LP -0.001 bps/h.

## Why the lag matters more than the gas

- arm a: volatile windows, mean fee paid by arbs on the Oniblock pool 0.692% (vanilla 0.30%), arb trades on it 52% of the vanilla pool's; retail share 36.9%.
- arm b: volatile windows, mean fee paid by arbs on the Oniblock pool 0.580% (vanilla 0.30%), arb trades on it 60% of the vanilla pool's; retail share 38.3%.
- arm c: volatile windows, mean fee paid by arbs on the Oniblock pool 0.317% (vanilla 0.30%), arb trades on it 90% of the vanilla pool's; retail share 39.7%.
- arm d: volatile windows, mean fee paid by arbs on the Oniblock pool 0.313% (vanilla 0.30%), arb trades on it 93% of the vanilla pool's; retail share 40.0%.
- arm e: volatile windows, mean fee paid by arbs on the Oniblock pool 0.325% (vanilla 0.30%), arb trades on it 91% of the vanilla pool's; retail share 40.6%.
- arm f: volatile windows, mean fee paid by arbs on the Oniblock pool 0.325% (vanilla 0.30%), arb trades on it 91% of the vanilla pool's; retail share 40.7%.

With a stale attested mid the hook measures the gap against the wrong price: the arb that trades toward the TRUE mid often shows no (or a reversed) gap vs the attested one, so it pays about the base fee and the pool loses its LVR protection, while retail that happens to trade toward the attested mid still pays the surcharge and routes to the vanilla pool.

## Verdict (net of keeper cost, 1 gwei, measured gas)

- arm a (every, lag 1 s (v4 default)): net **INCONCLUSIVE** 0.146 [-0.086, 0.453] bps/h (3+/3- of 6); volatile 0.411 [0.090, 0.817], calm -0.119 [-0.146, -0.104].
- arm b (change, lag 1 s): net **INCONCLUSIVE** 0.129 [-0.076, 0.416] bps/h (3+/3- of 6); volatile 0.356 [0.043, 0.820], calm -0.098 [-0.125, -0.080].
- arm c (every, lag 12 s): net **NO** -0.117 [-0.134, -0.101] bps/h (0+/6- of 6); volatile -0.117 [-0.149, -0.091], calm -0.118 [-0.145, -0.103].
- arm d (change, lag 12 s): net **NO** -0.100 [-0.115, -0.085] bps/h (0+/6- of 6); volatile -0.104 [-0.122, -0.076], calm -0.097 [-0.122, -0.082].
- arm e (every, 12 s keeper cadence, lag 6 s): net **NO** -0.111 [-0.146, -0.083] bps/h (0+/6- of 6); volatile -0.128 [-0.189, -0.069], calm -0.093 [-0.116, -0.081].
- arm f (change, 12 s keeper cadence, lag 6 s): net **NO** -0.102 [-0.136, -0.074] bps/h (0+/6- of 6); volatile -0.121 [-0.176, -0.066], calm -0.082 [-0.109, -0.068].

## Per run

| arm | window | posts | posts/step | reasons | k predict miss | gas/post | keeper gas | sim USD @1 gwei | mainnet USD/h @1 gwei | mainnet bps/h | gross bps/h | gross USD/h [within-window CI] | net bps/h @1 gwei | share % | stale steps | reverts |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| a | ETH-vol1 | 3422 | 0.951 | every 3422 | 0 | 81057 | 277375974 | 623.2 | 51.93 | 0.0260 | 0.843 | 1685 [-202, 4045] | 0.817 | 39.1 | 0 | 0 |
| a | ETH-vol2 | 3422 | 0.951 | every 3422 | 0 | 80941 | 276980778 | 678.3 | 56.53 | 0.0283 | 0.355 | 710 [-865, 3478] | 0.327 | 31.8 | 0 | 0 |
| a | ETH-vol3 | 3422 | 0.951 | every 3422 | 0 | 80976 | 277098398 | 707.5 | 58.96 | 0.0295 | 0.119 | 239 [-417, 1165] | 0.090 | 32.7 | 0 | 0 |
| a | ETH-calm1 | 3422 | 0.951 | every 3422 | 0 | 79188 | 270981142 | 506.2 | 42.19 | 0.0211 | -0.084 | -168 [-264, -85] | -0.105 | 39.9 | 0 | 0 |
| a | ETH-calm2 | 3422 | 0.951 | every 3422 | 0 | 79250 | 271192410 | 507.8 | 42.31 | 0.0212 | -0.125 | -250 [-403, -104] | -0.146 | 37.0 | 0 | 0 |
| a | ETH-calm3 | 3422 | 0.951 | every 3422 | 0 | 79274 | 271275866 | 507.0 | 42.25 | 0.0211 | -0.083 | -166 [-345, -31] | -0.104 | 41.1 | 0 | 0 |
| b | ETH-vol1 | 2281 | 0.634 | first 1, skip 1141, mid 806, heartbeat 76, k 1314, p 84 | 0 | 81248 | 185326506 | 416.4 | 34.70 | 0.0173 | 0.837 | 1675 [-118, 3897] | 0.820 | 40.8 | 5 | 0 |
| b | ETH-vol2 | 1995 | 0.554 | first 1, skip 1427, heartbeat 128, mid 617, k 1176, p 73 | 0 | 81178 | 161949554 | 396.6 | 33.05 | 0.0165 | 0.221 | 441 [-701, 2430] | 0.204 | 32.9 | 6 | 0 |
| b | ETH-vol3 | 2114 | 0.587 | first 1, skip 1308, heartbeat 108, mid 578, k 1376, p 51 | 0 | 81208 | 171674104 | 438.3 | 36.53 | 0.0183 | 0.061 | 123 [-320, 698] | 0.043 | 35.2 | 5 | 0 |
| b | ETH-calm1 | 1145 | 0.318 | first 1, skip 2277, heartbeat 515, mid 13, p 19, k 597 | 0 | 79699 | 91255324 | 170.5 | 14.21 | 0.0071 | -0.072 | -145 [-242, -61] | -0.080 | 41.4 | 30 | 0 |
| b | ETH-calm2 | 1343 | 0.373 | first 1, skip 2079, heartbeat 430, mid 14, k 885, p 13 | 0 | 79699 | 107036128 | 200.4 | 16.70 | 0.0084 | -0.117 | -233 [-388, -88] | -0.125 | 38.1 | 23 | 0 |
| b | ETH-calm3 | 1053 | 0.292 | first 1, skip 2369, heartbeat 556, mid 21, p 17, k 458 | 0 | 79942 | 84178714 | 157.3 | 13.11 | 0.0066 | -0.083 | -166 [-346, -30] | -0.090 | 41.2 | 27 | 0 |
| c | ETH-vol1 | 3422 | 0.951 | every 3422 | 0 | 80391 | 275098066 | 618.1 | 51.51 | 0.0258 | -0.065 | -130 [-245, -27] | -0.091 | 43.4 | 0 | 0 |
| c | ETH-vol2 | 3422 | 0.951 | every 3422 | 0 | 80411 | 275167602 | 673.9 | 56.16 | 0.0281 | -0.082 | -163 [-350, 27] | -0.110 | 39.2 | 0 | 0 |
| c | ETH-vol3 | 3422 | 0.951 | every 3422 | 0 | 80575 | 275727992 | 704.0 | 58.66 | 0.0293 | -0.120 | -240 [-404, -88] | -0.149 | 37.6 | 0 | 0 |
| c | ETH-calm1 | 3422 | 0.951 | every 3422 | 0 | 79183 | 270965210 | 506.2 | 42.18 | 0.0211 | -0.085 | -169 [-262, -87] | -0.106 | 39.9 | 0 | 0 |
| c | ETH-calm2 | 3422 | 0.951 | every 3422 | 0 | 79250 | 271194866 | 507.8 | 42.31 | 0.0212 | -0.124 | -248 [-402, -103] | -0.145 | 37.1 | 0 | 0 |
| c | ETH-calm3 | 3422 | 0.951 | every 3422 | 0 | 79273 | 271272676 | 507.0 | 42.25 | 0.0211 | -0.082 | -165 [-343, -30] | -0.103 | 41.2 | 0 | 0 |
| d | ETH-vol1 | 1782 | 0.495 | first 1, skip 1640, heartbeat 194, mid 527, k 739, p 321 | 0 | 80863 | 144098288 | 323.7 | 26.98 | 0.0135 | -0.062 | -125 [-246, -19] | -0.076 | 42.4 | 18 | 0 |
| d | ETH-vol2 | 1616 | 0.449 | first 1, skip 1806, heartbeat 223, mid 383, p 234, k 775 | 0 | 80863 | 130674478 | 320.0 | 26.67 | 0.0133 | -0.101 | -203 [-350, -59] | -0.115 | 38.8 | 10 | 0 |
| d | ETH-vol3 | 1680 | 0.467 | first 1, skip 1742, heartbeat 219, mid 449, k 803, p 208 | 0 | 80915 | 135937992 | 347.1 | 28.92 | 0.0145 | -0.108 | -215 [-345, -105] | -0.122 | 37.6 | 14 | 0 |
| d | ETH-calm1 | 1148 | 0.319 | first 1, skip 2274, heartbeat 513, mid 13, p 22, k 599 | 0 | 79754 | 91558100 | 171.0 | 14.25 | 0.0071 | -0.075 | -151 [-243, -68] | -0.082 | 41.1 | 24 | 0 |
| d | ETH-calm2 | 1328 | 0.369 | first 1, skip 2094, heartbeat 438, mid 11, k 868, p 10 | 0 | 79694 | 105834044 | 198.2 | 16.51 | 0.0083 | -0.114 | -228 [-374, -92] | -0.122 | 38.4 | 15 | 0 |
| d | ETH-calm3 | 1056 | 0.293 | first 1, skip 2366, heartbeat 552, mid 18, p 11, k 474 | 0 | 79955 | 84432014 | 157.8 | 13.15 | 0.0066 | -0.079 | -158 [-335, -28] | -0.086 | 41.6 | 32 | 0 |
| e | ETH-vol1 | 283 | 0.079 | every 283 | 0 | 80896 | 22893650 | 51.4 | 51.43 | 0.0257 | -0.043 | -86 [-190, 4] | -0.069 | 42.1 | 0 | 0 |
| e | ETH-vol2 | 283 | 0.079 | every 283 | 0 | 81405 | 23037720 | 56.4 | 56.42 | 0.0282 | -0.161 | -322 [-459, -183] | -0.189 | 37.0 | 0 | 0 |
| e | ETH-vol3 | 283 | 0.079 | every 283 | 0 | 81412 | 23039654 | 58.8 | 58.82 | 0.0294 | -0.096 | -192 [-330, -52] | -0.126 | 37.9 | 0 | 0 |
| e | ETH-calm1 | 283 | 0.079 | every 283 | 0 | 80520 | 22787270 | 42.6 | 42.57 | 0.0213 | -0.061 | -122 [-197, -57] | -0.083 | 42.7 | 0 | 0 |
| e | ETH-calm2 | 283 | 0.079 | every 283 | 0 | 80670 | 22829648 | 42.7 | 42.74 | 0.0214 | -0.095 | -189 [-317, -70] | -0.116 | 40.2 | 0 | 0 |
| e | ETH-calm3 | 283 | 0.079 | every 283 | 0 | 80636 | 22819918 | 42.6 | 42.65 | 0.0213 | -0.060 | -120 [-261, -17] | -0.081 | 43.8 | 0 | 0 |
| f | ETH-vol1 | 220 | 0.061 | first 1, mid 85, skip 63, p 57, k 75, heartbeat 2 | 0 | 81133 | 17849242 | 40.1 | 40.10 | 0.0201 | -0.046 | -91 [-196, 3] | -0.066 | 41.8 | 0 | 0 |
| f | ETH-vol2 | 230 | 0.064 | first 1, mid 109, skip 53, p 38, k 80, heartbeat 2 | 0 | 81451 | 18733730 | 45.9 | 45.88 | 0.0229 | -0.153 | -305 [-437, -167] | -0.176 | 37.5 | 0 | 0 |
| f | ETH-vol3 | 233 | 0.065 | first 1, skip 50, mid 115, heartbeat 1, p 34, k 82 | 0 | 81456 | 18979264 | 48.5 | 48.46 | 0.0242 | -0.097 | -194 [-333, -55] | -0.121 | 37.8 | 0 | 0 |
| f | ETH-calm1 | 101 | 0.028 | first 1, skip 182, heartbeat 41, mid 18, k 10, p 31 | 0 | 81186 | 8199782 | 15.3 | 15.32 | 0.0077 | -0.061 | -122 [-198, -54] | -0.069 | 42.7 | 12 | 0 |
| f | ETH-calm2 | 100 | 0.028 | first 1, skip 183, mid 23, heartbeat 40, k 24, p 12 | 0 | 81354 | 8135428 | 15.2 | 15.23 | 0.0076 | -0.102 | -203 [-345, -73] | -0.109 | 40.6 | 0 | 0 |
| f | ETH-calm3 | 96 | 0.027 | first 1, skip 187, heartbeat 44, mid 21, k 15, p 15 | 0 | 81442 | 7818468 | 14.6 | 14.61 | 0.0073 | -0.061 | -122 [-267, -16] | -0.068 | 43.7 | 12 | 0 |

Reproduce: `pnpm -C benchmark exec tsx src/v4/keepercost4.ts` (or per arm: `--arms a,b --port 8800`), then `--report-only`. Single runs with the same knobs: `tsx src/v4/run4.ts --jev heuristic --steps 3600 --b500 false --post change --keeper-lag 12 [--keeper-every 12 --stale-steps 60 --heartbeat 144]`.
