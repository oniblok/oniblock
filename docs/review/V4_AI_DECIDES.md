# V4 build: the AI decides the fee (no hard-coded threshold)

> Note (later change): the `minSamples` probation ("unseasoned") described in this historic document has since been removed from the hook; the calibration gate is now the pool allowlist + Brier demotion only, and a model with no calibration record is active.

Date: 2026-09-26. Follows `V3_THRESHOLD_BUILD.md` and the v3 review (`V3_REVIEW.md`). User intent: **Jev is called on every block and itself decides whether, and how much, extra fee to charge.** No hard-coded gap threshold gates the model.

Mechanism (config only, no contract change): `fee = base + k·gap` (arb direction, capped) with `arbThresholdPips = 0` and `k = kMin + (kMax − kMin)·p·c` where `kMin = 0`, `kDefault = 0`, `kMax = 0.8`, `maxKStep = kMax`. A "calm / no profitable arbitrage" judgement (p ≈ 0) gives k ≈ 0, i.e. **exactly the base fee, identical to a vanilla pool**; a "toxic arbitrage" judgement gives a high k, applied from the next block. An unseasoned or demoted model gets `kDefault = 0`: **no trusted AI ⇒ vanilla pool.**

## CONCLUSION

<!-- V4-CONCLUSION -->
(benchmark running at the time of writing — filled in below when `benchmark/results_v4/results.md` is generated)
<!-- /V4-CONCLUSION -->

## 1. Contract: nothing changed, the v4 config is accepted and tested

`contracts/src/OniblockHook.sol` is untouched (the v3 reviewer was reviewing it concurrently). `_validateConfig` already accepts `kMinBps = 0`, `kDefaultBps = 0` (`kDefault ≥ kMin`) and `arbThresholdPips = 0`; `kFromScore` is `kMin + (kMax − kMin)·p·c / 1e8`, so with kMin 0 and kMax 8000: p = 0 → k = 0; the calm Jev answer (p 0.03, c 0.30) → k = 72 bps (0.0072); the toxic answer (p 0.93, c 0.70) → k = 5208 bps. No dead-zone parameter was added: the v4 prompt makes calm answers land at k ≈ 0.006–0.012 (§3), which adds ~0.002% to a 0.20% gap — indistinguishable from vanilla — so a contract change is not needed. The "dead-zone on p·c" idea was kept as an exploratory, keeper-emulated benchmark arm (f) so the numbers exist if anyone wants to propose it (§8).

New `contracts/test/V4AiDecides.t.sol` (5 tests) applies the v4 config through `updatePoolConfig` and checks:
- the config is accepted; `kFromScore` gives 0 / 72 / 5208 for p·c = 0 / calm / toxic;
- p = 0 pays **exactly base in both directions**, quote == executed, Receipt k = 0;
- k follows the model within one block, up (0 → 5208, fee = base + k·gap) and back down to base on the next attestation (step 8000);
- an unseasoned node and a demoted node (Brier 0.40) have no power: fee = base;
- fuzz over (p, c, gap): quote == `min(base + gap·(8000·p·c/1e8)/1e4, feeMax)`, and p = 0 or c = 0 ⇒ base.

Evidence: `forge test` — **106 passed, 0 failed, 1 skipped** (the offline fork test), including the 11 v3 ThresholdLaw tests and the 3 review3 invariants.

## 2. Defaults

| where | field | v3 | **v4** |
|---|---|---|---|
| `DeployBase.s.sol` (`DeployLocal`, `DeploySepolia`) | `ARB_THRESHOLD_PIPS` | base + 300 | **0** |
| | `K_MIN_BPS` / `K_DEFAULT_BPS` / `K_MAX_BPS` | 2000 / 5000 / 8000 | **0 / 0 / 8000** |
| | `MAX_K_STEP_BPS` | 1000 | **8000** (= kMax − kMin: one attestation can move k anywhere) |
| | allowlist | jev-v1, heuristic-v1, rule-v1 | jev-v1, heuristic-v1; **rule-v1 only with `KEEPER_GATE=1`** (F-11) |
| `services` keeper | `KEEPER_GATE` | 1 | **0** (Jev every block; 1 = the v3 rule-v1 gate, comparison only) |
| | `JEV_PROMPT` | – | **v4** (`v1` restores the old question + state) |
| `services` settler | `SETTLER_LABEL_FEE` | (paid) | **base** (§4) |
| `EnsSetup.s.sol` | text records | | jev-v1 `agent-context` says "asked every block … k = kMax·p·c, p near 0 = base fee"; rule-v1 says "v3 gate only"; header lists the v4 pool config. Not broadcast. |
| `scripts/demo-local.sh` | | | exports `KEEPER_GATE=0`; story text updated; `DEMO_RUNTIME_DIR` / `DEMO_DEPLOYMENTS_FILE` let a headless check run next to the live demo on 8545 |

