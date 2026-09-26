# ReceiptHook — overview and plan (v3)

**One line.** A Uniswap v4 hook that charges informed flow a directional fee on the live price gap, with a TEE-attested sensitivity `k` each block, a deterministic liquidity penalty for JIT, and receipts that are scored against markouts — where a model's on-chain calibration record decides how much power it gets. Liquidity stays permissionless.

**Customer.** LPs.
**Partners.** Uniswap Foundation. ENS (quoter role, model identity, settler-written calibration).
**Deploy.** Ethereum Sepolia — v4 and ENSv2 on the same chain.
**Team credential.** We built UniPerp (ETHGlobal New Delhi 2025 finalist; Uniswap "Build with v4 Hooks" 2nd).

---

## 1. Problem

Private routing took most user-side sandwich extraction on Ethereum: ~$10M/month in late 2024 → ~$2.5M/month by Oct 2025, ~$3 average profit per attack (EigenPhi, Dec 2025). That is not the LP problem.

A pool's mid only moves when someone trades. The CEX mid moves first. The next informed trader buys the stale AMM and sells elsewhere; LPs sold cheap. That is LVR / adverse selection. More than a quarter of volume on the top-5 Ethereum DEXes is non-atomic arbitrage (Heimbach et al., IEEE S&P 2024).

Same-block JIT is a separate leak: liquidity appears, collects the swap fee, leaves. Raising the swap fee makes it worse — the JIT position is the fee collector.

Solana prop AMMs fix the stale mid by pushing a price many times per slot: 60–70%+ of SOL-USDC volume, about half of all Solana DEX volume. Tessera and ElfomoFi quote that way on Base (>$100M combined on Jan 30 2026). P.A.T won Uniswap's volatile-pairs prize at Buenos Aires 2025 with a TEE prop-AMM launchpad on v4.

We are not that product. No inventory, no closed book. A public fee law on an existing Uniswap pool, an attested input to that law, and a public score of every decision.

---

## 2. Mechanism

### Fee law (in the contract, readable by anyone)

```
gap      = |oracleMid − poolMid|            // read in beforeSwap
arbDir   = (poolMid > oracleMid) == zeroForOne
fee      = arbDir ? min(base + k · max(0, gap − arbThreshold), feeMax) : base     // v3, see §13
```

- **Arbitrage threshold (v3).** Below `arbThreshold` (default `base + 0.03%`) no arbitrage is profitable at the base fee, so the pool charges exactly `base` in both directions — it is a vanilla pool in quiet markets. Only the excess gap above the threshold is priced. `arbThreshold = 0` is the v2 law.

- **Directional.** Only swaps that move the pool toward the oracle (the arbitrage direction) pay `k · gap`. Swaps the other way pay `base`. Taxing both sides punishes the retail flow LPs earn on. (Nezlobin directional fee; Detox-Hook.)
- **Anchored per block** (as implemented, see docs/review/CONTRACT_FIXES_1.md: per-direction high-water gap, so a same-block backrun after a displacement is priced from the live gap and fees never fall within a block). On the first swap in `block.number`, store `gap` and the fee rate per PoolId; reuse them for every later arb-direction swap in that block. Without this, an arb splits one trade into many sub-swaps inside a single unlock, each sees a smaller gap, and LPs capture far less.
- **`k ≈ 0.5`** maximises LP capture (~50% of the per-block loss) in a linearised constant-product model. `k ≥ 1` stops re-alignment entirely. Bounds reflect this.

### Oracle mid

