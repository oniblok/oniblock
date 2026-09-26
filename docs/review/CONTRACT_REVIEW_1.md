# Oniblock contract review #1

> Note (later change): the `minSamples` probation ("unseasoned") described in this historic document has since been removed from the hook; the calibration gate is now the pool allowlist + Brier demotion only, and a model with no calibration record is active.

Scope: `contracts/src/OniblockHook.sol`, `src/roles/*`, `src/periphery/SplitSwapRouter.sol`, `src/libraries/PriceMath.sol`, `script/*`, and the existing tests, checked against `docs/BUILD_SPEC.md`, `docs/DESIGN.md` and `docs/ENS_INTEGRATION.md`.
Method: manual review plus PoC tests in `contracts/test/review/ReviewFindings.t.sol`. Each PoC **passes when the finding reproduces**. The suite also has a sequence fuzz with 3,000 runs.
Status: `forge test` gives 53 passed, 1 skipped (the fork suite). No `src/` file was modified.

No Critical findings. The v4 plumbing is sound: permissions, the override flag, delta accounting in the merged penalty logic, and no reverts in the swap path. The main problems are in the **mechanism claims**: the calibration gate can be bypassed, the anchor handles intra-block displacement badly, and receipts can credit the wrong model. There are also some centralization and spec gaps.

---

## Findings

| ID | Sev | Where | Title | PoC |
|---|---|---|---|---|
| R-01 | **High** | OniblockHook.sol:287-297, 326-345 | Calibration gate bypass: an uncalibrated / rotated modelNode escapes demotion | `test_poc_R01_modelNodeRotation_escapesDemotion` |
| R-02 | Medium | OniblockHook.sol:442-455, 537-572 | Intra-block displacement: the reverse-direction arb pays baseFee for the rest of the block | `test_poc_R02_intraBlockDisplacement_backrunPaysBase` |
| R-03 | Medium | OniblockHook.sol:466-479 (477) | Receipt.modelNode comes from live state, while gap/k come from the anchor, so calibration can be credited to the wrong model | `test_poc_R03_receiptModelNode_misattributed` |
| R-04 | Medium | OniblockHook.sol:241-256, 313-318 | Owner and settler powers are instant (no timelock); the "no admin step" claim does not hold | — |
| R-05 | Low | OniblockHook.sol:449-452 | A dust swap before the keeper's attestation freezes the old mid for the whole block | `test_poc_R04_dustSwapFreezesOldMidForBlock` |
| R-06 | Low | OniblockHook.sol:241-246 | `updatePoolConfig` does not clamp the stored k or the current anchor | `test_poc_R05_updatePoolConfig_kNotClamped` |
| R-07 | Low | OniblockHook.sol:270-273 | One slot per block, and a (block-1) attestation is still valid, so a second quoter can burn the slot | `test_poc_R06_olderAttestationBlocksFreshOne` |
| R-08 | Low | OniblockHook.sol:507-512, 622-633 | The parked penalty goes to whoever is in range at the next swap, so a JIT can redirect it to its own old position | `test_poc_R07_parkedPenaltyRedirectedToOwnOldPosition` |
| R-09 | Low | script/DeploySepolia.s.sol (RoleRef defaults) | ENS resource defaults to `0` (the ROOT resource), not the labelhash; the comment says "resource" | — |
| R-10 | Low | OniblockHook.sol:127, 577-620 | Chainlink max age is 1 day, and the band is wide relative to feeMax (quoter/attestor griefing room) | — |
| R-11 | Low / ops | foundry.toml, script/DeployLocal.s.sol | The hook deployed by DeployLocal and the tests is the 44M-run build (24,235 B, 341 B headroom) | — |
| R-12 | Info | various | Smaller notes (Receipt semantics, quote vs. execution across blocks, redundant checks, router footguns) | — |

---

### R-01 (High): the calibration gate can be escaped by rotating `modelNode`

**Where.** `isDemoted` (OniblockHook.sol:341-345) returns false when `c.n == 0`. `modelNode` is a free field of the attestation (:80), chosen by whoever holds the attestor key. In `services/src/keeper.ts` the attestor key lives in the keeper process: `MODEL_NODE` env, and the `fallback` node when Jev fails.

