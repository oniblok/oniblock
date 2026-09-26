# kev08b-v1 — Kev-0.8B fine-tune for Oniblock `informed` question

**This adapter is oniblock1, the production model** (until Kev v2 replaces the weights): ENS model node
`oniblock1.models.oniblock.eth`, the node the keeper posts under with `MODEL_MODE=oniblock1` (`services/src/model/kev.ts`),
served by `ml/serve/start-kev.sh`, state text `KEV_STATE_FORMAT=auto`. Charge gate 0.8175 (`charge_threshold.json`: chosen on
`val_1k`, temperature-corrected, FPR <= 5%; on the held-out `test_3k` it gives FPR 6.2%, pass 77.3%). It was registered as
`kev-v1` before; `kev08b-v1` is only this results folder's name. Produced by following `ml/train_kev4b/README.md`,
"⚡ Fast path: Kev-0.8B in about 1 hour" (Steps 1–7 with the 0.8B flag substitutions).

## Model hash (this is what goes into ENS as `model-hash`)

```
24f0793d55e0fde516ebe4da1d187e0468a5f7c830ba9a9f4d48e43f007c88be
```

sha256 of `SHA256` (the sorted per-file digest list, README Step 6). Component files:

```
999a96b5390e036a251e63b3fd329b71f4d05d840fafbdbeebf6b16b7abd939c  ./adapter_model.safetensors
036a703cfac533a19bf1e6c2438bc294b7e5f66e3bad4ce5548a436b92152c39  ./head.pt
```

`score_kev.py --adapter` independently recomputed the same hash.

## Machine and cost

| | |
|---|---|
| Machine | Apple M5 Pro, 48 GB unified memory, macOS 26.6.2 |
| Device | `mps`, compute dtype fp32 (`--weights_dtype bf16` for the frozen backbone) |
| Training wall time | 2158 s (36.0 min), 375 optimizer steps, 5.75 s/step median |
| Peak device memory | 1.92 GB (peak RSS 2.00 GB) |
| Trainable params | 11.3 M (LoRA r=16, all targets, + pointer head) |
| Base / init | `Qwen/Qwen3.5-0.8B-Base` / `jaredpalmer/kev-0.8b` (372 LoRA tensors + head loaded) |
| kev revision | github.com/jaredpalmer/kev @ main, torch 2.8.0, transformers 5.17.0 |

## Results

`test_3k.jsonl` was read exactly once, after the temperature was fitted on `val_1k.jsonl`.
Brier / ECE / AUC below are `score_kev.py` output (binary Brier, the same definition as the
README baseline table). Brackets are bootstrap 95% CIs.

| model | split | n | acc | Brier ↓ | ECE ↓ | AUC ↑ | skill vs train base rate |
|---|---|---|---|---|---|---|---|
| **kev08b-v1 (fine-tuned)** | **test_3k** | 3000 | **0.6813** | **0.2115** [0.2049, 0.2183] | **0.0407** [0.0288, 0.0580] | **0.6994** [0.6804, 0.7189] | **+0.1195** |
| kev08b-v1 (fine-tuned) | val_1k | 1000 | 0.6910 | 0.2074 [0.1955, 0.2189] | 0.0625 [0.0409, 0.0918] | 0.7396 [0.7091, 0.7716] | +0.1706 |
| `jaredpalmer/kev-0.8b` zero-shot | test_3k | 3000 | 0.5697 | 0.2465 [0.2449, 0.2481] | 0.0764 [0.0605, 0.0949] | 0.5106 [0.4893, 0.5320] | −0.0261 |

### Head-to-head against hosted Jev (added after the initial run)

`typesafe-ai/jev` via the Vercel AI Gateway (`/v1/evaluate`), scored on the same 3,000
`test_3k.jsonl` records, asked the **dataset's own `informed` question with the instructions
and criteria strings verbatim** — only the type name is mapped `noul` → `boolean`, which is
Jev's protocol for a yes/no probability. 3000/3000 answered, zero errors.

