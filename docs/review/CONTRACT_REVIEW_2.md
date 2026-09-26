# Oniblock contract review #2

**Scope.** This round re-checks the fixes in `docs/review/CONTRACT_FIXES_1.md` against `contracts/src/OniblockHook.sol` (786 lines), and looks for new attack surface introduced by those fixes. That covers the timelock, same-block attestation replacement, the per-direction high-water gap, and the model allowlist with probation.

**Method.**
- Manual review.
- New PoCs in `contracts/test/review2/Review2Findings.t.sol`. Each `test_r2_*` passes when the finding reproduces or the property holds.
- Invariant tests in `contracts/test/review2/Review2Invariants.t.sol`.
- No file under `src/` or `script/` was modified. No git operations and no broadcasts.

**Status.**
- `FOUNDRY_FUZZ_RUNS=3000 FOUNDRY_INVARIANT_RUNS=256 FOUNDRY_INVARIANT_DEPTH=100 forge test`: **83 passed, 0 failed, 1 skipped** (the fork suite).
- The round-1 sequence fuzz ran 3,004 runs × 16 steps.
- The new invariants ran 3 × 256 × 100 calls. A separate run at 500 × 100 also passed.

## Verdict: **ship** (hackathon / testnet)

- No Critical or High findings.
- Every round-1 fix is present and does what it claims.
- The swap path does not revert under fuzz or invariants.
- quote == executed holds everywhere.
- The ERC-6909 accounting is exact.

The main new issue is economic (N-01/N-02). The per-block high-water gap, which is needed for split resistance, makes later same-block traders in a displaced direction pay up to `feeMax` (3.3× base with the default config). A dominant LP can also trigger that at almost no cost. The damage is capped by `feeMax`, and the victim is the in-block retail trader, not the LPs.

Recommended cheap fixes before a longer-lived deployment: N-04 (validate `minSamples ≥ 1`), N-08 (timelock grace period), N-11 (bench script size), and the optional live-side check for N-01. Document N-01/N-02/N-03 in the README.

---

## 1. Round-1 fixes: verification

| R-# | Fix | Verified by | Result |
|---|---|---|---|
| R-01 | Per-pool allowlist; unseasoned (`n < minSamples`) or not allowlisted ⇒ demoted (kDefault) | `test_fix_R01_*` (5), `test_r2_R01_*` (3) | **Correct as specified.** A fresh node is rejected. An allowlisted but unseasoned node is capped at kDefault. A settler reset to n=0 keeps the node demoted. Remaining gaps are N-03 (relabel to another *seasoned* node, a trust assumption) and N-04 (`minSamples = 0` re-opens R-01). Calibration is global per node while the gates are per pool (Info N-13). |
| R-02 / R-05 | Per-block, per-direction high-water gap measured live before every swap and quote | `test_fix_R02_*`, `test_fix_R05_*`, `testFuzz_r2_R02_splitNeverCheaper` (3,004 runs), `test_r2_R02_dustPrenudgeCannotLowerArbFee` | **Correct.** Splits of 2–6 parts never receive more output than one swap. Dust nudges cannot lower an arb fee. A same-block backrun pays the live gap. A keeper attestation after a dust swap is used for the rest of the block. Side effects: N-01, N-02 and N-07 (the stale-at-first-touch case is not covered). |
| R-03 | Anchor stores k / model / attestBlock; Receipt emits `anc.modelNode` | `test_fix_R03_*` | **Correct for k.** A lower-k same-block attestation still feeds its *mid* into later gaps, so attribution can mix two attestations (N-05). |
| R-04 | Timelock on `updatePoolConfig` / `setAttestor` / `setRoleOracle`, queued on first call | `test_fix_R04_*`, `test_r2_T0*` | **Works.** Params are bound to the queue id (the hash of the calldata). A replay after execution re-queues instead of executing. Too-early calls revert. Only the owner can queue or cancel. Weaknesses: entries never expire (N-08), and non-canonical calldata creates separate entries (N-09). |
| R-06 | Clamp k and clear the anchor on config update | `test_fix_R06_*`, fuzz op 2 | **Correct.** Clearing the anchor mid-block can lower fees already locked in that block (Info N-12; owner and timelock only). |
| R-07 | A newer attestation may replace an older one in the same block | `test_fix_R07_*`, `test_r2_A01/A04` | **Correct.** k can only rise within an anchored block. Two posts in one block give two k steps (Info N-10). |
| R-08 | Documented only | `test_poc_R08_*` still reproduces | Accepted as documented. |
| R-09 | Sepolia ENS defaults use labelIds; ROOT refused | Read `DeploySepolia.s.sol:75-86` | **Correct.** |
| R-10 | `chainlinkMaxAge` config; strict decimals | `test_fix_R10_*` | **Correct.** |
| R-11 | Tests and deploys use the 800-run build | `forge build --sizes` | **Correct for tests, DeployLocal and DeploySepolia.** `script/bench/DeployBench.s.sol` still imports PoolManager (N-11). |

