# Submission checklist (ETHGlobal Tokyo 2026)

Status as of 2026-09-26 (final acceptance review, see [`docs/review/FINAL_ACCEPTANCE.md`](review/FINAL_ACCEPTANCE.md)).
Legend: **[x]** done and verified · **[ ]** open · **USER** must be done by a human (account, form, funds, git).

## 1. Uniswap Foundation: Best Uniswap Stack Contribution (Start Fresh)

Requirements (from the prize page; re-verify at ethglobal.com/events/tokyo2026/prizes/uniswap-foundation):

| requirement | status | notes |
|---|---|---|
| Builds on the Uniswap stack | [x] | v4 dynamic-fee hook `contracts/src/OniblockHook.sol` on the real Sepolia PoolManager `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543` (fork-verified). |
| Public GitHub repo | [ ] **USER** | No repo exists yet (no `.git`). Create a public GitHub repo; see §3 for the commit-history requirement. |
| README identifies relevant contracts and code lines | [x] | README "Where to look". All 18 `OniblockHook.sol` ranges and the sub-line pointers in the `setAttestation` row (398, 399-402, 403-405, 406, 409-410, 413, 415-427, 438-454) were re-checked against the current 872-line file and point at the right code. The `EnsV2RoleOracle`, `EnsV2Lib`, `EnsSetup`, `DeployBase`, `DeploySepolia` and services pointers were checked too. GitHub `#Lx-Ly` anchors only resolve once the repo is public; re-check them in the GitHub UI if `contracts/src` changes. |
| `FEEDBACK.md` in repo root | [x] | `FEEDBACK.md`: what worked, 9 numbered friction points with concrete suggestions. |
| Uniswap Developer Feedback Form | [ ] **USER** | Submit the form (link on the prize page). You can paste from `FEEDBACK.md`. |
| Demo video / ETHGlobal submission form | [ ] **USER** | Use the script in `docs/PITCH.md` (3 min). Record against `./scripts/demo-local.sh` and `./scripts/demo-fork.sh`. |

## 2. ENS: Best Use of ENSv2

| requirement | status | notes |
|---|---|---|
| ENSv2 is central, not cosmetic | [x] | Quoter and settler power are custom EAC role bits on `quoter.oniblock.eth` / `settler.oniblock.eth` (UserRegistry). The hook checks them through `EnsV2RoleOracle` on every attestation and calibration post. `revokeRoles` is the kill switch. The model scorecard is `calibration.*` text records only the settler can write (PermissionedResolver per-key permissions). All reads go through UniversalResolverV2. |
| Runs on ENSv2 on Sepolia | [~] | Verified end to end on an **Anvil fork of Sepolia** against the real ENSv2 contracts (`scripts/demo-fork.sh`, headless run passed today: ENS records via UR, revoke → stale → conservative fee, grant backup → resumed). **Nothing is broadcast to Sepolia yet.** |
| Functional demo, no hard-coded values | [x] with one note | The app resolves names and records through UniversalResolverV2, and addresses and namehashes come from `deployments/<chainId>.json` / `<chainId>.ens.json`. `app/src/lib/server/chain.ts` `DEFAULT_NAMES` lists the default `*.oniblock.eth` names, but only to label namehashes in the UI (reverse lookup). The ENS root is configurable (`ENS_NAME`). Note: dev buttons (`/api/dev/*`, including Revoke quoter) are disabled on `CHAIN=sepolia` by design. On Sepolia, run the kill switch with `cast send` (below). |
| Live demo link | [ ] **USER** | Needs a Sepolia deploy (below) plus a hosted app. |
| Open source | [ ] **USER** | Same public repo as §1. Consider adding a LICENSE file (none present). |

### Sepolia deploy: status