**Issue.** The settler demotes node A. The keeper then signs the next attestations with node B, which has no calibration record, so B is never demoted. `kFromScore` gives B full `[kMin, kMax]` power immediately. The stored k only has to climb from `kDefault` by `maxKStepBps` per block: 5000 → 8000 in 3 blocks with the default config. "A model that gets it wrong loses its job automatically" is therefore only true while the operator keeps posting under the same name. The same gap lets a brand-new model have full power before it has any track record ("n == 0 not demoted").

The keeper already switches between `primary` and `fallback` nodes each block depending on Jev availability. Each node is judged separately, which is fine, but nothing on-chain ties either node to an allowed set.

**PoC.** `test_poc_R01_modelNodeRotation_escapesDemotion`: MODEL is demoted, MODEL2 posts identical scores, and k reaches 8000 after 3 blocks.

**Fix.** Any of these, cheapest first:
1. **Probation.** A node with `n < minSamples` (a new config field) is treated like a demoted one, getting `kDefault` or a tighter `[kDefault ± probationBand]`. Uncalibrated models then have no extra power. This is the simplest honest version of the gate.
2. **Allowlist nodes.** Add `setModelAllowed(bytes32 node, bool)`, gated by the settler role or an ENS check done off the swap path. Reject attestations for unknown nodes.
3. Make demotion **sticky per pool**. Keep `demotedUntilBlock[pool]` whenever a demoted node posts. Switching nodes during that window keeps kDefault.
4. In the README, state the trust assumption plainly: the attestor, a TEE stand-in, is trusted to report the true model identity. Today the keeper holds that key.

### R-02 (Medium): intra-block displacement makes the backrun arb pay base

**Where.** `_computeAnchor` fixes `arbZeroForOne` and `hasArb` from the price *before the first swap* (:549-559). `_feeFromAnchor` charges `baseFee` to every other direction for the rest of the block (:570-571).

**Issue.** In the PoC the oracle equals the pool price at block start (gap 0), and a big swap then pushes the pool more than 1% away. Any swap in the opposite direction moves the pool back toward the oracle, which is the arb direction, yet it pays only `baseFee` for the rest of the block. The same happens after an arb overshoots the oracle: re-alignment back across it pays base. The "directional" law is only evaluated once per block, so a same-block backrun of retail or overshoot flow escapes `k·gap`.

On the question of whether a user can pre-set the anchor in a favourable direction with a tiny reverse swap: **no**. The anchor is computed from the pre-swap price and ignores the direction of the first swap. Can an arb anchor a small gap with a tiny first swap? Also **no**: the tiny swap anchors the same pre-block gap the arb would have seen. The real leak is the post-displacement reverse direction shown above, plus R-05.

**PoC.** `test_poc_R02_intraBlockDisplacement_backrunPaysBase`: quoteFee(false) returns 3000 in the same block, and the next block classifies the same trade as arb at 10000.

**Fix.** Keep the anchor for the anchored direction, and price the other direction from the live gap. A "high-water" variant is also resistant to splitting. In `_beforeSwap`, when `zeroForOne != anc.arbZeroForOne` (or `!anc.hasArb`), compute the live gap. If the live pool price is on the side that makes this swap toward the oracle, charge `max(base, base + k·liveGap)`, capped. Optionally store a second anchor (`revFee`) the first time this happens in the block, so later reverse sub-swaps cannot shrink it. The cost is roughly one `getSlot0` and one `mulDiv` on reverse swaps only. Watch the size budget (R-11).

### R-03 (Medium): receipts can credit the wrong model

**Where.** `_afterSwap` emits `_state[id].modelNode` (:477), but `gapPips` and `kBps` come from the block anchor (:472-473).

**Issue.** The keeper targets `block+1` (`ATTEST_BLOCK_OFFSET=1`), so its attestation often lands *after* the first swap of a block. Every later swap in that block then emits a receipt naming the new model while its fee was computed from the previous attestation's k and mid. The settler scores the new model on decisions it did not make, and the gate acts on that score. The same mismatch applies to `pToxic`/`confidence` if the settler reads them from `AttestationPosted`.

**PoC.** `test_poc_R03_receiptModelNode_misattributed`: the receipt shows MODEL2 while k = 6000, which is MODEL's k.

**Fix.** Snapshot `modelNode` (and ideally `lastAttestBlock`) into the anchor, then emit `anc.modelNode` and `anc.attestBlock`. `Anchor` currently packs into 22 bytes, so a separate `bytes32` slot costs one extra SSTORE per block, not per swap. Alternatively emit `st.lastAttestBlock` as recorded at anchor time. In the settler, attribute each receipt through `attestBlock`. Also document that a `stale == true` receipt belongs to no model.

