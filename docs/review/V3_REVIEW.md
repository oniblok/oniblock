# Oniblock v3 review (threshold fee law + gated Jev keeper)

> Note (later change): the `minSamples` probation ("unseasoned") described in this historic document has since been removed from the hook; the calibration gate is now the pool allowlist + Brier demotion only, and a model with no calibration record is active.

Date: 2026-09-26. Independent reviewer. Scope: `contracts/src/OniblockHook.sol` (arbThresholdPips + law), `contracts/test/ThresholdLaw.t.sol`,
`services/src/{keeper,settler,price,features}.ts`, app status strip / receipt page, deploy scripts, e2e/story, benchmark v3 conclusion.
No source files under `contracts/src` or `services/src` were edited. PoCs: `contracts/test/review3/V3Review.t.sol` (7 tests, all pass).

**Mid-review direction change (user):** "Jev decides when to charge extra". New default: `arbThresholdPips = 0`, `kMinBps = 0`,
keeper gate OFF (Jev every block), no rule-v1 posts; the threshold stays in the contract for comparison only. The findings below
are graded for **both** the v3-as-built default (threshold base+300, gated keeper) and the new default.

## Evidence (runs)

| check | result |
|---|---|
| `forge build --sizes` | OniblockHook runtime **21,817 B** (margin 2,759 B). Prototype `MidOnlyHook` (hook + F-1 fix) **22,799 B** (margin 1,777 B) |
| `forge test` | 94 passed, 0 failed, 1 skipped (offline fork) |
| `FOUNDRY_FUZZ_RUNS=2000 forge test` | 94 passed, 0 failed, 1 skipped (invariants incl. `invariant_feeLawAndNoRevert` pass) |
| `forge test --match-path test/review3/*` | 7/7 pass (PoCs below) |
| `OFFLINE=1 pnpm -C services test` | 11 files, 59 passed, 5 skipped |
| e2e, v3 default (port 8631, `--out deployments/31337.review3.json`) | **PASS**: 61 blocks, 53 attestations (43 rule-v1), Jev rate 0.20, 11 arb receipts (8 below / 3 above threshold). **Only 3 labelled blocks; model never seasoned (n=3 < minSamples 10); k = 5000 at every non-rule attestation (kPath flat).** |
| e2e, new default (port 8632, `KEEPER_GATE=0 K_MIN_BPS=0 MAX_K_STEP_BPS=8000 MIN_SAMPLES=3 CALIB_WINDOW=8 --arb-threshold 0 --blocks 90`) | see §5 |
| `pnpm -C app build` | passes (Next 16 dev server on :3000 uses `.next/dev`, unaffected) |

## 1. Contract: threshold law

Verified by reading `_fee` (`OniblockHook.sol:780-795`), `_liveAnchor` (`:738-774`), `_validateConfig` (`:861-869`) and by tests:

- **Boundaries.** `gap == thr` gives excess 0, so base (`test_atThreshold_baseFee`). `thr = 0` gives exactly the v2 law (`excess = gap`; test + fuzz). `thr == feeMax` is accepted and `thr > feeMax` rejected. A threshold near feeMax just needs `gap ≥ thr + (feeMax−base)/k` to hit the cap. No discontinuity.
- **Overflow.** `excess ≤ 1e6` and `k < 1e4`, so the product is below 1e10 in uint256. The value is clamped to `feeMax ≤ 1e5` before the uint24 cast. Safe.
- **Anchor / dead-band / N-07 / stale.** The threshold only applies inside `_fee`, after the high-water gap and the live-side check. So:
  - The HW anchor and "live at/past mid → base" are unchanged.
  - Stale returns conservativeFee before the law.
  - The N-07 floor applies after the law, including below the threshold (tested) and at k = 0 (`test_kMin0_staleAndFloorStillConservative`).
- **quoteFee == executed.** `quoteFee` and `_beforeSwap` share `_liveAnchor` and `_fee`. Existing fuzz, plus the new `testFuzz_kMin0_thr0_law`.
- **Split resistance above the threshold.** It holds because the threshold is subtracted from the HW gap, not the live gap (`test_split…` in ThresholdLaw).
- **Config and timelock.** The field is the last struct member and goes through `updatePoolConfig`'s timelock (tested). The anchor is cleared on execute (N-12, unchanged).
- **Invariants.** They still hold: the review2 handler and the review fuzz mutator randomise `thr ∈ [0, feeMax]` and `kMin ∈ [0, kMax]`.
- **New default is accepted.** The contract accepts `kMinBps = 0` and `arbThresholdPips = 0`. It also accepts `kDefaultBps = 0`. With k = 0 the arb direction pays **exactly baseFee**, quote == executed, and the Receipt shows kBps = 0 (`test_kMin0_thr0_kZeroPaysExactlyBase_andStepLag`, `test_kDefault0_unseasonedIsVanilla`). At k = 0 the only non-base fees are stale → conservativeFee and the N-07 floor, which is intended.
- **Receipt recomputability.** It needs the threshold **in force at the swap block**, not the current one (F-4).

