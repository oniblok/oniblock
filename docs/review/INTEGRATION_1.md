# Integration pass #1: demo liveliness, narrative, deployBlock, ENS on a fork, calibration gate

Date: 2026-09-26. Nothing was broadcast to Sepolia; all ENS/v4 work ran on local Anvil forks. `contracts/src` and `benchmark/` were not edited.

## Summary

| Task | Result |
|---|---|
| 1. Replay price source | `services/src/pricesource.ts`, selected with `PRICE_SOURCE=live\|replay`. The keeper, arb bot, retail bot and settler share one block-indexed path, so the same block gives the same mid. `demo-local.sh` defaults to replay (`DEMO_PRICE_SOURCE`). Arbs now fire on their own: 15 arb txs in the first 60 blocks of run 1, with no manual swaps. |
| 2. Narrative in 3 min | Headless `DEMO_DURATION=180` passes `--expect seasoned,honest-active,demoted`. The model is seasoned at t+22 s. Degrade model is pressed at t+73 s. The model is demoted at t+102 s, and k = kDefault from the next block. |
| 3. deployBlock | `scripts/lib.sh patch_deploy_block` writes the first block that holds a deploy tx, read from forge's broadcast receipts. Local: 0 → 1. Fork: 11782826 → 11782827. The app and services already start their history reads at `deployBlock`. |
| 4. ENS on a fork | `scripts/demo-fork.sh` runs end to end: EnsSetup commit/finish, DeploySepolia on the real PoolManager with the EnsV2RoleOracle, and settler writes of `calibration.*` that the UR resolves. The app's `/api/models` and `/api/receipt` show the ENS names and records. Revoke makes the pool stale at conservativeFee 5000; Grant backup resumes attestations. |
| 5. Tests | Services `tsc` is clean. `OFFLINE=1 vitest`: 52 passed, 5 skipped. Live vitest: 57 passed. Services e2e: PASS. `pnpm -C app build`: OK. EnsSetup fork tests: 5/5. `contracts/smoke-local.sh`: SMOKE OK. |
| Coordinator add-on 1: disk | `--prune-history 64` is now set on every anvil we spawn (`run-local.ts`, `demo-local.sh`, `demo-fork.sh`, `contracts/smoke-local.sh`). `du -sh ~/.foundry/anvil` was **0 B** after all runs. The fork also uses `--no-storage-caching`. |
| Coordinator add-on 2: gate | The skill-normalised gate is implemented, but it is opt-in because it separated honest from degraded models worse than raw. The actual fixes were the label horizon (mid in force) and a fee-aware model state. On the same labels, the honest model was demoted at 0 % of settle points and the degraded one at 100 %. Details below. |

## 1. Replay price source

`services/src/pricesource.ts`:
- `PRICE_SOURCE=live` (the default for services run on their own) uses the Binance bookTicker.
- `PRICE_SOURCE=replay` uses real cached Binance klines (`REPLAY_INTERVAL=1m`, `REPLAY_STEP=4` klines per block, `REPLAY_BLOCKS=150`).
  - Block *b* reads index `pingPong((b − REPLAY_ORIGIN_BLOCK) · STEP)`. Walking forward then backward means the path never jumps.
  - The window is `REPLAY_START_MS`, or the most volatile `REPLAY_BLOCKS·STEP` stretch of the last `REPLAY_LOOKBACK_H=168` h.
- `demo-local.sh` resolves the window **once** (`tsx src/pricesource.ts --resolve`) and exports `REPLAY_START_MS`, so processes started across an hour boundary still agree. The pool is initialised at the first replay price, and `REPLAY_ORIGIN_BLOCK` is set to the first block after deploy.
- Keeper (`midSource(block)`), ArbBot (`step(block)`), RetailBot (`step(block)`) and the settler's fallback mid all index by the observed block number. They agree without any IPC. This is verified by `test/pricesource.test.ts` ("two instances agree on the price for every block").

The window used in all local evidence runs was `REPLAY_START_MS=1789978440000` (2026-09-21 08:14 UTC), ETH 2667.50 → 2765.92, with a mean |step| of 15.9 bps and 21 steps over 30 bps.

