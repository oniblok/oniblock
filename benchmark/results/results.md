# Oniblock benchmark results

Generated 2026-09-26T01:30:52.011Z - total runtime 723s. Reproduce: `pnpm -C benchmark bench`.

**Setup.** Real Binance ETHUSDT 1s klines (held-out windows, frozen in `data/windows.json`), one kline step = one price step, replayed on a fresh anvil (automine off, manual mining; each step = keeper block + trading block). Five v4 pools with identical full-range liquidity and initial price (mWETH/mUSDC): (1) hookless 0.30%; (2) Detox-style gap fee, constant k=0.7; (3) Oniblock law, constant k=0.5; (4) Oniblock law, k from the model (Jev via /v1/evaluate with quantized-state cache + bounded budget, heuristic fallback); (5) like 4 but the model is deliberately degraded (probability inverted, confidence 0.95) for the second half; the settler posts calibration every M steps and the on-chain Brier gate demotes k to kDefault. One hook instance, four pool keys (tickSpacing 10/20/30/40), each with its own PoolConfig; base fee 0.30%, feeMax 1%. Arb: rational, trades to the no-trade band edge at the hook-quoted per-block fee vs the kline mid, only if profit at mid > fixed gas. Retail: identical seeded Poisson orders on all pools (same sizes/directions).

**Model/settler mode:** label horizon 0 (markout vs the attested mid in force at the swap block), model state fee-aware (Jev/heuristic see min(base + k*gap, feeMax)).

## Before / after the INTEGRATION_1 fixes

Before = `results/before/` (settler labels vs the NEXT step mid; model state without the hook fee). After = this run (labels vs the mid in force at the swap block; fee-aware model state). Same windows, pools, arb and retail flow.

| run | 4 model - 3 const, LP-HODL (before) | (after) | honest pool-4 steps demoted (before) | (after) | degraded pool-5 steps demoted in 2nd half (before) | (after) |
|---|---|---|---|---|---|---|
| volatile | -105 [-376, 172] | -510 [-903, -133] | 2520/7200 | 1440/7200 | 3480/3600 | 3460/3600 |
| volatile-split5 | -130 [-466, 226] | -629 [-1,099, -182] | 1880/7200 | 960/7200 | 3440/3600 | 3500/3600 |
| volatile-highretail | -312 [-581, -105] | -553 [-959, -177] | 2220/7200 | 1220/7200 | 3600/3600 | 3560/3600 |
| calm | -38 [-62, -14] | -113 [-148, -81] | 3960/7200 | 0/7200 | 3600/3600 | 3480/3600 |

**Metrics** (USD, marked to the kline mid): LP-HODL = LP position value incl. uncollected fees minus value of the initial deposit held; LVR proxy = sum of arb profit at mid (before gas); LP fees = fee growth accrued; retail cost = paid - received at mid (fees + price impact; negative = retail gained, e.g. trading against a stale pool price). Brackets are 95% circular block-bootstrap CIs over steps (block length ~ sqrt(N)); they capture within-path noise only, not across-path/regime uncertainty.

## Window: volatile

2026-09-11T12:15:00.000Z + 120 min at 1s (7200 steps), price range 9.522%, TVL/pool ~$19,808,968, split=1, retail lambda=0.05/step median $500, gas $0.5/arb tx, model=jev. Runtime 393s, 31965 txs, reverts: 0.

