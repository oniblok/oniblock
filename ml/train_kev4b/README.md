# Fine-tune Kev-4B for Oniblock — instructions for the training machine

Written for: a person (or a coding agent such as Claude Code) on an Apple Silicon Mac with ≥32 GB unified memory, or a machine with an NVIDIA GPU. No knowledge of the Oniblock project is needed. Follow the steps in order. Every step has a check.

## What you are training, and why

Oniblock is a Uniswap v4 hook (ETHGlobal Tokyo 2026). Every block, an off-chain "keeper" asks a small AI model one yes/no question about the pool:

> "Is this block's arbitrage-direction flow **informed**?" — i.e. will the swaps that push the pool price toward the Binance price make money against Binance after paying the pool fee (which means they are taking money from the liquidity providers)?

The model answers with a **probability** (e.g. 0.82). The hook turns that probability into how aggressively it charges arbitrage trades. Every prediction is later graded against what actually happened, the grade is published in ENS, and a model that predicts worse than chance is demoted automatically. So the model's **calibration** (a 0.8 should come true about 80% of the time) matters as much as its accuracy.

Today the keeper uses TypeSafe's hosted **Jev**. **Kev** is the open-weight, Apache-2.0 model family that implements the same API. You are fine-tuning **Kev-4B** on ~27,000 real, decisively-labelled Uniswap blocks (filtered from 87,000; see "About the labels" below) so that:

1. it answers this specific question better than Jev and better than simple baselines, and
2. its weights are open, so their hash can be published in ENS and anyone can verify which model made each decision.

Baselines to beat, measured on the same held-out test set with the same labels (Brier score; lower is better; 0.2381 = always guessing the base rate):

| model | test Brier | test AUC | test ECE |
|---|---|---|---|
| base rate (no model) | 0.2381 | 0.500 | 0.015 |
| project heuristic | 0.2267 | 0.698 | 0.117 (badly calibrated) |
| logistic regression | 0.2070 | 0.712 | 0.032 |
| LightGBM | **0.2008** | **0.724** | **0.018** |

A useful Kev-4B lands at or below ~0.20 Brier with good calibration (ECE < 0.03). Report whatever you get honestly; a negative result is still a result.

**About the labels.** A block is *informed* only when the arbitrage-direction swaps made **more than max($1, 1 bp of their volume)** against Binance after the fee, and *benign* only when they lost more than that. Blocks in between (about 70% of all blocks — tiny amounts decided by price noise) were removed from every split, so the model learns from decisive outcomes and is scored on decisive outcomes. That is why "informed" is the majority class here (≈60%) even though it is ≈37% of all blocks.

## What you received

**If you cloned the Oniblock repo:** the data files are shipped as a zip to keep the repo small. Unpack them first:

```bash
cd <repo>/ml && unzip -o train_kev4b.zip      # recreates ml/train_kev4b/data/*.jsonl
```

A folder (or zip) with this layout:

```
train_kev4b/
  README.md                ← this file
  data/
    train.jsonl            ← 26,925 labelled records (Jul 31 – Sep 2, 2026)
    val.jsonl              ← 11,842 records (Sep 2 – Sep 15)  → use for tuning / temperature
    test.jsonl             ← 12,837 records (Sep 15 – Sep 25) → touch ONCE, at the very end
    train_20k.jsonl        ← 20,000-record subset of train.jsonl for a faster first run
    val_1k.jsonl, test_3k.jsonl ← small subsets for smoke tests
  DATA_CARD.md             ← dataset documentation (source, label definition, limitations)
  score_kev.py             ← numpy-only scorer: turns a benchmark output folder into our standard metrics file
```

Each JSONL line is one request in Kev's native training format: a text `state` (what the keeper could see *before* the block) and one `noul` (yes/no) question with its `label`:

```json
{"state": "Uniswap v4 ETH/USDC pool, per-block regime snapshot (past data only).\nprice_gap: pool price is above the Binance mid by 0.034% (343 pips); base swap fee 0.05%.\narb_edge: gap minus base fee = -0.016% ...",
 "questions": {"informed": {"type": "noul",
   "instructions": "Is this block's arbitrage-direction flow informed, i.e. will the swaps that move the pool toward the Binance mid be profitable against the Binance mid at swap time after paying the pool fee?",
   "criteria": {"true": "informed / toxic: ...", "false": "benign: ..."},
   "label": false}}}
```

The `state` contains only information available before the block. There is nothing to leak. **Do not edit the `instructions`/`criteria` text**: the production keeper sends exactly these strings, so the model must be trained on them.