Verdict on the law: **correct.** No contract bug found.

## 2. Findings

| # | sev (v3 default / new default) | file:line | issue | PoC | fix |
|---|---|---|---|---|---|
| F-1 | **High / moot** (returns if the gate is ever re-enabled) | `OniblockHook.sol:426-436`; `keeper.ts:309-313` | rule-v1 is allowlisted but never graded, so it is unseasoned. Every rule post sets k to kDefault. The next model post can move only `maxKStepBps` from kDefault, so with step 1000 k oscillates between 5000 and 6000. **The first block of every arb episode is priced at kDefault**, because the rule post comes right before the gap opens. This is consistent with benchmark v3 mean model k of 4,9xx–5,1xx even with step 6000, and with the e2e kPath being flat at 5000. The "Jev k ≈ constant k" result is therefore partly an artifact. | `test_F1_rulePostResetsModelK` | See §3: a mid-only refresh path (prototype passes, +982 B). |
| F-2 | Low / **Medium** (builder already set default 8000, verified) | `DeployBase.s.sol:107` (`MAX_K_STEP_BPS` default 1000) | With kMin = 0 the Jev decision is rate-limited. Switching the premium off from kDefault 5000 takes 5 blocks. Switching it on from 0 gives k = 1000 on the first volatile block and needs 8 blocks to reach kMax. That contradicts "Jev decides when to charge". | `test_kMin0_thr0_kZeroPaysExactlyBase_andStepLag` (5 posts to reach 0; one post from 0 gives 1000) | Default `maxKStepBps = kMaxBps − kMinBps` (8000) for the demo and Sepolia. The step limit adds little safety beyond the [kMin, kMax] bounds, feeMax, instant demotion and the trusted attestor. |
| F-3 | – / **Medium (design decision; builder chose kDefault 0, doc sentences still need fixing)** | `DeployBase.s.sol` kDefault; `DESIGN.md §12` "falls back to kDefault, never to less fee"; `README.md:192,324` | With kMin = 0, `kDefault` decides what "no trusted AI" means. It applies while unseasoned, while demoted, and on every heuristic-fallback post from an unseasoned heuristic-v1 node. **kDefault 5000 means the fallback is the v2 law**: a calm-hour loser at the 0.30% tier (−0.21 bps/h, 26% retail share), but YES at the 0.05% tier. **kDefault 0 means the fallback is a vanilla pool**: "never worse than vanilla except stale", and demotion shows up as the fee dropping to base. The docs' "never less fee" claims are false for kDefault 0. **Never combine kDefault 0 with KEEPER_GATE=1**: the first above-threshold block would be priced at k = 0 (see F-1). | `test_kDefault0_unseasonedIsVanilla` | Pick explicitly. The reviewer recommends kDefault 0 for the "Jev decides" story (see §4) and updating the doc sentences. |
| F-4 | Low (Medium if the threshold is flipped for comparisons during a demo) | `OniblockHook.sol:246-253` (NatSpec); `app/src/lib/server/receipt.ts:258`, `app/src/app/receipt/[tx]/page.tsx:94-95` | The Receipt carries the raw gap, and the fee is recomputed with the *current* `poolConfig.arbThresholdPips`. After any threshold change, older receipts fail the app's fee check, and third-party verifiers need the `PoolConfigUpdated` history. | `test_F4_receiptNotRecomputableFromCurrentConfig` | Cheapest: the app resolves the config at the receipt block from `PoolConfigUpdated` logs. Cleanest, since Sepolia is not yet deployed: add `uint24 arbThresholdPips` to the `Receipt` event (+32 B log data, about 256 gas per swap; ABI/topic change). |
| F-5 | Low | `settler.ts:289-321` | With `SETTLER_LABEL_MID=cex`, blocks whose CEX mid can't be fetched are silently not labelled. Host fallback exists (`cex.ts:13`), but a total outage leaves the model unseasoned forever with no log line. | read | Log `label_mid_unresolved {count}` per settle. Optionally fall back to `attested` after N consecutive failures (logged). |
| F-6 | Low / moot | `keeper.ts:222-232` | `poolConfig` is cached for 100 blocks, so after a timelocked threshold change the gate is out of sync for up to 100 blocks. | read | Re-read every 10 blocks (cheap view) or on `PoolConfigUpdated`. |
| F-7 | Low | `app/src/lib/server/live.ts:149`, `app/src/app/page.tsx:89-92,139-147` | Under the gate the status strip shows "Model node rule-v1 · no calibration yet" and "unseasoned → kDefault" (warn tone) most of the time. Under the new default: at k = 0 the fee tile says "regime fee (arb dir)" in warn tone while it charges base; the fee-law line prints "− 0.00%"; the banner and model-mix text still mention rule-v1. | read | Show the last *model* attestation's node and calibration. Show "k = 0 → base (Jev: calm)" when kBps = 0. Hide the threshold term when it is 0. Drop the rule-v1 copy when no rule posts exist. |
| F-8 | **Medium (demo)** / resolved | `scripts/demo-local.sh`, `services/src/e2e/story.ts` | With the gate on, models are graded only on above-threshold blocks. The e2e got 3 labels in 61 blocks, never seasoned, and never showed k moving. The demo's story (seasoned → degraded → demoted in about 3 min, MIN_SAMPLES 3, window 8) is at best marginal. The v3 benchmark saw 0 graded blocks in 4 of 6 calm windows. | e2e summary above | With the new default (gate off, threshold 0) every arb-direction block is graded again (§5). If the gate is kept for a comparison demo, use a volatile replay window, `REPLAY_STEP ≥ 4`, `ARB_THRESHOLD_PIPS = base` (no margin), and MIN_SAMPLES 3. |
| F-9 | **Medium (claims)** | `README.md:186-190`, `docs/PITCH.md:11,25,51-53` | "The fee law beats a fixed fee in every window" comes from the v1 no-competition benchmark. Under routing competition, v2 (`results_v2`) and v3 do not support it at 0.30%: v2 law INCONCLUSIVE (−$169/h), threshold law NO (−$37/h). The v2 law is YES only at the 0.05% tier (+0.06 bps/h). PITCH's "ship constant k" also conflicts with the new "Jev decides" direction. No benchmark arm has tested Jev with kMin 0 and threshold 0. | – | Rewrite the wording (§4). Run a `bench:v3` arm "v2 law, kMin 0, Jev every block, step 8000" at both tiers before making any LP-benefit claim for Jev. |
| F-10 | Low | `services/src/e2e/run-local.ts:218-239` | The e2e requires ≥ 1 rule-v1 attestation and checks below-threshold receipts, so it fails under the new default. | – | The builder should switch to: gate off gives 0 rule posts; receipts with k = 0 must pay base; CalibrationUpdated for jev-v1 happens. |
| F-11 | Low | `DeployBase.s.sol:71-76`, `EnsSetup.s.sol` | rule-v1 is allowlisted by default even when unused. That is an extra identity the attestor may claim (N-03 surface). It is harmless while unseasoned, but costs k if kDefault ≠ the model's k. | – | Allowlist rule-v1 only when `KEEPER_GATE=1`. |
| F-12 | Info | `keeper.ts` fallback | If Jev fails, the keeper posts under heuristic-v1. If heuristic-v1 is unseasoned, that is the same k reset as F-1 for that block. It recovers next block with the full-range step (F-2). Do not use `FALLBACK_SAME_NODE=1` to hide it: that misattributes heuristic scores to jev-v1. | read | Document it; full-range step. |
| F-13 | Info | `OniblockHook.sol:867` | `arbThresholdPips ≤ feeMax` compares a gap to a fee cap. It is an arbitrary but harmless sanity bound, and `thr < baseFee` is allowed (documented). | – | none |
| F-14 | Info | `cex.ts:179-191` | The settler's `midAt` returns the close of the 1 s kline containing the timestamp, which looks ahead up to 1 s. Negligible for labels. | – | none |

