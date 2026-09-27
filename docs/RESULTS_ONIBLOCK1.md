# Results: No hook vs Jev vs oniblock1

Two measurements: (1) how well each model picks the blocks to charge, on held-out mainnet blocks; (2) what LPs earn against a vanilla pool in the mainnet-block benchmark. The rows were measured under different conditions, so each row states its own.

**Status.** oniblock1's weights today are **Kev v1**. **Kev v2 is training to replace them**: it reads a fresh (about 2 s old) Binance price instead of an 11 s-old one, and is distilled from the teacher LightGBM (section 1, last part). Every oniblock1 number below is Kev v1's. The mainnet-block benchmark in section 2 was run with the teacher, not with oniblock1, and will be re-run with Kev v2.

## What oniblock1 is

- **Model.** A TypeSafe System One LLM decision model. The keeper sends the block's state as text (the gap between the pool and Binance, the base fee, the edge over the base fee, flow, volatility) with one typed `noul` question, "is this block's arbitrage-direction flow informed?", and gets back P(true). The weights are Kev v1: a LoRA fine-tune (r = 16, 11.3 M trainable parameters) of `jaredpalmer/kev-0.8b` on `Qwen/Qwen3.5-0.8B-Base`, trained for 36 min on an Apple M5 Pro. Details: `ml/models/kev08b-v1/NOTE.md`.
- **Trained on the v1 data.** The state text states the base fee, and the Binance price in it is about 11 s old at the block. The keeper must send the same wording (`KEV_STATE_FORMAT=auto`, the default).
- **Calibration.** Served at temperature T = 1.1225, fitted on `val_1k`. The test predictions are post-temperature; the validation predictions were stored before the temperature was fitted, so the gate below is chosen on validation with T applied.
- **Identity.** It posts under `oniblock1.models.oniblock.eth`. The ENS `model-hash` is the SHA-256 of the adapter's per-file digest list `ml/models/kev08b-v1/SHA256`: `24f0793d55e0fde516ebe4da1d187e0468a5f7c830ba9a9f4d48e43f007c88be`.
- **Serving.** `ml/serve/start-kev.sh` starts Kev's own System One server (`POST /v1/systemone`), which the keeper calls with `MODEL_MODE=oniblock1`. It answers in about 13.5 ms per block once warm (MLX on Apple silicon). Hosted Jev takes about 383 ms per call over the network (median `latency_ms` in `ml/models/jev-eval/jev-test/report.json`).

## 1. Which blocks get charged (held-out mainnet blocks)

**Rule.** The hook charges a premium on a block iff the model's p is at or above the threshold t (the charge gate). Below t, k = 0 and the pool behaves exactly like a vanilla pool.

**Metrics, in plain terms.**
- **Blocks charged (coverage):** the share of all blocks that pay a premium.
- **Pass rate:** of the blocks we charged, the share that really were toxic. This measures how often a premium is deserved.
- **FPR:** of all benign blocks, the share we charged anyway. This measures how often honest flow is overcharged.
- **Toxic caught (TPR):** of all toxic blocks, the share we charged.
- **AUC:** how well p ranks toxic above benign blocks, independent of any threshold. 0.5 is chance and 1.0 is perfect.
- **Target:** pass rate ≥ 75% and FPR < 7%.

**Data.** Real mainnet Uniswap v3 USDC/WETH blocks (0.05% and 0.30% pools), test split Sep 15–25 2026. The split is time-ordered after train (Jul 31 – Sep 2) and validation (Sep 2–15), and was never used for any choice. Labels use the dead band, the same label the on-chain settler grades: a block is toxic iff its arb-direction markout against Binance at the base fee is above max($1, 1 bp of arb volume). Blocks inside the band are not graded, so the metrics cover decisive blocks only. The common subset is `test_3k` (3,000 blocks, 1,203 benign), the set both Jev and Kev v1 were scored on, from the same state text with the same 11 s-old price. The gate is chosen on `val_1k` (1,000 blocks, 453 benign).