## 2. Findings

| ID | Sev | Where | Description | PoC | Fix |
|---|---|---|---|---|---|
| N-01 | **Medium** (economic) | OniblockHook.sol:650-685 (`_liveAnchor` high-water), 688-698 (`_fee`) | Once a direction's high-water gap is set, every later swap in that direction in the same block pays it, even when the live gap is ~0. Any in-block displacement (a whale trade, an overshoot) is enough. Retail pays the arb's fee after the arb has already restored the price. After an overshoot, both directions pay arb fees. | `test_r2_R02_retailAfterWhaleAndArb_overcharged`, `test_r2_R02_overshoot_bothDirectionsElevated` | Cheap partial fix: charge `baseFee` when the live price is at or past the mid for this direction (live toward-gap for this direction == 0). It stays split-resistant because every part of a split arb runs while the live gap is > 0. Long-term fix: average-gap (integral) pricing, which is split-invariant without a high-water mark. Always: keep `feeMax` tight and document the cost. |
| N-02 | **Medium** (griefing) | same | A sole or dominant LP can round-trip the price (+2% → −2% → mid) at almost zero net cost, because the fees go back to itself. That leaves **both directions at `feeMax`** for every other trader for the rest of the block. Measured: $833.83 of gross fees, **$0.000003 net cost** to a sole-LP griefer. A non-LP griefer pays the full fees, so only LPs can do this profitably. | `test_r2_R02_dominantLP_roundTripInflatesBlockFees` | The N-01 live-side check removes the "back at mid" case, though a griefer can still leave mid+ε. Also documented as bounded by `feeMax`. A real fix needs integral pricing. |
| N-03 | Low (trust) | :353, :364, :428-435 | The allowlist bounds *which* identities the attestor can claim, not *which model produced the score*. When the primary node is demoted, the keeper can sign the same scores under another allowlisted **seasoned** node (for example the heuristic fallback) and reach kMax in 3 blocks. This self-corrects only once the settler demotes that node too. | `test_r2_R01_keeperRelabelsScoresAsOtherSeasonedNode` | Documented trust assumption (attestor = TEE stand-in). Optional: sticky per-pool demotion (`demotedUntil[pool]`) whenever any demoted node posts, or one allowed node per pool. |
| N-04 | Low | :432, `_validateConfig` :764-771 | `minSamples = 0` passes validation. It re-opens round-1 R-01: a node with no record has full power, and a settler reset to n=0 un-demotes a bad model. The bench flow recommends `MIN_SAMPLES=0`. | `test_r2_R01_minSamplesZero_reopensGap` | Require `minSamples ≥ 1` in `_validateConfig`, or keep treating `n == 0` as demoted when `minSamples == 0`. |
| N-05 | Low | :376-390 | A same-block attestation with a **lower** k does not take over the anchor's k / model, but its mid replaces `st.oracleMidX96` and drives later live gaps. Receipts then pair MODEL/k=6000 with a gap (and arb classification) measured against MODEL2's mid. This is a partial return of the R-03 misattribution. | `test_r2_A02_lowerKAttestation_mixesAttribution` | Also snapshot the mid in the anchor and measure gaps against `anc.mid`. Replace the mid only when (k, model) take over. Alternatively, accept the mix and have the settler attribute by `attestBlock` and ignore mismatched receipts. |
| N-06 | Info | :377 | A same-block attestation can **raise** the *other* direction mid-block by placing the mid on the other side of the pool. Fees never fall, as claimed. Within the band the attestor is trusted anyway. | `test_r2_A01_laterAttestationCannotLowerLockedFee_butCanRaiseOther` | Document. |
| N-07 | Low | :653-661, :386 (`!anc.stale`) | When the first touch of a block finds the mid stale, the whole block is pinned to `conservativeFee`, even after the keeper's fresh attestation lands in that block. The R-05 fix does not cover this case. A searcher can dust-swap ahead of the keeper after a missed heartbeat and arb a 3% gap at 5,000 pips instead of 10,000. | `test_r2_A03_staleDustFreezesConservativeForBlock` | In `setAttestation`, if the anchor is stale for this block, un-stale it and charge `max(conservativeFee, law fee)` for the rest of the block. Or document it (it requires a missed keeper heartbeat). |
| N-08 | Low (centralization) | `_timelocked` :627-640 | Queued entries **never expire**, and any number can be pending at once. The owner can queue an extreme config (`baseFee = feeMax = 10%`), let it sit, and execute it instantly months later with no fresh notice. Watchers must treat every un-cancelled `ChangeQueued` as armed forever. | `test_r2_T01_queuedChangeNeverExpires` | Add a grace window (for example, execution only in `[eta, eta + GRACE]`, after which the entry must be re-queued). Optionally store a nonce so that executing one config invalidates the other pending configs for that pool. |
| N-09 | Info | :629 | The queue id is `keccak256(msg.data)`. The same logical call with trailing bytes is a different entry, so cancelling the canonical id leaves the variant armed. Queue entries also survive `transferOwnership` (`test_r2_T04`). | `test_r2_T03_nonCanonicalCalldataSeparateEntry` | Hash `abi.encode(selector, decoded args)` instead of raw calldata. Clear or re-validate the queue on ownership transfer, or document that the new owner must cancel stale entries. |
| N-10 | Info | :346-349, :362-374 | Two attestations in one block (for `block-1`, then `block`) apply two k steps in that block (5000 → 7000 with `maxKStep` 1000). On average this is still about 1 step per block. | `test_r2_A04_twoAttestationsOneBlock_doubleStep` | Limit the step per `block.number` (track `lastPostBlock` and step from the value at block start). Optional. |
| N-11 | Low (ops) | `script/bench/DeployBench.s.sol:4, :74` | Still does `import {PoolManager}` + `new PoolManager`. The whole graph then compiles in the 44M-run profile: `OniblockHook.v4core` is **26,690 B (−2,114 B over EIP-170)**, so the bench hook deploy reverts, and `forge build --sizes` exits non-zero. This was flagged as an ACTION item in FIXES_1 and is still open. | `forge build --sizes` | Use `DeployBase._deployPoolManager()` and drop the import. |
| N-12 | Info | `updatePoolConfig` :298 | Executing a config update mid-block deletes the anchor, so high-water fees locked earlier in the block can fall. This is owner-only and timelocked. The fuzz already resets its monotonicity check here. | `test_r2_T05_configUpdateMidBlockResetsHighWater` | Document, or keep the gaps and reset only k/stale. |
| N-13 | Info | :166, :428-435 | Calibration is keyed by node only (global), while the allowlist, `minSamples` and Brier threshold are per pool. A node seasoned anywhere gets instant (step-limited) power on any pool that allowlists it, and a demotion applies on every pool. The owner's `setModelAllowed` is instant, so the owner can disallow every node and push the pool to stale / `conservativeFee`. That is a bounded DoS, because `conservativeFee` itself is timelocked. | `test_r2_R01_calibrationIsGlobal` | Document. Per-pool calibration (`_calibration[pool][node]`) would match the per-pool gates. |

