# V3 build: threshold fee law and the gated Jev keeper

Date: 2026-09-26. Motivation: benchmark v2 (`benchmark/results_v2/results.md`) found that calm hours were negative for LPs. Under the v2 law even a tiny gap adds `k·gap` to the arb-direction fee, so retail in that direction routes to the vanilla pool. v2 also found two other problems. Model-tuned k was about the same as constant k. Settler labels computed against the attested (lagged) mid mislabelled arbs.

## 1. Contract (`contracts/src/OniblockHook.sol`)

- **New field.** `PoolConfig.arbThresholdPips` is a `uint24` appended as the **last** field. `_validateConfig` rejects `arbThresholdPips > feeMax`. A value of 0 is allowed and gives exactly the v2 law. The field is timelocked like the rest of the config: `registerPool` sets it before init and `updatePoolConfig` queues and executes it.
- **Fee law.** For arb-direction swaps (live price on the arb side of the mid by at least 1 pip, not stale):
  `fee = min(base + max(0, gapHW − arbThresholdPips) · k / 1e4, feeMax)`, then the N-07 floor applies.
  Below or at the threshold the fee is exactly `baseFee` in both directions, so the pool behaves like a vanilla pool with that fee.
- **Properties unchanged.**
  - The fee is directional.
  - The per-block, per-direction high-water anchor still applies, including the "at or past the mid pays base" rule.
  - A stale mid gives `conservativeFee`.
  - The N-07 floor applies, and it also holds below the threshold (tested).
  - The swap path never reverts.
  - `quoteFee` equals the executed fee.
- **Receipt event is unchanged.** `gapPips` is the raw high-water gap. `arbDir` still means "moved toward the mid", so a swap can be `arbDir` and still pay exactly base. To recompute the fee: `min(base + max(0, gapPips − poolConfig(id).arbThresholdPips)·kBps/1e4, feeMax)`. The NatSpec documents this.
- **ABI changes.** The only change is the `PoolConfig` tuple, which gains a 15th component. It affects `registerPool`, `updatePoolConfig`, `poolConfig`, and the `PoolRegistered` and `PoolConfigUpdated` events (their topic0 changes). ABIs were re-exported with `contracts/export-abis.sh` to `abis/*.json`. `services/src/abi/oniblockHook.ts` now contains the `PoolConfig` tuple and the `poolConfig` view.
- **Size.** Hook runtime is **21,817 B**, below the 24,576 B limit with 2,759 B to spare (`forge build --sizes`).
- **Gas (`test_gas`).** A hookless swap costs 59,900. The first Oniblock swap in a block costs 77,901 (+18,001). Later swaps in the same block cost 53,469.

## 2. Tests

- All fee-law mirrors are updated: `_lawFee` in `test/utils/OniblockTestBase.sol`, the fuzz fee-law checks in the review and review2 suites, the `Review2Invariants` fee-law handler, and hard-coded expectations such as R-02 overshoot 8000 → 6350. The default test config sets `arbThresholdPips = 3300`. The review fuzz config mutator now randomises the threshold in `[0, feeMax]`.
- New `test/ThresholdLaw.t.sol` (11 tests):
  - below the threshold pays base in both directions (pool above and pool below the mid); the Receipt reports the raw gap
  - at the threshold pays base
  - just above the threshold pays `3000 + 200·0.5`
  - a 5% gap hits the cap
  - threshold 0 reproduces the v2 law
  - stale mid plus N-07 floor below the threshold
  - split resistance above the threshold: a 6-way split walks the live gap below the threshold, and every part still pays the high-water fee
  - threshold validation, including edges `= feeMax` and 0
  - `updatePoolConfig` timelock path: queued, too early reverts, executes, fee drops to base
  - fuzz of the law mirror plus quote equals executed

**Evidence.**
- `forge test`: 94 passed, 0 failed, 1 skipped (the offline fork test). Same result with `FOUNDRY_FUZZ_RUNS=2000`.
- Invariants: `invariant_feeLawAndNoRevert`, `invariant_quotesBounded` and `invariant_claimsCoverPendingPenalties` each ran 256 runs × 128,000 calls and passed.

## 3. Services (`services/`)

**Keeper (`keeper.ts`)**
- Reads `hook.poolConfig` (refreshed every 100 blocks) and falls back to the deployment JSON.
- Pure `gateDecision(gap, thr, hyst)`. If `gap < arbThresholdPips − KEEPER_HYSTERESIS_PIPS` (default 100), the keeper does **not** call Jev or the heuristic. It posts the mid with the deterministic rule score `pToxic 1000, confidence 10000` under `rule-v1.models.oniblock.eth` (env `RULE_MODEL_NAME`).
- Otherwise it calls Jev as before, with the heuristic under heuristic-v1 as fallback. `KEEPER_GATE=0` restores the old behaviour.
- Stats (ticks, rule ticks, model ticks, Jev call rate) appear in every log line, plus a `jev_rate` summary every 50 ticks.

