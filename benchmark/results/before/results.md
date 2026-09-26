# Oniblock benchmark results

Generated 2026-09-26T00:13:16.662Z - total runtime 482s. Reproduce: `pnpm -C benchmark run run`.

**Setup.** Real Binance ETHUSDT 1s klines (held-out windows, frozen in `data/windows.json`), one kline step = one price step, replayed on a fresh anvil (automine off, manual mining; each step = keeper block + trading block). Five v4 pools with identical full-range liquidity and initial price (mWETH/mUSDC): (1) hookless 0.30%; (2) Detox-style gap fee, constant k=0.7; (3) Oniblock law, constant k=0.5; (4) Oniblock law, k from the model (Jev via /v1/evaluate with quantized-state cache + bounded budget, heuristic fallback); (5) like 4 but the model is deliberately degraded (probability inverted, confidence 0.95) for the second half; the settler posts calibration every M steps and the on-chain Brier gate demotes k to kDefault. One hook instance, four pool keys (tickSpacing 10/20/30/40), each with its own PoolConfig; base fee 0.30%, feeMax 1%. Arb: rational, trades to the no-trade band edge at the hook-quoted per-block fee vs the kline mid, only if profit at mid > fixed gas. Retail: identical seeded Poisson orders on all pools (same sizes/directions).

**Metrics** (USD, marked to the kline mid): LP-HODL = LP position value incl. uncollected fees minus value of the initial deposit held; LVR proxy = sum of arb profit at mid (before gas); LP fees = fee growth accrued; retail cost = paid - received at mid (fees + price impact; negative = retail gained, e.g. trading against a stale pool price). Brackets are 95% circular block-bootstrap CIs over steps (block length ~ sqrt(N)); they capture within-path noise only, not across-path/regime uncertainty.

## Window: volatile

2026-09-11T12:15:00.000Z + 120 min at 1s (7200 steps), price range 9.522%, TVL/pool ~$19,808,968, split=1, retail lambda=0.05/step median $500, gas $0.5/arb tx, model=jev. Runtime 40s, 31949 txs, reverts: 0.

| pool | LP - HODL | LVR proxy (arb profit) | LP fees (from arbs / retail) | retail cost | retail cost bps | arbs | arb vol | retail vol | mean k | mean arb fee (pips) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 fixed 0.30% | -7,352 [-21,076, 3,942] | 501 [223, 837] | 2,818 [1,959, 3,784] (2,091 / 727) | 808 [701, 920] | 33.43 | 155 | 697,144 | 241,762 | - | 3000 |
| 2 detox-style k=0.7 | -4,761 [-16,768, 5,568] | 319 [102, 590] | 5,372 [3,215, 7,971] (4,237 / 1,135) | 1,367 [1,136, 1,595] | 56.67 | 91 | 423,662 | 241,163 | 7000 | 10000 |
| 3 oniblock const k=0.5 | -5,757 [-18,585, 5,113] | 236 [104, 392] | 4,419 [2,844, 6,363] (3,535 / 884) | 1,049 [894, 1,213] | 43.45 | 141 | 506,698 | 241,485 | 5000 | 6748 |
| 4 oniblock model k | -5,862 [-18,605, 4,962] | 243 [118, 392] | 4,319 [2,752, 6,238] (3,450 / 869) | 1,043 [885, 1,210] | 43.19 | 124 | 485,669 | 241,480 | 4299 | 6896 |
| 5 oniblock gated | -5,905 [-18,713, 4,946] | 228 [101, 383] | 4,278 [2,712, 6,168] (3,394 / 883) | 1,048 [893, 1,211] | 43.4 | 135 | 486,456 | 241,484 | 4852 | 6755 |

Paired differences (A - B, sum over steps, 95% CI):

| comparison | LP - HODL | LVR proxy | retail cost |
|---|---|---|---|
| **4 model - 3 const** | -105 [-376, 172] | 7.74 [-18, 32] | -6.34 [-22, 13] |
| 3 const - 1 fixed | 1,595 [642, 2,669] | -265 [-486, -98] | 241 [157, 323] |
| 2 detox - 1 fixed | 2,591 [940, 4,492] | -182 [-400, -42] | - |
| 3 const - 2 detox | -996 [-1,889, -115] | -83 [-215, 19] | -317 [-397, -239] |
| 5 gated - 4 model (2nd half) | -42 [-228, 96] | -15 [-36, 4.62] | - |

