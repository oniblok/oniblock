# Final acceptance review

Date: 2026-09-26. Reviewer: final acceptance agent. Constraints followed: no git, no Sepolia broadcasts, no `.env` values printed, every Anvil run used `--prune-history`, every started process was stopped (checked with `pgrep` afterwards), and `contracts/src` was not modified. Disk: 39 GiB free on `/System/Volumes/Data` before and after.

## 1. Acceptance commands (BUILD_SPEC "Acceptance" + README "Run it")

| command | result | key numbers |
|---|---|---|
| `cd contracts && forge build --sizes` | **PASS** (exit 0) | `OniblockHook` runtime 21,349 B (3,227 B margin under EIP-170), initcode 23,530 B; `EnsV2RoleOracle` 1,537 B |
| `cd contracts && forge test` | **PASS** | 83 passed, 0 failed, 1 skipped (fork suite, gated by `FORK=1`); 8 suites; 3 invariants |
| `OFFLINE=1 pnpm -C services test` | **PASS** | 52 passed, 5 skipped (10 files) |
| `pnpm -C services test` (live Binance + Jev) | **PASS** | 57 passed |
| `pnpm -C services e2e` (port 8545, free) | **PASS** | 61 blocks, 60 attestations, 18 receipts (12 arb), 0 stale receipts, no fee-law failures; degraded at 60% by design; 1 min 26 s |
| `pnpm -C benchmark run:quick` | **PASS** | 2 runs × 150 steps, 0 reverts; writes `benchmark/results/quick/` only |
| `pnpm -C app build` | **PASS** | tsc + eslint + next build; 11 routes. Client bundle (`.next/static`) contains no private keys or API-key names |
| `DEMO_DURATION=200 ./scripts/demo-local.sh` | **PASS** (rc 0, story `missing: []`) | unseasoned from block 25 (all at kDefault) → seasoned at block 34 (Brier 0.0236, n=3; first k off default 0.30 at block 35) → Degrade at block 63/64 → demoted at block 89 (Brier 0.3979) → k back to 0.50 at block 90. 100 attestations, 44 receipts, no honest demotions, no attestation gaps |
| `DEMO_DURATION=200 ./scripts/demo-fork.sh` | **PASS** (rc 0, story `missing: []`) | Fork at Sepolia block 11783090. EnsSetup commit/finish on real ENSv2. Hook on the real PoolManager. ENS `calibration.brier=115 n=3` read via UniversalResolverV2; `/api/models` and `/api/receipt` resolve ENS names. Revoke quoter (ENS `revokeRoles`) → `isQuoter=false` → `quoteFee` 5000 stale → swap while stale charged 5000. Grant backup → `quoteFee` 3018, not stale. 53 attestations, 26 receipts, 1 attestation gap (15 blocks, intended), 5 stale receipts at 5000 |

Not run: `FORK=1 forge test --match-path test/fork/EnsSetup.t.sol` (not on the requested list; the fork demo covers the same path) and `contracts/smoke-local.sh`.

### Doc / command mismatches fixed
- **`pnpm -C benchmark run` does not run the benchmark.** With no script name, pnpm only lists scripts. BUILD_SPEC Acceptance used it, and README used the awkward `pnpm -C benchmark run run`. Changed to `pnpm -C benchmark bench` in `docs/BUILD_SPEC.md` and in two places in `README.md`, plus the generator string in `benchmark/src/report.ts`, the header of `benchmark/results/results.md` and the usage comment in `benchmark/src/run.ts`.

## 2. Benchmark refresh