**Settler (`settler.ts`)**
- Grades only real models: rule-v1 receipts are skipped.
- **Labelling fix.** The default is `SETTLER_LABEL_MID=cex`: swaps are marked out against the CEX mid at the swap's own block time, fetched after the fact. The source is the replay path when `PRICE_SOURCE=replay`, otherwise a Binance 1s kline at the block timestamp (batched and cached).
- `SETTLER_LABEL_MID=attested` restores the old mid-in-force behaviour. `MARKOUT_HORIZON=1` still means next attestation.

**Mirrors**
- `price.ts feeLaw` now takes `arbThresholdPips`; new helper `excessGap`.
- `features.ts` accepts an optional threshold. Default 0 keeps the state text byte-identical, so v1/v2 cache keys still match.
- `labelBlocks` has an optional `{ skipModelNodes }`.

**E2E**
- `run-local.ts` passes `ARB_THRESHOLD_PIPS` (`--arb-threshold`, default base + 300). It checks that the fee follows the threshold law, that below-threshold receipts pay base, that rule-v1 attestations exist, and that rule-v1 is never calibrated.
- `story.ts` ignores rule-v1 when reading k phases.

**Evidence**
- `OFFLINE=1 pnpm -C services test`: 11 files, 59 passed, 5 skipped. Typecheck is clean.
- e2e on port 8612 with `--out ../deployments/31337.e2e.json`: PASS.
  - 58 attestations, 46 of them under rule-v1.
  - 4 below-threshold arb receipts, all paying base; 5 above.
  - Keeper Jev call rate 0.20.
  - `CalibrationUpdated` fired only for jev-v1.
- `contracts/smoke-local.sh 8611`: SMOKE OK. The receipt showed gap 10101, k 5000, fee 6400, which equals the threshold law.

## 4. Deploy scripts, ENS, app

- `DeployBase` / `DeployLocal` / `DeploySepolia` read `ARB_THRESHOLD_PIPS` (default `BASE_FEE + 300`) and write `config.arbThresholdPips` to the deployment JSON. They allowlist rule-v1 by default next to jev-v1 and heuristic-v1. Nothing was broadcast to Sepolia.
- Bench scripts `DeployBench` / `DeployBenchV2` take the same env var with the same default. The v1/v2 TypeScript runners pass `ARB_THRESHOLD_PIPS=0`, so they keep reproducing their frozen results. New `DeployBenchV3.s.sol` holds the v3 arms.
- `EnsSetup.s.sol`: adds the `rule-v1` model subname with a model-hash text record (`keccak("oniblock/rule-v1")`), an agent-context text record, and an entry in the JSON (not broadcast). `docs/ENS_INTEGRATION.md` has a note.
- App:
  - fee tiles say "below arb threshold → base fee", and a banner appears when the live gap is below the threshold
  - the fee-law line shows the threshold
  - a "Keeper model calls" line shows the Jev / heuristic / rule-v1 share of the last 100 blocks of attestations
  - the receipt page's fee check uses the threshold
- `pnpm -C app build` passes. **Note:** the build rewrote `app/.next`. If the demo on 8545 serves `next start` from that directory, it will serve the new bundle after a restart.

## 5. Finding: rule-v1 resets k

rule-v1 is allowlisted but never graded, so it stays unseasoned. The contract treats unseasoned nodes as demoted, so every rule post sets the stored k back to `kDefault` immediately. The first model post above the threshold can then move k only by `maxKStepBps` from `kDefault`. In the e2e, k stayed at 5000 the whole time.

This is harmless below the threshold, where k is irrelevant, but it largely neutralises model-tuned k. Possible fixes:
1. A gated keeper uses a large `maxKStepBps`. The v3 benchmark uses 6000 for its model pools.
2. The keeper skips the post when below threshold and the previous attestation is still fresh. This costs staleness margin.
3. A future contract change lets a flagged "rule" node keep the stored k.

The benchmark shows k is second-order anyway (§6).

## 6. Benchmark v3 (`benchmark/results_v3/`, `pnpm -C benchmark bench:v3`)

**Setup.** v2's routing-competition simulator was copied to `src/v3/` and extended:
- one keeper step of lag and competing arbitrageurs, as in v2
- the same 12 frozen windows × 3600 1s steps
- markets, each a vanilla pool vs a competitor: control, **old** (v2 law, const k 0.5, reference), **tconst** (threshold, const k), **theur** (threshold, heuristic k, gated keeper), **tjev** (threshold, Jev k with Jev called only above the threshold), **tgated** (as tjev with Jev degraded in the second half)
- a **b500** variant on all 12 windows: base fee 0.05% on both the hooked and vanilla pools, threshold 0.08%
- split5 on ETH-vol1 and BTC-vol1