**CIs.** 95% day-block bootstrap intervals: whole test days are resampled (1,000 draws). test_3k spans 11 days, so the intervals are wide-ish and themselves approximate.

**Test_3k (3,000 blocks, toxic base rate 59.9%):**

| model | conditions | blocks charged | pass rate | FPR | toxic caught | AUC |
|---|---|---|---|---|---|---|
| No hook | vanilla pool; never charges a premium | 0% | — | 0% | 0% | — |
| Jev as deployed | hosted TypeSafe Jev, Binance price 11 s old, k = 0.8·p (premium on every block) | 100% | 59.9% | 100% | 100% | 0.605 |
| Jev + charge gate | Jev with a logit calibration fitted on validation, charged iff p > 0.7682 (validation FPR ≤ 5%), price 11 s old | 13.8% | 81.1% [76.9, 84.6] | 6.5% [5.2, 8.2] | 18.6% [16.7, 20.3] | 0.605 |
| **oniblock1 = Kev v1** | System One LLM (Kev-0.8B LoRA), Binance price 11 s old, charge gate 0.8175 (validation FPR ≤ 5%) | **10.9%** | **77.3% [74.0, 81.2]** | **6.2% [4.9, 7.2]** | **14.0% [12.8, 15.3]** | **0.699** |
| oniblock1 = Kev v1, rolling gate | as above, gate re-picked each test day on the trailing 7 days (thin windows, see below) | 8.6% | 76.7% [72.3, 81.4] | 5.0% [3.7, 6.1] | 11.0% [9.3, 12.6] | 0.699 |

**Against the target (pass ≥ 75%, FPR < 7%).**
- **Fixed gate 0.8175: meets both on the point estimates, not clear of either line.** 77.3% pass and 6.2% FPR, but the FPR interval reaches 7.2% and the pass interval starts at 74.0%. In counts: 326 blocks charged, 252 of them toxic; 74 of 1,203 benign blocks charged.
- **Rolling gate: FPR clearly under 7%** (5.0%, interval up to 6.1%) and 76.7% pass, at the cost of charging fewer blocks (8.6%) and catching fewer toxic ones (11.0%).
- **Low coverage is the price of the stale price.** Kev v1 charges about one block in nine and catches one toxic block in seven. With an 11 s-old Binance price there is little to rank on: a LightGBM on the same 11 s data reaches only AUC 0.724 on the dead-band test split (baseline table in `ml/train_kev4b/README.md`), against 0.936 for the same kind of model on a 2 s-old price (the teacher below). That gap is why Kev v2 is trained on the fresh price.

**Against Jev.** Kev v1 ranks blocks better (AUC 0.699 against 0.605; the 95% CIs, [0.680, 0.719] and [0.584, 0.624], do not overlap), runs locally in about 13.5 ms instead of 383 ms, and its weights are pinned by hash in ENS. At the gated operating point, however, Jev + gate is not worse: pass rate and FPR intervals overlap Kev v1's, and Jev + gate catches more toxic blocks (18.6% against 14.0%, intervals disjoint). On the selective metric Kev v1 does not beat a gated Jev.

**How the fixed gate was chosen.** On `val_1k` with the temperature applied, the gate charges 22 of 453 benign blocks (4.86%, the most allowed under 5%). Any t in (0.81606, 0.81882] charges the same 22 validation blocks; across that range test_3k gives 76.6–77.9% pass and 6.0–6.4% FPR, so the choice of 0.8175 inside it does not move the reading. Using the validation predictions without the temperature picks a different threshold, which does not transfer to the post-temperature test scores.

**Rolling gate.** Each test day's gate is the lowest value that keeps FPR ≤ 5% on the trailing 7 days of labelled blocks available before that day: `val_1k` plus the earlier `test_3k` days. It never sees the day it scores; a window with fewer than 100 benign labels falls back to the fixed gate (none did). Because only the 1k/3k scored subsets exist, the windows hold 235–846 benign labels (546–2,007 blocks), so the daily gates (0.818–0.826) are noisy and this row is indicative. The live settler computes the same kind of rolling gate over every graded block (`CHARGE_THRESHOLD=auto`).

