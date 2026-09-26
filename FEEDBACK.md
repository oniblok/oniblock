# Uniswap developer feedback (Oniblock, ETHGlobal Tokyo 2026)

We built a v4 dynamic-fee hook. It combines a directional oracle-gap fee, a per-block anchor, the OZ `LiquidityPenaltyHook` for JIT, and per-swap receipts. Around it we built TypeScript services: a keeper, a settler, bots and a replay benchmark, all running against local Anvil and an Anvil fork of Sepolia with the real v4 PoolManager. Everything below comes from actually hitting these issues during the build. Our review and fix notes are in `docs/review/`.

## What worked well

- **Dynamic fee override is the right primitive.** For a fee that depends on per-block state, returning `fee | OVERRIDE_FEE_FLAG` from `beforeSwap` on a `0x800000` pool is exactly what we needed.
  - No storage writes to the pool are required.
  - The fee applies to that swap only.
  - Pairing it with a `quoteFee` view gave us "quote == executed" as a testable invariant.
- **Flash accounting made the JIT penalty clean.** The penalty logic in `afterRemoveLiquidity` settles withheld fees, donates, and takes ERC-6909 claims, all inside one unlock with return deltas.
  - When OZ's version would revert (the last in-range LP exits inside the window), we could instead `take` the penalty as 6909 claims and donate it on the next swap.
  - An invariant (`hook 6909 balance == parked + withheld`) held exactly across 128k fuzzed calls.
- **OpenZeppelin uniswap-hooks saved a day.** We inherited `LiquidityPenaltyHook` (and through it `BaseHook`) and changed one function, instead of writing JIT accounting from scratch. The base-hook `_beforeSwap` / `_afterSwap` override pattern is pleasant to use.
- **Transient storage is a natural fit for `beforeSwap` → `afterSwap`.** We pass the exact fee-law result (fee, arbDir, gap) through one `tstore` / `tload` slot, so the Receipt event reports what was actually charged instead of recomputing it after the price moved. This also made swaps about 1k gas cheaper.
- **The hook flags-in-address design** makes permissions auditable at a glance, and pool allowlisting in `beforeInitialize` is straightforward.
- **Gas overhead is reasonable.** A full oracle-gap law with a per-block anchor costs about 77.7k gas for the first swap in a block and 53.2k for later ones, against 59.9k for a hookless swap.

## Friction points

1. **`HookMiner` runs out of memory with large initcode.**
   - `v4-periphery/test/shared/HookMiner.sol` re-hashes the full creation code and allocates memory on every iteration.
   - With our about 23.5 kB initcode and a flag set that needed tens of thousands of iterations, `forge script` hit `MemoryOOG`.
   - We wrote an allocation-free miner that hashes the initcode once and computes the CREATE2 address in scratch memory (`contracts/script/DeployBase.s.sol:_mineHookSalt`).
   - Suggestion: take `bytes32 initCodeHash` in HookMiner (or add an overload), and avoid per-iteration allocation.