### R-04 (Medium, centralization / spec deviation): instant owner and settler powers

**Where.** `updatePoolConfig` (:241), `setAttestor` (:248), `setRoleOracle` (:253), `setCalibration` (:313).

**Issue.** The owner can do any of the following in a single transaction:
- set `baseFee = feeMax = 100000` (10% on every swap);
- set `brierDemoteBps = 0`, which switches the gate off;
- repoint `attestor` or `roleOracle` to itself, bypassing the ENS kill switch and gaining full control of mid and k;
- change the Chainlink feed.

DESIGN §2 promises "`k` bounds behind a timelock" and "no admin step". In `EnsV2RoleOracle`, the owner can also repoint the role refs (`setQuoterRole`). A settler can write any `n`, including `n = 0`, which un-demotes a model. The settler role is ENS-gated, which is the intended trust model.

**Fix.** For the hackathon, at minimum document it in the README. Better, add a queued config: `proposeConfig` / `applyConfig` after `CONFIG_DELAY` blocks, with an event, and the same for attestor and oracle. Setting the owner to a Safe helps too. Optionally make `brierDemoteBps` only tighten without a delay.

### R-05 (Low): a dust swap freezes the old mid for the block

**Where.** `_beforeSwap` anchors on the first swap of the block (:449-452). Attestations accepted later in the block are not used until the next block.

**Issue.** A searcher can place a 1-wei swap ahead of the keeper's `setAttestation`. Sepolia has a public mempool and priority-fee ordering. The block then keeps the old mid, and the searcher can read the new mid from the keeper's calldata and arb after it at the stale fee. This extends the documented "arb can land before the keeper" limit to the whole block.

**PoC.** `test_poc_R04_dustSwapFreezesOldMidForBlock`.

**Fix.** Either accept it and document it, or let `setAttestation` refresh the anchor when an anchor already exists for the current block and the new attestation yields a **higher** arb fee for the anchored direction (monotone-up only, so splitting stays defeated). The simplest version: in `setAttestation`, if `_anchor[id].blockNumber == block.number`, recompute and keep `max(old, new)` per direction.

### R-06 (Low): `updatePoolConfig` does not clamp k or the anchor

**Where.** OniblockHook.sol:241-246 (the NatSpec admits this).

**Issue.** After `kMax` is lowered, `st.kBps` stays above it and walks down only `maxKStepBps` per attestation. The PoC stays at 7000 after the new `kMax` of 3000. A config change in the middle of a block also leaves `anc.arbFee`, computed under the old `feeMax`, in force while `baseFee` and `conservativeFee` are read live.

**PoC.** `test_poc_R05_updatePoolConfig_kNotClamped`.

**Fix.** In `updatePoolConfig`, clamp `st.kBps` into `[kMin, kMax]` and invalidate the anchor (`delete _anchor[id]`).

### R-07 (Low): the one-per-block slot can be burned with an older attestation

**Where.** OniblockHook.sol:270-273.

**Issue.** A signed attestation for block B stays valid in B+1. Any address holding the quoter role (for example a backup keeper) can post the stale one first, and the fresh one then reverts with `AlreadyAttested`. This needs a second quoter or a compromised one, so it is griefing only.

**PoC.** `test_poc_R06_olderAttestationBlocksFreshOne`.

**Fix.** Allow a newer attestation to replace an older one within the same block (`a.blockNumber > st.lastAttestBlock` is enough, so drop the `lastPostBlock == block.number` clause). Or only accept `a.blockNumber == block.number` when a same-block post already exists.

### R-08 (Low): the parked JIT penalty can be redirected

**Where.** The park branch (:507-512) and `_flushPenalty` in `_afterSwap` (:480, :622-633).

**Delta accounting is correct.** Park: `take(claims)` gives −p, the return delta gives +p − w, and `settle(burn)` of the withheld amount gives +w, for a net of 0. Flush: `donate` gives −p and `burn` gives +p, for a net of 0. The claims can only be moved by hook logic; they cannot be drained or become inconsistent. They stay parked if the pool never regains in-range liquidity, which is acceptable.

**Economics.** The penalty goes to whoever is in range at *any later* swap. A JIT that holds an old, out-of-range, dust position can exit as the only in-range LP (the penalty is parked), then push the price into its own position and receive the whole penalty. The OZ original reverts the exit, so the JIT has to wait out the window or move the price *before* exiting. The cost of moving the price is the same either way. Parking adds flexibility over timing, and also means a swapper's `afterSwap` pays for the donate.