Keeper gate correctness (was item 3):
- Units and token order are consistent with the contract: `gapPips` uses the same mulDiv on priceX96, and `midToPriceX96` handles `baseIsToken0`.
- The gate compares the pool now against the *mid about to be attested*. That is the same mid the hook will measure against in the target block, so it is correct.
- Hysteresis errs toward calling the model.
- If the mid fetch fails, the tick throws and nothing is posted, so the pool goes stale and falls back to conservativeFee (safe).
- With `thr = 0`, `gateDecision` always returns 'model', so `KEEPER_GATE=1` is inert under the new default.

Settler: rule-v1 is filtered twice (pre-filter plus `skipModelNodes`), which is harmless. There is no double counting: labels are grouped by `block:modelNode`, and calibration is recomputed from scratch over the window every settle.

## 3. F-1 fix spec: mid-only refresh (recommended if a gated keeper is ever deployed)

Options compared:

| option | contract change | security | calibration integrity | verdict |
|---|---|---|---|---|
| (a) mid-only attestation path | yes (+982 B, fits) | same trust as today: quoter-gated plus attestor-signed, separate typehash; demotion re-checked | clean: the model is graded only on its own posts | **recommended** |
| (b) rule posts carry the last model score/node | no | the attestor signs a model identity for a block the model didn't score (a misattribution the N-03 trust model forbids) | pollutes Brier with stale scores on below-threshold blocks | reject |
| (c) exempt the rule node from demotion | yes | – | rule's own score (p 0.1) would then *drag* k toward kMin + 0.1·span, which is worse | reject |
| (d) raise `maxKStepBps` | config only | weakens the rate limit (acceptable, see F-2) | ok | necessary but **insufficient**: every episode's first block is still at kDefault |