- **v4 hook is live** (2026-09-27 00:08): hook `0x8A350b37Ae9B6d7502197db4A45Cd97E34CDB5c3`, EnsV2RoleOracle `0xda0078c14d57c93478fa07993188c4a82add5872`, `oniblock.eth` registered on ENSv2 Sepolia (`deployments/11155111*.json`).
- **v5 (two knobs, `docs/review/V5_JIT_HEAD_SPEC.md`) needs a redeploy of the hook + pools**: the attestation struct gained `pJitBps`, so v5 services cannot post to the v4 hook. One command, rehearsed on a fork against the real ENS state (`REHEARSE=1`): `scripts/deploy-sepolia.sh` — it skips ENS registration (already done), runs the idempotent `ENS_PHASE=grant-jit` (settler roles for `calibration.jit.*`), keeps the v4 file as `11155111.prev.json`, deploys and verifies the new hook (~9M gas ≈ 0.009 ETH at 1 gwei) and rewrites the `weth-usdc.pools` records. Then restart `CHAIN=sepolia` keeper/settler (they preflight the ENS roles and refuse to start on a mismatch).

### Sepolia deploy: exact steps (as scripted; manual equivalents below)

The deployer `0x2Fd8…Fc73` has **0 Sepolia ETH** and nonce 0 (checked 2026-09-26). `oniblock.eth` and `oni-block.eth` are both **available** on the Sepolia ENSv2 `ETHRegistrar` (read-only `isAvailable` check). Registration is paid in the registrar's mintable MockUSDC, so the name itself costs no ETH.

0. **Keys.** Generate separate keys for the quoter (keeper), the settler, the attestor (signs only, needs no gas) and a backup quoter. Put them in the root `.env` as `QUOTER_PK`, `SETTLER_PK`, `ATTESTOR_PK`, `BACKUP_QUOTER_PK`. Without them, every role falls back to `DEPLOYER_PK`, which works but weakens the ENS role story. Fund the deployer, quoter and settler.
1. **ENSv2 commit** (about 63k gas):
   ```bash
   cd contracts && set -a && source ../.env && set +a
   export ENS_OWNER=$DEPLOYER_ADDR ENS_QUOTER=<quoter addr> ENS_SETTLER=<settler addr> ENS_SECRET=$(cast keccak "$(openssl rand -hex 32)")
   ENS_PHASE=commit forge script script/EnsSetup.s.sol --rpc-url $SEPOLIA_RPC_HTTPS --private-key $DEPLOYER_PK --broadcast
   ```
2. Wait **at least 60 s and less than 24 h**. Keep `ENS_SECRET`, `ENS_OWNER` and `ENS_DURATION` identical.
3. **ENSv2 finish** (about 8.5M gas, about 40 txs) writes `deployments/11155111.ens.json`:
   ```bash
   ENS_PHASE=finish forge script script/EnsSetup.s.sol --rpc-url $SEPOLIA_RPC_HTTPS --private-key $DEPLOYER_PK --broadcast --slow
   ```
4. **Hook + pools** (about 12.0M gas; picks up `roleOracle` from `11155111.ens.json`; `--verify` uses `ETHERSCAN_API_KEY`) writes `deployments/11155111.json`:
   ```bash
   QUOTER=<quoter> SETTLER=<settler> ATTESTOR=<attestor> \
     forge script script/DeploySepolia.s.sol --rpc-url $SEPOLIA_RPC_HTTPS --broadcast --verify
   ```
5. **Pool records** on `weth-usdc.pools.oniblock.eth`. Use the same resolver multicall that `scripts/demo-fork.sh` (lines 138-145) sends, with `--rpc-url $SEPOLIA_RPC_HTTPS --private-key $DEPLOYER_PK`, for the `hook` and `pool-id` keys.
6. Check the wiring: `cast call <roleOracle> "isQuoter(address)(bool)" <quoter>`, and `isSettler`, both `true`; `cast call <hook> "roleOracle()(address)"` equals the roleOracle.
7. **Services + app:** `CHAIN=sepolia pnpm -C services keeper` and `CHAIN=sepolia pnpm -C services settler` (optionally `arb` / `retail`), plus `CHAIN=sepolia pnpm -C app build && CHAIN=sepolia pnpm -C app start`.
8. **Host the app** for the live link. The app reads `../deployments` and `../abis` from disk at request time. On Vercel, set the project root to `app/`, keep the monorepo checked out, and verify that those files are traced into the serverless bundle. Add `outputFileTracingIncludes` for `../deployments/**` and `../abis/**` in `app/next.config.ts` if the routes 500. Alternative: run the app on a small VM or a tunnel.
9. **Kill switch on Sepolia** (for the video): `cast send <UserRegistry> "revokeRoles(uint256,uint256,address)" <labelId(quoter)> $((1<<64)) <quoter>`, then `grantRoles(...)` for the backup key. Take `registry` from `11155111.ens.json`. labelId(quoter) = `uint256(keccak256("quoter"))` (see `docs/ENS_INTEGRATION.md` §1).
10. Transfer hook ownership to a Safe (Ownable2Step). Optional for the hackathon.

