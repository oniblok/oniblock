# V5: the model decides two knobs — k (arbitrage) and the JIT window (opportunistic liquidity)

> Note (later change): the `minSamples` probation ("unseasoned") described in this historic document has since been removed from the hook; the calibration gate is now the pool allowlist + Brier demotion only, and a model with no calibration record is active.

Status: spec (build in progress). Everything in v4 (`docs/review/V4_AI_DECIDES.md`) stays. This adds a second typed
question to the SAME per-block Jev call, a second attested number, a second on-chain knob and a second calibration
record. Nothing about the fee law for swaps changes.

## 1. Why

Today JIT protection is a wall: `LiquidityPenaltyHook` with a fixed `blockNumberOffset = 10` blocks, set once at
deploy. Liquidity removed within 10 blocks of being added forfeits its fees (donated to standing LPs). Hold for 11
blocks and the wall is gone; raise the wall to 100 blocks for everyone and honest LPs who rebalance often get hurt.
Same problem the fee threshold had in v3: markets move, walls don't think.

v5 makes the window a bounded knob the model sets every block, exactly like k:

```
window = jitWindowMin + (jitWindowMax - jitWindowMin) * pJit * confidence / 1e8      (blocks; clamped)
demoted / unseasoned JIT head  =>  window = jitWindowDefault
```

The model keeps that power only while its JIT predictions are calibrated (own Brier record, own demotion).

## 2. Contract (`contracts/src/OniblockHook.sol`)

### 2.1 Structs — append fields at the END of each struct (positional literals only need appending)

```solidity
struct PoolConfig { ...existing...; uint16 jitWindowMin; uint16 jitWindowMax; uint16 jitWindowDefault; }
struct PoolState  { ...existing...; uint16 jitWindow; uint32 pJitBps; }   // window in force for adds from now on
struct Attestation {
    uint64 blockNumber; uint256 oracleMidX96; uint32 pToxicBps; uint32 confidenceBps;
    uint32 pJitBps;                 // NEW, 0..10000, inserted BEFORE modelNode
    bytes32 modelNode; bytes signature;
}
string constant ATTESTATION_TYPE =
  "Attestation(bytes32 poolId,uint64 blockNumber,uint256 oracleMidX96,uint32 pToxicBps,uint32 confidenceBps,uint32 pJitBps,bytes32 modelNode)";
```

Validation in `setAttestation`: `pJitBps <= BPS` (else `InvalidAttestation`).
Config validation (`_validateConfig` or wherever `kMinBps > kMaxBps` is checked):
`1 <= jitWindowMin <= jitWindowDefault <= jitWindowMax`. The OZ immutable `blockNumberOffset` (constructor arg
`JIT_OFFSET`) is kept for ABI/deploy compatibility and documented as unused by the v5 logic.

### 2.2 JIT calibration key and demotion

```solidity
/// Derived calibration key of a model's JIT head (ENS: mirrored as calibration.jit.* records on the model name).
function jitCalibrationKey(bytes32 modelNode) public pure returns (bytes32) {
    return keccak256(abi.encodePacked(modelNode, keccak256("jit")));
}
/// Same rule as isDemoted, read on the JIT key: not allowlisted (parent modelNode) OR n < minSamples OR
/// (brierDemoteBps != 0 && n != 0 && brier > brierDemoteBps).
function isJitDemoted(PoolId id, bytes32 modelNode) public view returns (bool);
/// jitWindowMin + (jitWindowMax - jitWindowMin) * p * c / 1e8, or jitWindowDefault if isJitDemoted.
function jitWindowFromScore(PoolId id, uint32 pJitBps, uint32 confidenceBps, bytes32 modelNode) public view returns (uint16);
```

The settler writes the JIT head's record with the EXISTING `setCalibration(jitCalibrationKey(modelNode), brier, hitRate, n)`.
No new allowlist: the JIT head is gated by the parent model's allowlist plus its own calibration.

### 2.3 setAttestation

After k is computed: `st.jitWindow = jitWindowFromScore(id, a.pJitBps, a.confidenceBps, a.modelNode); st.pJitBps = a.pJitBps;`
No step limiter (the window only affects liquidity added from now on). Pool init: `st.jitWindow = cfg.jitWindowDefault`.
Event `AttestationPosted`: append `uint32 pJitBps, uint16 jitWindow` (non-indexed) at the END.

### 2.4 Per-position window ("the window in force when the liquidity was added")

New storage `mapping(PoolId => mapping(bytes32 positionKey => uint16)) internal _windowAtAdd;`

- Override `_afterAddLiquidity`: the "added recently" check and the stored window use
  `w = _windowFor(id, positionKey)` where `_windowFor` = `_windowAtAdd[id][positionKey]` if non-zero, else the
  effective window now. Effective window now = `st.jitWindow` if the attestation is not stale
  (`block.number - st.lastAttestBlock <= cfg.staleBlocks`), else `cfg.jitWindowDefault`. On every add: while the position's previous window is still running, store
  `max(existing, effectiveNow)` (re-adding inside a window never shortens it, mirroring OZ's "splitting additions does
  not reduce the penalty"); once it has expired the add starts fresh at `effectiveNow` (as built: a position key is not
  pinned to a wide window forever).