### N-01 quantified (default config: base 3,000, k 5,000, feeMax 10,000; 1 ETH ≈ $2,500 retail trade)

The block sequence is: the whale moves the pool G away (pays base), the arb restores it to the mid (pays base + k·G), then retail trades in the arb direction later in the same block.

| G | High-water gap (pips) | Retail fee, arb dir (pips) | vs base | Excess on a $2,500 trade | Live gap at retail |
|---|---|---|---|---|---|
| 0.5% | 4,999 | 5,499 | 1.83× | $6.25 | ~0 |
| 1.0% | 9,999 | 7,999 | 2.67× | $12.50 | ~0 |
| 2.0% | 19,999 | 10,000 (cap) | 3.33× | $17.50 | ~0 |

- The opposite-direction retail trade paid ~3,990 pips. That is the correct live-gap charge, because the 1 ETH arb-direction trade had itself moved the pool ~0.2% past the mid.
- **Who pays:** the in-block retail trader, in the displaced toward direction. **Who gains:** the LPs.
- The effect is bounded by `feeMax` and lasts one block. Without the running max (plain live gap), retail would pay base in this case, but a split arb would then pay about half.

## 3. New surface: other checks (no issue)

- **Queue with different params.** Impossible: a different param set queues a new entry and does not execute (`test_r2_T02`).
- **Replay after execution.** Re-queues instead of executing (`test_r2_T02`).
- **Cancel race.** `cancelQueued` is owner-only, so there is no third party to race.
- **Owner bypass.** Not found for the timelocked setters. `registerPool` only works before initialization. `setModelAllowed` is instant but bounded (a new node is unseasoned, and a seasoned node is limited to `[kMin, kMax]` and step-limited).
- **Same-block attestation lowering fees.** Never, for either direction (`test_r2_A01`, `_checkMonotone` in the 3,000-run sequence fuzz, `test_fix_R05_laterAttestationNeverLowersFee`). k in the anchor only rises.
- **Reverts in `beforeSwap` / `afterSwap`.** None found:
  - `_liveAnchor` is pure math on a mid in (0, 2^224) plus a `getSlot0` extsload.
  - `_fee` casts are bounded by `feeMax` and by gaps ≤ 1e6.
  - `_flushPenalty` is guarded by `getLiquidity`.
  - Invariant runs with 25.6k calls per invariant (random swaps, splits, attestations, rolls, calibration writes, JIT add/remove that parks and flushes penalties) found 0 hook-originated reverts. The only swap reverts seen were PoolManager's `PriceLimitAlreadyExceeded` from the test router's split, raised before the hook runs. They are excluded.