- The keeper posts `oracleMid` (CEX mid) together with the attestation, once per block. The hook reads the stored value; **no hookData** (Uniswap's router sends none; the allowlist rejects hooks that need custom calldata).
- **Sanity band:** reject/clamp a posted mid outside a band around Chainlink ETH/USD Sepolia (`0x694AA1769357215DE4FAC081bf1f309aDC325306`). Chainlink Sepolia updates ~hourly, so it is a bound, not the price.
- **Age:** if the stored mid is older than N blocks → conservative fee. Never revert.
- **Honest limit (README):** the gap is only as fresh as the last keeper post; an arb can land before the keeper in a block. Worst case is the conservative fee, never less.

### Attested `k`

- Once per block, the keeper posts `(oracleMid, p_toxic, confidence, window, modelNode, sig)` from Jev or distilled Kev.
- The contract maps `p_toxic, confidence → k` with a public, clamped function. **The model never outputs a fee.**
- Verified once at post time (`setAttestation`), never per swap.
- `k` bounds behind a timelock (`configDelay` on updatePoolConfig / setAttestor / setRoleOracle; 1 h on Sepolia, owner should be a Safe); max change in `k` per block.
- Stale attestation (> N blocks) → conservative default `k` (not `feeMax`).

### Calibration gate (the novel part)

- Off-chain, a settler scores every receipt against the next-block markout.
- The settler holds an **ENSv2 EAC role scoped only to the calibration records** on the model's name (`calibration.brier`, `calibration.hitRate`, `calibration.n`, `calibration.epoch`). Nobody else can write them — not the team, not the keeper, not the model.
- The calibration value is mirrored to a uint the hook reads in `setAttestation`. **Bad calibration → `k` auto-clamped to conservative.** No admin step.
- Even if the model loses to constant `k`, the system demotes it by itself.
- Model nodes are allowlisted per pool, and a node with fewer than `minSamples` scored samples runs at `kDefault` (probation), so switching to a fresh name never escapes demotion. Trust assumption: the attestor (TEE stand-in) reports the mid within the Chainlink band.

### JIT — deterministic, not a model class

OpenZeppelin `LiquidityPenaltyHook` pattern:
- `afterAddLiquidity` + `afterRemoveLiquidity` with return-delta flags.
- Fees on liquidity removed within `blockNumberOffset` are penalised with linear decay (100% same block → 0% at the offset) and donated to in-range LPs.
- Handle `NoLiquidityToReceiveDonation` (last LP exiting inside the window). Use a larger offset in thin pools (multi-account bypass).

### Fee mechanics

- Pool `key.fee = 0x800000` (dynamic). Always return `fee | OVERRIDE_FEE_FLAG` — dynamic pools start at 0.
- `feeMax` ≈ 10,000 pips (1%); hard cap far below 1e6 (≥100% breaks exact-out).
- Out-of-band readings → `feeMax`, **never revert** (reverts break V4Quoter and aggregator quotes).
- Pool price: `FullMath.mulDiv(sqrtP, sqrtP, 1 << 96)`. Handle decimals and token order (native ETH = `address(0)` = token0; invert when token0 is the quote).
- Gap in pips: `mulDiv(|pool − oracle|, 1e6, oracle)`, clamped.

### Hook permissions

`beforeInitialize` (pool allowlist) + `afterInitialize` + `afterAddLiquidity` + `afterRemoveLiquidity` + `beforeSwap` + `afterSwap` (receipt with executed amounts) + both liquidity return-delta flags.
Merge `BaseOverrideFee` + `LiquidityPenaltyHook` by overriding `getHookPermissions`. Mine the address with HookMiner (`v4-periphery/test/shared/HookMiner.sol`).

### Receipt

Emitted in `afterSwap`: `poolId, block, gap, k, fee, amounts, modelNode, quoter`. ~2.5k gas.

### Safety checklist

- Allowlist PoolIds in `beforeInitialize`; key all state by PoolId.
- Never call ENS from `beforeSwap`.
- Scores are aggregate regimes from past blocks + CEX data — **never a reaction to a specific pending trade** (Uniswap's security framework flags selective fee raises as extractive).
- Users set `amountOutMin` (quote vs execution drift).

---

## 3. Off-chain

Inputs from confirmed pool events, a CEX mid, and (optional Unichain mirror) flashblocks. Sepolia has a public mempool; Base/Unichain do not.

Feature vector, start thin:
1. Gap vs CEX mid
2. Buy/sell imbalance over the last N mined swaps
3. Size / depth over that window

Then if needed: realised vol, attestation age, liquidity churn (dashboard only).

Model: Jev if the API works this weekend, else distilled Kev. Typed head only: `p_toxic`, `confidence`, `class ∈ {informed, dump, unknown}`.

**Write the watcher ourselves.** Start Fresh allows only public libraries and starter kits; another team's hackathon repo (BeeTrap, NeuralHook) is prior project-specific code and would cost partner prizes and Finalist. Cite them as related work.

---

## 4. Prior art and what is new

| Project | What it did | Us |
|---|---|---|
| Detox-Hook (Prague 2025) | Oracle gap fee, donated to LPs | Same fee idea — credited. We add attested `k`, directional + per-block anchor, calibration gate |
| LVR Minimizing Hook (Bangkok 2024, Uniswap 2nd) | Pulls 90% liquidity for first swap per block | Fee-based, risk-dependent |
| Hindsight Hook (UHI10) | Per-swap bond settled vs markout | We score the **model**, and the score changes its power on-chain |
| NeuralHook (Open Agents 2026, no prize) | TEE-signed IL fee every 30s | Per-block, directional, calibration-gated |
| Agentic BeeTrap (HackMoney 2026, no prize) | ML sandwich score, flat trap fee | Model never scores swaps or sets fees |
| P.A.T (Buenos Aires 2025, Uniswap 1st) / Tessera | Operator quotes, funds the book | Open LPs, no inventory, public law |
| OZ LiquidityPenaltyHook | JIT fee penalty | Used as-is, credited |

**The claim:** an off-chain quoter whose power is bounded by a public fee law, scored in public, and demoted or revoked on-chain through ENSv2 — on a pool anyone can LP into.

---

## 5. ENS (ENSv2, Sepolia)

```
oniblock.eth                        team Safe; our own subregistry (VerifiableFactory)
├── quoter.oniblock.eth             keeper holds ROLE_QUOTER; revokeRoles = quoter dead
├── models.oniblock.eth
│   ├── jev-v1.models.oniblock.eth  model-hash, agent-context (ENSIP-26), ENSIP-25 link,
│   └── kev-08b.models.oniblock.eth calibration.* (settler-only EAC role)
└── pools.oniblock.eth
    └── weth-usdc.pools.oniblock.eth  hook, pool-id, fee-min, fee-max, max-step, policy-uri
```

- `setAttestation` requires `hasRoles(quoterResource, ROLE_QUOTER, msg.sender)` and reads the model's calibration uint.
- Rotate model = change a record, not redeploy.
- Use our own PermissionedResolver (PublicResolverV2 is not EAC).
- Pin the **Sept 15 2026 ENSv2 Sepolia redeploy**; check the resolver ABI (`grantSetterRoles` vs `authorize*Roles`); registries use resource IDs, not token IDs.
- Explorer resolves names via UniversalResolverV2. No ENS calls inside the hook. No hard-coded names in the UI.

---

## 6. Language

**Use:** LVR, informed flow, stale mid, adverse selection, regime fee, attested k, markout, calibration, fee law.
**Don't:** "intelligence inside the hook" (it's behind the hook), frontier-LLM accuracy, "we ended sandwiches", "90% unsolved", per-tx coloring as if the hook scored each tx, "we built a PropAMM", L1-gas arguments for a Sepolia/L2 demo, "38% stat-arb" (no source).

---

## 7. Demo (≤3 min)

1. One-liner: *"When prices move, bots take money from the people who fund the pool. We make them pay it back — and an AI that gets it wrong loses its job automatically."*
2. **Split screen:** two identical pools, one bot hitting both. Vanilla pool's LP balance drains; ours holds.
3. Judge presses **Execute swap**: fee = this block's gap × current `k`, arb direction only.
4. **Receipt page:** tx → gap, k, fee, quoter and model resolved from ENS, running calibration.
5. **Self-correction:** degrade the model → settler writes a worse Brier to ENS → `k` clamps → fees change, nobody touches anything.
6. **Kill switch:** revoke the quoter role → next attestation fails → conservative fee → grant backup keeper → resumes.

Regime map colors blocks, not transactions. Fixed-seed cron so judges can replay.

---

## 8. Benchmark (start as soon as the scorer runs)

Held-out time window, real price path, rational arb bot **including split swaps**. Five pools:

1. Fixed fee
2. Detox-style gap fee (no model)
3. Our law, constant `k`
4. Our law, Jev/Kev-tuned `k`
5. Our law + calibration gate (model deliberately degraded mid-run)

Report LP PnL net of LVR with confidence intervals, retail cost, volume. If (4) doesn't beat (3), say so and ship (3) + the gate. That result is the paper.

---

## 9. Todo

**Contracts (Eng 1)**
- [ ] Directional fee law + per-block anchor
- [ ] Stored `oracleMid` + Chainlink sanity band + age fallback
- [ ] `setAttestation`: ENS role check, sig verify, calibration read, bounded `k` map, rate limit
- [ ] LiquidityPenaltyHook merge; handle last-LP revert
- [ ] Pool allowlist, `OVERRIDE_FEE_FLAG`, `feeMax`, no reverts
- [ ] `afterSwap` receipt
- [ ] Foundry: honest swap, arb swap, split-swap arb, reverse-direction retail, stale mid, stale k, bad sig, revoked role, bad calibration, JIT add/remove, empty hookData, last-LP exit
- [ ] Deploy Sepolia, verify source, save tx hashes

**Off-chain (Eng 2)**
- [ ] Watcher (our code) + CEX mid client
- [ ] Jev/Kev client, typed outputs; measure latency
- [ ] Keeper (mid + attestation per block)
- [ ] Settler: markouts → calibration → ENS records
- [ ] Five-pool replay benchmark

**ENS (shared)**
- [ ] Register `oniblock.eth` (commit-reveal — allow time)
- [ ] Subregistry, subnames, PermissionedResolver, roles
- [ ] ENSIP-25/26 records last

**Design**
- [ ] Split-screen pools, regime map, receipt + calibration page, kill-switch control, video frames

**Ship**
- [ ] Public repo, README with contract/line pointers, architecture diagram
- [ ] FEEDBACK.md + Uniswap Developer Feedback Form (ask at booth)
- [ ] ≤3 min video
- [ ] README note: designed for the hook allowlist (no custom calldata, no proxy, verified source); demo swaps via UniversalRouter/PoolSwapTest

**Don't:** clone BeeTrap/NeuralHook · loyalty scores · model-output fees · reverts · JIT as a model class · per-swap fee recompute · mock data · cosmetic ENS.

---

## 10. Split

| Who | Owns |
|---|---|
| Eng 1 | Hook, fee law, anchor, penalty, ENS gate, tests, Sepolia |
| Eng 2 | Watcher, model, keeper, settler, benchmark |
| Designer | Split screen, regime map, receipt/calibration UI, video |
| Shared | ENS records, README, FEEDBACK.md, form |

---

## 11. Odds (internal only)

| Prize | Estimate |
|---|---|
| Uniswap top 3 | ~40% |
| ENS | ~30–35% |
| Finalist | ~8–10% |
| At least one | ~55–60% |

Biggest risks: mock data, per-swap recompute, cosmetic ENS. Biggest lever: the calibration gate working live.

---

## 12. Known limitations / trust assumptions

These come from contract review #2 (`docs/review/CONTRACT_REVIEW_2.md`). The fixes are in `docs/review/CONTRACT_FIXES_2.md`. What is left is bounded, and it is documented here and in the NatSpec of `OniblockHook.sol`.

**Fee law inside a block**
- **High-water gap plus a live-side check (N-01, fixed in part).** In each block, each direction keeps the largest toward-oracle gap it has seen. That running max is what makes split arbs pay the full fee. A direction pays that fee only while the *live* pool price is still at least 1 pip on the arbitrage side of the mid. At the mid or past it, a swap cannot be an arbitrage toward the oracle, so it pays `baseFee`. Retail that trades after an arb has restored the price therefore pays base. A split can buy the last < 1 pip of movement toward the mid at base, which is at most about 1 ppm of output.
- **Residual LP self-griefing near the oracle (N-02).** A dominant LP can round-trip the price (+2% → −2%) and then leave the pool at mid + ε. The toward direction then pays the inflated high-water fee (up to `feeMax`) for the rest of the block, even though the live gap is ε. The LP earns those fees back, so this is profitable only for an LP. The cost is capped by `feeMax` and lasts one block. Integral (average-gap) pricing would remove it. Mitigation: keep `feeMax` tight.
- **Stale first touch (N-07, fixed).** Say the first swap of a block sees a stale mid and pays `conservativeFee`. A fresh attestation later in the same block un-stales the anchor. From then on, swaps are priced by the law, with a floor of `conservativeFee` for the rest of that block.
- **One attestation per Receipt (N-05, fixed).** The anchor carries exactly one attestation's (k, model, mid). A same-block attestation with k ≥ the anchored k takes over all three. One with a lower k applies only from the next block.
- **A same-block attestation can move fees (N-06).** A later attestation that takes over the anchor may put the mid on the other side of the pool. That raises the other direction and drops the old arb direction to base. The attestor is trusted within the Chainlink band.
- **Two k steps in one block (N-10).** A post for `block-1` followed by one for `block` applies two `maxKStep` steps in one block. On average this is still about one step per block.
- **A config update mid-block clears the anchor (N-12).** Fees locked earlier in that block can fall. Only the owner can do this, and it is timelocked.

**Trust and governance**
- **The attestor is trusted (N-03).** It stands in for a TEE. It is trusted to report the mid within the Chainlink band *and* to name the model that produced the score. The per-pool allowlist limits which identities it can claim, not which model actually scored. For example, a demoted model's scores could be relabelled as another seasoned, allowlisted node. That self-corrects only once the settler demotes that node too.
- **Calibration is global per model node (N-13).** Calibration is global, but the allowlist, `minSamples` and Brier threshold are set per pool. A node seasoned anywhere gets (step-limited) power on any pool that allowlists it, and a demotion applies everywhere.
- **`minSamples` must be ≥ 1 (N-04, fixed).** `_validateConfig` rejects 0, so a node with no record never has power.
- **The owner's `setModelAllowed` is instant.** A newly allowed node starts unseasoned, at kDefault. Disallowing every node pushes the pool to stale / `conservativeFee`. That is a bounded owner DoS, because `conservativeFee` itself is timelocked.
- **Timelock (N-08 fixed, N-09 documented).**
  - `updatePoolConfig`, `setAttestor` and `setRoleOracle` queue on the first call. The identical call executes in the window `[eta, eta + TIMELOCK_GRACE]`, where `TIMELOCK_GRACE` is 1 day. After that window the entry re-queues instead of executing.
  - The queue id is `keccak256(calldata)`, so the same call with trailing bytes is a separate entry. Watchers must track every `ChangeQueued`.
  - Entries are not bound to the owner that queued them and survive `transferOwnership`. A new owner should cancel entries it does not endorse.
  - With `configDelay = 0` (local), changes apply immediately.

**Calibration gate semantics (settler, INTEGRATION_1)**
- **Label.** A block with non-stale arb-direction swaps is "informed" (y = 1) if those swaps' net markout is positive against the attested CEX mid *in force at that block* (`MARKOUT_HORIZON=0`, the default). In other words, the swaps were profitable against the contemporaneous CEX price after the fee, which is the LVR definition. The +1-block markout (`MARKOUT_HORIZON=1`) adds the next block's price move to every label. When that move is comparable to the fee, the labels are mostly noise.
- **Model input.** The keeper tells the model the fee an arbitrageur actually pays on this pool, `min(base + k·gap, feeMax)` at the current k, not just the base fee. With only the base fee, Jev put p ≈ 0.8 on every gap above 0.30 %, even when the directional fee ate the whole edge. A 45 bps gap at k = 0.5 now gets p = 0.10 instead of 0.80. The model still outputs only p/confidence, never a fee.
- **Posted value.** `setCalibration.brierBps` is the raw Brier score (`CALIB_GATE=raw`, the default). With `brierDemoteBps = 2500`, a model is demoted iff it forecasts worse than a constant p = 0.5, which carries no information. A skill-normalised alternative is opt-in (`CALIB_GATE=skill`). It posts `2500 · Brier / Brier(base-rate predictor)` over the same window, with a Laplace-smoothed base rate, and demotes iff the model is no better than climatology.
- **Why raw.** Measured on live-chain runs (`services/src/e2e/calib-experiment.ts`; honest p vs its inversion on the same labels, share of settle points that would be demoted):

  | run | horizon | window | honest raw | honest skill | degraded (both) |
  |---|---|---|---|---|---|
  | replay 1m×4, fee-aware state (41 labels) | 0 | 8 / 20 / 50 | **0 / 0 / 0 %** | 0 / 0 / 0 % | 100 % |
  | same | 1 | 8 / 20 / 50 | 20.5 / 25.6 / 25.6 % | 43.6 / 33.3 / 30.8 % | 100 % |
  | replay 1m×4, base-fee state (43 labels) | 0 | 8 / 20 | 7.3 / 2.4 % | 29.3 / 9.8 % | 100 % |
  | calm 1s×12, base-fee state (27 labels, base rate 11 %) | 0 | 8 / 20 | 28 / 20 % | 56 / 80 % | 100 % |

  Skill never separated better than raw. It also demotes the honest model when the base rate is extreme, because climatology is then hard to beat. The levers that mattered were the label horizon and the fee-aware state.
- **Transparency.** The settler writes the posted value (`calibration.brier`), the raw Brier (`calibration.brierRaw`), the Brier skill against the base rate (`calibration.skill`, signed bps) and the base rate (`calibration.baseRate`) to ENS.
- **Labels near zero are noise: dead band (v4).** In the mainnet dataset 59% of blocks have |markout| < $1, so a sign-only label ("informed iff markout > 0") is decided by mid noise most of the time and the gate grades coin flips. The settler therefore grades only decisive blocks: with `m` = the block's arb-direction markout net of the label fee (the base fee under v4, §14) and `T = max(SETTLER_DEADBAND_USD, SETTLER_DEADBAND_BPS · arb-direction USD volume)` (defaults $1 and 1 bp), `y = 1` iff `m > T`, `y = 0` iff `m < −T`, and `|m| ≤ T` is not graded (logged as `skippedAmbiguous`). `0/0` restores the sign-only label. The fine-tuning export (`ml/src/kev_export_deadband.py`) uses the same rule, so the model and the gate agree on what "informed" means. Cost: fewer graded blocks per window, so seasoning takes longer (the demo profile compensates with `MIN_SAMPLES=3`, `CALIB_WINDOW=8`).
- **Small windows are noisy.** With 3–8 labels, an honest model can be demoted for a few settle points. In the calm run, the honest demotions were the first points, with n < 8. This bounded self-DoS falls back to `kDefault`. With the v4 default `kDefault = 0` (§14) that means k = 0: the arb direction pays exactly the base fee, i.e. an untrusted (unseasoned or demoted) model turns the pool into a vanilla pool — never a fee below base, and never a fee above what a seasoned model would set. Production should use `minSamples` and a window of at least 20. The demo profile uses `MIN_SAMPLES=3` and `CALIB_WINDOW=8` so that the story fits in 3 minutes.

## 13. v3: threshold fee law and the gated keeper

Benchmark v2 (`benchmark/results_v2/results.md`) showed the v2 law costs LPs in calm hours: even a tiny gap adds `k · gap` to the arb-direction fee, the retail flow in that direction routes to the vanilla pool next door, and the hooked pool keeps only ~26% of retail. v3 changes the law to price only the part of the gap above an arbitrage threshold:

```
fee = arbDir && !stale ? min(base + k · max(0, gapHW − arbThresholdPips) / 1e4, feeMax) : base   (stale: conservativeFee)
```

- `arbThresholdPips` is a new `PoolConfig` field (last field, `uint24`, validated `≤ feeMax`, timelocked like the rest of the config). Default in the deploy scripts: `baseFee + 300` (env `ARB_THRESHOLD_PIPS`).
- Everything else is unchanged: directional, per-block per-direction high-water gap, "live price at/past the mid → base", stale → `conservativeFee`, N-07 floor, never reverts, `quoteFee` = executed fee. The `Receipt` event is unchanged; `gapPips` is the raw high-water gap and the fee is recomputed with the pool's `arbThresholdPips` (`poolConfig(id)`).
- **Gated keeper.** Below `arbThresholdPips − hysteresis` k cannot matter, so the keeper does not call Jev; it posts the mid with a deterministic rule score under a dedicated allowlisted node `rule-v1.models.oniblock.eth`. The settler never grades rule-v1 blocks, so rule-v1 stays unseasoned and pins k to `kDefault` — harmless below the threshold, but a gated keeper should run with a `maxKStepBps` large enough that one above-threshold model attestation can reach its target k.
- **Settler labels** now mark arb-direction swaps out against the CEX mid at the swap's block time (fetched ex post from the price source / Binance), not the attested (possibly lagged) mid; the old behaviour is a flag.
- Build + evidence: `docs/review/V3_THRESHOLD_BUILD.md`; benchmark: `benchmark/results_v3/results.md`.

## 14. v4: the AI decides the fee (no hard-coded threshold)

Benchmark v3 (`benchmark/results_v3/results.md`) showed that a hard-coded arbitrage threshold makes the pool a vanilla pool in calm hours but also gives back most of the volatile-hour premium, and that the keeper only consulted the model on ~11% of blocks. v4 removes the hard-coded gate and makes the model's per-block judgement the fee decision, without any contract change:

- **Config, not code.** `arbThresholdPips = 0`, `kMinBps = 0`, `kDefaultBps = 0`, `kMaxBps = 8000`, `maxKStepBps = 8000` (deploy-script defaults, env-overridable). The public map is unchanged, `k = kMin + (kMax − kMin)·p·c`, so `k = 0.8·p·c`: a "no profitable arbitrage" answer (p near 0) gives k ≈ 0 and the arb direction pays exactly the base fee; a "toxic arbitrage" answer gives a high k. One attestation can move k across the whole range, so the fee follows the model block by block.
- **kDefault = 0 is the safety property.** Unseasoned, demoted or non-allowlisted nodes get `kDefault`; with 0 that means no power at all: the pool is a vanilla pool until a model has earned trust, and again the moment it loses it. Demotion never raises a fee and never lowers it below base.
- **Keeper (`KEEPER_GATE` default 0).** Jev is asked on every block with a k-free state (gap, base fee, the arbitrage edge at the base fee, flow, volatility) and a question that says what the answer does: the extra fee is proportional to the probability, and no profitable arbitrage at the base fee means a probability near 0. The v3 rule-v1 gate is kept behind `KEEPER_GATE=1` for comparison only; it must never be combined with `kDefault = 0` (rule-v1 posts would reset k to 0 on every quiet block), and the keeper refuses to start that way.
- **Settler (`SETTLER_LABEL_FEE` default `base`).** A block is "informed" iff its arb-direction flow was profitable at the base fee (gross markout > base-fee cost), the same question the model answers. Grading against the fee actually paid would punish a model for protecting LPs (a high k makes the remaining flow unprofitable net of fee). Every block with arb-direction flow is gradeable, so calm hours season the model too.
- Build + evidence: `docs/review/V4_AI_DECIDES.md`; benchmark: `benchmark/results_v4/results.md`.