### Teacher model (used to generate Kev v2's soft targets; not deployed)

LightGBM gradient-boosted trees (216 trees) over 17 per-block pool and Binance features, trained with the Binance features read about 2 s before the block (`build_v2.py --query-lag 3`). File: `ml/models/teacher-lightgbm.json` (it was `ml/models/oniblock1.json` before oniblock1 became the LLM). Its probabilities are the soft targets Kev v2 is distilled from, and it shows what a fresh price makes possible. It never posts on-chain and has no ENS name.

| split | threshold | blocks charged | pass rate | FPR | toxic caught | AUC |
|---|---|---|---|---|---|---|
| test_3k (2 s-old price) | rolling 7-day, FPR ≤ 5% | 45.2% | 95.1% [93.8, 96.5] | 5.6% [4.1, 6.8] | 71.7% [68.4, 74.9] | 0.929 |
| full test, 12,837 blocks | rolling 7-day, FPR ≤ 5% | 46.5% | 95.4% [94.2, 96.6] | 5.5% [4.2, 6.8] | 72.7% [70.6, 74.6] | 0.936 |
| full test, 12,837 blocks | fixed 0.8224 (its JSON `chargeThreshold`) | 51.3% | 94.4% | 7.4% | 79.4% | 0.936 |

The teacher's windows use every labelled validation and test block (not the 1k/3k subsets), so its rolling rows are not thin. Its conditions differ from Kev v1's (2 s-old price, tabular features), so the rows are not a like-for-like comparison with the table above.

**Sources.**
- Numbers: `ml/models/selective_results.json`, written by `ml/src/eval_selective.py`.
- Kev v1 predictions: `ml/models/kev08b-v1/eval/test/rows.json` (test_3k, post-temperature) and `eval/val/rows.json` (val_1k, pre-temperature). Row order = `ml/train_kev4b/data/v2/test_3k_keys.parquet` / `val_1k_keys.parquet` (pool, block, ts), which gives each row its day.
- Jev predictions: `ml/models/jev-eval/jev-test`, `jev-test-calibrated` and `jev-val`.
- Teacher inputs: `ml/train_kev4b/data/v2-fresh/tabular_features.parquet` and `test_3k_keys.parquet`.

## 2. LP result against a vanilla pool (mainnet-block benchmark, teacher model)

**These runs used the teacher LightGBM, not oniblock1 (Kev v1).** They measure what a fresh-price model and the keeper's position in the block are worth to LPs, and will be re-run with Kev v2. Kev v1 and Jev were not run in the mainnet-block benchmark.

Source: `benchmark/results_v4/coop-builder/results.md` (`benchmark/src/v4/coop4.ts`; the saved runs name the teacher by its old name `oniblock1`).

**Setup.**
- Real Binance ETHUSDT 1 s klines, replayed as 12 s blocks.
- Each hooked pool competes with a vanilla neighbour (same tier, same liquidity, $20M each) for the same routed retail and the same two arbitrageurs.
- 6 one-hour windows: the 3 most volatile and 3 calm hours of Jul 28 – Sep 26 2026 (`benchmark/data/windows_v2.json`).
- Results are per hour, net of keeper gas at 1 gwei, before any payment to the builder, with 95% Student-t intervals over the 6 windows (3 of them are calm hours at ≈ −0.01 to −0.02 bps/h, so a bootstrap over 6 windows would be too narrow).
- The benchmark hours (Aug 1 – Sep 11) fall inside the teacher's train and validation dates, so section 1, not this section, is the out-of-sample test of a model.
- The hook has no probation: an allowlisted model sets k from its first attestation and is demoted to the base fee only while its posted Brier score is above 0.25. It was never demoted in these runs.