| pool | LP - HODL | LVR proxy (arb profit) | LP fees (from arbs / retail) | retail cost | retail cost bps | arbs | arb vol | retail vol | mean k | mean arb fee (pips) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 fixed 0.30% | -7,352 [-21,076, 3,942] | 501 [223, 837] | 2,818 [1,959, 3,784] (2,091 / 727) | 808 [701, 920] | 33.43 | 155 | 697,144 | 241,762 | - | 3000 |
| 2 detox-style k=0.7 | -4,761 [-16,768, 5,568] | 319 [102, 590] | 5,372 [3,215, 7,971] (4,237 / 1,135) | 1,367 [1,136, 1,595] | 56.67 | 91 | 423,662 | 241,163 | 7000 | 10000 |
| 3 oniblock const k=0.5 | -5,757 [-18,585, 5,113] | 236 [104, 392] | 4,419 [2,844, 6,363] (3,535 / 884) | 1,049 [894, 1,213] | 43.45 | 141 | 506,698 | 241,485 | 5000 | 6748 |
| 4 oniblock model k | -6,267 [-19,455, 4,769] | 240 [123, 380] | 3,909 [2,551, 5,559] (3,099 / 810) | 947 [820, 1,081] | 39.2 | 139 | 527,966 | 241,644 | 3251 | 5678 |
| 5 oniblock gated | -5,951 [-18,832, 5,005] | 252 [119, 410] | 4,225 [2,668, 6,114] (3,391 / 833) | 982 [850, 1,122] | 40.63 | 136 | 516,234 | 241,626 | 4250 | 6334 |

Paired differences (A - B, sum over steps, 95% CI):

| comparison | LP - HODL | LVR proxy | retail cost |
|---|---|---|---|
| **4 model - 3 const** | -510 [-903, -133] | 4.29 [-44, 44] | -102 [-157, -49] |
| 3 const - 1 fixed | 1,595 [642, 2,669] | -265 [-486, -98] | 241 [157, 323] |
| 2 detox - 1 fixed | 2,591 [940, 4,492] | -182 [-400, -42] | - |
| 3 const - 2 detox | -996 [-1,889, -115] | -83 [-215, 19] | -317 [-397, -239] |
| 5 gated - 4 model (2nd half) | 315 [83, 608] | 13 [-19, 56] | - |

**Does the model beat constant k? worse (CI < 0)** (LP - HODL, pool 4 - pool 3: -510 [-903, -133] USD).

Gate (brierDemoteBps 2500, minSamples 10, settler every 20 steps over the last 50 labelled blocks): models start unseasoned (k = kDefault) until the first calibration post (pool 4 at step 540, pool 5 at step 540). Pool 5 model degraded at step 3600; first post-degradation calibration above threshold at step 3740 (Brier 0.271, n=50) -> k forced to kDefault (lag 140 steps) (note: pool 5 was ALSO demoted before the degradation, i.e. the honest model failed the gate). Steps demoted: pool 4 (honest) 1440/7200, pool 5 4160/7200. End-of-run calibration (off-chain, same labelling): pool 4 {"brierBps":2403,"hitRateBps":6600,"n":50}, pool 5 {"brierBps":6716,"hitRateBps":400,"n":50}.

Model sources (pool 4+5 scores): {"jev":600,"jev-cache":6186,"jev-nearest":6498,"heuristic":0,"heuristic-paced":1116,"heuristic-jev-failed":0}; Jev API calls 600 (failures 0, p50 latency 557 ms).

## Window: volatile-split5

2026-09-11T12:15:00.000Z + 120 min at 1s (7200 steps), price range 9.522%, TVL/pool ~$19,808,968, split=5, retail lambda=0.05/step median $500, gas $0.5/arb tx, model=jev. Runtime 37s, 31970 txs, reverts: 0.