| model | acc | Brier ↓ | ECE ↓ | AUC ↑ | skill vs base rate | latency |
|---|---|---|---|---|---|---|
| **kev08b-v1 (ours)** | **0.6813** | **0.2115** [0.2049, 0.2183] | **0.0407** [0.0288, 0.0580] | **0.6994** [0.6804, 0.7189] | **+0.1195** | 13.5 ms local |
| Jev, raw | 0.5397 | 0.3053 [0.2954, 0.3145] | 0.2516 [0.2342, 0.2700] | 0.6047 [0.5836, 0.6242] | −0.2711 | 383 ms network |
| Jev, + calibration fitted on val_1k | 0.5717 | 0.2324 [0.2279, 0.2369] | 0.0471 [0.0342, 0.0649] | 0.6047 | +0.0324 | 383 ms network |

**kev08b-v1 beats hosted Jev on every metric, and the AUC and Brier CIs do not overlap.**

- **Jev has real but weaker ranking signal**: AUC 0.605 vs our 0.699. The intervals are
  disjoint, so this is not sampling noise.
- **Raw Jev is badly miscalibrated on this label definition** — ECE 0.252, and a Brier of
  0.3053 that is *worse than always guessing the base rate* (0.2381). Cause is visible in the
  reliability table: Jev's mean prediction is **0.347** against an actual base rate of
  **0.599**. It systematically under-predicts by ~25 points. When it says 0.17 the truth is
  0.52; when it says 0.74 the truth is 0.785 — the top of its range is fine, the bottom is not.
- **This is a distribution mismatch, not incompetence.** The dead-band filter drops ~70% of
  blocks as indecisive, which lifts "informed" from ≈37% of all blocks to ≈60% of the kept
  ones. Jev is calibrated for the unfiltered world and was never told about the filter.
- **So Jev was given the same courtesy as our checkpoint.** kev08b-v1 got a temperature fitted
  on `val_1k`; Jev got a two-parameter logit calibration `sigmoid(a·logit(p)+b)`, a=0.5910,
  b=0.6688, fitted on Jev's own `val_1k` predictions and applied to test. That fixes the
  calibration (ECE 0.252 → 0.047) and the Brier (0.3053 → 0.2324), but **cannot fix the
  ranking** — AUC is unchanged at 0.605 by construction, and even calibrated, Jev's Brier skill
  over the base rate is only +3.2% against our +11.9%.
- **Latency**: 383 ms median over the network vs 13.5 ms for our adapter served locally by MLX,
  a ~28× difference, with no API key, no per-call cost and no external dependency in the keeper's
  block budget.

Reproduce: `jev_score.py` (queries Jev, emits kev-benchmark-shaped `rows.json`/`report.json`)
and `jev_calibrate.py` (fits the val calibration) in `ml/models/jev-eval/`. The API key is read from
`AI_GATEWAY_API_KEY` and is never written to disk. The stored Jev rows contain only
predictions and labels — no dataset state text.

Reference baselines from the README (full test split, same label definition):

| model | test Brier | test AUC | test ECE |
|---|---|---|---|
| base rate (no model) | 0.2381 | 0.500 | 0.015 |
| project heuristic | 0.2267 | 0.698 | 0.117 |
| logistic regression | 0.2070 | 0.712 | 0.032 |
| LightGBM | **0.2008** | **0.724** | **0.018** |

### Reading of the numbers

- **The fine-tune is doing the work.** The released `kev-0.8b` is at chance on this question
  (AUC 0.511, CI straddles 0.50) and its Brier (0.2465) is *worse* than always predicting the
  base rate. After 36 minutes the adapter reaches AUC 0.699 and Brier 0.2115, a Brier skill of
  +11.9% over the training base rate. The CIs on AUC do not overlap.
- **It does not beat LightGBM.** Test Brier 0.2115 vs 0.2008, and ECE 0.0407 vs 0.0180. It lands
  about level with logistic regression (0.2070) and clearly ahead of the project heuristic on
  calibration. Reported as-is, per the README's "a negative result is still a result".
