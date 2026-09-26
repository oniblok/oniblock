// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";

import {OniblockHook} from "../src/OniblockHook.sol";
import {IRoleOracle} from "../src/interfaces/IRoleOracle.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {SplitSwapRouter} from "../src/periphery/SplitSwapRouter.sol";
import {PriceMath} from "../src/libraries/PriceMath.sol";

/// @notice Shared deployment logic for DeployLocal / DeploySepolia.
abstract contract DeployBase is Script {
    uint160 internal constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.AFTER_ADD_LIQUIDITY_FLAG
            | Hooks.AFTER_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG | Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG
    );
    int24 internal constant TICK_SPACING = 60;
    int24 internal constant FULL_LOWER = -887220;
    int24 internal constant FULL_UPPER = 887220;
    uint24 internal constant VANILLA_FEE = 3000;

    struct Deployed {
        address deployer;
        IPoolManager manager;
        MockERC20 weth;
        MockERC20 usdc;
        bool wethIs0;
        Currency c0;
        Currency c1;
        IRoleOracle roles;
        string roleOracleType;
        OniblockHook hook;
        bytes32 hookSalt;
        SplitSwapRouter router;
        PoolModifyLiquidityTest liqRouter;
        PoolKey oniKey;
        PoolKey vanillaKey;
        OniblockHook.PoolConfig cfg;
        address attestor;
        address quoter;
        address settler;
        uint48 jitOffset; // OZ immutable blockNumberOffset: ABI/deploy compatibility only, v5 uses cfg.jitWindow*
        uint256 initUsdE8;
        int256 liquidity;
        address stateView;
        uint256 configDelay; // hook timelock (seconds) for updatePoolConfig / setAttestor / setRoleOracle
        bytes32[] modelNodes; // allowlisted for the Oniblock pool (default: jev-v1 + heuristic-v1 + kev-v1; + rule-v1 if KEEPER_GATE=1)
    }

    /// ENS namehash helpers for the default model names (jev-v1 / heuristic-v1 / kev-v1 / rule-v1 .models.oniblock.eth).
    function _subnode(bytes32 parent, string memory label) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(parent, keccak256(bytes(label))));
    }

    function _modelsNode() internal pure returns (bytes32) {
        return _subnode(_subnode(_subnode(bytes32(0), "eth"), "oniblock"), "models");
    }

    /// Model nodes to allowlist: env MODEL_NODES (comma-separated bytes32) or the keeper defaults: jev-v1, the
    /// heuristic-v1 fallback and kev-v1 (the open-weights Kev-0.8B fine-tune, ml/models/kev08b-v1); rule-v1 (the v3
    /// keeper's deterministic below-threshold rule) only when KEEPER_GATE=1 — the v4 keeper asks the model every
    /// block and never posts under rule-v1. Allowlisting grants no fee power by itself: a node with calibration
    /// n < minSamples runs at kDefault (0 = base fee) until the settler has graded enough of its receipts.
    function _defaultModelNodes() internal view returns (bytes32[] memory nodes) {
        bool gate = vm.envOr("KEEPER_GATE", uint256(0)) == 1;
        nodes = new bytes32[](gate ? 4 : 3);
        nodes[0] = _subnode(_modelsNode(), "jev-v1");
        nodes[1] = _subnode(_modelsNode(), "heuristic-v1");
        nodes[2] = _subnode(_modelsNode(), "kev-v1");
        if (gate) nodes[3] = _subnode(_modelsNode(), "rule-v1");
        nodes = vm.envOr("MODEL_NODES", ",", nodes);
    }

    /// Deploys v4-core's PoolManager from its separately compiled artifact (see script/V4CoreArtifacts.sol, R-11):
    /// importing PoolManager.sol here would compile OniblockHook under PoolManager's 44M-run profile.
    /// Sent as a call to the deterministic CREATE2 factory so it is broadcast (forge 1.3 does not broadcast
    /// vm.deployCode). Salt from env PM_SALT (default 0).
    function _deployPoolManager(address owner) internal returns (IPoolManager pm) {
        bytes memory initCode =
            abi.encodePacked(vm.getCode("out/PoolManager.sol/PoolManager.json"), abi.encode(owner));
        bytes32 salt = bytes32(vm.envOr("PM_SALT", uint256(0)));
        pm = IPoolManager(vm.computeCreate2Address(salt, keccak256(initCode), CREATE2_FACTORY));
        if (address(pm).code.length == 0) {
            (bool ok,) = CREATE2_FACTORY.call(abi.encodePacked(salt, initCode));
            require(ok && address(pm).code.length > 0, "PoolManager deploy failed");
        }
    }

    /// Pool config from env with sane defaults (see BUILD_SPEC PoolConfig).
    function _configFromEnv(address feed, bool inverted, uint32 bandDefault)
        internal
        view
        returns (OniblockHook.PoolConfig memory c)
    {
        c.baseFee = uint24(vm.envOr("BASE_FEE", uint256(3000)));
        c.feeMax = uint24(vm.envOr("FEE_MAX", uint256(10000)));
        c.conservativeFee = uint24(vm.envOr("CONSERVATIVE_FEE", uint256(5000)));
        // v4 "the AI decides the fee" defaults (docs/review/V4_AI_DECIDES.md): k = kMax * p * c, no floor, so a model
        // score of "no profitable arbitrage" (p near 0) gives k near 0 = the base fee; an untrusted (unseasoned or
        // demoted) model gets kDefault = 0, i.e. no power to raise the fee; one attestation can move k over the whole
        // [0, kMax] range (maxKStepBps = kMax), so the fee follows the model's per-block decision.
        c.kMinBps = uint32(vm.envOr("K_MIN_BPS", uint256(0)));
        c.kMaxBps = uint32(vm.envOr("K_MAX_BPS", uint256(8000)));
        c.kDefaultBps = uint32(vm.envOr("K_DEFAULT_BPS", uint256(0)));
        c.maxKStepBps = uint32(vm.envOr("MAX_K_STEP_BPS", uint256(8000)));
        c.staleBlocks = uint16(vm.envOr("STALE_BLOCKS", uint256(5)));
        c.sanityBandBps = feed == address(0) ? 0 : uint32(vm.envOr("SANITY_BAND_BPS", uint256(bandDefault)));
        c.chainlinkFeed = feed;
        c.chainlinkInverted = inverted;
        c.brierDemoteBps = uint32(vm.envOr("BRIER_DEMOTE_BPS", uint256(2500)));
        c.minSamples = uint32(vm.envOr("MIN_SAMPLES", uint256(10)));
        // Sepolia ETH/USD heartbeat ~1h => 2h max age. Ignored (but harmless) when the feed is disabled.
        c.chainlinkMaxAge = uint32(vm.envOr("CHAINLINK_MAX_AGE", uint256(2 hours)));
        // v4 default 0: no hard-coded gap threshold, the model decides (v3 used baseFee + 300; still settable).
        c.arbThresholdPips = uint24(vm.envOr("ARB_THRESHOLD_PIPS", uint256(0)));
        // v5 "the AI decides the JIT window" (docs/review/V5_JIT_HEAD_SPEC.md): window = min + (max - min) * pJit * c;
        // a demoted/unseasoned JIT head or a stale attestation gets jitWindowDefault (= the old 10-block wall).
        c.jitWindowMin = uint16(vm.envOr("JIT_WINDOW_MIN", uint256(10)));
        c.jitWindowMax = uint16(vm.envOr("JIT_WINDOW_MAX", uint256(100)));
        c.jitWindowDefault = uint16(vm.envOr("JIT_WINDOW_DEFAULT", uint256(10)));
    }

    function _deployTokens(Deployed memory d) internal {
        d.weth = new MockERC20("Mock WETH", "mWETH", 18);
        d.usdc = new MockERC20("Mock USDC", "mUSDC", 6);
        d.wethIs0 = address(d.weth) < address(d.usdc);
        (d.c0, d.c1) = d.wethIs0
            ? (Currency.wrap(address(d.weth)), Currency.wrap(address(d.usdc)))
            : (Currency.wrap(address(d.usdc)), Currency.wrap(address(d.weth)));
    }

    /// Mines a CREATE2 salt (forge scripts deploy `new{salt}` through the deterministic CREATE2 factory).
    function _deployHook(Deployed memory d) internal {
        bytes memory args = abi.encode(d.manager, d.deployer, d.attestor, d.roles, d.jitOffset, d.configDelay);
        (address expected, bytes32 salt) = _mineHookSalt(keccak256(abi.encodePacked(type(OniblockHook).creationCode, args)));
        d.hook = new OniblockHook{salt: salt}(d.manager, d.deployer, d.attestor, d.roles, d.jitOffset, d.configDelay);
        require(address(d.hook) == expected, "hook address mismatch");
        d.hookSalt = salt;
    }

    /// @dev Allocation-free CREATE2 salt miner. v4-periphery's HookMiner re-hashes the full initcode and allocates
    /// memory on every iteration, which runs out of memory (MemoryOOG) when the salt needs tens of thousands of
    /// iterations; here the initcode hash is computed once and the address hash uses scratch memory.
    function _mineHookSalt(bytes32 initHash) internal view returns (address hookAddress, bytes32 salt) {
        uint160 mask = Hooks.ALL_HOOK_MASK;
        address factory = CREATE2_FACTORY;
        for (uint256 s; s < 2_000_000; s++) {
            address a;
            assembly ("memory-safe") {
                let p := mload(0x40)
                mstore(p, or(shl(160, 0xff), factory))
                mstore(add(p, 32), s)
                mstore(add(p, 64), initHash)
                a := and(keccak256(add(p, 11), 85), 0xffffffffffffffffffffffffffffffffffffffff)
            }
            if (uint160(a) & mask == HOOK_FLAGS & mask && a.code.length == 0) return (a, bytes32(s));
        }
        revert("hook salt not found");
    }

    function _pools(Deployed memory d) internal {
        d.oniKey = PoolKey(d.c0, d.c1, LPFeeLibrary.DYNAMIC_FEE_FLAG, TICK_SPACING, IHooks(address(d.hook)));
        d.vanillaKey = PoolKey(d.c0, d.c1, VANILLA_FEE, TICK_SPACING, IHooks(address(0)));
        uint160 sqrtP = PriceMath.priceX96ToSqrtPriceX96(PriceMath.usdToPriceX96(d.initUsdE8, d.wethIs0, 18, 6));
        d.hook.registerPool(d.oniKey, d.cfg);
        for (uint256 i; i < d.modelNodes.length; i++) {
            d.hook.setModelAllowed(d.oniKey.toId(), d.modelNodes[i], true);
        }
        d.manager.initialize(d.oniKey, sqrtP);
        d.manager.initialize(d.vanillaKey, sqrtP);
    }

    function _liquidity(Deployed memory d) internal {
        d.liqRouter = new PoolModifyLiquidityTest(d.manager);
        d.router = new SplitSwapRouter(d.manager);
        d.weth.mint(d.deployer, 1e27);
        d.usdc.mint(d.deployer, 1e18);
        d.weth.approve(address(d.liqRouter), type(uint256).max);
        d.usdc.approve(address(d.liqRouter), type(uint256).max);
        d.weth.approve(address(d.router), type(uint256).max);
        d.usdc.approve(address(d.router), type(uint256).max);
        ModifyLiquidityParams memory p = ModifyLiquidityParams(FULL_LOWER, FULL_UPPER, d.liquidity, 0);
        d.liqRouter.modifyLiquidity(d.oniKey, p, "");
        d.liqRouter.modifyLiquidity(d.vanillaKey, p, "");
    }

    // ------------------------------------------------------------------ JSON

    function _keyJson(string memory tag, PoolKey memory k) internal returns (string memory) {
        vm.serializeAddress(tag, "currency0", Currency.unwrap(k.currency0));
        vm.serializeAddress(tag, "currency1", Currency.unwrap(k.currency1));
        vm.serializeUint(tag, "fee", k.fee);
        vm.serializeInt(tag, "tickSpacing", k.tickSpacing);
        return vm.serializeAddress(tag, "hooks", address(k.hooks));
    }

    function _cfgJson(OniblockHook.PoolConfig memory c) internal returns (string memory) {
        string memory t = "cfg";
        vm.serializeUint(t, "baseFee", c.baseFee);
        vm.serializeUint(t, "feeMax", c.feeMax);
        vm.serializeUint(t, "conservativeFee", c.conservativeFee);
        vm.serializeUint(t, "kMinBps", c.kMinBps);
        vm.serializeUint(t, "kMaxBps", c.kMaxBps);
        vm.serializeUint(t, "kDefaultBps", c.kDefaultBps);
        vm.serializeUint(t, "maxKStepBps", c.maxKStepBps);
        vm.serializeUint(t, "staleBlocks", c.staleBlocks);
        vm.serializeUint(t, "sanityBandBps", c.sanityBandBps);
        vm.serializeUint(t, "minSamples", c.minSamples);
        vm.serializeUint(t, "chainlinkMaxAge", c.chainlinkMaxAge);
        vm.serializeUint(t, "arbThresholdPips", c.arbThresholdPips);
        vm.serializeUint(t, "jitWindowMin", c.jitWindowMin);
        vm.serializeUint(t, "jitWindowMax", c.jitWindowMax);
        vm.serializeUint(t, "jitWindowDefault", c.jitWindowDefault);
        vm.serializeAddress(t, "chainlinkFeed", c.chainlinkFeed);
        vm.serializeBool(t, "chainlinkInverted", c.chainlinkInverted);
        return vm.serializeUint(t, "brierDemoteBps", c.brierDemoteBps);
    }

    function _json(Deployed memory d) internal returns (string memory) {
        // tokens
        vm.serializeAddress("weth", "address", address(d.weth));
        vm.serializeString("weth", "symbol", "mWETH");
        string memory wethJ = vm.serializeUint("weth", "decimals", 18);
        vm.serializeAddress("usdc", "address", address(d.usdc));
        vm.serializeString("usdc", "symbol", "mUSDC");
        string memory usdcJ = vm.serializeUint("usdc", "decimals", 6);
        vm.serializeString("tokens", "mWETH", wethJ);
        string memory tokensJ = vm.serializeString("tokens", "mUSDC", usdcJ);

        // pools
        string memory oniKeyJ = _keyJson("oniKey", d.oniKey);
        string memory cfgJ = _cfgJson(d.cfg);
        vm.serializeBytes32("oni", "poolId", PoolId.unwrap(d.oniKey.toId()));
        vm.serializeString("oni", "key", oniKeyJ);
        string memory oniJ = vm.serializeString("oni", "config", cfgJ);
        string memory vanKeyJ = _keyJson("vanKey", d.vanillaKey);
        vm.serializeBytes32("van", "poolId", PoolId.unwrap(d.vanillaKey.toId()));
        string memory vanJ = vm.serializeString("van", "key", vanKeyJ);
        vm.serializeString("pools", "oniblock", oniJ);
        string memory poolsJ = vm.serializeString("pools", "vanilla", vanJ);

        // eip712
        vm.serializeString("eip712", "name", "Oniblock");
        vm.serializeString("eip712", "version", "1");
        vm.serializeUint("eip712", "chainId", block.chainid);
        vm.serializeAddress("eip712", "verifyingContract", address(d.hook));
        string memory eipJ = vm.serializeString("eip712", "attestationType", d.hook.ATTESTATION_TYPE());

        string memory r = "root";
        vm.serializeUint(r, "chainId", block.chainid);
        vm.serializeUint(r, "deployBlock", block.number);
        vm.serializeAddress(r, "deployer", d.deployer);
        vm.serializeAddress(r, "poolManager", address(d.manager));
        vm.serializeAddress(r, "stateView", d.stateView);
        vm.serializeAddress(r, "hook", address(d.hook));
        vm.serializeBytes32(r, "hookSalt", d.hookSalt);
        vm.serializeAddress(r, "roleOracle", address(d.roles));
        vm.serializeString(r, "roleOracleType", d.roleOracleType);
        vm.serializeAddress(r, "splitSwapRouter", address(d.router));
        vm.serializeAddress(r, "liquidityRouter", address(d.liqRouter));
        vm.serializeAddress(r, "attestor", d.attestor);
        vm.serializeAddress(r, "quoter", d.quoter);
        vm.serializeAddress(r, "settler", d.settler);
        vm.serializeAddress(r, "currency0", Currency.unwrap(d.c0));
        vm.serializeAddress(r, "currency1", Currency.unwrap(d.c1));
        vm.serializeBool(r, "wethIsToken0", d.wethIs0);
        vm.serializeUint(r, "blockNumberOffset", d.jitOffset);
        vm.serializeUint(r, "configDelay", d.configDelay);
        if (d.modelNodes.length > 0) vm.serializeBytes32(r, "modelNode", d.modelNodes[0]);
        vm.serializeBytes32(r, "allowedModelNodes", d.modelNodes);
        vm.serializeUint(r, "initPriceUsdE8", d.initUsdE8);
        vm.serializeInt(r, "initialLiquidity", d.liquidity);
        vm.serializeString(r, "tokens", tokensJ);
        vm.serializeString(r, "eip712", eipJ);
        return vm.serializeString(r, "pools", poolsJ);
    }

    function _log(Deployed memory d) internal pure {
        console2.log("PoolManager      ", address(d.manager));
        console2.log("OniblockHook     ", address(d.hook));
        console2.log("RoleOracle       ", address(d.roles));
        console2.log("SplitSwapRouter  ", address(d.router));
        console2.log("LiquidityRouter  ", address(d.liqRouter));
        console2.log("mWETH            ", address(d.weth));
        console2.log("mUSDC            ", address(d.usdc));
        console2.log("oniblock poolId");
        console2.logBytes32(PoolId.unwrap(d.oniKey.toId()));
        console2.log("vanilla poolId");
        console2.logBytes32(PoolId.unwrap(d.vanillaKey.toId()));
    }
}