The splits are strictly ordered in time. **Never shuffle records across files**, and never train on `val.jsonl`/`test.jsonl`.

## ⏱ Time-boxed plan: you have 3–4 hours total

Follow this schedule instead of the full runs below. It uses the subsets and stops training on a clock.

| Clock | Do | Files |
|---|---|---|
| 0:00–0:25 | Step 1 (install, downloads). Needs a fast connection: the base model is 9.3 GB. | — |
| 0:25–0:35 | Step 2 smoke test (20 steps). **Write down the seconds per optimizer step** it prints/logs. | `train_20k.jsonl` |
| 0:35–2:35 | Step 3, but with `--epochs 1 --max_steps N` where **N = floor(7200 ÷ seconds-per-step)** (e.g. 4 s/step → `--max_steps 1800`). Each optimizer step = 8 records. Stop there even if the file isn't finished. | `train_20k.jsonl` |
| 2:35–2:50 | Step 4 using the **small** files: benchmark on `val_1k.jsonl` → calibrate → benchmark once on `test_3k.jsonl` | `val_1k`, `test_3k` |
| 2:50–3:05 | Zero-shot `jaredpalmer/kev-4b` benchmark on `test_3k.jsonl` (shows the fine-tune gain) | `test_3k` |
| 3:05–3:20 | `score_kev.py` on the three folders, Step 5 latency, Step 6 hash + zip | — |
| rest | Buffer. If time remains, nothing else — send the zip. | |

Why the small eval files: scoring a 4B model on the full 12.8k-row test split takes a long time by itself. 3,000 test rows give ±2% confidence intervals, which is enough. The full files are included only in case the machine is free overnight.

If the downloads alone take more than ~40 minutes, stop and tell us — the connection is too slow for this session.

## ⚡ Fast path: Kev-0.8B in about 1 hour

If you don't have 3–4 hours, train **Kev-0.8B** instead. Everything in this guide stays the same except the two model flags, the output folder name, and a smaller training budget. It runs on any Apple Silicon Mac (16 GB is enough).

| Clock | Do |
|---|---|
| 0:00–0:10 | Step 1 (install). Base model is only 1.8 GB. |
| 0:10–0:15 | Smoke test (Step 2) with the flags below. Note the seconds per optimizer step. |
| 0:15–0:55 | Training on `train_20k.jsonl` with `--epochs 1 --max_steps N`, **N = floor(2400 ÷ seconds-per-step)** (~40 min). |
| 0:55–1:05 | Step 4 on `val_1k.jsonl` → calibrate → `test_3k.jsonl` once; zero-shot `jaredpalmer/kev-0.8b` on `test_3k.jsonl`. |
| 1:05–1:15 | `score_kev.py`, latency (Step 5), hash + zip (Step 6). |

Flag substitutions everywhere in Steps 2–6:

| 4B (default in this guide) | 0.8B |
|---|---|
| `--base Qwen/Qwen3.5-4B-Base` | `--base Qwen/Qwen3.5-0.8B-Base` |
| `--init_from jaredpalmer/kev-4b` | `--init_from jaredpalmer/kev-0.8b` |
| `--out runs/oniblock-kev4b` | `--out runs/oniblock-kev08b` |
| zero-shot `--run jaredpalmer/kev-4b` | `--run jaredpalmer/kev-0.8b` |
| result zip `oniblock-kev4b-result.zip` | `oniblock-kev08b-result.zip` |

`--weights_dtype bf16` and `--checkpointing 1` are harmless on 0.8B but not needed. The ENS model node for this adapter is `kev-v1` (4B is `kev4b-v1`). Expect a weaker starting point than 4B; the point is a real, open, hash-verifiable model — report the numbers as they are.

## Requirements