Spec (prototype: `MidOnlyHook` in `contracts/test/review3/V3Review.t.sol`, `test_F1fix_midOnlyKeepsK_andRechecksDemotion`):

```
bytes32 MID_TYPEHASH = keccak256("MidAttestation(bytes32 poolId,uint64 blockNumber,uint256 oracleMidX96)");
event MidRefreshed(PoolId indexed id, uint64 indexed blockNumber, uint256 oracleMidX96, uint32 kBps, bytes32 indexed modelNode, address quoter);
function refreshMid(PoolKey key, uint64 blockNumber, uint256 oracleMidX96, bytes signature) external
```
1. Run the same checks as `setAttestation`: initialized, `isQuoter`, `blockNumber ∈ {block, block−1}`, `blockNumber > lastAttestBlock` (the monotonic counter is **shared** with full attestations, so replay and cross-ordering are rejected), mid in (0, 2^224), attestor EIP-712 signature under MID_TYPEHASH (a full-attestation signature is not valid here), Chainlink sanity band.
2. For k: `k = isDemoted(id, st.modelNode) ? kDefault : st.kBps`. This keeps today's "demotion applies at the next post" safety property. It is **not** re-stepped, and `st.modelNode`, `pToxicBps` and `confidenceBps` are untouched.
3. Write `oracleMidX96`, `lastAttestBlock`, `lastPostBlock` and `kBps`.
4. Handle a same-block anchor exactly as `setAttestation` does, with this k and `st.modelNode`: stale leads to un-stale plus the N-07 floor; `k ≥ anc.k` takes over; otherwise the anchor is pinned.
5. Emit `MidRefreshed`. The settler treats a block whose in-force post is a MidRefreshed as belonging to the carried model. For calibration purity, the recommendation is to **skip grading** such blocks, or to grade them with the carried score but mark them (open choice). Receipts keep `modelNode` equal to the carried model.
6. Keeper: below `thr − hysteresis`, call `refreshMid` instead of posting rule-v1. rule-v1 is then removed entirely.

Residual: a model's k can live on through mid-only refreshes long after its last score. That is bounded by [kMin, kMax] and by the demotion re-check. Optional: add `kMaxAgeBlocks` (not needed for the demo).

Gas: the swap path is unchanged. The keeper tx is slightly cheaper than `setAttestation` (no kFromScore, three fewer SSTOREs).

Under the new default (gate off) this fix is **not needed**. Keep it as the documented prerequisite for any gated deployment.

## 4. Defaults and wording

Benchmark facts:
- The threshold law is about the same as vanilla: NO at 0.30% (−$37/h), INCONCLUSIVE at 0.05%.
- The v2 law (threshold 0) is INCONCLUSIVE at 0.30%: +vol, −calm, 26% share. It is **YES at 0.05%**: +0.06 bps/h, volatile +0.15.
- Jev or heuristic k versus constant k differs by about $7–8/h.
- Jev deciding k ∈ [0, kMax] is **untested**.