All are env-overridable; a v3-style pool is still `ARB_THRESHOLD_PIPS=3300 K_MIN_BPS=2000 K_DEFAULT_BPS=5000 MAX_K_STEP_BPS=1000 KEEPER_GATE=1`.

**Never combine the gate with kDefault = 0.** rule-v1 is never graded, so every rule post is "unseasoned" and resets k to kDefault; with kDefault 0 the gate would switch the fee law off on every quiet block and make the model's k restart from 0. `keeper.ts assertGateConfig` throws on `KEEPER_GATE=1` + `poolConfig.kDefaultBps = 0`, both at startup (`checkConfig`, CLI exits 1 with `fatal_config`) and on every tick (tested in `keeper-gate.test.ts`).

## 3. Jev is fee-aware and asked every block (`services/src/model/jev.ts`, `features.ts`)

**Question (`JEV_QUESTIONS_V4.toxic`).** "Should this pool charge an extra arbitrage fee on the next block? Answer true only if there is profitable, informed arbitrage: the pool price is stale versus the Binance mid by MORE than the base fee (`arb_edge_at_base_fee` positive) … The extra fee is proportional to your probability. If `arb_edge_at_base_fee` is zero or negative there is no profitable arbitrage: the probability must be near 0, because an extra fee would only push ordinary traders to other pools." The regime head (informed / dump / unknown) is unchanged and still carries Jev's confidence.

**State (`featuresToState(f, { format: 'v4' })`).** Deliberately **k-free**: it states the gap, the base fee, `arb_edge_at_base_fee = gap − base` with the words "arbitrage IS profitable at the base fee" / "NO profitable arbitrage at the base fee", then the v1 flow / size / volatility / oracle-age lines. The v1–v3 state put the edge against the fee at the *current* k, which would feed the model's own decision back into its input under v4 (high k → edge < 0 → "calm" → k = 0 → edge > 0 → "toxic" → …). `features.test.ts` checks the v4 text is identical for k = 0 and k = 0.8.

**Compatibility.** `JEV_QUESTIONS_V1` and the v1 state are byte-identical to before, and v4 answers are cached under a namespaced key (`[jev-prompt:v4]\n…`), so the frozen v1–v3 benchmark caches (`benchmark/data/jev-cache.json`, 15,754 v1 entries) are still valid and were never reused for v4. `score()` / `scoreWithJev()` take `prompt: 'v1' | 'v4'` (default `defaultJevPrompt()` = env `JEV_PROMPT`, v4). `jev.test.ts` checks the default question, the cache namespacing and that the request body carries the selected question set.

**Does "calm" reach ~0?** Sweep with the v4 prompt (`pnpm -C services jev:probe:v4`, 18 live calls; full table in `docs/JEV_NOTES.md`):

| gap | edge at base | p | c | p·c → k = 0.8·p·c |
|---|---|---|---|---|
| 0–0.29% | ≤ 0 | 0.03–0.04 | 0.25–0.70 | 0.008–0.021 → **k 0.006–0.017** |
| 0.33% | +0.03% | 0.91–0.93 | 0.66–0.68 | 0.61 → k 0.49 |
| 0.40–1.20% | +0.10 … +0.90% | 0.92–0.96 | 0.68–0.78 | 0.63–0.75 → k 0.50–0.60 |

Under the old prompt the v1–v3 cache shows calm answers of p 0.10–0.15 with c ≈ 0.40 (p·c ≈ 0.05 → k ≈ 0.04, i.e. +0.008% on a 0.20% gap); so the prompt change alone takes calm to ~0 and no contract-side dead-zone is required. Jev's answer is dominated by gap vs base fee; volatility and flow move p·c by a few points.

## 4. Services