2. **Importing `PoolManager.sol` silently changes how your hook is compiled.**
   - v4-core's PoolManager only compiles with `via_ir` and 44,444,444 optimizer runs. We used Foundry `compilation_restrictions` to satisfy that.
   - The catch: any script or test that imports `PoolManager.sol` (directly, or through v4-core's `Deployers` test utility) pulls the hook into that 44M-run profile. Our hook went from about 20.5 kB to 26.7 kB, **over EIP-170**. Deployments then reverted in only some scripts, and `forge build --sizes` failed on an artifact we never deploy.
   - Workaround: never import PoolManager next to the hook. We deploy it from its artifact JSON instead (`V4CoreArtifacts.sol` + `vm.getCode` + the CREATE2 factory).
   - Suggestions:
     - A test `Deployers` variant that deploys PoolManager from the artifact.
     - A clear docs warning about this.
     - Ideally, published PoolManager bytecode or a deploy helper for local chains.

3. **`vm.deployCode` is not broadcast by `forge script`** (forge 1.3.x). We tried deploying PoolManager from the artifact with `deployCode` in a broadcast script, and nothing was sent. We had to push the artifact initcode through the CREATE2 factory manually. This is a Foundry issue, but every v4 developer who avoids the import in item 2 will hit it, so it deserves a line in the v4 local-deployment guide.

4. **The routing allowlist shapes the oracle design, and that is under-documented.**
   - The Uniswap router sends no `hookData`, and hooks that need custom calldata will not be routed. So the hook cannot receive a signed price with the swap.
   - We push the oracle mid in a keeper transaction once per block and read it from storage. That creates a freshness gap: an arb can land before the keeper in a block, and we fall back to a conservative fee.
   - Knowing the allowlist criteria up front changes the whole architecture: no hookData, no proxy, verified source, dynamic fees reviewed manually, and "never revert in the swap path" (reverts break V4Quoter and aggregator quotes).
   - Suggestion: a single "designing a routable hook" page with these criteria and the recommended oracle patterns (push-and-read versus pull).

5. **There is no hook routing on testnets through the Trading API, and no testnet UniswapX.**
   - The Trading API supports Sepolia, but only routes allowlisted hooks, and allowlisting is a mainnet manual review. A hackathon hook cannot demo "real router flow" on testnet, so we used a test router (`PoolSwapTest` and our `SplitSwapRouter`).
   - UniswapX has no testnet, so we could not show how filler flow interacts with a dynamic-fee hook.
   - Suggestion: a testnet allowlist fast-path (for example, verified plus no proxy means auto-allowlisted on Sepolia), or a documented way to point the Trading API at a specific hook pool on testnet.

6. **Reading pool state off-chain is awkward.**
   - Our keeper reads `slot0` and liquidity every block. We used `extsload` with StateLibrary's slot layout (`services/src/chain.ts`), because `StateView` is a separate periphery deployment whose address you must find per chain. We verified the Sepolia StateView by calling `poolManager()` on it.
   - Suggestions:
     - List StateView and the other periphery addresses in one canonical, machine-readable per-chain JSON.
     - Document the StateLibrary slot layout as a stable interface for off-chain readers.
     - Provide a viem or TypeScript helper for `getSlot0` / `getLiquidity` via `extsload`.

7. **Dynamic-fee semantics are spread across several places.** Things we learned from source rather than docs:
   - A dynamic pool starts at fee 0, so you must always return the override flag.
   - An override ≥ 100% breaks exact-out swaps.
   - The Receipt-level `fee` is the LP fee only and excludes the protocol fee.
   - `sender` in hook callbacks is the router, not the user.

   A short "dynamic fee hook checklist" would save every team the same hour.

8. **Precision and rounding guidance for price-gap math.** Computing `price = sqrtP² / 2^96` and a gap in pips is simple, but edge cases (tiny prices truncating to 0, `mulDiv` bounds, native ETH as `address(0)` = currency0, decimals and token order) all needed custom handling. A reference library for comparing the pool price with an oracle price would help. It is the first thing every oracle-aware hook writes.

9. **Docs staleness in the CCA / Liquidity Launcher area (from our research phase).** We considered a CCA-based design first.
   - The local-deployment guide and the `uniswap-cca` deployer skill in uniswap-ai still reference v1 factory addresses and `initializeDistribution`, while v2.1 uses `create()` / `getAddress()`. v1 is deprecated.
   - LiquidityLauncher, LBPStrategy and CCALens exist on Sepolia and Base Sepolia but not on Unichain Sepolia, which the docs do not make obvious.

## Small suggestions

- Publish the `OVERRIDE_FEE_FLAG` / `DYNAMIC_FEE_FLAG` constants and the hook-permission bit table in the docs next to a worked example, including the return-delta flags that need `afterAddLiquidityReturnDelta` / `afterRemoveLiquidityReturnDelta`.
- Add a note in the OZ `LiquidityPenaltyHook` docs (or v4 docs) that the last-LP-exit revert (`NoLiquidityToReceiveDonation`) blocks withdrawals until the window passes, and show the park-and-donate alternative.
- Consider an official "oracle-aware fee hook" example that is routable: no hookData, push oracle, never reverts, quote == execution. Many teams (Detox-Hook, NeuralHook, ours) are converging on this shape.

Thank you. v4 made a mechanism that used to need a fork of the AMM into a roughly 850-line hook on a standard, permissionless pool.
