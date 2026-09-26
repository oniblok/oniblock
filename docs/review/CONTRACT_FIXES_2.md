# Oniblock contract fixes #2 (response to CONTRACT_REVIEW_2.md)

## Status

All checks pass:

- `forge test`: **83 passed, 0 failed, 1 skipped** (the fork suite).
- `FOUNDRY_FUZZ_RUNS=2000 FOUNDRY_INVARIANT_RUNS=256 FOUNDRY_INVARIANT_DEPTH=100 forge test`: 83 passed, 1 skipped.
  - The round-1 sequence fuzz ran 2,006 runs.
  - The 3 invariants ran 25,600 calls each.
- `testFuzz_r2_R02_splitNeverCheaper` also passes at 5,007 runs.
- `forge build --sizes` exits 0, and every artifact is under 24,576 B.
- `smoke-local.sh 8571`: **SMOKE OK**.
- Services local e2e (`--port 8572 --out ../deployments/31337.e2e.json`): **PASS**. 61 blocks, 57 attestations, 20 receipts (12 arb), 0 fee-law failures.
- Services `tsc` is clean, and `OFFLINE=1 vitest` gives 45 passed, 4 skipped.
- No git operations and no broadcasts outside local anvil. Every anvil I started has been stopped.

## ABI / deploy changes for downstream agents

| What | Change |
|---|---|
| External ABI | **Unchanged**, except for one new view, `TIMELOCK_GRACE() → uint256` (= 86,400). `abis/OniblockHook.json` was diffed against the previous export: nothing removed, only that one entry added. `setAttestation`, `setCalibration`, `kFromScore`, `quoteFee`, `isDemoted`, `calibration`, `attestationDigest`, `poolState` (including the `Anchor` tuple layout), `Receipt`, `AttestationPosted` and `CalibrationUpdated` are byte-identical. |
| `PoolConfig.minSamples` | Must be **≥ 1**; `registerPool` and `updatePoolConfig` revert `InvalidConfig` on 0. DeployBase defaults to 10, `demo-local.sh` to 3 and the benchmark to 3 or 10, so none are affected. **Benchmark agent:** do not pass `--min-samples 0` / `MIN_SAMPLES=0`; use 1. |
| Timelock | A queued entry can be executed only within `[eta, eta + 1 day]`. After that, the same call re-queues it (a fresh `ChangeQueued` and the full delay). With `configDelay = 0` (local), nothing changes. |
| Receipt semantics | `arbDir` is true only when the live price was ≥ 1 pip on the arbitrage side of the mid. In a block un-staled by a same-block attestation, `feePips` can be `conservativeFee` when the law gives less (see N-07). |
| `script/DeployBase.s.sol` | `_deployHook` now mines the CREATE2 salt with an allocation-free loop (`_mineHookSalt`) instead of v4-periphery `HookMiner`. With the new initcode, HookMiner's per-iteration re-hash and allocation hit `MemoryOOG` in `DeployLocal`. The resulting address is the same kind (flags-matched CREATE2 through the factory); only the search is cheaper. `DeployBench` inherits the fix through `_deployHook`. |
| `services/src/e2e/run-local.ts` | The fee-law check accepts the N-07 floor (`fee == conservativeFee > law`). There is a new flag, `--conservative-fee` (default 5000). |

## Changes, per finding

### N-01: live-side check (partial fix, as the reviewer recommended)

- `_liveAnchor` now also returns `toward`, the direction that moves the **live** price toward the anchor's mid. It is 0 when the anchor is stale or when the live gap floors to 0 pips.
- `_fee(cfg, anc, zeroForOne, toward)` charges the high-water law only if `toward` equals this direction. Otherwise the swap pays `baseFee`, whatever the block's high-water mark.
- `quoteFee` and `beforeSwap` use the same computation.
- `beforeSwap` hands `(fee, arbDir, gap)` to `afterSwap` through one transient slot (`tstore`/`tload`, cancun). By `afterSwap` the price has moved, so the Receipt could not re-derive them. The Receipt is therefore exactly the executed fee.

**Split resistance.** Every part of a split arb starts while the live gap is still > 0, so it pays the running-max fee.

