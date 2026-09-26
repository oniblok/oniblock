# Oniblock — Build Spec (source of truth for all build agents)

Design rationale: `docs/DESIGN.md` (ReceiptHook v3). This file pins **interfaces, layout, commands and acceptance criteria** so parallel agents produce parts that fit.

Project root: `/Users/akshat/Desktop/et/oniblock`
Env: `/Users/akshat/Desktop/et/oniblock/.env` (never print secret values; never commit).

## Hard rules (all agents)
1. **NO git.** Do not `git init`, `git commit`, `git push`. `forge install` MUST use `--no-git` (otherwise it auto-commits). If a tool insists on git, find another way.
2. **Do not spend Sepolia ETH / broadcast to Sepolia** unless the task explicitly says so. Local Anvil and `anvil --fork-url` are fine.
3. **Never print secrets** from `.env` (DEPLOYER_PK, AI_GATEWAY_API_KEY, ETHERSCAN_API_KEY).
4. No mocks of on-chain data in the final demo/benchmark: price data comes from Binance public API (historical klines / live mid). Mocks are fine in unit tests.
5. Write clean, commented code matching the design; keep scope tight; tests must pass before you report done.

## Layout
```
oniblock/
  contracts/         Foundry (solc 0.8.26, via_ir as needed, evm cancun)
    src/OniblockHook.sol
    src/interfaces/IRoleOracle.sol
    src/roles/EnsV2RoleOracle.sol
    src/mocks/MockRoleOracle.sol, MockERC20.sol (tests/local only)
    script/DeployLocal.s.sol      (fresh anvil: PoolManager + tokens + hook + pools + liquidity; writes deployments/31337.json)
    script/DeploySepolia.s.sol    (uses real v4 PoolManager; writes deployments/11155111.json)
    script/EnsSetup.s.sol         (ENSv2: register oniblock.eth, subregistry, subnames, roles, resolver records)
    test/                          unit + fuzz + fork tests
  deployments/       <chainId>.json (addresses + poolIds + ENS resources) — written by scripts, read by services/app
  abis/              exported ABIs (OniblockHook.json, IRoleOracle.json, ERC20.json) — produced by `contracts/export-abis.sh`
  services/          TypeScript (pnpm, viem, tsx, vitest)
  benchmark/         TypeScript replay harness + results/
  app/               Next.js (App Router) + viem + wagmi-free reads (viem publicClient) + tailwind
  docs/
```

## Chain & addresses (Sepolia 11155111) — from .env
V4_POOL_MANAGER, CHAINLINK_ETH_USD, ENS_* (ETHRegistry, ETHRegistrar, UniversalResolverV2, PermissionedResolverImpl, VerifiableFactory, UserRegistryImpl, MockUSDC mintable). ENS_NAME=oniblock.eth (backup oni-block.eth). SEPOLIA_RPC_HTTPS (public node; may rate-limit — retry/backoff).
Local: anvil chainId 31337 (fresh) or anvil fork of Sepolia (chainId 11155111 unless overridden).

## Token pair
Two ERC20s we deploy: `mWETH` (18 dec) and `mUSDC` (6 dec). Sort by address for currency0/currency1. Price convention everywhere:
- **priceX96 = (raw token1 per raw token0) × 2^96**, i.e. same unit as `sqrtPriceX96² / 2^96`.
- Keeper converts CEX mid (USDC per ETH) to priceX96 accounting for decimals and token order.