| pool | LP - HODL | LVR proxy (arb profit) | LP fees (from arbs / retail) | retail cost | retail cost bps | arbs | arb vol | retail vol | mean k | mean arb fee (pips) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 fixed 0.30% | -7,352 [-21,076, 3,942] | 501 [223, 837] | 2,818 [1,959, 3,784] (2,091 / 727) | 808 [701, 920] | 33.43 | 155 | 697,144 | 241,762 | - | 3000 |
| 2 detox-style k=0.7 | -4,761 [-16,768, 5,568] | 319 [102, 590] | 5,372 [3,215, 7,971] (4,237 / 1,135) | 1,367 [1,136, 1,595] | 56.67 | 91 | 423,662 | 241,163 | 7000 | 10000 |
| 3 oniblock const k=0.5 | -5,757 [-18,585, 5,113] | 236 [104, 392] | 4,419 [2,844, 6,363] (3,535 / 884) | 1,049 [894, 1,213] | 43.45 | 141 | 506,698 | 241,485 | 5000 | 6748 |
| 4 oniblock model k | -6,386 [-19,496, 4,436] | 222 [115, 360] | 3,792 [2,442, 5,539] (2,988 / 804) | 945 [813, 1,083] | 39.1 | 141 | 508,377 | 241,617 | 3070 | 5652 |
| 5 oniblock gated | -5,968 [-18,805, 4,966] | 244 [116, 398] | 4,209 [2,656, 6,107] (3,380 / 829) | 973 [840, 1,111] | 40.27 | 139 | 514,730 | 241,610 | 4103 | 6297 |

Paired differences (A - B, sum over steps, 95% CI):

| comparison | LP - HODL | LVR proxy | retail cost |
|---|---|---|---|
| **4 model - 3 const** | -629 [-1,099, -182] | -13 [-69, 33] | -105 [-153, -58] |
| 3 const - 1 fixed | 1,595 [642, 2,669] | -265 [-486, -98] | 241 [157, 323] |
| 2 detox - 1 fixed | 2,591 [940, 4,492] | -182 [-400, -42] | - |
| 3 const - 2 detox | -996 [-1,889, -115] | -83 [-215, 19] | -317 [-397, -239] |
| 5 gated - 4 model (2nd half) | 418 [122, 785] | 22 [-19, 76] | - |

**Does the model beat constant k? worse (CI < 0)** (LP - HODL, pool 4 - pool 3: -629 [-1,099, -182] USD).

Gate (brierDemoteBps 2500, minSamples 10, settler every 20 steps over the last 50 labelled blocks): models start unseasoned (k = kDefault) until the first calibration post (pool 4 at step 540, pool 5 at step 540). Pool 5 model degraded at step 3600; first post-degradation calibration above threshold at step 3700 (Brier 0.260, n=50) -> k forced to kDefault (lag 100 steps) (note: pool 5 was ALSO demoted before the degradation, i.e. the honest model failed the gate). Steps demoted: pool 4 (honest) 960/7200, pool 5 3840/7200. End-of-run calibration (off-chain, same labelling): pool 4 {"brierBps":2547,"hitRateBps":6400,"n":50}, pool 5 {"brierBps":6894,"hitRateBps":0,"n":50}.

Model sources (pool 4+5 scores): {"jev":0,"jev-cache":7335,"jev-nearest":6804,"heuristic":0,"heuristic-paced":261,"heuristic-jev-failed":0}; Jev API calls 0 (failures 0, p50 latency - ms).

## Window: volatile-highretail

2026-09-11T12:15:00.000Z + 120 min at 1s (7200 steps), price range 9.522%, TVL/pool ~$19,808,968, split=1, retail lambda=0.1/step median $1000, gas $0.5/arb tx, model=jev. Runtime 38s, 33928 txs, reverts: 0.