**Keeper (`keeper.ts`).** `KEEPER_GATE` default 0: no `gateDecision`, no rule-v1 post; Jev (v4 prompt) every tick with heuristic fallback under heuristic-v1 as before (F-12: a fallback post from an unseasoned heuristic-v1 is a k = kDefault = 0 block; it recovers on the next Jev post thanks to the full-range step; `FALLBACK_SAME_NODE=1` is still available but misattributes and is not used). `poolConfig` cache: still refreshed every 100 blocks, and now **dropped immediately when a `PoolConfigUpdated` for the pool appears in the receipt scan range** (`pool_config_updated` log; the ABI gained the event) (F-6). Startup/tick assertion for gate + kDefault 0 (§2). Start log shows `gate` and `jevPrompt`.

**Settler (`settler.ts`).** New `SETTLER_LABEL_FEE=base` (default): a block is "informed" iff its arb-direction flow was profitable **at the base fee** (gross markout > Σ|input|·baseFee), which is exactly the v4 question. Grading against the fee actually paid (`paid`, the pre-v4 rule) would punish a model for protecting LPs: a high k makes the remaining arb-direction flow unprofitable net of the fee it paid, so a *good* "toxic" call would be labelled 0. `labelBlocks` takes `{ labelFee, baseFeePips }`; the base fee is read from `hook.poolConfig` (deployment JSON fallback). Tested in `settler.test.ts` (a swap that paid 0.80% and lost net is still informed at the base fee). **Dead band (coordinator finding, folded in after the benchmark runs started).** 59% of real blocks have |markout| < $1, so a sign-only label is decided by mid noise and the gate grades coin flips. With `m` = the block's markout net of the label fee and `T = max(SETTLER_DEADBAND_USD, SETTLER_DEADBAND_BPS/1e4 · arb-direction USD volume)` (defaults **$1 / 1 bp**; `0/0` = old behaviour): `y = 1` iff `m > T`, `y = 0` iff `m < −T`, `|m| ≤ T` is **not graded** and counted as `skippedAmbiguous` (logged on every `calibration_set`, and in `nothing_labelled`). USD conversion via `usdPerRawToken1(meta, mid)` (quote = mUSDC; both token orders, tested). Same rule as the fine-tuning export (`ml/src/kev_export_deadband.py`), so the model and the gate agree. `labelBlocks` tests cover ambiguous / informed / benign / bps-scaled T / no-USD-conversion cases. The v4 benchmark (§6) had already started with sign-only labels; `run4.ts` has `--deadband-usd/--deadband-bps` (default 0/0 so `bench:v4` reproduces `results_v4`), and the demo/e2e evidence with the dead band on is in §7. Unresolved CEX mids are now **logged loudly** (`cex_mid_unavailable {blocks, first, last, error}` per settle, and `nothing_labelled` when every graded block is unresolved) instead of silently skipped (F-5). Every block with arb-direction flow is gradeable under v4 (no rule-v1 blocks), so calm hours season the model too (F-8).

**Story (`e2e/story.ts`).** Grades the model that actually ran the pool: the configured primary if it posted ≥ half of the model attestations, else the dominant node (e.g. heuristic-v1 when Jev was unreachable; `--model-node` forces one); the summary carries `modelGraded`. Reason: on a flaky network Jev times out (2.2–2.5 s observed against a 2.5 s timeout) and the keeper posts the heuristic under heuristic-v1, which the degrade flag also inverts — the story is the same, the name differs.

**E2E (`e2e/run-local.ts`).** Default `--arb-threshold 0`, `--block-time 2` (Jev ~0.5–1 s live on every block; on 1 s blocks the keeper misses ~40% — reviewer R-1), coverage ≥ 70% on ≥ 2 s blocks (55% on faster). Assertions (F-10): with the gate off, **0 rule-v1 attestations and the model asked on every tick**; every non-stale arb-direction receipt with k = 0 paid exactly base; the threshold law with the pool's threshold (0) holds on every receipt; `CalibrationUpdated` exists and never for rule-v1. With `KEEPER_GATE=1` the v3 assertions apply. Summary adds `keeperGate`, `arbReceiptsAtK0`, `arbReceiptsAboveBase`, `kHistogram`.