**PoC.** `test_poc_R07_parkedPenaltyRedirectedToOwnOldPosition`.

**Fix.** Pick one:
- Keep parking, but only flush to liquidity that was in range at park time. Hard to do.
- Keep parking, but flush only after `blockNumberOffset` blocks, so fresh liquidity is itself inside the penalty window and gets re-penalised.
- Donate to the *next add* instead.
- Simplest: document it next to OZ's multi-account warning and use a large `blockNumberOffset` in thin pools.

### R-09 (Low): the DeploySepolia ENS resource default is ROOT

**Where.** `script/DeploySepolia.s.sol`: `vm.envOr("ENS_QUOTER_RESOURCE", uint256(0))`.

**Issue.** If `ENS_ROLE_REGISTRY` is set but the resource is not, the oracle checks `hasRoles(0 /*ROOT*/, ROLE_QUOTER, a)`, i.e. whoever holds the bit on ROOT. ENS_INTEGRATION.md says "always pass the labelhash" and "never grant ROLE_QUOTER on ROOT". The script comment also says "EAC resource", and the versioned resource changes on re-registration. The role bit defaults (1<<64, 1<<68) **do** match the docs and `EnsV2Lib`. `EnsSetup.s.sol` builds its oracle correctly with `labelId`.

**Fix.** Default the resources to `EnsV2Lib.labelId("quoter")` / `labelId("settler")`, rename the env vars `*_LABEL_ID`, and require a nonzero registry when broadcasting. Better, reuse the oracle deployed by EnsSetup (`roleOracle` in `deployments/<chainId>.ens.json`).

### R-10 (Low): Chainlink sanity band

**Where.** OniblockHook.sol:127, 577-620.

**Checked and correct:** the conversion math for both orders and decimals (non-inverted `a·10^d1·2^96 / 10^(fd+d0)`, inverted `10^fd·10^d1·2^96 / (a·10^d0)`), overflow bounds (d ≤ 30, fd ≤ 36, a < 2^128), and the try/catch around `latestRoundData`.

**Issues:**
- `CHAINLINK_MAX_AGE = 1 days` is 24× the Sepolia ETH/USD heartbeat (about 1h).
- The deployed band is 500 bps (5%) while `feeMax` is 1%. Within the band, a quoter/attestor pair can set the mid anywhere in ±5%, choose which direction is "arb", and push that direction to `feeMax` while the truly toxic direction pays base.
- Tokens without `decimals()` silently fall back to 18 (:651).

**Fix.** Make the max age a config field (about 2 × heartbeat) and tighten the band (for example 1–2%). Document that the attestor is trusted within the band. Revert in `registerPool` when `decimals()` fails and a feed is configured.

### R-11 (Low / ops): 24,235-byte hook build

`forge build --sizes` gives `OniblockHook` at 18,841 B in the default profile (800 runs) and `OniblockHook.v4core` at **24,235 B**. `DeployLocal.s.sol` and the test base import `PoolManager.sol`, which is pinned to 44,444,444 runs. Solc compiles the whole import graph in one profile, so **the hook that the local deploy and the tests put on-chain is the 24,235 B build, with 341 B to spare**. `DeploySepolia` does not import PoolManager, so Sepolia gets the 18.8 KB build. Local and Sepolia therefore run different bytecode, and any fix such as R-02 or R-03 may push the local deploy over EIP-170.

**Fixes (pick one):**
- In DeployLocal, deploy PoolManager with `vm.deployCode("PoolManager.sol:PoolManager", abi.encode(owner))` instead of `new PoolManager`. The script then compiles in the default profile.
- Deploy the hook from `vm.getCode("OniblockHook.sol:OniblockHook")` (the default artifact) plus HookMiner on that initcode.

**Byte savers if needed:**
- Remove `chainlinkPriceX96` (:398) and `domainSeparator` (:393); `eip712Domain()` already exists.
- Make `ATTESTATION_TYPE` internal and expose only the typehash.
- Drop the redundant `isDynamicFee` check in `_afterInitialize` (:433), which `beforeInitialize` already enforces.
- Store `pToxic`/`confidence` in events only.

Gas (existing test): the first swap in a block costs +17.1k gas over hookless, and later swaps are cheaper than hookless (50.7k vs 59.3k, warm storage).

### R-12 (Info)