| pool | conditions | 0.05% tier, net LP − HODL vs vanilla | 0.30% tier, net LP − HODL vs vanilla |
|---|---|---|---|
| No hook | the vanilla neighbour (baseline) | 0 | 0 |
| Jev | — | not run in the mainnet-block benchmark | not run in the mainnet-block benchmark |
| oniblock1 (Kev v1) | — | not run yet (to be re-run with Kev v2) | not run yet (to be re-run with Kev v2) |
| **teacher (LightGBM)** | keeper posts first in the block, Binance price 2 s old, charge gate at the fixed 0.8224, post-on-change | **+0.507 bps/h [−0.213, 1.227] ≈ +$1,014/h**, positive in 3/3 volatile windows | **+0.289 bps/h [−0.142, 0.720] ≈ +$578/h**, positive in 3/3 volatile windows |

**By regime.** All of the gain comes in the volatile hours.

| tier | volatile net bps/h | calm net bps/h |
|---|---|---|
| 0.05% | +1.032 (windows +1.638, +1.003, +0.454) | −0.018 (−0.017, −0.019, −0.017) |
| 0.30% | +0.588 (windows +0.978, +0.195, +0.590) | −0.010 (all three) |

In calm hours the premium is almost never charged. The pool loses the keeper's gas (about 0.007 bps/h), and at 0.05% about 0.01 bps/h more of gross LP result, with a lower retail share (36–41% instead of about 50%).

**Keeper first vs no builder deal** (the same teacher, paired by window). Without a builder deal (arm R in the report) the keeper's post lands last in the previous block, so the Binance price is 13 s old at the block it prices: 11 s older than the price the teacher was trained on, which is part of what this comparison measures. There the teacher earns +0.037 bps/h [−0.045, 0.119] ≈ +$74/h at 0.05% and +0.160 [−0.049, 0.368] ≈ +$320/h at 0.30%, positive in 3/3 volatile windows at both tiers. Keeper first minus no deal, before any payment to the builder: +0.470 bps/h [−0.170, 1.110] at 0.05% (positive in 3/3 volatile windows) and +0.129 [−0.158, 0.417] at 0.30% (positive in 2/3 volatile windows). A heuristic scorer at the same timing earns about the same (teacher minus heuristic, paired by window: −0.025 [−0.061, 0.012] at 0.05%, positive in 0/3 volatile windows; +0.016 [−0.024, 0.055] at 0.30%, positive in 1/3 volatile windows), so the LP gain comes from the fresh price and first position; the teacher's contribution is precision. The break-even payment to the builder, the most the LPs could pay for first position every block before the pool stops beating vanilla, is $3.38 [−1.42, 8.18] per block at 0.05% and $1.93 [−0.94, 4.80] at 0.30%.

**Retail.**
- 0.05% tier: retail pays 4.9 bps on the teacher's pool against 6.2 bps on the vanilla pool, with a 36.5% retail share.
- 0.30% tier: retail pays 28.3 bps against 31.0 bps, with a 43.3% share.

**On the sim's own graded blocks** (0.05% tier), the teacher passes 99.4% with 5.3% FPR, and 98.6% with 0.5% FPR on the 0.30% tier.

## Reproduce

```bash
# section 1: writes ml/models/selective_results.json from the stored predictions (needs pandas, numpy, scikit-learn, pyarrow)
cd ml/src && python eval_selective.py
shasum -a 256 ../models/kev08b-v1/SHA256            # = oniblock1's ENS model-hash
# teacher: data (Binance features read 3 s before the block, price ~2 s old) and model
python build_v2.py --query-lag 3 --out ../train_kev4b/data/v2-fresh
python train_tabular_v2.py                          # writes ml/models/teacher-lightgbm.json
# section 2, teacher runs (add --tier 500 for the 0.05% tier), then rebuild results.md
pnpm -C benchmark exec tsx src/v4/coop4.ts --run coop
pnpm -C benchmark exec tsx src/v4/coop4.ts --run realistic
pnpm -C benchmark exec tsx src/v4/coop4.ts --report-only
```

The Kev v1 predictions were produced by `kev.benchmark` (`ml/train_kev4b/README.md`, 0.8B fast path) and are stored in the repo. The Jev predictions were produced by `ml/models/jev-eval/jev_score.py` (needs `AI_GATEWAY_API_KEY`) and `jev_calibrate.py`, and are stored in the repo.