Evidence: `OFFLINE=1 pnpm -C services test` — **12 files, 73 passed, 5 skipped** (live Jev tests); typecheck clean apart from a pre-existing error in `src/model/kev.ts` (another agent's file, `ml/` work in progress; `'kev'` is not in the `ModelScore.model` union). E2E: see §7.

## 5. App (`app/`)

- **Receipt page uses the config in force at the receipt's block** (F-4): `readConfigAt()` picks the last `PoolRegistered` / `PoolConfigUpdated` event for the pool at or before the block (events already in the exported ABI); the page's fee check uses it and a note says so when it differs from today's config. No contract / event change.
- Status strip (F-7): at k = 0 the fee tiles say "arb dir, k = 0 → base fee" in the normal tone (warn tone only when the arb-direction fee is actually above base); the k tile says "model: no profitable arb → base fee" / "unseasoned → kDefault 0.00 (base fee)" (no warn colour when kDefault = 0); a green banner "k = 0 → base fee both ways (same as a vanilla pool): the model sees no profitable arbitrage / no trusted model"; the fee-law line drops the "− 0.00%" threshold term when the threshold is 0 and says "the model decides k every block (k = kMax·p·c)"; the rule-v1 share is shown only when rule posts exist. Receipt tiles likewise ("arb direction, k = 0 → base").
- `next.config.ts`: `NEXT_DIST_DIR` lets a verification build (`NEXT_DIST_DIR=.next-check pnpm -C app build`) run next to the live `next start` on :3000 without rewriting its `.next`. Evidence: `pnpm -C app build` (to `.next-check`, then removed; the `tsconfig.json` include lines Next adds were reverted) — **compiled successfully, all routes built**.

## 6. Benchmark v4 (`benchmark/src/v4/`, `pnpm -C benchmark bench:v4`, results in `benchmark/results_v4/`)

Copy of the v3 simulator (`sim3.ts` → `sim4.ts`; routing competition, one keeper step of lag, 5% missed posts, two competing arbitrageurs, seeded retail routed by best execution, labels vs the CEX mid at the swap's block time) with these differences:

- **Markets** (`chain4.ts`, `DeployBenchV4.s.sol`, 7 markets = 14 pools): control; **(a) v2k** v2 law const k 0.5 no threshold; **(b) thrk** hard-coded threshold base + 0.03%, const k 0.5 (v3); **(c) ai** threshold 0, kMin 0, kDefault 0, kMax 0.8, step 0.8, **Jev every block** (primary); **(d) aiheur** same config, heuristic every block; **(e) aigated** same as (c) with Jev inverted from mid-window (calibration gate); **(f) aidz** exploratory: (c) plus a keeper-emulated contract dead-zone z = 5% on p·c (`k = kMax·max(0, p·c − z)/(1 − z)`; the settler grades the raw p).
- **No keeper gate**: every model pool's model is asked on every attested step, with the k-free v4 features (`ScorerV4`, `heuristicV4`).
- **Settler label = base fee** (§4; `--label-fee paid` restores the old rule).
- **Jev budget / cache** (`scorer4.ts`): v4-namespaced cache; quantised states (0.01% gap buckets within ±0.10% of the base fee, coarser elsewhere); hard cap of live calls per run (250), paced over the run; a failed call is retried once, then the nearest cached v4 answer is used (same side, same base fee, same sign of the edge, |Δgap| ≤ 200 pips near the base fee else ≤ 1000) and only then the heuristic, **counted as fallback**; after 4 consecutive failures live calls pause for 100 steps; the cache is saved every 300 steps. One `ScorerV4` (shared cache and budget) serves pools c, e, f.
- **Re-scope (network).** The first attempt at 3600 steps with a 1,500-call budget and a 5 s timeout ran 600 steps in 758 s (85 timeouts at 5 s each; the gateway here is slow and flaky, ~100 KB/s) and was stopped. The v4 run therefore uses **1200 1 s steps (20 min) per window** for the Jev arms, all 12 windows, both tiers (24 runs), and a separate **full-length 3600-step run with every AI arm heuristic-scored** (`--jev heuristic --steps 3600 --out results_v4/heuristic-full`; 24 runs) so at least one AI-decides arm has full-hour evidence. Both are reported below.

<!-- V4-BENCH-RESULTS -->
(pending)
<!-- /V4-BENCH-RESULTS -->

## 7. Demo and e2e evidence

<!-- V4-E2E -->
**Services e2e** (`pnpm -C services e2e --port 8640 --blocks 60 --out ../deployments/31337.e2e.json`, 2 s blocks, 3-min replay steps, degrade at 60%): **PASS**. 58 attestations in 58/60 blocks, keeper gate off, `ruleAttestations 0`, model asked on 59/59 ticks (58 answered by Jev, 1 heuristic fallback), 24 receipts (17 arb-direction, all at k = 0 → all paid exactly base, `arbReceiptsAboveBase 0`), 0 stale receipts, mean arb fee 3000. `CalibrationUpdated` for jev-v1 at blocks 55/65/75/85 (n 4 → 9, Brier 0.003 → 0.40 after the degrade at block ~36+). With `MIN_SAMPLES = 10` (DeployLocal default) the model did not reach probation exit inside 60 blocks, so k stayed at kDefault = 0 for the whole run — which is the v4 safety property (untrusted model ⇒ vanilla pool) and exactly what the receipts show. A 90-block run (below) shows k following Jev once seasoned.

**90-block e2e** (`--port 8641 --blocks 90`, degrade at block 54 of the run; dead band not yet in place): **PASS**. 89/90 blocks attested, Jev answered 90/90 ticks, 0 rule-v1; 30 receipts, 20 arb-direction: 12 at k = 0 (paid base), 8 above base once the model had power. k histogram over the 89 attestations: 0 ×59, <0.05 ×6, 0.05–0.2 ×2, 0.2–0.5 ×1, ≥0.5 ×21. Calibration for jev-v1: n 5 → 10 at block 74 (**seasoned**, Brier 0.003), k moves off 0 at 75 (0.017, 0.038, 0.053 on calm blocks, **0.74** on the toxic block 90 — one attestation), then the degrade: Brier 0.08 → 0.19 → **0.28 at block 104 (n = 16) ⇒ demoted, k = 0 from block 105**. Every arb-direction receipt at k = 0 paid exactly base; mean arb fee 3194 pips over the run.

**Headless demo** (`RPC_PORT=8631 SKIP_APP=1 DEMO_DURATION=240 DEMO_RUNTIME_DIR=… DEMO_DEPLOYMENTS_FILE=deployments/31337.demo-v4.json scripts/demo-local.sh`; demo profile MIN_SAMPLES 3, SETTLE_EVERY 5, CALIB_WINDOW 8, volatile replay window 2026-09-21 08:14Z, 1m×4 steps, 2 s blocks; the live demo on :8545/:3000 was left alone): story **`missing: []`** — expect `seasoned,honest-active,demoted` all found, Jev on every block (119/119 attestations under jev-v1, 0 rule-v1):
- unseasoned: blocks 25–35, 10 attestations, **all at k = kDefault = 0** (base fee);
- seasoned at block 35 (n = 3, Brier 0.003); first k off 0 at block 36 (k = 0.0093); k then follows Jev block by block: `37:74 40:60 43:7065 46:6992 49:60 52:74 55:112 58:4872 61:4416 64:5414 67:151 70:236 73:7372` — "calm" blocks at 0.006–0.02, "toxic" blocks at 0.44–0.74, switching within one block thanks to the full-range step;
- no honest-period demotion (blocks 36–71);
- "Degrade model" at t+97 s (block 71); Brier 0.21 → **0.33 at block 90 (n = 8) ⇒ demoted, k back to 0 at block 91** and 0 for the rest of the run (blocks 91–142): a vanilla pool again.

(An earlier headless run during a Jev outage — 53 of 62 attestations were heuristic fallbacks under heuristic-v1 with 2.2–2.5 s Jev latencies — motivated the story's "grade the model that actually ran the pool" rule, §4.)

**With the settler dead band ($1 / 1 bp, §4)** — 60-block e2e on port 8642: **PASS** (57/60 blocks attested, Jev 56/58 ticks, 0 rule-v1, 16 arb-direction receipts all at k = 0 → base, 0 stale). Grading is stricter as intended: 4 graded blocks and 6 ambiguous (|markout| ≤ T) blocks skipped by the end of the run (`skippedAmbiguous` 4 → 5 → 6 across settles), so with `MIN_SAMPLES = 10` the model stays on probation (k = 0, vanilla pool) for the whole 60-block run; the 90-block run above seasoned at n = 10 without the dead band.

Headless demo with the dead band (same command and profile as above, MIN_SAMPLES 3 / CALIB_WINDOW 8 unchanged): story **`missing: []`**, Jev on 110 of 114 attestations (4 heuristic fallbacks, all graded under jev-v1 as the dominant node). Unseasoned blocks 25–40 at k = 0; seasoned at block 40 (n = 4, Brier 0.22); k follows Jev (`43:6912 46:7144 49:60 52:73 55:128 58:5428 … 73:7372`); no honest-period demotion; degrade at block 71; 17 ambiguous blocks skipped over the run, so n sat at 7 from block 50 to 105 and the demotion came at **block 125 (n = 8, Brier 0.34 ⇒ k = 0 from block 126)**, ~53 blocks after the degrade versus ~19 without the dead band. The story still completes inside the 240 s headless run; no demo-profile change was needed, but a headless check should keep `DEMO_DURATION ≥ 240` (the interactive demo runs until Ctrl-C).
<!-- /V4-E2E -->

## 8. v3 review fix list → what was done

| # | fix |
|---|---|
| F-1 (rule-v1 resets model k) | moot under the v4 default (no rule posts); the gate is benchmark/comparison-only and refused with kDefault 0 (§2). `refreshMid` not implemented (contract untouched). |
| F-2 | `MAX_K_STEP_BPS` default 8000 (deploy scripts and bench AI pools). |
| F-3 | `kDefault = 0` chosen (product decision: no trusted AI ⇒ vanilla pool). DESIGN §12 "never to less fee", README "never to a lower fee" / "demotion is constant k" / "never lower" rewritten: demotion or probation = k 0 = the base fee, never below base, never above a seasoned model's k. New DESIGN §14. |
| F-4 | app resolves the pool config at the receipt's block from `PoolRegistered` / `PoolConfigUpdated` (§5). |
| F-5 | settler logs `cex_mid_unavailable` / `nothing_labelled` (§4). |
| F-6 | keeper drops its `poolConfig` cache on `PoolConfigUpdated` (§4). |
| F-7 | status-strip / receipt copy for k = 0 and threshold 0; rule-v1 copy only when rule posts exist (§5). |
| F-8 | every arb-direction block is graded under v4 (§4, §7). |
| F-9 | README: "beats a fixed fee in every window" scoped to v1 (no competition) with the v2/v3 verdicts and a v4 pointer; "ship constant k" replaced by "the AI decides, the gate guarantees vanilla when the AI is untrusted" (README, PITCH pitch / demo script / Q&A 2 / don't-say list). v4 numbers added when the benchmark finished (§6). |
| F-10 | e2e assertions for gate off (§4). |
| F-11 | rule-v1 allowlisted only with `KEEPER_GATE=1` (DeployBase); ENS note updated. |
| F-12 | documented (§4); full-range step recovers on the next post. |
| R-1 (1 s blocks) | e2e default `--block-time 2`; coverage check 55% on faster blocks. |

## 9. Files touched

- contracts: `script/DeployBase.s.sol`, `script/DeployLocal.s.sol`, `script/DeploySepolia.s.sol` (doc), `script/EnsSetup.s.sol` (text records / header), `script/bench/DeployBenchV4.s.sol` (new), `test/V4AiDecides.t.sol` (new). `src/` untouched.
- services: `src/keeper.ts`, `src/settler.ts`, `src/features.ts`, `src/model/jev.ts`, `src/model/index.ts`, `src/model/jev-probe-v4.ts` (new), `src/abi/oniblockHook.ts` (+`PoolConfigUpdated`), `src/e2e/run-local.ts`, `src/e2e/story.ts`, `package.json` (`jev:probe:v4`), tests `keeper-gate`, `jev`, `features`, `settler`.
- benchmark: `src/v4/{chain4,scorer4,sim4,report4,run4}.ts` (new), `package.json` (`bench:v4`, `bench:v4:quick`), `results_v4/`. v1–v3 sources and results untouched; `data/jev-cache.json` gained v4-namespaced entries only.
- app: `src/lib/server/live.ts` (`readConfigAt`), `src/lib/server/receipt.ts`, `src/app/page.tsx`, `src/app/receipt/[tx]/page.tsx`, `next.config.ts`.
- scripts: `demo-local.sh`. docs: `DESIGN.md` (§12, new §14), `README.md`, `PITCH.md`, `ENS_INTEGRATION.md`, `JEV_NOTES.md`, this file.
- Not touched: `ml/`, `contracts/src/`, anything on Sepolia (nothing broadcast), the demo on :8545/:3000.