- **ERC-6909 accounting (invariant).** `balanceOf(hook, c) == pendingPenalty(c) + OZ withheld fees(c)` held exactly across all runs, with parks and flushes exercised.
- **Fee bounds (invariant).** Quotes stay ≤ feeMax and ≥ min(base, conservative). Stored k stays in `[kMin, kMax]`. Every Receipt obeys the fee law with its own (gap, k), and the first receipt of each swap equals the prior `quoteFee`.
- **Split resistance.** Holds (3,004-run fuzz). Cross-block splitting (closing half the gap per block) pays about 75% of the one-shot fee. This is inherent to per-block anchoring and costs the arb a block of exposure (Info).

## 4. Size and gas

**Size.** `OniblockHook` runtime is **20,511 B** (4,065 B headroom) and initcode is 22,692 B. This matches FIXES_1. The v4core-profile artifact (26,690 B) is only produced because of DeployBench (N-11).

**Gas** (`test_gas_swapWithHook_vsHookless`):

| Swap | Gas |
|---|---|
| Hookless 0.30% | 59,900 |
| Oniblock, first in block | 78,646 (+18.7k) |
| Oniblock, later in block | 54,363 |

**High-water paths** (`test_r2_gas_highWaterPaths`, same-slot warm conditions):

| Path | Gas |
|---|---|
| First in block | 59,112 |
| Later, no high-water change | 54,641 |
| Later, high-water raise (one extra SSTORE to a warm slot) | 56,039 (+1.4k) |
| `quoteFee` (view) | 6,140 |

The running max is cheap: storage is written only when a mark rises.

## 5. Tests added

- `contracts/test/review2/Review2Findings.t.sol` (18 tests, including one fuzz): R-01 variants, the high-water economics, split and dust resistance, same-block attestation behaviour, the stale freeze, the timelock semantics, and gas.
- `contracts/test/review2/Review2Invariants.t.sol` (3 invariants and a handler): claims == pending + withheld; fee law, no revert and quote == executed; fee and k bounds.
