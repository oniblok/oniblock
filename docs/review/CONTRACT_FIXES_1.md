# Oniblock contract fixes #1 (response to CONTRACT_REVIEW_1.md)

Status: all review items addressed except R-08, which is documented only. `forge test` gives 62 passed, 1 skipped (the fork suite). The same holds with `FOUNDRY_FUZZ_RUNS=2000`, where the review sequence fuzz ran 2,004 runs × 16 steps. `smoke-local.sh` passes. The services local e2e passes, and so do the services unit tests (`OFFLINE=1`, 45 passed, 4 skipped) and `tsc`.

## CHANGELOG for downstream agents (ABI / deploy changes)

**Unchanged (services depend on these):** `setAttestation`, `setCalibration`, `kFromScore`, `quoteFee`, `isDemoted`, `calibration`, `attestor`, `attestationDigest`, `domainSeparator`, `eip712Domain`, `chainlinkPriceX96`, `pendingPenalty0/1`, and the events `AttestationPosted`, `Receipt` and `CalibrationUpdated`. Their signatures are byte-for-byte the same, as are the EIP-712 domain and type.

**Changed:**

| What | Change |
|---|---|
| `struct PoolConfig` | Two fields appended: `uint32 minSamples`, `uint32 chainlinkMaxAge`. This changes the selectors of `registerPool` and `updatePoolConfig`, the `poolConfig()` return value, and the `PoolRegistered` / `PoolConfigUpdated` event signatures. Solidity code that sets fields by name (`c.x = …`) still compiles; the two new fields default to 0 (0 = no probation; 0 max age is invalid only if a feed is set). |
| `struct Anchor` (returned by `poolState`) | Now `{uint64 blockNumber, bool stale, uint32 kBps, uint32 gapZeroForOne, uint32 gapOneForZero, uint64 attestBlock, bytes32 modelNode}`. The old fields `hasArb`, `arbZeroForOne`, `arbFee` and `gapPips` are gone. Derive the fee with `quoteFee`. |
| constructor | Extra last argument `uint256 _configDelay` (timelock in seconds). `DeployBase.Deployed` gained `configDelay` and `bytes32[] modelNodes`; `_deployHook(d)` passes them through. |
| removed | `CHAINLINK_MAX_AGE()` constant. Max age is now `PoolConfig.chainlinkMaxAge`. |
| added functions | `setModelAllowed(bytes32 poolId, bytes32 modelNode, bool)` (owner), `modelAllowed(bytes32, bytes32) → bool`, `configDelay() → uint256`, `queuedEta(bytes32) → uint256`, `cancelQueued(bytes32)` (owner). |
| added events / errors | `ModelAllowed(bytes32 indexed id, bytes32 indexed modelNode, bool)`, `ChangeQueued(bytes32 indexed id, uint256 eta, bytes data)`, `ChangeCancelled(bytes32 indexed id)`; `ModelNotAllowed()`, `TimelockNotReady(uint256 eta)`. |
| behaviour | `setAttestation` reverts with `ModelNotAllowed` for a model node that is not allowlisted. `isDemoted` / `kFromScore` treat non-allowlisted **and unseasoned** (`n < minSamples`) nodes as demoted (kDefault). A `stale` Receipt now carries `modelNode = 0`. A newer attestation (higher `blockNumber`) may be posted in a block that already has one. |
| deployments/31337.json | New keys: `modelNode` (namehash of jev-v1, which the keeper picks up as its primary node), `allowedModelNodes`, `configDelay`, and `pools.oniblock.config.minSamples` / `chainlinkMaxAge`. |
| DeployLocal / DeployBase | The hook is allowlisted for `namehash(jev-v1.models.oniblock.eth)` = `0x32a8…cdcf` and `namehash(heuristic-v1.models.oniblock.eth)`; override with `MODEL_NODES=0x..,0x..`. Env `MIN_SAMPLES` (default 10), `CHAINLINK_MAX_AGE` (default 7200), `CONFIG_DELAY` (local default 0, Sepolia default 3600). PoolManager is deployed through `DeployBase._deployPoolManager(owner)`: the artifact initcode goes via the CREATE2 factory, and PoolManager.sol is not imported. |
| services | `services/src/abi/oniblockHook.ts` gained `modelAllowed` plus error entries (`ModelNotAllowed`, `AlreadyAttested`, …) so keeper reverts decode. No other change was needed. |

**ACTION for the benchmark agent (`contracts/script/bench/DeployBench.s.sol`, not edited by me):** the script still does `import {PoolManager}` + `new PoolManager(...)`. That compiles `OniblockHook` in the 44M-run profile, which is now **26,690 B (over EIP-170)**, so the hook deployment in that script will revert on a default anvil. `forge build --sizes` also exits non-zero because of that one artifact (`OniblockHook.v4core`); plain `forge build` / `forge test` are fine. Fix: delete the PoolManager import and use `d.manager = _deployPoolManager(d.deployer);` from DeployBase. Its existing low-level `setModelAllowed(bytes32,bytes32,bool)` call matches the new ABI. Pass `MODEL_NODES`, and note that models on the `model`/`gated` pools start **unseasoned (kDefault)** until the settler writes `n >= MIN_SAMPLES`. Set `MIN_SAMPLES=0` in the bench env to reproduce the pre-fix behaviour.