| profile | arbThresholdPips | kMin / kDefault / kMax | maxKStep | gate | other |
|---|---|---|---|---|---|
| demo (local) | **0** | 0 / **0** (or 5000, see F-3) / 8000 | **8000** | off | MIN_SAMPLES 3, CALIB_WINDOW 8, SETTLE_EVERY 5; volatile replay window |
| Sepolia | **0** | 0 / 0 / 8000 | 8000 | off | MIN_SAMPLES ≥ 10, CALIB_WINDOW ≥ 20; consider base 500 (the tier where the v2 law was YES); do not allowlist rule-v1 |
| docs recommendation | 0 (the threshold is a comparison knob; `base + 300` gives vanilla parity in calm hours at the cost of the volatile premium) | per above | = kMax − kMin | off | "set a threshold only with the mid-only path (F-1)" |

README/PITCH wording (suggested):
- "Jev decides, per block, whether arbitrage-direction flow pays extra: its score sets k ∈ [0, 0.8], and k = 0 makes the pool a plain base-fee pool. The fee law is `base + k·gap`, capped. The calibration gate removes Jev's power automatically if its forecasts go bad."
- "Under routing competition with a vanilla pool next door (benchmark v2/v3), a constant-k law is a small LP win at the 0.05% tier (+0.06 bps/h, CI above zero) and inconclusive at 0.30%. A fixed arbitrage threshold makes the pool equivalent to vanilla. Whether Jev's k beats constant k is not established: past runs showed differences of a few dollars per hour."
- Remove: "beats a fixed fee in every window" (v1-only, no competition), "ship constant k" (superseded), and "demotion never lowers the fee" (false with kDefault 0).

## 5. New-default e2e (port 8632, 90 blocks, 1 s blocks, 3-min replay steps, degrade at 60%)

At run time the builder's `DeployBase` already defaulted to kMin 0, **kDefault 0**, **maxKStep 8000** and threshold 0 (the `V4_AI_DECIDES` comment), which matches F-2 and F-3 above. Results:

- **Story works again.**
  - k = 0 while unseasoned. The first labels arrive around block 66 (n = 5, Brier 0.0026), and that seasons the model.
  - k then follows Jev per block: 0, 88, 86, **5059, 7296**, 532, 7296. The full-range step makes Jev's decision apply immediately.
  - After the degrade (around block 95), Brier goes 0.4547, then 0.4453, then 0.6708. Those are above 2500, so the model is **demoted and k is back at kDefault = 0**.
- There were 19 arb receipts, all graded-eligible (threshold 0). Jev rate was 1.0, with 63 of 65 answers from Jev and a mean latency of about 790 ms.
- The e2e reported **FAIL** for two reasons:
  - "keeper never posted under rule-v1": an expected assertion to update (F-10).
  - "attestations in only 55/90 blocks": with Jev every block at about 0.8 s latency plus the tx, on **1 s** blocks, the keeper misses about 40% of blocks. There was 1 stale receipt (conservativeFee). This is a new residual, **R-1 (Low)**. It is harmless at the demo's `BLOCK_TIME=2` and on Sepolia (12 s). For the e2e, relax the check to at least 55% of blocks or use `--block-time 2`, and keep `staleBlocks ≥ 5`.

## Prioritized fix list

1. **F-2**: `MAX_K_STEP_BPS` default = kMax − kMin (deploy scripts, bench). Without it, "Jev decides" lags up to 8 blocks.
2. **F-3**: choose kDefault explicitly (recommend 0) and fix the DESIGN §12 / README "never less fee" sentences.
3. **F-10 / F-11**: update the e2e assertions for gate off; allowlist rule-v1 only when the gate is on.
4. **F-9**: README/PITCH wording, and add a "Jev decides (kMin 0, thr 0, step 8000)" benchmark arm at both tiers before claiming anything.
5. **F-4**: resolve the receipt config at the swap block in the app, or add the threshold to `Receipt` (the contract ABI is still undeployed on Sepolia).
6. **F-7**: status-strip copy for k = 0 and threshold = 0; show the last model node.
7. **F-5, F-6**: settler unresolved-mid logging; keeper config refresh.
8. **F-1**: implement `refreshMid` per §3 **only if** a gated keeper is kept as a deployable mode; otherwise keep the gate as a benchmark-only mode and document F-1.

## Verdict

- **Contract: ship-ready.** The threshold law is correct at all boundaries. It accepts the new default (thr 0, kMin 0, kDefault 0), and k = 0 pays exactly base. Invariants and fuzz pass at 2000 runs. There is size headroom of 2,759 B, or 1,777 B with the optional mid-only path.
- **v3 gated keeper as built:** functionally correct, but F-1 neutralises model k and starves the calibration gate of labels (F-8). Under the user's new default (gate off, threshold 0) both issues are moot.
- **Remaining work before the demo/Sepolia:** deploy defaults (F-2, F-3), e2e assertions (F-10), and claims (F-9).