- Override `_afterRemoveLiquidity` (already overridden): replace `blockNumberOffset` with `_windowAtAdd[id][positionKey]`
  (fallback `cfg.jitWindowDefault` if 0). Penalty decay: OZ's `_calculateLiquidityPenalty(totalFees, lastAdded)` uses
  the immutable; override it (it is `internal view virtual` — verify) or compute inline with the position's window:
  `penalty = totalFees * (window - (now - lastAdded)) / window` (same shape as OZ). Clear `_windowAtAdd` when the
  position is fully removed? Not necessary (lastAdded governs); keep it simple and document.
- New event, emitted whenever a penalty is applied (donated or parked):
  `event JitPenalty(PoolId indexed id, address indexed sender, bytes32 positionKey, uint48 addedBlock, uint16 window, uint256 penalty0, uint256 penalty1);`

### 2.5 Deploy scripts

`DeployBase.s.sol`: env `JIT_WINDOW_MIN` (default 10), `JIT_WINDOW_MAX` (100), `JIT_WINDOW_DEFAULT` (10) into
PoolConfig. All bench deploy scripts and tests that build `PoolConfig`/`Attestation` literals must compile.
`EnsSetup.s.sol`: add settler per-key setter grants for `calibration.jit.brier`, `calibration.jit.hitRate`,
`calibration.jit.n`, `calibration.jit.epoch`, `calibration.jit.brierRaw`, `calibration.jit.skill`,
`calibration.jit.baseRate` on every model name (mirror the existing `calKeys` loop). Also add an idempotent phase
`ENS_PHASE=grant-jit` that ONLY performs those grants on an existing setup (reads `ENS_OUT`/`deployments/<chain>.ens.json`
for addresses) so an already-registered `oniblock.eth` does not need re-registration. The model-name description
records mention the JIT head.

### 2.6 Tests (`contracts/test/JitWindow.t.sol` + fix existing)

- attestation with pJit sets `jitWindow` per the formula; demoted/unseasoned JIT head => default; parent not allowlisted => default.
- `jitCalibrationKey` matches `keccak256(abi.encodePacked(node, keccak256("jit")))`.
- position added under window 40 and removed at +11 blocks IS penalised (would have escaped the old 10-block wall);
  removed at +41 is not; `JitPenalty` emitted with the right window; honest LP added under window 10 and removed at +15
  is not penalised even if the window later rises to 100 (window-at-add semantics).
- stale attestation => adds use `jitWindowDefault`.
- config validation reverts on `min > default`, `default > max`, `min == 0`.
- EIP-712 digest includes pJitBps (signature over a different pJit fails).
- All 94 existing tests + `test/review*/` still pass (`forge test`).

## 3. Services (`services/`)

### 3.1 Model (`src/model/`)

- `types.ts`: `ModelScore.pJitBps: number` (required; heuristic/kev/tabular fill it).
- `jev.ts`: keep `JEV_QUESTIONS_V1` and `JEV_QUESTIONS_V4` byte-identical (frozen caches). Add
  `JEV_QUESTIONS_V5 = { ...V4, jit: { type: 'boolean', instructions: <see below>, criteria: {...} } }`, `JevPrompt = 'v1'|'v4'|'v5'`,
  default prompt `v5` (env `JEV_PROMPT=v4|v1` restores). Cache key namespaced `[jev-prompt:v5]`. `parseJev` reads
  `answers.jit.probability` -> `pJitBps` (missing => 0 = "no JIT signal", never a failure).
  JIT question (typed boolean): "Will liquidity added to this pool in the next block be opportunistic just-in-time
  liquidity: placed tightly around the current price to capture the fee of a large expected swap and removed again
  within about 100 blocks, rather than liquidity that stays? Answer with the probability that new liquidity in the
  next block is short-lived fee capture." criteria true: "short-lived fee capture around a large swap (mint, swap, burn
  within ~100 blocks)"; false: "liquidity that stays, routine rebalancing, or no liquidity change expected".
- `heuristic.ts`: `pJitBps` from liquidity features: `clamp(1000 + 8000 * churn)` where churn = share of positions
  added in the last 200 blocks that were removed within `JIT_LABEL_BLOCKS`; 0 features => 1000.
- `kev.ts`, `tabular.ts`: `pJitBps = 0` (documented: no JIT head yet).

### 3.2 Features (`src/features.ts`)