Run 1 arb log, first 60 blocks, with no manual swaps:
```
arb vanilla  fee 3000 gap 4979  block 28 | arb oniblock fee 5489 gap 6650  block 29
arb oniblock fee 9901 gap 12471 block 32 | arb vanilla  fee 3000 gap 10000 block 33
arb oniblock fee 6659 gap 15207 block 43 | arb oniblock fee 10000 gap 11384 block 46 ...   (15 arb txs)
```

## 2. Demo narrative (`DEMO_DURATION=180 APP_CMD=start ./scripts/demo-local.sh`)

The demo profile sets `MIN_SAMPLES=3`, `SETTLE_EVERY=5`, `CALIB_WINDOW=8`, `CALIB_MIN_N=3` and `RETAIL_LAMBDA=1`. Headless, it presses **Degrade model** through the app (`POST /api/dev/degrade`) at 40 % of the duration. It then runs `pnpm -C services story --expect seasoned,honest-active,demoted --degraded-at <block>`. The new `services/src/e2e/story.ts` rebuilds the timeline from chain events. The service defaults outside the demo are unchanged: `SETTLE_EVERY=10`, `CALIB_WINDOW=30`, and `MIN_SAMPLES=10` in DeployBase.

Final run (`demo4`, services started at block 23, 2 s blocks):
```
[demo] t+73s block 59: Degrade model (POST /api/dev/degrade) -> {"degraded":true,"useBackupQuoter":false}
story: unseasoned {firstBlock 24, 10 attestations, allAtKDefault: true}
       seasoned   {block 34, brier 285, n 4, firstKOffDefault {block 35, k 4894}}
       degradedAt 60, honestDemotions []
       maxKWhileSeasoned 7073   (the degraded model briefly grabs power: k 2163 -> 5163 -> 7016)
       demoted    {block 74, brier 2751, n 8, kBackToDefault {block 75, k 5000}}
calibration (block: Brier bps): 34:285 39:316 44:335 49:934 54:941 59:911 | degrade | 64:911 69:1860 74:2751 79:2744 89:4638 99:5475
kPath: 24:5000 … 33:5000 36:5894 39:4266 42:6029 45:6488 48:4547 51:2422 … 60:2163 63:5163 66:7016 69:7016 72:6959 75:5000 … 111:5000
missing: []   -> rc 0
```
In seconds after services start, that is: unseasoned until about 22 s, seasoned (k follows the model, 2.1k–6.5k) until the degrade at 73 s, the Brier crossing 0.25 at about 102 s, and k = kDefault from then to the end.

Honest note: "k rises when seasoned" holds only when the model sees informed flow. In quiet blocks a seasoned model pushes k *below* kDefault, to about 2200, which is the law working as designed. The visible rise in the story is the degraded model: its inverted scores push k to 7016 until the gate clamps it.

Earlier runs, kept because they drove the fixes:
- **Run 1** used the old settings: +1-block labels and base-fee state. It passed, with seasoned at block 39 and demoted at block 99. The demotion took 35 blocks after the degrade.
- **Run 2** used `CALIB_WINDOW=6`. It **failed**: the honest model scored a Brier of 0.34–0.58 and was never seasoned.
- **Run 3** passed the old check, but the honest model had already been demoted at block 39 (Brier 2760, n=5) before the degrade. That led to the `honest-active` check, the label horizon change and the fee-aware state (§6).

## 3. deployBlock

Forge serializes the simulation's `block.number`, which is the pre-deploy head: 0 on a fresh anvil, or the fork head. `patch_deploy_block` (in `scripts/lib.sh`) takes the minimum `receipts[].blockNumber` from `contracts/broadcast/<Script>/<chainId>/run-latest.json`, falling back to the pre-deploy head + 1. `contracts/script/*` was not changed, because DeployBench inherits DeployBase and the benchmark is running.
```
[demo] deployed -> deployments/31337.json (deployBlock 0 -> 1)
[fork] deployed -> 11155111.anvil-fork.json (deployBlock 11782826 -> 11782827)
```
Readers:
- The app (`live.ts`, `models.ts`, `receipt.ts`) starts at `deployBlock`.
- The services settler and story start at `Deployment.startBlock` (= `deployBlock`).
- The replay origin defaults to it.