## What changed, per finding

### R-11: bytecode headroom (done first)
- `test/utils/OniblockTestBase.sol` no longer uses v4-core `Deployers`, which imports PoolManager.sol. It deploys PoolManager with `deployCode("out/PoolManager.sol/PoolManager.json")` and builds `PoolModifyLiquidityTest` / `PoolSwapTest` itself.
- `script/V4CoreArtifacts.sol` imports only PoolManager, so its artifact is still built in its own 44M-run profile.
- `DeployLocal` deploys PoolManager from that artifact through the CREATE2 factory, because forge 1.3.5 does not broadcast `vm.deployCode`.
- Result: tests, DeployLocal, smoke, e2e and DeploySepolia all use the **same default-profile (800 runs) hook bytecode**.
- **Final hook size: 20,511 B runtime (4,065 B headroom), 22,692 B initcode.** Before: 18,841 B at 800 runs, and 24,235 B for the 44M build used locally.

### R-01 (High): calibration gate bypass
- There is now a per-pool model allowlist, managed by the owner and applied instantly: `setModelAllowed(poolId, node, bool)`. `setAttestation` rejects non-allowlisted nodes (`ModelNotAllowed`).
- Probation: `isDemoted` is true when the node is not allowlisted, or when `calibration.n < PoolConfig.minSamples`, or (as before) when Brier > `brierDemoteBps` with n > 0. A demoted node gets k = kDefault immediately; the step limit does not apply to demotion.
- A demoted model therefore cannot regain power by rotating nodes: the new node is either rejected or unseasoned. The settler writing `n = 0` also puts the model back on probation.
- Tests: `test_fix_R01_rotationToNewNode_rejected`, `…_allowedButUnseasoned_cappedAtKDefault`, `…_seasonedGoodModel_reachesComputedK` (6000 → 7000 → 8000), `…_demotedStaysDemoted`, `…_setModelAllowed_guards`.
- Trust assumption, stated plainly: the attestor key (a TEE stand-in, held by the keeper today) is trusted to report the mid within the Chainlink band. The allowlist bounds *which* identities it can claim, and probation bounds the power of a new one.

### R-03: receipt attribution
- The anchor now stores `kBps`, `attestBlock` and `modelNode` of the attestation in force. `Receipt.modelNode` is `anchor.modelNode`, so it always matches `Receipt.kBps`. The event signature is unchanged.
- A later attestation in the same block takes over the anchor only if its k is ≥ the anchored k (see R-05). A stale receipt carries `modelNode = 0`.
- Settler note: `poolState().anchor.attestBlock` identifies the exact attestation. The settler's existing lookup by (block, modelNode) is correct for the common case.
- Tests: `test_fix_R03_receiptModelNode_matchesAnchor`, `test_fix_R03_R05_higherKAttestationTakesOverAnchor`, `test_fix_R03_staleReceipt_noModel`.

### R-02 + R-05: intra-block displacement and the dust-swap freeze
New fee law: a per-block, **per-direction high-water gap**.
- Before every swap, and in every quote, the live gap against the stored mid is measured, and the toward-oracle direction's gap becomes `max(stored, live)`. The gaps reset on the first touch of a new block.
- `fee(dir) = gap[dir] > 0 ? min(base + gap[dir]·k/1e4, feeMax) : base`.

Consequences:
- The anchored direction keeps its fee: a split arb pays the first sub-swap's fee on every part.
- The reverse direction after a displacement or overshoot is priced from the live gap, and that price cannot shrink under splitting because it becomes a high-water mark once a swap locks it.
- A keeper attestation after a dust swap takes effect for the rest of the block: the new mid feeds the live gap, and a higher k takes over the anchor. Fees never fall within a block once a swap has locked them.

Other points:
- `quoteFee` runs exactly the same computation, so quote == executed, as asserted by the fuzz.
- Every Receipt satisfies the fee law with the `(gapPips, kBps)` it reports, which is what the services e2e checks.
- Costs: one `getSlot0` per swap (warm), plus one SSTORE only when a high-water mark rises.
- Tests: `test_fix_R02_intraBlockDisplacement_backrunPaysLiveGap` (a split backrun: 4 receipts, all at the live-gap fee), `test_fix_R05_dustSwapNoLongerFreezesOldMid`, `test_fix_R05_laterAttestationNeverLowersFee`, and the updated `test_anchor_sameDirKeepsAnchor_reverseAfterOvershootPricedLive`. The existing split test is unchanged and green.
- Documented retail cost (R-12): same-direction retail later in the block still pays the anchored fee, and quotes made before any swap in a block are not binding.

### R-06: config update
When `updatePoolConfig` executes, it clamps the stored k into `[kMin, kMax]` and deletes the current anchor, so the next swap re-anchors under the new config. Test: `test_fix_R06_updatePoolConfig_clampsK_clearsAnchor`.