| pool | LP - HODL | LVR proxy (arb profit) | LP fees (from arbs / retail) | retail cost | retail cost bps | arbs | arb vol | retail vol | mean k | mean arb fee (pips) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 fixed 0.30% | -4,837 [-18,571, 6,481] | 546 [261, 878] | 5,282 [4,349, 6,262] (2,352 / 2,930) | 3,300 [2,947, 3,648] | 33.86 | 180 | 784,174 | 974,801 | - | 3000 |
| 2 detox-style k=0.7 | -1,530 [-13,790, 8,774] | 331 [108, 609] | 8,568 [6,167, 11,314] (4,312 / 4,256) | 4,938 [4,315, 5,595] | 50.74 | 91 | 431,245 | 973,193 | 7000 | 10000 |
| 3 oniblock const k=0.5 | -2,838 [-15,768, 8,032] | 240 [107, 398] | 7,291 [5,555, 9,350] (3,696 / 3,595) | 4,174 [3,700, 4,669] | 42.84 | 150 | 532,019 | 974,239 | 5000 | 6738 |
| 4 oniblock model k | -3,391 [-16,396, 7,458] | 268 [138, 417] | 6,735 [5,200, 8,543] (3,463 / 3,273) | 3,788 [3,362, 4,233] | 38.88 | 166 | 595,264 | 974,421 | 3055 | 5524 |
| 5 oniblock gated | -2,946 [-15,880, 7,985] | 272 [132, 433] | 7,180 [5,479, 9,215] (3,758 / 3,421) | 3,971 [3,529, 4,438] | 40.75 | 164 | 586,995 | 974,375 | 4089 | 6158 |

Paired differences (A - B, sum over steps, 95% CI):

| comparison | LP - HODL | LVR proxy | retail cost |
|---|---|---|---|
| **4 model - 3 const** | -553 [-959, -177] | 28 [-17, 81] | -385 [-503, -270] |
| 3 const - 1 fixed | 1,999 [1,013, 3,162] | -306 [-538, -130] | 873 [623, 1,129] |
| 2 detox - 1 fixed | 3,307 [1,529, 5,256] | -215 [-445, -68] | - |
| 3 const - 2 detox | -1,308 [-2,270, -368] | -92 [-222, 11] | -764 [-1,036, -497] |
| 5 gated - 4 model (2nd half) | 445 [195, 738] | 3.99 [-19, 34] | - |

**Does the model beat constant k? worse (CI < 0)** (LP - HODL, pool 4 - pool 3: -553 [-959, -177] USD).

Gate (brierDemoteBps 2500, minSamples 10, settler every 20 steps over the last 50 labelled blocks): models start unseasoned (k = kDefault) until the first calibration post (pool 4 at step 200, pool 5 at step 200). Pool 5 model degraded at step 3600; first post-degradation calibration above threshold at step 3640 (Brier 0.264, n=50) -> k forced to kDefault (lag 40 steps) (note: pool 5 was ALSO demoted before the degradation, i.e. the honest model failed the gate). Steps demoted: pool 4 (honest) 1220/7200, pool 5 4200/7200. End-of-run calibration (off-chain, same labelling): pool 4 {"brierBps":2649,"hitRateBps":6400,"n":50}, pool 5 {"brierBps":6932,"hitRateBps":200,"n":50}.

Model sources (pool 4+5 scores): {"jev":0,"jev-cache":2959,"jev-nearest":11302,"heuristic":0,"heuristic-paced":139,"heuristic-jev-failed":0}; Jev API calls 0 (failures 0, p50 latency - ms).

## Window: calm

2026-09-13T04:45:00.000Z + 120 min at 1s (7200 steps), price range 0.215%, TVL/pool ~$20,079,841, split=1, retail lambda=0.05/step median $500, gas $0.5/arb tx, model=jev. Runtime 254s, 31341 txs, reverts: 0.