**Does the model beat constant k? no significant difference (CI spans 0)** (LP - HODL, pool 4 - pool 3: -105 [-376, 172] USD).

Gate (brierDemoteBps 2500, minSamples 10, settler every 20 steps over the last 50 labelled blocks): models start unseasoned (k = kDefault) until the first calibration post (pool 4 at step 540, pool 5 at step 540). Pool 5 model degraded at step 3600; first post-degradation calibration above threshold at step 3720 (Brier 0.273, n=50) -> k forced to kDefault (lag 120 steps) (note: pool 5 was ALSO demoted before the degradation, i.e. the honest model failed the gate). Steps demoted: pool 4 (honest) 2520/7200, pool 5 5440/7200. End-of-run calibration (off-chain, same labelling): pool 4 {"brierBps":1941,"hitRateBps":7400,"n":50}, pool 5 {"brierBps":5943,"hitRateBps":1600,"n":50}.

Model sources (pool 4+5 scores): {"jev":3,"jev-cache":14397,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0}; Jev API calls 3 (failures 0, p50 latency 696 ms).

## Window: volatile-split5

2026-09-11T12:15:00.000Z + 120 min at 1s (7200 steps), price range 9.522%, TVL/pool ~$19,808,968, split=5, retail lambda=0.05/step median $500, gas $0.5/arb tx, model=jev. Runtime 134s, 31944 txs, reverts: 0.

| pool | LP - HODL | LVR proxy (arb profit) | LP fees (from arbs / retail) | retail cost | retail cost bps | arbs | arb vol | retail vol | mean k | mean arb fee (pips) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 fixed 0.30% | -7,352 [-21,076, 3,942] | 501 [223, 837] | 2,818 [1,959, 3,784] (2,091 / 727) | 808 [701, 920] | 33.43 | 155 | 697,144 | 241,762 | - | 3000 |
| 2 detox-style k=0.7 | -4,761 [-16,768, 5,568] | 319 [102, 590] | 5,372 [3,215, 7,971] (4,237 / 1,135) | 1,367 [1,136, 1,595] | 56.67 | 91 | 423,662 | 241,163 | 7000 | 10000 |
| 3 oniblock const k=0.5 | -5,757 [-18,585, 5,113] | 236 [104, 392] | 4,419 [2,844, 6,363] (3,535 / 884) | 1,049 [894, 1,213] | 43.45 | 141 | 506,698 | 241,485 | 5000 | 6748 |
| 4 oniblock model k | -5,887 [-18,636, 4,965] | 256 [110, 437] | 4,284 [2,670, 6,349] (3,430 / 854) | 1,028 [873, 1,192] | 42.55 | 121 | 476,578 | 241,530 | 4123 | 6911 |
| 5 oniblock gated | -5,954 [-18,736, 4,985] | 227 [100, 380] | 4,228 [2,700, 6,110] (3,369 / 860) | 1,028 [881, 1,187] | 42.54 | 133 | 482,436 | 241,531 | 4713 | 6757 |

Paired differences (A - B, sum over steps, 95% CI):

| comparison | LP - HODL | LVR proxy | retail cost |
|---|---|---|---|
| **4 model - 3 const** | -130 [-466, 226] | 21 [-20, 74] | -22 [-51, 6.21] |
| 3 const - 1 fixed | 1,595 [642, 2,669] | -265 [-486, -98] | 241 [157, 323] |
| 2 detox - 1 fixed | 2,591 [940, 4,492] | -182 [-400, -42] | - |
| 3 const - 2 detox | -996 [-1,889, -115] | -83 [-215, 19] | -317 [-397, -239] |
| 5 gated - 4 model (2nd half) | -68 [-316, 107] | -29 [-78, 3.34] | - |

**Does the model beat constant k? no significant difference (CI spans 0)** (LP - HODL, pool 4 - pool 3: -130 [-466, 226] USD).