`testFuzz_r2_R02_splitNeverCheaper` now compares against the honest decomposition:
- the toward part up to the mid pays the law fee;
- the remainder past the mid is not an arbitrage and pays base;
- this equals one swap whenever the amount does not reach the mid.

It asserts two things. A 2–6-way split never beats that decomposition. When the amount does not reach the mid, a split never beats the single swap.

One tolerance remains. The < 1 pip dead-band at the mid lets a split buy the last < 1e-6 of price movement at base, which is at most 1 ppm of output. I kept the dead-band so that "back at the mid" does not depend on sqrt rounding.

Two behaviour changes follow from this fix:
- An overshooting one-shot still pays the arb fee on its whole size. A split pays it only up to the mid. This is intended, and it is why `test_perBlockAnchor_splitSwapsDoNotReduceLpRevenue` now uses a 3 ETH swap that does not overshoot.
- Fees in a direction can now fall within a block, but **only to the non-arbitrage fee** (base, or the N-07 floor), and only once the live price is at or past the mid. The round-1 `_checkMonotone` was updated to match.

**Residual N-02.** A dominant LP can still leave the pool at mid + ε after a round trip. The toward direction then pays the high-water fee for the rest of the block. This is documented in the NatSpec and in DESIGN.md §12, and asserted in `test_r2_R02_dominantLP_residual_N02`: at mid + 0.1%, the toward direction is at feeMax 10,000, where 3,500 would be fair.

Before and after, from `test_r2_R02_retailAfterWhaleAndArb_paysBase_fixed`:

| G | Arb fee | Retail fee in the arb direction, before | Retail fee, after |
|---|---|---|---|
| 0.5% | 5,499 | 5,499 | **3,000** |
| 1.0% | 7,999 | 7,999 | **3,000** |
| 2.0% | 10,000 | 10,000 | **3,000** |

The overshoot case (`test_r2_R02_overshoot_onlyLiveTowardElevated_fixed`):
- At −1% after a +1% displacement, only the direction that moves the live price back toward the mid is elevated (8,000). The other direction pays 3,000.
- Back at the mid, both directions pay 3,000.

### N-04: `minSamples ≥ 1`

- `_validateConfig` now rejects `minSamples == 0`.
- Test: `test_r2_R01_minSamplesZero_rejected_fixed`.
  - Both `registerPool` and `updatePoolConfig` revert.
  - With `minSamples = 1`, a settler reset to n = 0 keeps the node demoted, and a fresh node has no power.
- The round-1 fuzz now bounds `minSamples` to `[1, 20]`.

### N-07: a stale first touch no longer freezes the block

- `setAttestation`: if this block's anchor is stale, the new attestation un-stales it. The anchor takes the new k, model and attest block, and sets `conservativeFloor`.
- `_fee` then floors every fee at `conservativeFee` for the rest of that block, which is what the block had already charged.
- Test: `test_r2_A03_staleDust_freshAttestationUnstales_fixed`.
  - After a dust front-run and the keeper's 3% attestation, the arb direction pays 10,000 (feeMax, by the law) instead of 5,000.
  - The non-arb direction pays 5,000 (the floor).
  - The Receipt is non-stale and credits the fresh model.
  - The next block is back to base 3,000.

### N-05: each Receipt reflects exactly one attestation

- The anchor's `(k, model, mid)` now move together.
- Same-block attestation with **k ≥ anchored k**: it takes over all three. The high-water gaps are kept, and `pinnedMid` is cleared, so gaps are measured against the new mid.
- Same-block attestation with **k < anchored k**: the stored state updates for the next block, but the anchor keeps its own mid. The old mid is copied once into `_pinnedMid[id]` and `pinnedMid` is set.
- `_liveAnchor` reads `_pinnedMid` only when that flag is set, which happens only in this rare case, so there is no extra SLOAD on the normal path.
- Tests:
  - `test_r2_A02_lowerKAttestation_doesNotMixAttribution_fixed`. The Receipt after a lower-k MODEL2 post is non-arb against MODEL's mid (k 6000, MODEL). The next block uses MODEL2's k, model and mid.
  - `test_r2_A01_sameBlockAttestation_lowerKPinned_higherKTakesOver`. A lower-k post changes neither direction in the block.