| pool | LP - HODL | LVR proxy (arb profit) | LP fees (from arbs / retail) | retail cost | retail cost bps | arbs | arb vol | retail vol | mean k | mean arb fee (pips) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 fixed 0.30% | 775 [665, 889] | 4.04 [1.18, 8.04] | 773 [677, 877] (47 / 727) | 775 [665, 888] | 32.06 | 6 | 15,564 | 241,666 | - | 3000 |
| 2 detox-style k=0.7 | 1,039 [878, 1,206] | 0.00 [0.00, 0.00] | 999 [861, 1,157] (0.00 / 999) | 1,052 [897, 1,218] | 43.59 | 0 | 0.00 | 241,434 | 7000 | - |
| 3 oniblock const k=0.5 | 961 [803, 1,123] | 0.00 [0.00, 0.00] | 921 [799, 1,054] (0.00 / 921) | 974 [821, 1,132] | 40.34 | 0 | 0.00 | 241,435 | 5000 | - |
| 4 oniblock model k | 848 [713, 984] | 1.69 [0.00, 3.97] | 831 [723, 950] (31 / 801) | 854 [722, 991] | 35.37 | 3 | 7,138 | 241,537 | 2531 | 4280 |
| 5 oniblock gated | 889 [754, 1,025] | 1.69 [0.00, 3.97] | 873 [759, 997] (31 / 842) | 896 [763, 1,033] | 37.1 | 3 | 7,138 | 241,537 | 3868 | 4280 |

Paired differences (A - B, sum over steps, 95% CI):

| comparison | LP - HODL | LVR proxy | retail cost |
|---|---|---|---|
| **4 model - 3 const** | -113 [-148, -81] | 1.69 [0.00, 3.97] | -120 [-153, -91] |
| 3 const - 1 fixed | 186 [113, 258] | -4.04 [-8.06, -1.18] | 199 [139, 265] |
| 2 detox - 1 fixed | 264 [191, 343] | -4.04 [-8.21, -0.71] | - |
| 3 const - 2 detox | -78 [-100, -59] | 0.00 [0.00, 0.00] | -78 [-101, -58] |
| 5 gated - 4 model (2nd half) | 42 [30, 55] | 0.00 [0.00, 0.00] | - |

**Does the model beat constant k? worse (CI < 0)** (LP - HODL, pool 4 - pool 3: -113 [-148, -81] USD).

Gate (brierDemoteBps 2500, minSamples 10, settler every 20 steps over the last 50 labelled blocks): models start unseasoned (k = kDefault) until the first calibration post (pool 4 at step 280, pool 5 at step 280). Pool 5 model degraded at step 3600; first post-degradation calibration above threshold at step 3720 (Brier 0.259, n=50) -> k forced to kDefault (lag 120 steps). Steps demoted: pool 4 (honest) 0/7200, pool 5 3480/7200. End-of-run calibration (off-chain, same labelling): pool 4 {"brierBps":126,"hitRateBps":10000,"n":50}, pool 5 {"brierBps":7876,"hitRateBps":0,"n":50}.

Model sources (pool 4+5 scores): {"jev":376,"jev-cache":13977,"jev-nearest":46,"heuristic":0,"heuristic-paced":0,"heuristic-jev-failed":1}; Jev API calls 377 (failures 1, p50 latency 557 ms).

## Split-swap robustness (volatile window, split=1 vs split=5)

| pool | LVR split=1 | LVR split=N | arbs / sub-swaps split=1 | split=N | mean arb fee split=1 | split=N | LP-HODL split=1 | split=N |
|---|---|---|---|---|---|---|---|---|
| 1 fixed 0.30% | 501 | 501 | 155 / 155 | 155 / 775 | 3000 | 3000 | -7,352 | -7,352 |
| 2 detox-style k=0.7 | 319 | 319 | 91 / 91 | 91 / 455 | 10000 | 10000 | -4,761 | -4,761 |
| 3 oniblock const k=0.5 | 236 | 236 | 141 / 141 | 141 / 705 | 6748 | 6748 | -5,757 | -5,757 |
| 4 oniblock model k | 240 | 222 | 139 / 139 | 141 / 705 | 5678 | 5652 | -6,267 | -6,386 |
| 5 oniblock gated | 252 | 244 | 136 / 136 | 139 / 695 | 6334 | 6297 | -5,951 | -5,968 |

