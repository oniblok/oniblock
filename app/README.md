# Oniblock app

Next.js (App Router, TypeScript, Tailwind v4) dashboard for the Oniblock hook. The browser only talks to this app's
API routes; they read the chain with a viem public client. There are no wallet libraries.

## Pages
- `/`: live demo. Split screen showing Vanilla v4 (static fee) and Oniblock side by side: pool price vs the attested CEX mid, LP value minus HODL over time, fees earned, and loss to arb (swapper markout > 0 at the next attested mid). Below that, the **regime map**: one cell per block, colored by the *attested* k in force for that block. Stale blocks are hatched, demoted blocks are outlined, and hovering a cell shows p_toxic, confidence, k, regime fee, model and attestation age. Clicking a cell opens its receipt. The status strip shows the last block, p_toxic, attested k, `hook.quoteFee` in both directions, attestation age, the model node, and whether the model is demoted.
- `/receipt/[tx]`: decodes the Receipt and the attestation in force for that block. The attestor is recovered from the `setAttestation` calldata's EIP-712 signature and compared with `hook.attestor()` at post time. The page also shows the model's running calibration (`hook.calibration`, CalibrationUpdated history, and ENS text records via UniversalResolverV2 when the chain has our ENS deployment).
- `/models`: per model node: Brier score, hit rate, n, demoted/unseasoned state, a Brier history chart with the demotion threshold, and ENS text records.
- Dev controls (on `/`, only on local anvil or an anvil fork): Execute swap (arb direction or reverse, same swap on both pools through SplitSwapRouter), Degrade model, Revoke quoter / Grant backup quoter / Restore.

Every business value (fees, k bounds, stale window, demotion threshold, tokens, addresses) is read from chain or
from `../deployments/<chainId>.json`. ABIs come from `../abis/*.json` at request time, so a redeploy or regenerated
ABIs need no rebuild. Price math and the EIP-712 attestation type are imported from `../services/src`.

## Run
Everything at once (anvil, deploy, keeper, settler, arb and retail bots, app):
```bash
./scripts/demo-local.sh            # http://localhost:3000, Ctrl-C stops everything
DEMO_DURATION=180 ./scripts/demo-local.sh  # headless: presses "Degrade model" at 40 %, then checks the story
DEMO_PRICE_SOURCE=live ./scripts/demo-local.sh  # live Binance mid instead of the replay
DEMO_DURATION=200 ./scripts/demo-fork.sh   # Sepolia fork: real ENSv2 + v4 PoolManager, app on :3001 (CHAIN=fork)
```
**Demo profile (story in about 3 minutes).** The keeper, arb, retail bot and settler share one price source (`PRICE_SOURCE`, see
`services/src/pricesource.ts`). The default for `demo-local.sh` is `replay`: a volatile window of real Binance 1m klines from the
last 7 days, resolved once and exported (`REPLAY_START_MS`). Block *b* maps to kline `(b − REPLAY_ORIGIN_BLOCK) × REPLAY_STEP` (4 minutes of
history per block), so every process sees the same mid for the same block, and gaps larger than the fee open often enough for the arb
bot to act by itself. `MIN_SAMPLES=3`, `SETTLE_EVERY=5` and `CALIB_WINDOW=8` give the story in about 3 minutes: unseasoned (k = kDefault),
then seasoned (k follows the model), then Degrade model (the inverted model briefly pushes k up), then the Brier crosses 0.25, then demoted
(k = kDefault). `pnpm -C services story` prints that timeline from chain events.
App only, against a chain that is already running:
```bash
pnpm -C app install
CHAIN=local LOCAL_RPC=http://127.0.0.1:8545 pnpm -C app dev
pnpm -C app build                  # tsc + eslint + next build
```

Env:
| var | default | meaning |
|---|---|---|
| `CHAIN` | `local` | `local` (31337) · `fork` (anvil fork of Sepolia) · `sepolia` (read-only, uses `SEPOLIA_RPC_HTTPS` from root `.env`) |
| `LOCAL_RPC` / `FORK_RPC` | `http://127.0.0.1:8545` | RPC URL |
| `DEPLOYMENTS_FILE` | `../deployments/<chainId>.json` | deployment override |
| `ENS_DEPLOYMENT_FILE` | `<chainId>.ens.json` (fork: also `<chainId>.anvil-fork.ens.json`) | ENS deployment |
| `KEEPER_FLAGS_FILE` | `../.runtime/keeper-flags.json` | live keeper flags written by the dev panel |
| `APP_HISTORY_BLOCKS` / `APP_REGIME_BLOCKS` | 900 / 120 | chart / regime-map windows |
| `APP_MODEL_NAMES` | – | extra ENS names used to label namehashes when no ENS is on the chain |
| `APP_DEV_CONTROLS` | on | `0` disables `/api/dev/*` |

## How the dev controls work
- Signing happens only in server routes, with anvil's public default keys (`src/lib/server/devkeys.ts`). The routes refuse to run unless the chain is local anvil (chainId 31337) or an anvil fork. No key ever reaches the browser.
- **Degrade model** writes `{"degraded": true}` to `.runtime/keeper-flags.json`. The keeper (`services/src/keeper.ts`) re-reads that file every block and inverts its scores. The settler's Brier score then rises, and `hook.isDemoted` clamps k to kDefault. Nobody touches the contract.
- **Revoke quoter**: locally this calls `MockRoleOracle.setQuoter(quoter,false)`. On a fork with our ENS deployment it calls `revokeRoles(labelId("quoter"), ROLE_QUOTER, quoter)` on our ENSv2 UserRegistry. Either way the next attestation reverts, the mid goes stale and the pool charges the conservative fee.
- **Grant backup quoter** grants the role to anvil #6 and sets `useBackupQuoter: true`, so the keeper switches keys and attestations resume. **Restore** reverses both.

## API
`GET /api/state`, `GET /api/history?blocks=&regime=&points=`, `GET /api/models`, `GET /api/receipt/<tx>`,
`POST /api/dev/swap {direction:"arb"|"reverse", size, target?}`, `POST /api/dev/degrade {degraded}`,
`POST /api/dev/quoter {action:"revoke"|"grant-backup"|"restore"}`.

## Notes and limits
- "LP" means the whole pool's full-range liquidity (DeployLocal adds one identical full-range position to each pool). HODL means holding the same tokens from the baseline block on. Both are valued at the attested CEX mid, the same mid the hook sees.
- With `DEMO_PRICE_SOURCE=live` and 2 s blocks the CEX mid moves slowly, so gaps larger than the fee (and arbs) are occasional. Use **Execute swap** to open a gap and watch the arb bot close it at the regime fee. The replay default does not need that.
- The "calibration score" is what the settler posts to `hook.setCalibration` (raw Brier by default; see `docs/DESIGN.md` §12). ENS records carry the raw Brier, the skill vs the base rate, and the base rate as well.
- `deployBlock` in the deployments JSON is patched by the demo scripts to the first block with a deploy tx, taken from the forge broadcast receipts. Forge serializes the simulation's `block.number`, which is 0 on a fresh anvil. History reads start there.