`README.md` `<!-- BENCH-UPDATE -->` and "What this means", plus `docs/PITCH.md` (pitch paragraph, demo 2:45 line, Q&A #2 and a new follow-up, "lines to avoid"), were rewritten from the latest `benchmark/results/results.md` (2026-09-26T01:30Z, 723 s, 0 reverts, contemporaneous labels, fee-aware model state):

- **Model vs constant k:** the model picks a lower k (mean 0.25–0.33). LP − HODL is significantly worse in all 4 runs (−113 to −629 USD, CIs < 0), retail cost is lower (−102 to −385 USD, CIs < 0), and LVR shows no significant difference.
- **Constant k vs fixed 0.30%:** better in every window (+186 to +1,999 USD, CIs > 0), at 8–10 bps more retail cost.
- **Gate:** the degraded model was demoted 40–140 steps after degradation, and gated − ungated in the second half is +42 to +445 USD. The honest model had 0 demoted steps in calm and 13–20% (960–1,440 of 7,200) in the volatile windows.
- **Framing used:** ship constant k plus the calibration gate. The model is a pluggable, accountable input; on this data it trades LP revenue for lower retail cost. The gate is what makes plugging in any model safe.
- The stale README claim that "the benchmark still uses its original +1-block labelling (26–55% honest demotion)" was removed, because the rerun uses the live services' labelling.

## 3. Prize requirements

See [`docs/SUBMISSION_CHECKLIST.md`](../SUBMISSION_CHECKLIST.md). README line pointers into `OniblockHook.sol` (and scripts/services) were verified against the current files, and all are correct.

## 4. Code-quality pass

- **TODO / FIXME / HACK:** none in contracts, services, app, benchmark or scripts.
- **Debug output:** the only `console.log` calls are intentional CLI output (`--once` modes of the bots and settler, `jev-probe`, `pricesource`, benchmark logger). Nothing is left in `contracts/src`.
- **Secrets:** no `.env` value (`DEPLOYER_PK`, `AI_GATEWAY_API_KEY`, `ETHERSCAN_API_KEY`, `SEPOLIA_RPC_HTTPS`) appears in any other file, **except** that the RPC URL appears in `.runtime/logs/fork/anvil.log`, which is gitignored. The hard-coded 32-byte hex values are the public Anvil dev keys, namehashes, labelIds and event topics. The app's dev keys live in `app/src/lib/server/devkeys.ts` behind `import 'server-only'`, and `/api/dev/*` refuses non-dev chains. No `sk-` / `vck_` / AWS-style keys were found. `~/Desktop/et/keys.txt` sits **outside** the repo, so do not `git init` in `~/Desktop/et`.
- **`.gitignore` hardened (root):** added `.env.*`, `!.env.example`, `*.tsbuildinfo`, `.DS_Store`, `*.log`. It already had `.env`, `node_modules`, `out`, `cache`, `broadcast`, `.next`, `.runtime`.
- **Naming:** "ReceiptHook" remains only as the documented working name (`docs/DESIGN.md` title, `docs/BUILD_SPEC.md` line 3, the README "More docs" note). Fixed one user-visible leftover: the ENS `description` record in `contracts/script/EnsSetup.s.sol:297` said "(ReceiptHook)" and is now just "Oniblock: attested, directional LVR fee law for Uniswap v4". `forge build` still compiles; the change is a string only.
- **Stale review line numbers (noted, not rewritten):** `docs/review/CONTRACT_REVIEW_1.md` (13 `OniblockHook.sol:N` refs) and `CONTRACT_REVIEW_2.md` (for example N-01 cites `_liveAnchor` at 650-685, now 729-765, and `_fee` at 688-698, now 770-784) point at pre-fix line numbers. They are historical review snapshots. README is the source of truth for current lines.
- **Other observations:**
  - `contracts/lib` is 160 MB of vendored deps with no `.gitmodules` (see the checklist).
  - There is no LICENSE file; add one for "open source".
  - `app/AGENTS.md` / `app/CLAUDE.md` are auto-generated by `next dev`, which is harmless.
  - The e2e keeper shows `degraded:true` in the second 40% of the run, which is intended (`--degrade-at` defaults to 60% of blocks).

## 5. Sepolia deployer balance (read-only)

`DEPLOYER_ADDR` = `0x2Fd8A0fA5E7CF993c167fcF6b514D22d2b79Fc73`: **0.0 ETH**, nonce 0. Sepolia gas price is about 1.05 gwei. `oniblock.eth` (and backup `oni-block.eth`) are available on the ENSv2 registrar. Nothing was deployed.

## Files changed in this review

- `docs/BUILD_SPEC.md`: benchmark acceptance command.
- `README.md`: benchmark command (×2); BENCH-UPDATE section and "What this means" rewritten.
- `docs/PITCH.md`: pitch, demo line, Q&A #2 plus follow-up, lines to avoid.
- `benchmark/src/report.ts`, `benchmark/src/run.ts`, `benchmark/results/results.md`: "Reproduce" command string.
- `contracts/script/EnsSetup.s.sol:297`: ENS description string (no "ReceiptHook").
- `.gitignore`: extra secret, log and build patterns.
- New: `docs/SUBMISSION_CHECKLIST.md`, `docs/review/FINAL_ACCEPTANCE.md`.

## Remaining user actions

1. **Git history (high risk):** `git init` inside `oniblock/`, and decide on `contracts/lib` (submodules or not) first. Commit incrementally in logical steps and keep committing until the deadline. A single large commit risks Start Fresh disqualification.
2. **Public GitHub repo:** push it and check that the README `#Lx-Ly` links resolve. Add a LICENSE.
3. **Uniswap Developer Feedback Form:** submit it (content in `FEEDBACK.md`).
4. **Fund Sepolia:** at least 0.1 ETH (bare), about 0.5 ETH comfortable, split across deployer, quoter and settler. Generate `QUOTER_PK` / `SETTLER_PK` / `ATTESTOR_PK` / `BACKUP_QUOTER_PK`.
5. **Sepolia deploy:** follow `docs/SUBMISSION_CHECKLIST.md` §2 steps 1–9 (EnsSetup commit, wait 60 s, finish, DeploySepolia, pool records, services, app).
6. **Host the app** for the ENS "live demo link" (check that `deployments/` and `abis/` are traced when deploying to Vercel).
7. **Record the demo video** (`docs/PITCH.md` script) and fill in the ETHGlobal submission, selecting both prizes.