**Estimated Sepolia ETH** (gas price measured today about 1.05 gwei; Sepolia spikes to 10+ gwei):

| item | gas | @1 gwei | @5 gwei |
|---|---|---|---|
| EnsSetup commit + finish | about 8.6M | 0.009 | 0.043 |
| DeploySepolia (hook, tokens, pools, liquidity) | about 12.0M | 0.012 | 0.060 |
| pool records, role checks, kill-switch demo | about 0.3M | <0.001 | 0.002 |
| **deployer subtotal** | **about 21M** | **about 0.021** | **about 0.105** |
| keeper: 1 attestation per 12 s block, about 100–130k gas each | about 35M per hour | 0.035 per hour | 0.18 per hour |
| settler: `setCalibration` + ENS multicall every `SETTLE_EVERY` blocks | about 3M per hour | 0.003 per hour | 0.015 per hour |

Recommendation: deployer **0.15 ETH**, quoter **0.2 ETH** (a few hours of live keeper at normal gas), settler **0.05 ETH**, plus 0.05 each for arb and retail bots if you run them on Sepolia. That is about **0.5 Sepolia ETH total** for comfort, and 0.1 is the bare minimum for deploy plus about 1 h of keeper at 1 gwei. The gas figures come from the fork runs' `forge script` estimates (`.runtime/logs/fork/*.log`) and the Foundry gas report.

## 3. ETHGlobal "Start Fresh" rules

| rule | status | notes |
|---|---|---|
| Work began after the hackathon start (Sep 25) | [x] | All project files date from 2026-09-26 (mtimes). README states no code is reused from other hackathon projects, including UniPerp. |
| **Version-control history** | [ ] **USER, HIGH RISK** | There is **no git repository**. ETHGlobal requires a public repo whose history shows the work progressing during the event. Projects submitted as one large commit (or a handful of huge ones) are routinely flagged, and can be **disqualified** from Start Fresh prizes, because judges cannot tell the code was written at the event. You said you do not want the agent to commit, so do this yourself **as early as possible**: `git init` in `oniblock/` (**not** in `~/Desktop/et`, which holds `keys.txt`), then commit in logical, incremental steps (contracts → tests → scripts → services → benchmark → app → docs) and keep committing real changes until the deadline. Do not rewrite timestamps. Be ready to explain the history to judges if asked. |
| No secrets in the repo | [x] | Root `.gitignore` covers `.env`, `.env.*` (except `.env.example`), `.runtime` (whose fork logs contain the RPC URL), `broadcast`, `out`, `cache`, `node_modules`, `.next`, `*.log`. No `.env` value appears in any other tracked file. Only the public Anvil dev keys are hard-coded, and the app uses them server-side only (`import 'server-only'`, dev chains only). |
| Large vendored deps | [ ] **USER** | `contracts/lib` is 160 MB of plain directories (no `.gitmodules`). Before the first commit, either re-add them as submodules (`forge install foundry-rs/forge-std OpenZeppelin/uniswap-hooks`, pinned to the same commits) or commit them knowingly. Committing 160 MB of vendored code in the first commit also looks like the "large single commit" pattern. |
| Prizes selected on the submission form | [ ] **USER** | Uniswap Foundation (Start Fresh) and ENS (Best Use of ENSv2). |