## Contract interface (OniblockHook) — MUST match
```solidity
struct PoolConfig {
    uint24 baseFee;          // pips (1e6 = 100%), e.g. 3000 = 0.30%
    uint24 feeMax;           // pips, e.g. 10000 = 1%  (hard cap in contract: <= 100000)
    uint24 conservativeFee;  // pips, used when oracle mid is stale
    uint32 kMinBps;          // 10000 = 1.0
    uint32 kMaxBps;          // must be < 10000 (k>=1 blocks re-alignment)
    uint32 kDefaultBps;      // used when attestation stale or model demoted (~5000)
    uint32 maxKStepBps;      // max |Δk| per accepted attestation
    uint16 staleBlocks;      // attestation older than this => stale
    uint32 sanityBandBps;    // max |oracleMid - chainlink| / chainlink; 0 = disabled
    address chainlinkFeed;   // address(0) = disabled
    bool   chainlinkInverted;// true if feed price must be inverted to match priceX96 convention
    uint32 brierDemoteBps;   // if model brier > this => k forced to kDefault (e.g. 2500 = 0.25)
    uint32 minSamples;       // (fixes-1) calibration n needed before a model can move k off kDefault (default 10)
    uint32 chainlinkMaxAge;  // (fixes-1) seconds; required if chainlinkFeed != 0 (default 7200)
    uint24 arbThresholdPips; // (v3) gap below which the arb-direction fee is exactly baseFee; <= feeMax (default base+300)
}
// (fixes-1) setModelAllowed(PoolId, bytes32 modelNode, bool) — owner; attestations for other nodes revert.
// (fixes-1) constructor(..., uint48 blockNumberOffset, uint256 configDelay); updatePoolConfig/setAttestor/setRoleOracle
//           are timelocked (first call queues, same call after configDelay executes). See docs/review/CONTRACT_FIXES_1.md.

struct Attestation {
    uint64  blockNumber;     // must equal block.number at post time (or block.number-1 tolerated)
    uint256 oracleMidX96;    // CEX mid in priceX96 convention
    uint32  pToxicBps;       // 0..10000
    uint32  confidenceBps;   // 0..10000
    bytes32 modelNode;       // ENS namehash of the model name (e.g. jev-v1.models.oniblock.eth)
    bytes   signature;       // EIP-712 sig by `attestor` (TEE stand-in) over all fields above + poolId
}

// admin (Ownable2Step): registerPool(PoolKey, PoolConfig) BEFORE initialize (allowlist); setAttestor(address); setRoleOracle(IRoleOracle)
function setAttestation(PoolKey calldata key, Attestation calldata a) external;   // requires roleOracle.isQuoter(msg.sender)
function setCalibration(bytes32 modelNode, uint32 brierBps, uint32 hitRateBps, uint32 n) external; // requires roleOracle.isSettler(msg.sender)
function kFromScore(PoolId id, uint32 pToxicBps, uint32 confidenceBps, bytes32 modelNode) public view returns (uint32 kBps); // public, clamped, demotion-aware (not step-limited)
function quoteFee(PoolKey calldata key, bool zeroForOne) external view returns (uint24 feePips, bool arbDir, uint32 gapPips, bool stale);
function poolState(PoolId id) external view returns (...);  // current k, oracleMid, lastAttestBlock, modelNode, anchor
event AttestationPosted(PoolId indexed id, uint64 indexed blockNumber, uint256 oracleMidX96, uint32 pToxicBps, uint32 confidenceBps, uint32 kBps, bytes32 indexed modelNode, address quoter);
event Receipt(PoolId indexed id, uint64 indexed blockNumber, address indexed sender, bool zeroForOne, bool arbDir, uint32 gapPips, uint32 kBps, uint24 feePips, int128 amount0, int128 amount1, bytes32 modelNode, bool stale);
event CalibrationUpdated(bytes32 indexed modelNode, uint32 brierBps, uint32 hitRateBps, uint32 n);
```
Fee law (beforeSwap, dynamic-fee pool, return `fee | OVERRIDE_FEE_FLAG`, never revert):
```
if oracle mid stale (now - lastAttestBlock > staleBlocks) -> fee = conservativeFee, arbDir=false, stale=true
poolX96  = FullMath.mulDiv(sqrtP, sqrtP, 1<<96)
gapPips  = mulDiv(|poolX96 - oracleX96|, 1e6, oracleX96) (clamp to 1e6)
arbDir   = (poolX96 > oracleX96) == zeroForOne     // swap moves pool toward oracle
Per-block anchor: on the FIRST swap of block.number for this pool, compute (gapPips, arbDirection, arbFee = min(base + gap*k/1e4, feeMax)) and store.
  Later swaps in same block: if same direction as anchored arb direction -> anchored arbFee; else baseFee.
  (fixes-1, supersedes the two lines above) per-direction HIGH-WATER gap per block: before every swap/quote, the live
  toward-oracle gap vs the stored mid raises gap[dir] (never lowers); fee(dir) = gap[dir]>0 ? min(base+gap*k/1e4, feeMax) : base.
  A later same-block attestation with k >= anchored k takes over the anchor's k/model. Receipt.modelNode = anchor model.
fee = arbDir ? min(base + gapPips*kBps/10000, feeMax) : base
(v3, supersedes the line above) fee = arbDir ? min(base + max(0, gapPips - arbThresholdPips)*kBps/10000, feeMax) : base
  arbThresholdPips = PoolConfig field (uint24, <= feeMax; default baseFee + 300; 0 = the v2 law). See DESIGN.md §13.
```
k: stored per pool, updated only via setAttestation: `kTarget = kFromScore(...)`, then step-limited by maxKStepBps; if model brier > brierDemoteBps -> kDefault; if attestation stale at swap time -> kDefault.
kFromScore (public, simple, documented): `k = kMin + (kMax-kMin) * pToxic * confidence / 1e8`, then demotion.
JIT: merge OpenZeppelin uniswap-hooks `LiquidityPenaltyHook` pattern (afterAddLiquidity/afterRemoveLiquidity + return deltas, linear decay over blockNumberOffset, donate to in-range LPs). Handle last-LP exit case (no donation target) without bricking withdrawals — document behaviour.
Receipt emitted in afterSwap (needs afterSwap permission) with executed amounts.
Permissions: beforeInitialize (allowlist), afterInitialize, afterAddLiquidity, afterRemoveLiquidity, beforeSwap, afterSwap, afterAddLiquidityReturnDelta, afterRemoveLiquidityReturnDelta. Mine address with HookMiner.