## 4. ENS on an Anvil fork of Sepolia (`DEMO_DURATION=240 ./scripts/demo-fork.sh`)

Flow:
1. Pin the fork block to Sepolia head − 3 (override with `FORK_BLOCK`). Anvil runs with `--retries 10 --fork-retry-backoff 1000 --no-storage-caching --prune-history 64`, and the script retries forge and RPC steps with backoff.
2. `anvil_setCode(addr, 0x)` on anvil accounts 0–7, to clear the EIP-7702 sweeper delegations.
3. EnsSetup commit, then `evm_increaseTime 61` and `anvil_mine`, then finish, all in automine.
4. DeploySepolia with `DEPLOYER_PK` set to anvil #0 (fork only) and the real v4 PoolManager `0xE03A…3543`. It uses the real StateView `0xE1Dd…7E4C`, which was verified with `poolManager()`, `ROLE_ORACLE` set to the EnsV2RoleOracle from EnsSetup, and Chainlink ETH/USD with a 200 bps band. The output goes to `deployments/11155111.anvil-fork.json`, so a future real `11155111.json` is never overwritten.
5. The owner writes `hook` and `pool-id` text records on `weth-usdc.pools.oniblock.eth`.
6. Interval mining at 3 s; keeper, settler, arb, retail and app (`next start`, `CHAIN=fork`, port 3001) start.
7. Headless checks run.

The price source is `live` by default on the fork. A replayed historical price would fall outside the Chainlink band; `DEMO_PRICE_SOURCE=replay` turns the band off explicitly.

Evidence from the final run (fork block 11782784):
```
[fork] ENS ready: oniblock.eth, roleOracle 0x579af5aB6e3E8C1247798B2a160517B561339561
[fork] deployed -> 11155111.anvil-fork.json (deployBlock 11782826 -> 11782827)
[fork] ENS weth-usdc.pools.oniblock.eth: hook=0x908FF05D811B92D8304142F0cAB6aFb41EDff5c3 pool-id=0x7081…79d1
[fork] roleOracle.isQuoter(quoter)=true isSettler(settler)=true hook.roleOracle=0x579a…9561
[fork] ENS jev-v1.models.oniblock.eth via UR: calibration.brier=82 hitRate=10000 n=3 epoch=11782870
/api/models: chain {fork, ens:true, ensName oniblock.eth}; jev-v1 ens {calibration.brier "82", calibration.brierRaw "82",
             calibration.skill "7958", calibration.baseRate "0", calibration.hitRate "10000", calibration.n "3", model-hash 0x5a36…, agent-context …}
/api/receipt/<retail swap tx>: modelName jev-v1.models.oniblock.eth, quoterEns {name quoter.oniblock.eth,
             resolved 0x7099…79C8, matches true}, attestation verified (recovered attestor 0x90F7…b906 == hook.attestor), calibration history
[fork] Revoke quoter (app POST /api/dev/quoter revoke) -> mechanism ensv2, "ENS revokeRoles(quoter, ROLE_QUOTER, 0x7099…79C8)" success
[fork] isQuoter(quoter) after revoke: false
[fork] quoteFee(zeroForOne) after 8 blocks: 5000 false 0 true      <- conservativeFee, stale
[fork] Execute swap while stale -> quotedFeePips 5000, success
[fork] Grant backup quoter -> "ENS grantRoles(quoter, ROLE_QUOTER, 0x976E…0aa9)" success, flags.useBackupQuoter true
[fork] quoteFee(zeroForOne) after grant: 3000 false 0 false        <- fresh again
story: killSwitch {attestationGaps [{from 11782876, to 11782892, blocks 16}], staleReceipts 5, staleFees [5000],
       quoters [0x7099… from 11782846, 0x976E… (backup) from 11782892]}; seasoned at 11782861 (Brier 82, n 3), k 5000 -> 2.0–2.4k
[fork] ENS after run: calibration.brier=103 n=8 epoch=11782920      -> rc 0
```
Settler log: `ens text_records_written name jev-v1.models.oniblock.eth … tx 0x…`, once per settle, with 7 keys per multicall.