Add `LiquidityObs { block, sender, tickLower, tickUpper, liquidityDelta, salt }` (from PoolManager `ModifyLiquidity`
events; also track hook `JitPenalty` events) and features:
- `liqAdds20`: adds in last 20 blocks; `liqChurn200`: share of adds in last 200 blocks removed within `JIT_LABEL_BLOCKS`;
- `liqNewestSpanTicks`: tick span of the newest add (narrow = fee capture) and whether it brackets the current tick;
- `liqMedianLifetime`: median blocks between add and remove for positions removed in last 200 blocks (or "n/a");
- `jitPenalties200`: count of JitPenalty events in last 200 blocks; `jitWindowNow`.
v5 state text = the v4 lines (unchanged, byte-identical) + these 3 lines appended:
```
liquidity_recent: {liqAdds20} positions added in the last 20 blocks; {churn}% of positions added in the last 200 blocks were removed again within {JIT_LABEL_BLOCKS} blocks.
liquidity_shape: newest position spans {span} ticks {around|away from} the current price; median lifetime of recently removed positions {M} blocks.
jit_enforcement: {jitPenalties200} JIT penalties in the last 200 blocks; current penalty window {jitWindowNow} blocks.
```
`featuresToState(..., { format: 'v5' })`. `format: 'v4'` output must stay byte-identical.

### 3.3 Keeper (`src/keeper.ts`)

Track `ModifyLiquidity` (PoolManager) and `JitPenalty` (hook) logs the same way swaps are tracked (`refreshSwaps`).
Attestation gains `pJitBps` (attest.ts type string + struct order per §2.1). Log `pJitBps` and the resulting window
(`AttestationPosted` event or `poolState` read). `RULE_SCORE` gets `pJitBps: 0`. `abi/oniblockHook.ts` updated
(Attestation tuple, PoolConfig, PoolState if present, `AttestationPosted`, `JitPenalty`, the 3 new views).

### 3.4 Settler (`src/settler.ts`)

Second label per attested block b (the block the attestation targets):
- adds(b) = ModifyLiquidity events with liquidityDelta > 0 in block b.
- If adds(b) is empty: not graded (`skipped_no_liquidity`).
- y_jit(b) = 1 iff any position added in b is removed (liquidityDelta < 0, same positionKey = keccak(sender, tickLower,
  tickUpper, salt)) within `SETTLER_JIT_LABEL_BLOCKS` (default 100) blocks; else 0. Grade only once block
  b + SETTLER_JIT_LABEL_BLOCKS is final (same lag discipline as markouts).
- p = pJitBps of the attestation in force at b. Rolling window/min-n like the arb head (`CALIB_WINDOW`, `CALIB_MIN_N`).
- Post `setCalibration(jitCalibrationKey(modelNode), brier, hitRate, n)` and ENS records `calibration.jit.{brier,hitRate,n,epoch,brierRaw,skill,baseRate}`
  on the model name (same multicall pattern as the arb records). Skip if no graded samples. Never grade rule-v1.
Log lines: `jit_graded`, `jit_calibration_posted`.

### 3.5 JIT bot (`src/bots/jit.ts`, script `"jit": "tsx src/bots/jit.ts"`)

Dev-chain actor (anvil key #8) that repeatedly: mints a narrow position (±`JIT_TICKS` tick spacings around the
current tick, size `JIT_SIZE_USD`) -> performs one swap of `JIT_SWAP_USD` in the arb direction (or waits for the next
retail swap when `--passive`) -> removes the position after `--hold N` blocks (default 12: escapes a 10-block wall,
caught by an adaptive window >= 13). Logs whether `JitPenalty` fired and the amounts. `--every M` blocks between cycles.
Reuse `bots/executor.ts` and the PoolModifyLiquidityTest router already in deployments (`liquidityRouter`).

### 3.6 Tests (vitest, offline)

parseJev with/without `jit` answer; v5 state text (snapshot) and v4 byte-identity; attest digest includes pJit
(matches a fixed vector computed once with the contract, or at least round-trips through viem's typed-data
verification); settler JIT label unit test with synthetic events (add+remove within/after window, no adds);
heuristic pJit. All existing 75 tests still pass.

## 4. App (`app/`)

- Pool page: show `pJit` and the current JIT window next to k/p ("model decides: k = …, JIT window = … blocks").
- Models page: second calibration row per model ("JIT head": brier / hitRate / n / demoted?) from `jitCalibrationKey`
  + ENS `calibration.jit.*` via UniversalResolver.
- Receipts/activity: list `JitPenalty` events (block, window, added block, penalty amounts) with a "caught by adaptive
  window (would have escaped a 10-block wall)" tag when `now - addedBlock >= 10`.
- Reads the regenerated `abis/OniblockHook.json`.

## 5. Demo (`scripts/demo-local.sh`, `src/e2e/story.ts`)

Demo profile starts the jit bot (`--hold 12 --every 30`). `story --expect …,jit-caught,jit-seasoned` checks: at least
one `JitPenalty` with `now - addedBlock >= 10`, and a `calibration.jit.*` record with n >= CALIB_MIN_N.
`docs/review/V5_JIT_HEAD_BUILD.md` records what was built, test counts and the headless run output.

## 6. Out of scope (say so in the pitch)

Mempool-level JIT detection (bundles are invisible to the keeper); the window is set BEFORE the block, and the
contract catches the mint→swap→burn pattern deterministically. Sandwiches (retail direction, private RPC territory).