- **Calibration misses the < 0.03 ECE bar.** Test ECE is 0.0407 with CI [0.0288, 0.0580], so the
  miss is real and not just sampling noise. Temperature 1.12 was fitted on `val_1k` rows via
  `scripts/calibrate_checkpoint.py --allow-in-distribution`; the script warns that a temperature
  fitted on the checkpoint's own training distribution is not held out, which is the most likely
  cause. A pooled out-of-domain fit, or simply more training, is the obvious next step.
- Note the val figures were benchmarked *before* the temperature was written, so val ECE (0.0625)
  is the uncalibrated number; test ECE (0.0407) is post-temperature. Val and test also have
  different base rates (0.547 vs 0.599), so cross-split comparison is loose.

## Serving latency (Step 5)

`kev.serve --run runs/oniblock-kev08b --port 8009`, MLX backend (bfloat16) on MPS, one
`test_3k.jsonl` record posted to `/v1/systemone`:

| | latency_ms |
|---|---|
| first (cold) request | 2653 |
| warm requests (5 consecutive) | 27.9, 13.4, 13.5, 13.6, 14.8 → **~13.5 ms median** |

Response shape confirmed: `"answers": {"informed": {"type": "noul", "noul": 0.3203}}`.
Well inside the keeper's ~12 s per-block budget on Sepolia. (The `latency_ms` recorded in the
benchmark folders is ~198 ms — that is the batch-scoring path, not the MLX serving path.)

## What differs from the README commands

- Followed the **0.8B fast path**, so throughout Steps 2–7: `--base Qwen/Qwen3.5-0.8B-Base`,
  `--init_from jaredpalmer/kev-0.8b`, `--out runs/oniblock-kev08b`, zero-shot
  `--run jaredpalmer/kev-0.8b`, results under `ml/models/kev08b-v1`.
- **No `--dtype bf16`** (Mac; the trainer rejects it without `--device cuda`). `--device mps`,
  default fp32 autocast. Kept `--weights_dtype bf16 --checkpointing 1` — both worked on MPS.
- **`--epochs 1 --max_steps 375`.** The smoke test measured 0.774 s/record ⇒ ~6.4 s/optimizer
  step at `--accum 8`, so N = floor(2400 / 6.4) = 375 per the fast-path table. Realized speed was
  slightly better (5.75 s/step), so the run took 36.0 min rather than the budgeted 40.
- **Trained on `data/train_20k.jsonl`.** At 375 steps × 8 records, the run saw **3,000 of the
  20,000 records (15%)** — a partial first pass, not one full epoch. This is the single biggest
  lever left: the same recipe with the full 20k, or 2 epochs of the full 26,925-record
  `train.jsonl`, is untested here and would be the first thing to try with more time.
- **Evaluated on the small files only** (`val_1k.jsonl`, `test_3k.jsonl`) as the fast path
  directs. `val.jsonl` and `test.jsonl` were never read; nothing was shuffled across files; the
  `instructions`/`criteria` strings were not modified.
- Benchmarks were run with `--device mps`; each `--out` was a fresh folder.

## Contents

```
adapter/                  LoRA adapter + pointer head + training_config.json + training_metrics.json
eval/val/                 kev.benchmark on val_1k.jsonl (pre-temperature) + oniblock_metrics.json
eval/test/                kev.benchmark on test_3k.jsonl (post-temperature, single read)
eval/zeroshot-test/       kev.benchmark on test_3k.jsonl with untouched jaredpalmer/kev-0.8b
charge_threshold.json     the keeper's CHARGE_THRESHOLD=auto fallback (KEV_THRESHOLD_FILE)
SHA256                    per-file digests (Step 6)
../jev-eval/              the hosted-Jev comparison (jev-test, jev-test-calibrated, jev-val, jev_score.py, jev_calibrate.py)
```