- **Permissions.** They match the implemented callbacks and the address bits (`test_permissions_matchSpec`). `beforeSwapReturnDelta` and `afterSwapReturnDelta` are false; `_beforeSwap` returns `ZERO_DELTA` and `_afterSwap` returns 0, as required. `fee | OVERRIDE_FEE_FLAG` is always returned. The fee is at most `FEE_MAX_CAP` (1e5), below `MAX_LP_FEE`. `DYNAMIC_FEE_FLAG` is checked in `registerPool` and `beforeInitialize`.
- **Fee law direction.** `arbZeroForOne = poolX96 > mid` is correct for both token orders, because the convention is always token1/token0. Token order is the keeper's job, and PriceMath and the Chainlink code are consistent with it.
- **Gap math.** `mulDiv(sqrtP, sqrtP, 2^96)` stays ≤ 2^224 across the full sqrtPrice range. The mid is kept in (0, 2^224) at post time, so there is no division by zero. At the minimum price, poolX96 rounds to 0, which gives gap = 1e6 and feeMax, with no revert (existing fuzz). The k step limit is fine. Demotion bypasses the step limit, down to kDefault only.
- **Swap path never reverts.** Existing fuzzes plus `testFuzz_review_swapPathNeverReverts_quoteMatches` (3,000 runs, random interleaving of attestations including same-block-after-swap ones, rolls, config updates, calibration toggles, JIT add/remove, and split swaps with 1–4 parts). **quoteFee == executed fee held in every case**, including anchored later swaps. No hookData, no proxy, and protocol fees are untouched.
- **Receipt.** `feePips` is the LP fee only; with a protocol fee on, the total swap fee is higher. `sender` is the router, not the user. `amount0` and `amount1` use the v4 swapper convention (negative = paid by the swapper). A quote made off-chain in block N and executed in N+1 can legitimately differ, so users should set `amountOutMin`.
- **Anchored same-direction overcharge.** After the arb closes the gap, later same-direction retail in the same block still pays the anchored arb fee. This is by design (split resistance) but should be documented as a retail cost.
- **EIP-712.** The domain is ("Oniblock", "1", chainId, hook). Including poolId, chainId and the verifying contract prevents replay across pools, chains and hooks. `tryRecover` rejects high-s signatures. Only the two-block window allows reuse (R-07).
- **Reentrancy.** External calls in `setAttestation` (the role oracle and Chainlink) happen before any state write. `donate` inside hooks does not re-enter, because the donate permissions are off.
- **SplitSwapRouter.** It is for tests and bots only. It has no deadline, no min-out, and no native support. `payer = msg.sender`, so an approval cannot be abused by third parties. The `int128(a0)` cast at :86 is unchecked, which is cosmetic. It is fine for its purpose; never list it as a user-facing router.
- **Unused or odd code.** `Calibration.hitRateBps`/`updatedBlock` and `PoolState.pToxicBps`/`confidenceBps` are stored but never read on-chain (views only). `_decimalsOf` caps at 30 by reverting, while its comment says "Capped".
- **EnsV2RoleOracle** fails closed (an unset registry, a zero bitmap or a revert all return false), which is correct. It is not immutable: its owner can repoint the refs (R-04). It must stay consistent with the ROOT-fallback warning in the docs.

---

## Prioritized fix list

1. **R-01** Add a probation rule (`n < minSamples` gives kDefault) or a modelNode allowlist, plus sticky per-pool demotion, and state the attestor trust assumption. This protects the headline "calibration gate" claim.
2. **R-03** Snapshot `modelNode` and `attestBlock` into the anchor and emit them in the Receipt; update the settler to attribute through them.
3. **R-11** Decouple DeployLocal and tests from the 44M-run profile (`vm.deployCode` for PoolManager) before adding any bytes. Otherwise fixes 1, 2 and 4 may not fit.
4. **R-02** Live or high-water pricing for the non-anchored direction (and optionally R-05's monotone anchor refresh).
5. **R-04** A config, attestor and oracle timelock (or at least a Safe owner plus README disclosure); **R-06** clamp k and clear the anchor on a config update.
6. **R-09** Fix the DeploySepolia ENS defaults to labelhashes, or reuse the EnsSetup oracle.
7. **R-10** Configurable Chainlink max age, a tighter band, and a strict decimals check.
8. **R-07, R-08** Allow same-block replacement by a newer attestation; document or delay the parked-penalty flush.
9. The R-12 documentation items (Receipt fee semantics, same-direction retail overcharge, SplitSwapRouter scope).