**Storage note.** The external `Anchor` struct returned by `poolState` is unchanged. Internally the anchor is a `BlockAnchor`: the same fields plus two bools (`conservativeFloor`, `pinnedMid`), packed into the same first slot (31/32 bytes). `poolState` converts it to `Anchor`. The new `_pinnedMid` mapping is declared after all existing storage.

### N-08: timelock grace window, and N-09 documented

- `_timelocked`: an entry with `block.timestamp > eta + TIMELOCK_GRACE` (1 day) re-queues (a new `ChangeQueued`, eta = now + delay) instead of executing.
- Test: `test_r2_T01_queuedChangeExpires_fixed`.
  - A year-old entry does not execute and re-queues with a full delay.
  - The entry executes at exactly `eta + grace`.
  - The entry re-queues at `eta + grace + 1`.
- N-09 (non-canonical calldata ids; entries survive `transferOwnership`, so a new owner should cancel stale ones) is documented in the NatSpec on `cancelQueued` and in DESIGN.md §12. `test_r2_T03` and `test_r2_T04` still reproduce.

### Documented, not changed: N-03, N-06, N-10, N-12, N-13

These are covered in the contract-level NatSpec ("Trust model") and in the new **DESIGN.md §12 "Known limitations / trust assumptions"**:
- attestor trust, including relabelling to another seasoned node;
- same-block attestations that can raise the other direction (and, after N-01, drop the old arb direction to base when the new mid is on the other side);
- the double k step;
- a config update mid-block that clears the anchor;
- calibration that is global per model node;
- owner's instant `setModelAllowed` (bounded DoS).

The PoCs still reproduce: `test_r2_R01_keeperRelabelsScoresAsOtherSeasonedNode`, `test_r2_A01` (second half), `test_r2_A04_twoAttestationsOneBlock_doubleStep`, `test_r2_T05_configUpdateMidBlockResetsHighWater` and `test_r2_R01_calibrationIsGlobal`.

### Tests updated

- `test/review2/Review2Findings.t.sol`: fixed findings now assert the fixed behaviour (`*_fixed`). N-02 asserts the documented residual. The split fuzz uses the honest-decomposition reference.
- `test/review2/Review2Invariants.t.sol` and the round-1 sequence fuzz: the fee law accepts `fee == law`, or `fee == conservativeFee` when conservativeFee > law (N-07 floor). The non-arb fee must be base. The quote is compared against the **first** Receipt of a split: later parts that start past the mid pay base. `_checkMonotone` allows a drop only to the non-arb fee.
- `test/OniblockHook.t.sol`:
  - `test_perBlockAnchor_splitSwapsDoNotReduceLpRevenue` now uses 3 ETH, which does not overshoot.
  - `test_anchor_sameDirKeepsAnchor_reverseAfterOvershootPricedLive`: after an overshoot, the same direction pays base.

## Size

| Artifact | Runtime | Initcode | Runtime margin |
|---|---|---|---|
| OniblockHook, FIXES_1 | 20,511 | 22,692 | 4,065 |
| **OniblockHook, now** | **21,349** | **23,530** | **3,227** |

`forge build --sizes` exits 0. No artifact exceeds 24,576 B. N-11 was resolved by the bench agent: `DeployBench` uses `_deployPoolManager`, so no v4core-profile hook is built.

## Gas

From `test_gas_swapWithHook_vsHookless` and `test_r2_gas_highWaterPaths`:

| Path | FIXES_1 / review 2 | Now |
|---|---|---|
| Hookless swap, 0.30% | 59,900 | 59,900 |
| Oniblock, first in block | 78,646 | **77,680** |
| Oniblock, later in block | 54,363 | **53,248** |
| High-water paths: first in block | 59,112 | 58,126 |
| High-water paths: later, no change | 54,641 | 53,538 |
| High-water paths: later, high-water raise | 56,039 | 55,066 |
| `quoteFee` (view) | 6,140 | 6,404 |

Swaps are about 1k cheaper, because `afterSwap` no longer reloads the config and recomputes the fee law; it reads one transient slot. `quoteFee` costs about 260 gas more for the extra `toward` logic.