Labels use the CEX mid at swap time. The Jev budget is 400 live calls per run, with a cache. Totals: 26 runs, 4,886 s, 0 reverts. Control share was exactly 50.00% in every run.

One bug was found and fixed during the run: the benchmark's Jev-state quantiser (`benchmark/src/model.ts quantize`) re-derived the fee with the v2 law. The first attempt was aborted after 6 runs and restarted clean. The fix is a no-op for threshold 0, so v1/v2 keys are unchanged. Results in `results/` (v1) and `results_v2/` are untouched.

### v3 CONCLUSION (verbatim from `benchmark/results_v3/results.md`)

**Bottom line.** **Calm hours are essentially fixed** (the loss shrinks from $-413/h to $-12/h): with the threshold the hooked pool charges exactly the base fee whenever the gap is below 0.33%, i.e. it is a vanilla pool in quiet markets (calm-window LP difference vs vanilla: threshold law -0.01 [-0.01, -0.00] bps/h, 0+/2- of 6, vs -0.21 [-0.23, -0.18] for the v2 law; retail share 49.7% vs 25.9%). Volatile-hour gains are **NOT kept** (volatile: -0.03 [-0.05, -0.01] vs v2 law 0.04 [-0.12, 0.22]). Over all 12 windows the threshold law with constant k is **NO** vs the vanilla pool next to it (-0.02 [-0.03, -0.01] bps (≈ $-37/h, CI $-61 to $-16)). Model-tuned k (Jev only above the threshold, or the heuristic) vs constant k: Jev 0.00 [-0.00, 0.01] bps, heuristic 0.00 [0.00, 0.01] bps. The keeper consulted Jev on only 10.7% of steps (the rest were rule-v1 posts below the threshold).

**Why.** Competing arbitrageurs keep every pool inside its no-trade band (gap ≈ base fee + CEX taker fee ≈ 0.32%), so a new 1 s move opens a gap only a little above the 0.33% threshold. The v2 law charged k on the WHOLE gap (volatile-hour mean arb fee on the v2-law pool 6,054 pips) and so earned more per arb but lost ~48 pp of retail share; the threshold law charges k only on the excess (mean arb fee 3,131 pips, 34% of volatile-hour arbs pay exactly the base fee) and keeps retail parity (49.4% share). The result is a pool that behaves almost exactly like its vanilla neighbour: the calm-hour loss is gone, but so is most of the volatile-hour gain.

Other results (full text in results.md):

- **Retail.** Threshold arms keep a 49.4–49.7% retail share (v2 law: 26.2%). Retail cost vs control is −0.05 [−0.14, 0.03] bps of volume (v2 law +0.23).
- **Jev-gated vs constant vs heuristic k.** Jev minus const is INCONCLUSIVE at 0.00 [−0.00, 0.01] bps. Heuristic minus const is YES at 0.00 [0.00, 0.01] bps, but that is about $7/h. Jev minus heuristic is INCONCLUSIVE. There were 1,368 live Jev calls over the 12 base runs (v2: 1,883), and 98.2% of scores were exact Jev answers.
- **Calibration gate.** Separation is YES: 30.8 [9.4, 53.4] pp over all windows and 54.1 pp in volatile windows (degraded 68% vs honest 14% demoted). Calm windows produce almost no gradeable blocks, 0 in four of the six at 0.30%, so both nodes stay on probation at kDefault. That is harmless below the threshold.
- **b500 tier (0.05% on both pools).**
  - The v2 law is YES overall at 0.06 [0.01, 0.14] bps/h: volatile +0.15, calm −0.02, with 33% share.
  - The threshold arms are INCONCLUSIVE overall at 0.01 [−0.00, 0.02]: volatile +0.03 (YES), calm −0.01, with 47–48% share.
  - Threshold minus v2 law, paired, is −0.07 [−0.13, −0.02]. At the realistic tier, the v2 law's volatile gain outweighs its calm loss.
- **Split resistance.** Splitting arbs 5 ways changes the constant-k pools' LP difference by at most 0.001 bps.

**Overall reading.**
- The threshold does what it was designed to do: in quiet markets the hook becomes a vanilla pool and retail share returns to parity.
- It gives the volatile-hour premium back, because arbitrage competition keeps gaps close to the threshold.
- At either fee tier, no law here is a robust, economically meaningful LP win over a vanilla neighbour. The effects are tens of dollars per hour on a $20M pool.
- A lower threshold would trade calm-hour parity for volatile-hour premium, anywhere between the two laws measured here. For example, base with no margin, or a threshold scaled by volatility.
- The v3 contract supports any threshold via `updatePoolConfig`.