- macOS on Apple Silicon with **≥32 GB** unified memory (Kev-4B in bf16), or Linux with an NVIDIA GPU (≥24 GB; an L40S/H100 is comfortable).
- ~30 GB free disk (base model Qwen3.5-4B ≈ 8 GB, adapters, checkpoints).
- Python 3.12 or 3.13 and [uv](https://docs.astral.sh/uv/) (`curl -LsSf https://astral.sh/uv/install.sh | sh`).
- Internet access for the first run (downloads `Qwen/Qwen3.5-4B-Base` and the `jaredpalmer/kev-4b` adapter from Hugging Face).
- Run **one** training job at a time on a Mac. Close other GPU-heavy apps.

## Step 1 — Get Kev

```bash
git clone https://github.com/jaredpalmer/kev.git
cd kev
uv sync --extra serve
```

Check: `uv run python -c "import kev, torch; print(torch.__version__)"` prints a version.

Put the data next to the repo (adjust the path if you unzipped elsewhere):

```bash
export DATA=~/train_kev4b/data     # folder containing train.jsonl etc.
ls $DATA
```

## Step 2 — Smoke test (5–10 minutes)

Prove the pipeline works before spending hours. This trains from the released Kev-4B for a handful of steps on the small subset.

**Apple Silicon (MPS):**

```bash
uv run python -m kev.train \
  --data $DATA/train_20k.jsonl \
  --base Qwen/Qwen3.5-4B-Base --init_from jaredpalmer/kev-4b \
  --epochs 1 --max_steps 20 --lr 2e-5 --batch 1 --accum 8 \
  --weights_dtype bf16 --checkpointing 1 \
  --device mps \
  --out runs/smoke
```

**Linux / NVIDIA (CUDA):** same command but replace `--device mps` with `--device cuda` and add `--dtype bf16`.

- Do **not** pass `--dtype bf16` on a Mac: Kev's trainer only accepts it with `--device cuda` (it errors with "--dtype bf16 requires --device cuda"). On MPS the default fp32 autocast is used and that is fine.
- `--weights_dtype bf16` stores the frozen 4B backbone in bf16 to halve its memory. If that flag errors on MPS, drop it (training then needs more memory — a 64 GB Mac is comfortable; on 32 GB add `--max_state 512`).
- If you see an MPS out-of-memory error: make sure nothing else is training; add `--max_state 512` (our states are ~150 tokens, so this is safe); as a last resort use `--lora_targets attn`.

Check: `runs/smoke/` exists and contains adapter weights and `training_config.json`. Then:

```bash
uv run python -m kev.benchmark --run runs/smoke --data $DATA/val_1k.jsonl --out runs/smoke-eval
```

Check: it prints accuracy, Brier and calibration for the `informed` question. Numbers will be poor after 20 steps; that's fine.

## Step 3 — Full fine-tune

Start from the released Kev-4B (`--init_from`) so the model keeps what it already knows. Use the full training set. Two epochs at `lr 2e-5` is Kev's recommended delta-training recipe.

**Apple Silicon (MPS):**

```bash
uv run python -m kev.train \
  --data $DATA/train.jsonl \
  --base Qwen/Qwen3.5-4B-Base --init_from jaredpalmer/kev-4b \
  --epochs 2 --lr 2e-5 --batch 1 --accum 8 \
  --weights_dtype bf16 --checkpointing 1 \
  --device mps \
  --out runs/oniblock-kev4b
```

**CUDA:** replace `--device mps` with `--device cuda` and add `--dtype bf16`.

Rough time: 26,925 records × 2 epochs ≈ 6,700 optimizer steps at `--accum 8`. The smoke test tells you the seconds per step; multiply. On an M-series Mac with 32–64 GB expect a few hours; on an H100 well under an hour. If time is short, follow the time-boxed plan at the top (`train_20k.jsonl` + `--max_steps`).

Tip: run it inside `tmux` or `nohup ... &` so a closed laptop lid doesn't kill it. Log to a file: append `2>&1 | tee runs/oniblock-kev4b.log`.

Check: training finishes without error; `runs/oniblock-kev4b/training_config.json` records `init_from: jaredpalmer/kev-4b`.

## Step 4 — Calibrate and evaluate

Kev checkpoints carry a temperature fitted on held-out data so that probabilities are honest. Fit/verify it on **validation**, then read **test once**:

```bash
# validation: use this to choose between runs / check calibration
uv run python -m kev.benchmark --run runs/oniblock-kev4b --data $DATA/val.jsonl  --out runs/oniblock-kev4b-val

# test: run exactly once, after you have stopped changing anything
uv run python -m kev.benchmark --run runs/oniblock-kev4b --data $DATA/test.jsonl --out runs/oniblock-kev4b-test
```

Also benchmark the **untouched** released model on the same test file, so we can show the gain from fine-tuning:

```bash
uv run python -m kev.benchmark --run jaredpalmer/kev-4b --data $DATA/test.jsonl --out runs/kev4b-zeroshot-test
```

Fit the temperature on the **validation** benchmark's rows, then re-run the test benchmark once. (The script refuses "in-distribution" rows by default; our validation split is the same distribution as training, so the flag is required.)

```bash
uv run python scripts/calibrate_checkpoint.py \
  --run runs/oniblock-kev4b \
  --rows runs/oniblock-kev4b-val/rows.json \
  --allow-in-distribution

uv run python -m kev.benchmark --run runs/oniblock-kev4b --data $DATA/test.jsonl --out runs/oniblock-kev4b-test
```

If `calibrate_checkpoint.py` reports different flag names, run it with `--help` and use the equivalents; the intent is: temperature from validation rows, test read once afterwards.

Each `--out` folder will contain `predictions.jsonl`, `rows.json` and `report.json`. **Every `--out` must be a folder that does not exist yet** — re-running into the same folder fails; pick a new name (e.g. `-test2`).

Then produce our standard metrics file for each benchmark folder (Brier, log loss, ECE with reliability table, AUC, Brier skill vs the training base rate, bootstrap 95% CIs, latency — and, with `--adapter`, the ENS model hash):

```bash
python ~/train_kev4b/score_kev.py runs/oniblock-kev4b-test --adapter runs/oniblock-kev4b
python ~/train_kev4b/score_kev.py runs/oniblock-kev4b-val
python ~/train_kev4b/score_kev.py runs/kev4b-zeroshot-test
```

Each call writes `oniblock_metrics.json` inside that folder. (`score_kev.py` needs only Python 3 + numpy: `pip install numpy` if missing.)

## Step 5 — Serve it and measure latency

```bash
uv run --extra serve python -m kev.serve --run runs/oniblock-kev4b --port 8009
```

In another terminal:

```bash
curl -s localhost:8009/v1/systemone -H 'content-type: application/json' -d "$(head -1 $DATA/test_3k.jsonl | python3 -c 'import json,sys; r=json.load(sys.stdin); [q.pop("label",None) for q in r["questions"].values()]; r["model"]="kev-latest"; print(json.dumps(r))')"
```

Check: the response contains `"answers": {"informed": {"type": "noul", "noul": <probability>}}` and a `latency_ms`. Note the latency (the keeper has ~12 s per block on Sepolia, so anything under ~2 s is fine). On Apple Silicon the server uses MLX automatically.

## Step 6 — Hash the weights (for ENS) and package the result

```bash
cd runs/oniblock-kev4b
# hash every adapter/head weight file in a stable order
find . -type f \( -name '*.safetensors' -o -name '*.bin' -o -name '*.pt' \) | sort | xargs shasum -a 256 | tee ../oniblock-kev4b.SHA256
shasum -a 256 ../oniblock-kev4b.SHA256          # ← this single hash is the "model hash" we publish in ENS
cd ../..
```

Then zip and send back:

```bash
zip -r oniblock-kev4b-result.zip \
  runs/oniblock-kev4b runs/oniblock-kev4b-val runs/oniblock-kev4b-test runs/kev4b-zeroshot-test \
  runs/oniblock-kev4b.SHA256 runs/oniblock-kev4b.log
```

## What to send back

1. `oniblock-kev4b-result.zip` (adapter weights + eval outputs incl. each `oniblock_metrics.json` + hash + log).
2. A short note with:
   - machine (chip, memory), total training time, peak memory if known;
   - val and **test** metrics for the fine-tuned model and for zero-shot `jaredpalmer/kev-4b` (accuracy, Brier, ECE);
   - serving latency per request;
   - the single model hash line;
   - anything you changed from the commands above (flags, subset used, epochs).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `torch` has no wheel / Python 3.14 | Use Python 3.12/3.13 (`uv python install 3.13`, then `uv sync --extra serve`) |
| `--dtype bf16 requires --device cuda` | You are on a Mac: remove `--dtype bf16` (keep `--weights_dtype bf16`) |
| MPS out of memory | One job only; `--weights_dtype bf16`; `--max_state 512`; `--lora_targets attn`; last resort: `--accum 16 --batch 1` |
| Very slow on Mac | Expected for 4B; use `train_20k.jsonl`, or `--max_steps 4000` and report that |
| Hugging Face download fails | `huggingface-cli login` is not required for these public repos; check network; retry |
| `--init_from` refuses to load | Make sure `--base Qwen/Qwen3.5-4B-Base` exactly (the trainer checks base, LoRA rank 16 and head size match the released checkpoint) |
| Benchmark complains about labels | Only the `informed` question exists; do not modify instructions/criteria strings |
| `kev.benchmark` fails because `--out` exists | It refuses to overwrite; use a fresh folder name |

## Do not

- Do not train on `val.jsonl` or `test.jsonl`, and do not shuffle across splits.
- Do not change the question text.
- Do not upload the data or the resulting adapter anywhere public yet — the team will publish the dataset and model hash together.

Thank you. If anything is unclear, send the exact error text and the command that produced it.