## IRoleOracle
```solidity
interface IRoleOracle { function isQuoter(address) external view returns (bool); function isSettler(address) external view returns (bool); }
```
`EnsV2RoleOracle`: queries ENSv2 EAC `hasRoles(resource, roleBitmap, account)` on our registry for `quoter.oniblock.eth` / `settler.oniblock.eth` (exact mechanism decided by the ENS agent from contracts-v2 source + Sepolia fork tests; document it). `MockRoleOracle` for unit tests.

## Services (TypeScript) — key modules
- `services/src/config.ts` loads .env + deployments/<chainId>.json + abis/.
- `services/src/cex.ts` Binance public REST: live mid (bookTicker ETHUSDT) and historical klines (1s/1m); retry/backoff; also support `api.binance.us`/`data-api.binance.vision` fallback.
- `services/src/model/` typed output `{ pToxicBps, confidenceBps, cls: 'informed'|'dump'|'unknown', latencyMs, model: 'jev'|'heuristic' }`.
  - `jev.ts`: Jev via Vercel AI Gateway (`AI_GATEWAY_API_KEY`, model id `typesafe-ai/jev`, base URL https://ai-gateway.vercel.sh/v1). Discover the correct request format empirically (it is a "decision model": state + typed questions → probabilities). Must parse robustly, timeout ~2s, fall back to heuristic.
  - `heuristic.ts`: deterministic baseline from features.
- `services/src/features.ts` from last N swaps (Receipt events or pool Swap events), CEX mid, pool price: gap, imbalance, size/depth, realized vol.
- `services/src/keeper.ts` per block: features → model → EIP-712 sign with attestor key → `setAttestation` from quoter key. Handles nonce, retries, never crashes.
- `services/src/settler.ts` reads Receipt + AttestationPosted, markout at +1 block vs CEX mid → per-model Brier (p_toxic vs realized "informed" label: arb-direction swap whose markout > fee) and hit rate → `setCalibration` + (if ENS configured) write calibration text records.
- `services/src/bots/arb.ts` rational arbitrageur: trades to the no-trade band given current fee; optional `--split N` sub-swaps in one tx via a router helper contract. `bots/retail.ts` random noise flow.
- `services/src/e2e/run-local.ts` starts anvil, deploys (forge script), runs keeper+bots+settler for N blocks, asserts invariants, prints summary.
Local keys: use anvil default accounts for deployer/quoter/settler/attestor/bots on local chains.

## Benchmark
`benchmark/` replays a held-out real ETHUSDT price path (Binance klines, e.g. 1s over 2–4h, cached to `benchmark/data/`) on a fresh anvil with **five pools** (one hook instance/config each, or a baseline hookless pool for "fixed fee"):
1 fixed fee (plain v4, 0.30%) · 2 Detox-style gap fee, constant k=1 cap / no model · 3 Oniblock law, constant k · 4 Oniblock law, model-tuned k (Jev with cache; heuristic fallback) · 5 Oniblock law + calibration gate with a deliberately degraded model mid-run.
Same arb bot (incl. split swaps) + same retail flow on all. Metrics: LP PnL vs HODL, LP loss to arb (LVR proxy), fees earned, retail cost, volume, with bootstrap CIs. Outputs `benchmark/results/results.json`, `results.md` (table), `chart.svg`. Report negative results honestly.

## App
Next.js app in `app/`: reads deployments + chain (local anvil default, Sepolia via env). Pages: `/` split screen (vanilla vs Oniblock pool LP value over time, live regime map colored per block, status strip: last block, p_toxic, k, fee, attestation age), `/receipt/[tx]` (decoded Receipt + AttestationPosted, ENS names resolved via UniversalResolverV2 when on Sepolia/fork, running calibration), `/models` (calibration per model), dev-only controls: "Execute swap", "Degrade model", "Revoke quoter". No hard-coded values in the UI.

## Acceptance (final)
- `cd contracts && forge build && forge test` all green (unit+fuzz; fork tests may be gated by env FORK=1).
- `pnpm -C services test` green; `pnpm -C services e2e` runs a local e2e (≥50 blocks) successfully.
- `pnpm -C benchmark bench` produces results files (note: bare `pnpm -C benchmark run` only lists scripts; `run:quick` is the smoke run).
- `pnpm -C app build` succeeds; app runs against local e2e chain.
- README.md at root: what/why, architecture diagram (mermaid), how to run everything, contract + line pointers, prior-art credits, honest limits. `FEEDBACK.md` for Uniswap.