### R-04: timelock
- `updatePoolConfig`, `setAttestor` and `setRoleOracle` are timelocked by the immutable `configDelay`, with **no change to their signatures**.
- The first call is validated, then queued under `keccak256(calldata)`; it emits `ChangeQueued(id, eta, calldata)` and changes nothing else. The identical call after the delay executes. `cancelQueued(id)` removes a queued call.
- `configDelay` is 0 locally and 3600 s by default on Sepolia.
- Not timelocked: `registerPool` (pre-initialize only) and `setModelAllowed`. Disallowing a model is a safety action, and allowing one starts it on probation.
- ENS role revocation, the kill switch, stays instant.
- Still open: the `EnsV2RoleOracle` owner can repoint role refs instantly, and the settler can write any calibration (ENS-gated by design). Recommended for Sepolia: transfer hook ownership (Ownable2Step) to a Safe.
- Test: `test_fix_R04_timelock_queueExecuteCancel`.

### R-09: DeploySepolia ENS defaults
DeploySepolia first reuses the `roleOracle` recorded by EnsSetup in `deployments/<chainId>.ens.json`, or the one given by `ROLE_ORACLE`. Otherwise it builds a new `EnsV2RoleOracle`:
- `ENS_ROLE_REGISTRY` is required and must be nonzero.
- `ENS_QUOTER_LABEL_ID` / `ENS_SETTLER_LABEL_ID` default to `EnsV2Lib.labelId("quoter"/"settler")`.
- The role bits default to `1<<64` / `1<<68`.
- The ROOT resource (0) is refused.
- Nothing was broadcast.

### R-10: Chainlink
- `PoolConfig.chainlinkMaxAge` replaces the old constant; the deploy default is 2 h, and it is required when a feed is set.
- The default sanity band is 200 bps in both deploy scripts.
- `registerPool` reverts if a feed is configured and a token's `decimals()` cannot be read.
- Test: `test_fix_R10_chainlinkMaxAgeConfig_andStrictDecimals`.

### R-07 / R-08
- R-07: the "one post per block" rule is gone. Any attestation with a strictly newer `blockNumber` (current or previous block) is accepted, so a stale block-1 attestation can no longer burn the slot. Test: `test_fix_R07_newerAttestationReplacesOlder`.
- R-08: **documented, not changed.** A parked penalty goes to whatever liquidity is in range at the next swap. A JIT with an old out-of-range position can steer it to itself, at the cost of moving the price. Delaying the flush would not stop an aged position, so it was not implemented. Mitigation: use a large `blockNumberOffset` in thin pools. The PoC `test_poc_R08_parkedPenaltyRedirectedToOwnOldPosition` still reproduces and is kept as a marker.

### R-12
NatSpec now covers the fee law, Receipt semantics (LP fee only; sender = the router; swapper sign convention; stale = no model), the trust model, the timelock, probation and the R-08 caveat. `SplitSwapRouter` is still for tests and bots only.

Also removed: the redundant `isDynamicFee` check in `_afterInitialize` (enforced in `beforeInitialize`) and the redundant `signer == 0` check (`tryRecover` never returns 0 without an error).

## Evidence

- `forge test`: 62 passed, 0 failed, 1 skipped. The same holds with `FOUNDRY_FUZZ_RUNS=2000`.
- The sequence fuzz `testFuzz_review_swapPathNeverReverts_quoteMatches` is extended. Random steps cover:
  - attestations, including block-1 then newer same-block ones, from both models;
  - allowlist toggles;
  - seasoned / unseasoned / bad calibrations;
  - config updates, including `minSamples`;
  - JIT add/remove, rolls, and split swaps in both directions.

  Asserted on every step:
  - the swap path never reverts;
  - quote == executed;
  - every Receipt obeys the fee law with its own (gap, k);
  - k stays within bounds after a config update;
  - a fee locked in by an executed swap never falls within the block.
- `./smoke-local.sh 8561`: SMOKE OK. The Receipt shows arbDir=1, gap 10101, k 5000 (the jev node is unseasoned, so kDefault), fee 8050, modelNode = namehash(jev-v1).
- `pnpm -C services e2e -- --port 8570 --out ../deployments/31337.e2e.json`: **PASS**, with 61 blocks, 58 attestations, 20 receipts (14 arb), 0 fee-law violations and calibration updates.
  - The jev node stayed on probation (kDefault) until the settler reached n=13, which happened after the degradation at step 36. Its Brier was then 3467 > 2500, so it was demoted.
  - A second run with `MIN_SAMPLES=3` also passed: from its first seasoned record (Brier 3368 at n=5) onward it stayed demoted at k=5000.
  - For a demo in which the model visibly **gains** power before degrading, deploy with a small `MIN_SAMPLES` (e.g. 3) and/or run more blocks. With the default of 10 and ~1 labelled block per 2–4 blocks, seasoning takes 20–40 blocks.
- Gas (`test_gas_swapWithHook_vsHookless`):

  | swap | gas |
  |---|---|
  | hookless 0.30% | 59,900 |
  | Oniblock, first in block | 78,646 (+18.7k; before: +17.1k) |
  | Oniblock, later in block | 54,363 (before: 50.7k; now includes the live-gap read) |