Gate (brierDemoteBps 2500, minSamples 10, settler every 20 steps over the last 50 labelled blocks): models start unseasoned (k = kDefault) until the first calibration post (pool 4 at step 540, pool 5 at step 540). Pool 5 model degraded at step 3600; first post-degradation calibration above threshold at step 3760 (Brier 0.255, n=50) -> k forced to kDefault (lag 160 steps) (note: pool 5 was ALSO demoted before the degradation, i.e. the honest model failed the gate). Steps demoted: pool 4 (honest) 1880/7200, pool 5 4700/7200. End-of-run calibration (off-chain, same labelling): pool 4 {"brierBps":1819,"hitRateBps":7600,"n":50}, pool 5 {"brierBps":5958,"hitRateBps":1600,"n":50}.

Model sources (pool 4+5 scores): {"jev":180,"jev-cache":14219,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":1}; Jev API calls 181 (failures 1, p50 latency 545 ms).

## Window: volatile-highretail

2026-09-11T12:15:00.000Z + 120 min at 1s (7200 steps), price range 9.522%, TVL/pool ~$19,808,968, split=1, retail lambda=0.1/step median $1000, gas $0.5/arb tx, model=jev. Runtime 277s, 33879 txs, reverts: 0.

| pool | LP - HODL | LVR proxy (arb profit) | LP fees (from arbs / retail) | retail cost | retail cost bps | arbs | arb vol | retail vol | mean k | mean arb fee (pips) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 fixed 0.30% | -4,837 [-18,571, 6,481] | 546 [261, 878] | 5,282 [4,349, 6,262] (2,352 / 2,930) | 3,300 [2,947, 3,648] | 33.86 | 180 | 784,174 | 974,801 | - | 3000 |
| 2 detox-style k=0.7 | -1,530 [-13,790, 8,774] | 331 [108, 609] | 8,568 [6,167, 11,314] (4,312 / 4,256) | 4,938 [4,315, 5,595] | 50.74 | 91 | 431,245 | 973,193 | 7000 | 10000 |
| 3 oniblock const k=0.5 | -2,838 [-15,768, 8,032] | 240 [107, 398] | 7,291 [5,555, 9,350] (3,696 / 3,595) | 4,174 [3,700, 4,669] | 42.84 | 150 | 532,019 | 974,239 | 5000 | 6738 |
| 4 oniblock model k | -3,149 [-16,143, 7,580] | 234 [107, 386] | 6,981 [5,335, 9,006] (3,441 / 3,540) | 4,116 [3,636, 4,612] | 42.25 | 137 | 501,009 | 974,327 | 3903 | 6659 |
| 5 oniblock gated | -2,978 [-15,945, 7,917] | 244 [112, 402] | 7,153 [5,443, 9,187] (3,588 / 3,566) | 4,165 [3,685, 4,666] | 42.75 | 144 | 523,607 | 974,298 | 4452 | 6640 |

Paired differences (A - B, sum over steps, 95% CI):

| comparison | LP - HODL | LVR proxy | retail cost |
|---|---|---|---|
| **4 model - 3 const** | -312 [-581, -105] | -5.34 [-30, 16] | -57 [-116, -0.76] |
| 3 const - 1 fixed | 1,999 [1,013, 3,162] | -306 [-538, -130] | 873 [623, 1,129] |
| 2 detox - 1 fixed | 3,307 [1,529, 5,256] | -215 [-445, -68] | - |
| 3 const - 2 detox | -1,308 [-2,270, -368] | -92 [-222, 11] | -764 [-1,036, -497] |
| 5 gated - 4 model (2nd half) | 172 [2.60, 394] | 10 [-7.76, 35] | - |

**Does the model beat constant k? worse (CI < 0)** (LP - HODL, pool 4 - pool 3: -312 [-581, -105] USD).

Gate (brierDemoteBps 2500, minSamples 10, settler every 20 steps over the last 50 labelled blocks): models start unseasoned (k = kDefault) until the first calibration post (pool 4 at step 200, pool 5 at step 200). Pool 5 model degraded at step 3600; first post-degradation calibration above threshold at step 3600 (Brier 0.261, n=50) -> k forced to kDefault (lag 0 steps) (note: pool 5 was ALSO demoted before the degradation, i.e. the honest model failed the gate). Steps demoted: pool 4 (honest) 2220/7200, pool 5 4620/7200. End-of-run calibration (off-chain, same labelling): pool 4 {"brierBps":2149,"hitRateBps":7000,"n":50}, pool 5 {"brierBps":5077,"hitRateBps":3200,"n":50}.

Model sources (pool 4+5 scores): {"jev":416,"jev-cache":11532,"jev-nearest":2452,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0}; Jev API calls 416 (failures 0, p50 latency 548 ms).

## Window: calm

2026-09-13T04:45:00.000Z + 120 min at 1s (7200 steps), price range 0.215%, TVL/pool ~$20,079,841, split=1, retail lambda=0.05/step median $500, gas $0.5/arb tx, model=jev. Runtime 32s, 31339 txs, reverts: 0.

| pool | LP - HODL | LVR proxy (arb profit) | LP fees (from arbs / retail) | retail cost | retail cost bps | arbs | arb vol | retail vol | mean k | mean arb fee (pips) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 fixed 0.30% | 775 [665, 889] | 4.04 [1.18, 8.04] | 773 [677, 877] (47 / 727) | 775 [665, 888] | 32.06 | 6 | 15,564 | 241,666 | - | 3000 |
| 2 detox-style k=0.7 | 1,039 [878, 1,206] | 0.00 [0.00, 0.00] | 999 [861, 1,157] (0.00 / 999) | 1,052 [897, 1,218] | 43.59 | 0 | 0.00 | 241,434 | 7000 | - |
| 3 oniblock const k=0.5 | 961 [803, 1,123] | 0.00 [0.00, 0.00] | 921 [799, 1,054] (0.00 / 921) | 974 [821, 1,132] | 40.34 | 0 | 0.00 | 241,435 | 5000 | - |
| 4 oniblock model k | 923 [781, 1,067] | 1.27 [0.00, 3.18] | 900 [780, 1,041] (25 / 875) | 931 [790, 1,079] | 38.53 | 2 | 5,050 | 241,505 | 4225 | 4962 |
| 5 oniblock gated | 923 [781, 1,067] | 1.27 [0.00, 3.18] | 900 [780, 1,041] (25 / 875) | 931 [790, 1,079] | 38.53 | 2 | 5,050 | 241,505 | 4225 | 4962 |

Paired differences (A - B, sum over steps, 95% CI):

| comparison | LP - HODL | LVR proxy | retail cost |
|---|---|---|---|
| **4 model - 3 const** | -38 [-62, -14] | 1.27 [0.00, 3.19] | -43 [-66, -23] |
| 3 const - 1 fixed | 186 [113, 258] | -4.04 [-8.06, -1.18] | 199 [139, 265] |
| 2 detox - 1 fixed | 264 [191, 343] | -4.04 [-8.21, -0.71] | - |
| 3 const - 2 detox | -78 [-100, -59] | 0.00 [0.00, 0.00] | -78 [-101, -58] |
| 5 gated - 4 model (2nd half) | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | - |

**Does the model beat constant k? worse (CI < 0)** (LP - HODL, pool 4 - pool 3: -38 [-62, -14] USD).

Gate (brierDemoteBps 2500, minSamples 10, settler every 20 steps over the last 50 labelled blocks): models start unseasoned (k = kDefault) until the first calibration post (pool 4 at step 280, pool 5 at step 280). Pool 5 model degraded at step 3600; first post-degradation calibration above threshold at step 3600 (Brier 0.364, n=50) -> k forced to kDefault (lag 0 steps) (note: pool 5 was ALSO demoted before the degradation, i.e. the honest model failed the gate). Steps demoted: pool 4 (honest) 3960/7200, pool 5 3960/7200. End-of-run calibration (off-chain, same labelling): pool 4 {"brierBps":3099,"hitRateBps":5400,"n":50}, pool 5 {"brierBps":4175,"hitRateBps":4600,"n":50}.

Model sources (pool 4+5 scores): {"jev":0,"jev-cache":14400,"jev-nearest":0,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":0}; Jev API calls 0 (failures 0, p50 latency - ms).

## Split-swap robustness (volatile window, split=1 vs split=5)

| pool | LVR split=1 | LVR split=N | arbs / sub-swaps split=1 | split=N | mean arb fee split=1 | split=N | LP-HODL split=1 | split=N |
|---|---|---|---|---|---|---|---|---|
| 1 fixed 0.30% | 501 | 501 | 155 / 155 | 155 / 775 | 3000 | 3000 | -7,352 | -7,352 |
| 2 detox-style k=0.7 | 319 | 319 | 91 / 91 | 91 / 455 | 10000 | 10000 | -4,761 | -4,761 |
| 3 oniblock const k=0.5 | 236 | 236 | 141 / 141 | 141 / 705 | 6748 | 6748 | -5,757 | -5,757 |
| 4 oniblock model k | 243 | 256 | 124 / 124 | 121 / 605 | 6896 | 6911 | -5,862 | -5,887 |
| 5 oniblock gated | 228 | 227 | 135 / 135 | 133 / 665 | 6755 | 6757 | -5,905 | -5,954 |

Constant-k pools (1-3): splitting every arb into 5 sub-swaps in one tx leaves the arb fee, LVR and LP PnL unchanged (per-block anchor: every sub-swap pays the first sub-swap's fee). Pools 4/5 differ between the two runs only because their model inputs diverged (each run sees a different Jev cache / budget state, so a few scores differ and the k paths drift apart), not because of the split.

## Sensitivity: 2x retail rate and 2x order size (volatile-highretail)

| comparison | LP - HODL | LVR proxy | retail cost |
|---|---|---|---|
| **4 model - 3 const** | -312 [-581, -105] | -5.34 [-30, 16] | -57 [-116, -0.76] |
| 3 const - 1 fixed | 1,999 [1,013, 3,162] | -306 [-538, -130] | 873 [623, 1,129] |
| 3 const - 2 detox | -1,308 [-2,270, -368] | -92 [-222, 11] | -764 [-1,036, -497] |

## Conclusions

- **volatile** decomposition (3 const vs 1 fixed): LVR proxy lower by 265, LP fees from arbs higher by 1,444, LP fees from retail higher by 158 USD. The LP gain comes mainly from the higher fee charged to arb-direction flow (arbs, and retail that happens to trade toward the oracle), much more than from avoided LVR.
- **volatile**: LVR proxy fixed 501 vs detox 319 / const 236 / model 243 USD. LP - HODL fixed -7,352 vs const -5,757 (const - fixed better (CI > 0)). Retail cost fixed 33.43 bps vs const 43.45 bps vs detox 56.67 bps of retail volume. Model vs constant k: no significant difference (CI spans 0) (-105 [-376, 172]).
- **volatile-highretail** decomposition (3 const vs 1 fixed): LVR proxy lower by 306, LP fees from arbs higher by 1,344, LP fees from retail higher by 665 USD. The LP gain comes mainly from the higher fee charged to arb-direction flow (arbs, and retail that happens to trade toward the oracle), much more than from avoided LVR.
- **volatile-highretail**: LVR proxy fixed 546 vs detox 331 / const 240 / model 234 USD. LP - HODL fixed -4,837 vs const -2,838 (const - fixed better (CI > 0)). Retail cost fixed 33.86 bps vs const 42.84 bps vs detox 50.74 bps of retail volume. Model vs constant k: worse (CI < 0) (-312 [-581, -105]).
- **calm** decomposition (3 const vs 1 fixed): LVR proxy lower by 4.04, LP fees from arbs higher by -47, LP fees from retail higher by 194 USD. In the calm window almost no arbs happen; the gain is the gap fee paid by retail that trades toward the oracle.
- **calm**: LVR proxy fixed 4.04 vs detox 0.00 / const 0.00 / model 1.27 USD. LP - HODL fixed 775 vs const 961 (const - fixed better (CI > 0)). Retail cost fixed 32.06 bps vs const 40.34 bps vs detox 43.59 bps of retail volume. Model vs constant k: worse (CI < 0) (-38 [-62, -14]).

Charts: `chart.svg` (LP - HODL over time per pool), `chart-gate.svg` (k over time, pool 5 vs pool 4, degradation point, settler posts, demotion).