The public RPC gave no rate-limit errors in three fork runs. Setup through deploy takes about 2 minutes.

Notes:
- The `evm_increaseTime 61` shifts the fork clock. Chainlink's `updatedAt` on Sepolia was 21 minutes old at fork time, well within `chainlinkMaxAge` 7200 s.
- Forge writes the fork's broadcast records to `contracts/broadcast/{EnsSetup,DeploySepolia}.s.sol/11155111/`. These exist **only on the fork**, not on Sepolia.

## 5. Tests and runs

| Command | Result |
|---|---|
| `pnpm -C services typecheck` | clean |
| `OFFLINE=1 pnpm -C services test` | 10 files, **52 passed, 5 skipped** |
| `pnpm -C services test` (live Binance + Jev) | **57 passed** |
| `pnpm -C services e2e --port 8572 --out ../deployments/31337.e2e.json` | **PASS**: 61 blocks, 60 attestations, 17 receipts (11 arb), 0 fee-law violations, CalibrationUpdated present |
| `pnpm -C app build` | OK (tsc + eslint + next build) |
| `FORK=1 forge test --match-path test/fork/EnsSetup.t.sol` | 5 passed (after the EnsSetup change) |
| `contracts/smoke-local.sh` | SMOKE OK (with `--prune-history`) |
| `DEMO_DURATION=180 ./scripts/demo-local.sh` | story PASS (above) |
| `DEMO_DURATION=240 ./scripts/demo-fork.sh` | story PASS `--expect stale,resumed` (above) |

New unit tests:
- `test/pricesource.test.ts`: ping-pong, volatile window, two instances agreeing per block, a live window.
- Skill gate and `midInForce` tests in `test/settler.test.ts`.
- Detail ENS records in `test/ens.test.ts`.
- Fee-aware state in `test/features.test.ts`.

## 6. Calibration gate (coordinator add-on 2)

**Problem.** The honest model also failed the absolute 0.25 gate.

**Experiment.** `pnpm -C services calib:experiment` runs on a live chain. It takes the attested p and the realised labels, and compares the honest p against its inversion, `1 − p`, which is exactly what the keeper's `degrade()` does to p. It evaluates the gate at every labelled block with a rolling window, and reports the share of settle points where the posted value would be over 2500.

| run (honest keeper, 300 s) | labels | horizon | W=6 raw / skill | W=8 raw / skill | W=20 raw / skill | W=50 raw / skill | degraded |
|---|---|---|---|---|---|---|---|
| A2: replay 1m×4, **fee-aware state** | 41 | **0** | **0 / 5.1 %** | **0 / 0 %** | **0 / 0 %** | **0 / 0 %** | 100 % (all cells) |
| A2 | 41 | 1 | 20.5 / 48.7 % | 20.5 / 43.6 % | 25.6 / 33.3 % | 25.6 / 30.8 % | 100 % |
| A: replay 1m×4, base-fee state | 43 | 0 | 12.2 / 22.0 % | 7.3 / 29.3 % | 2.4 / 9.8 % | 2.4 / 7.3 % | 100 % |
| A | 43 | 1 | 41.5 / 61.0 % | 41.5 / 58.5 % | 26.8 / 46.3 % | 4.9 / 12.2 % | 95–100 % |
| B: calm 1s×12, base-fee state, base rate 11 % | 27 | 0 | 20 / 32 % | 28 / 56 % | 20 / 80 % | 20 / 100 % | 100 % |

Median posted value in A2, horizon 0, W=8: honest 243 bps raw vs degraded 7233 bps.