Constant-k pools (1-3): splitting every arb into 5 sub-swaps in one tx leaves the arb fee, LVR and LP PnL unchanged (per-block anchor: every sub-swap pays the first sub-swap's fee). Pools 4/5 differ between the two runs only because their model inputs diverged (each run sees a different Jev cache / budget state, so a few scores differ and the k paths drift apart), not because of the split.

## Sensitivity: 2x retail rate and 2x order size (volatile-highretail)

| comparison | LP - HODL | LVR proxy | retail cost |
|---|---|---|---|
| **4 model - 3 const** | -553 [-959, -177] | 28 [-17, 81] | -385 [-503, -270] |
| 3 const - 1 fixed | 1,999 [1,013, 3,162] | -306 [-538, -130] | 873 [623, 1,129] |
| 3 const - 2 detox | -1,308 [-2,270, -368] | -92 [-222, 11] | -764 [-1,036, -497] |

## Conclusions

- **volatile** model vs const: the model sets mean k 3251 (const 5000); LP - HODL -510 [-903, -133], retail cost -102 [-157, -49], LVR 4.29 [-44, 44]. A lower k moves value from LPs to retail (a cheaper fee toward the mid) without reducing LVR.
- **volatile-highretail** model vs const: the model sets mean k 3055 (const 5000); LP - HODL -553 [-959, -177], retail cost -385 [-503, -270], LVR 28 [-17, 81]. A lower k moves value from LPs to retail (a cheaper fee toward the mid) without reducing LVR.
- **calm** model vs const: the model sets mean k 2531 (const 5000); LP - HODL -113 [-148, -81], retail cost -120 [-153, -91], LVR 1.69 [0.00, 3.97]. A lower k moves value from LPs to retail (a cheaper fee toward the mid) without reducing LVR.
- **volatile** decomposition (3 const vs 1 fixed): LVR proxy lower by 265, LP fees from arbs higher by 1,444, LP fees from retail higher by 158 USD. The LP gain comes mainly from the higher fee charged to arb-direction flow (arbs, and retail that happens to trade toward the oracle), much more than from avoided LVR.
- **volatile**: LVR proxy fixed 501 vs detox 319 / const 236 / model 240 USD. LP - HODL fixed -7,352 vs const -5,757 (const - fixed better (CI > 0)). Retail cost fixed 33.43 bps vs const 43.45 bps vs detox 56.67 bps of retail volume. Model vs constant k: worse (CI < 0) (-510 [-903, -133]).
- **volatile-highretail** decomposition (3 const vs 1 fixed): LVR proxy lower by 306, LP fees from arbs higher by 1,344, LP fees from retail higher by 665 USD. The LP gain comes mainly from the higher fee charged to arb-direction flow (arbs, and retail that happens to trade toward the oracle), much more than from avoided LVR.
- **volatile-highretail**: LVR proxy fixed 546 vs detox 331 / const 240 / model 268 USD. LP - HODL fixed -4,837 vs const -2,838 (const - fixed better (CI > 0)). Retail cost fixed 33.86 bps vs const 42.84 bps vs detox 50.74 bps of retail volume. Model vs constant k: worse (CI < 0) (-553 [-959, -177]).
- **calm** decomposition (3 const vs 1 fixed): LVR proxy lower by 4.04, LP fees from arbs higher by -47, LP fees from retail higher by 194 USD. The LP gain comes mainly from the higher fee charged to arb-direction flow (arbs, and retail that happens to trade toward the oracle), much more than from avoided LVR.
- **calm**: LVR proxy fixed 4.04 vs detox 0.00 / const 0.00 / model 1.69 USD. LP - HODL fixed 775 vs const 961 (const - fixed better (CI > 0)). Retail cost fixed 32.06 bps vs const 40.34 bps vs detox 43.59 bps of retail volume. Model vs constant k: worse (CI < 0) (-113 [-148, -81]).

Charts: `chart.svg` (LP - HODL over time per pool), `chart-gate.svg` (k over time, pool 5 vs pool 4, degradation point, settler posts, demotion).