**Decision.** Three changes, all in services (no contract change):
1. **Label horizon.** `MARKOUT_HORIZON=0` is now the default: the markout is taken against the attested mid in force at the swap block, i.e. the contemporaneous CEX price, which is the LVR definition. The +1-block markout adds a whole block of price noise, which with 4-minute replay steps is comparable to the fee. It remains available as `MARKOUT_HORIZON=1`.
2. **Fee-aware model input.** The keeper passes the hook's current k, and the state tells Jev that swaps toward the mid pay `min(base + k·gap, feeMax)`. With only the base fee, Jev said p ≈ 0.8 for any gap above 0.30 %, even when the directional fee ate the edge. Probe results, with p in bps and k = 0.5:

   | gap | base-fee state | fee-aware state |
   |---|---|---|
   | 45 bps | 8000 | 1000 |
   | 60 bps | 8000 | 1600 |
   | 90 bps | 8500 | 7200 |
   | 150 bps | 8400 | 7800 |

   The old wording is kept byte-for-byte when k is not passed, so the benchmark's Jev cache keys are unaffected.
3. **Gate value.** `CALIB_GATE=raw` stays the default: demoted iff the model is worse than the p = 0.5 no-information forecaster. The skill gate is opt-in (`CALIB_GATE=skill`): it posts `min(10000, 2500·B/B_ref)`, with `B_ref` the Brier of a Laplace-smoothed in-window base-rate predictor, so 2500 means skill = 0. It never separated better, and when the base rate is extreme (run B), climatology is hard to beat and the honest model gets demoted.
   - The settler writes `calibration.brier` (the posted value), `calibration.brierRaw`, `calibration.skill` (signed bps) and `calibration.baseRate` to ENS either way.
   - `EnsSetup.s.sol` now grants the settler the three detail keys. The writer falls back to the four base keys, with one log line, when a resolver from an older setup rejects them.

This is documented in `docs/DESIGN.md` §12 ("Calibration gate semantics") and `docs/ENS_INTEGRATION.md` §4.

**For the benchmark agent.** `benchmark/src/sim.ts` calls `labelBlocks` with its own `midNext`. To adopt horizon 0, pass the mid in force, `attestationIndex(atts).midInForce(b)` or the kline mid at the swap step. To adopt the fee-aware state, pass `kBps`/`feeMax` to `computeFeatures`. This invalidates its Jev cache keys, which is why it is not the default there. `calibrate(labels, window)` now defaults to `CALIB_GATE=raw`, which is the same number as before, and returns the extra fields `rawBrierBps`, `refBrierBps`, `skillBps` and `baseRateBps`.

## Files changed / added

- services:
  - `src/pricesource.ts` (new)
  - `src/keeper.ts`: shared price source, fee-aware features through `poolState.kBps`
  - `src/bots/arb.ts`, `src/bots/retail.ts`: `step(block)`, shared price source
  - `src/settler.ts`: horizon, skill/raw gate, detail records, replay fallback
  - `src/ens.ts`: detail keys with fallback
  - `src/features.ts`: `kBps`/`feeMax` giving `arbFeePips` and state text
  - `src/model/heuristic.ts`: cost = arb fee when known
  - `src/e2e/story.ts` (new)
  - `src/e2e/calib-experiment.ts` (new)
  - `src/e2e/run-local.ts`: `--prune-history`
  - `package.json` scripts: `story`, `pricesource`, `calib:experiment`
  - tests
- scripts: `lib.sh` (new), `demo-local.sh` (replay, demo profile, headless degrade and story), `demo-fork.sh` (new)
- contracts: `script/EnsSetup.s.sol` (3 more settler text keys), `smoke-local.sh` (`--prune-history`)
- app: calibration labels ("calibration score"), `CALIBRATION_KEYS` gained the detail keys, README
- docs: `DESIGN.md` §12, `ENS_INTEGRATION.md`, this file

Deployment JSONs written by the runs:
- `deployments/31337.json` (last local run)
- `deployments/31337.e2e.json`
- `deployments/11155111.anvil-fork.json` (new)
- `deployments/11155111.anvil-fork.ens.json` (overwritten by the fork run; the addresses exist only on a fork)
