// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";

import {DeployBase} from "../DeployBase.s.sol";
import {OniblockHook} from "../../src/OniblockHook.sol";
import {MockRoleOracle} from "../../src/mocks/MockRoleOracle.sol";
import {IRoleOracle} from "../../src/interfaces/IRoleOracle.sol";
import {SplitSwapRouter} from "../../src/periphery/SplitSwapRouter.sol";
import {PriceMath} from "../../src/libraries/PriceMath.sol";

/// @notice Benchmark v4 deployment (fresh anvil only): v2/v3's market layout (one vanilla pool + one competitor per
/// market, identical full-range liquidity, one OniblockHook) with the v4 "the AI decides the fee" arms.
///
///   market   vanilla (ts)    competitor (ts)  competitor config
///   control  v_control_a 60  v_control_b 61   hookless BASE_FEE (vanilla vs vanilla)
///   v2k      v_v2k 62        v2k 10           v2 law (arbThresholdPips = 0), k = CONST_K              (a, reference)
///   thrk     v_thrk 63       thrk 20          hard-coded threshold ARB_THRESHOLD_PIPS, k = CONST_K    (b, v3 reference)
///   ai       v_ai 64         ai 30            threshold 0, k in [0, AI_K_MAX], kDefault AI_K_DEFAULT (c, Jev)
///   aiheur   v_aiheur 65     aiheur 50        same config as ai                                       (d, heuristic)
///   aigated  v_aigated 66    aigated 40       same config as ai (Jev degraded in the 2nd half)        (e, gate)
///   aidz     v_aidz 67       aidz 70          same config as ai (keeper emulates a p*c dead-zone)     (f, exploratory)
///
/// Env: BASE_FEE (3000; applies to the vanilla pools AND the hooked pools' baseFee), ARB_THRESHOLD_PIPS
/// (BASE_FEE + 300, thrk only), CONSERVATIVE_FEE (BASE_FEE + 2000), FEE_MAX (10000), CONST_K (5000),
/// AI_K_MAX_BPS (8000), AI_K_STEP_BPS (8000), AI_K_DEFAULT_BPS (0), MIN_SAMPLES, STALE_BLOCKS, BRIER_DEMOTE_BPS,
/// MODEL_NODES (allowlisted on every hooked pool), INIT_PRICE_USD_E8, LIQUIDITY, BENCH_OUT.
contract DeployBenchV4 is DeployBase {
    uint256 internal constant ANVIL0_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant N = 14;

    struct BenchPool {
        string name;
        PoolKey key;
        bool hooked;
    }

    function _base() internal view returns (uint24) {
        return uint24(vm.envOr("BASE_FEE", uint256(3000)));
    }

    function _cfg(uint32 kMin, uint32 kMax, uint32 kDef, uint32 brier, uint24 thr, uint32 kStep)
        internal
        view
        returns (OniblockHook.PoolConfig memory c)
    {
        c = _configFromEnv(address(0), false, 0);
        c.baseFee = _base();
        c.feeMax = uint24(vm.envOr("FEE_MAX", uint256(10000)));
        c.conservativeFee = uint24(vm.envOr("CONSERVATIVE_FEE", uint256(c.baseFee) + 2000));
        c.kMinBps = kMin;
        c.kMaxBps = kMax;
        c.kDefaultBps = kDef;
        c.maxKStepBps = kStep;
        c.staleBlocks = uint16(vm.envOr("STALE_BLOCKS", uint256(15)));
        c.sanityBandBps = 0;
        c.chainlinkFeed = address(0);
        c.brierDemoteBps = brier;
        c.arbThresholdPips = thr;
    }

    function _vanilla(Deployed memory d, string memory name, int24 ts) internal view returns (BenchPool memory) {
        return BenchPool(name, PoolKey(d.c0, d.c1, _base(), ts, IHooks(address(0))), false);
    }

    function _hooked(Deployed memory d, string memory name, int24 ts) internal pure returns (BenchPool memory) {
        return BenchPool(name, PoolKey(d.c0, d.c1, LPFeeLibrary.DYNAMIC_FEE_FLAG, ts, IHooks(address(d.hook))), true);
    }

    function run() external {
        uint256 pk = vm.envOr("LOCAL_PK", ANVIL0_PK);
        Deployed memory d;
        d.deployer = vm.addr(pk);
        address actor = vm.envOr("ACTOR", address(0x70997970C51812dc3A010C7d01b50e0d17dc79C8));
        d.quoter = actor;
        d.settler = actor;
        d.attestor = vm.envOr("ATTESTOR", address(0x90F79bf6EB2c4f870365E785982E1f101E93b906));
        d.jitOffset = 10;
        d.initUsdE8 = vm.envOr("INIT_PRICE_USD_E8", uint256(2500e8));
        d.liquidity = int256(vm.envOr("LIQUIDITY", uint256(2e17)));
        d.roleOracleType = "mock";
        d.configDelay = 0;

        vm.startBroadcast(pk);
        d.manager = _deployPoolManager(d.deployer);
        _deployTokens(d);
        MockRoleOracle roles = new MockRoleOracle(d.deployer);
        roles.setQuoter(actor, true);
        roles.setSettler(actor, true);
        d.roles = IRoleOracle(address(roles));
        _deployHook(d);

        BenchPool[N] memory ps;
        OniblockHook.PoolConfig[N] memory cfgs;
        ps[0] = _vanilla(d, "v_control_a", 60);
        ps[1] = _vanilla(d, "v_control_b", 61);
        ps[2] = _vanilla(d, "v_v2k", 62);
        ps[3] = _hooked(d, "v2k", 10);
        ps[4] = _vanilla(d, "v_thrk", 63);
        ps[5] = _hooked(d, "thrk", 20);
        ps[6] = _vanilla(d, "v_ai", 64);
        ps[7] = _hooked(d, "ai", 30);
        ps[8] = _vanilla(d, "v_aiheur", 65);
        ps[9] = _hooked(d, "aiheur", 50);
        ps[10] = _vanilla(d, "v_aigated", 66);
        ps[11] = _hooked(d, "aigated", 40);
        ps[12] = _vanilla(d, "v_aidz", 67);
        ps[13] = _hooked(d, "aidz", 70);
        {
            uint32 brier = uint32(vm.envOr("BRIER_DEMOTE_BPS", uint256(2500)));
            uint32 constK = uint32(vm.envOr("CONST_K", uint256(5000)));
            uint24 thr = uint24(vm.envOr("ARB_THRESHOLD_PIPS", uint256(_base()) + 300));
            uint32 kMax = uint32(vm.envOr("AI_K_MAX_BPS", uint256(8000)));
            uint32 step = uint32(vm.envOr("AI_K_STEP_BPS", uint256(8000)));
            uint32 kDef = uint32(vm.envOr("AI_K_DEFAULT_BPS", uint256(0)));
            cfgs[3] = _cfg(constK, constK, constK, 0, 0, 1000);
            cfgs[5] = _cfg(constK, constK, constK, 0, thr, 1000);
            for (uint256 i = 7; i < N; i += 2) {
                cfgs[i] = _cfg(0, kMax, kDef, brier, 0, step);
            }
        }

        uint160 sqrtP = PriceMath.priceX96ToSqrtPriceX96(PriceMath.usdToPriceX96(d.initUsdE8, d.wethIs0, 18, 6));
        d.liqRouter = new PoolModifyLiquidityTest(d.manager);
        d.router = new SplitSwapRouter(d.manager);
        d.weth.mint(d.deployer, 1e30);
        d.usdc.mint(d.deployer, 1e24);
        d.weth.approve(address(d.liqRouter), type(uint256).max);
        d.usdc.approve(address(d.liqRouter), type(uint256).max);
        d.weth.mint(actor, 1e30);
        d.usdc.mint(actor, 1e24);

        bytes32[] memory nodes = vm.envOr("MODEL_NODES", ",", new bytes32[](0));
        for (uint256 i = 0; i < N; i++) {
            if (ps[i].hooked) d.hook.registerPool(ps[i].key, cfgs[i]);
            d.manager.initialize(ps[i].key, sqrtP);
            if (ps[i].hooked) {
                for (uint256 j = 0; j < nodes.length; j++) {
                    d.hook.setModelAllowed(ps[i].key.toId(), nodes[j], true);
                }
            }
            int24 ts = ps[i].key.tickSpacing;
            d.liqRouter.modifyLiquidity(
                ps[i].key, ModifyLiquidityParams(TickMath.minUsableTick(ts), TickMath.maxUsableTick(ts), d.liquidity, 0), ""
            );
        }
        vm.stopBroadcast();
        _writeJson(d, ps, cfgs, actor, sqrtP);
    }

    function _writeJson(
        Deployed memory d,
        BenchPool[N] memory ps,
        OniblockHook.PoolConfig[N] memory cfgs,
        address actor,
        uint160 sqrtP
    ) internal {
        string memory poolsJ;
        for (uint256 i = 0; i < N; i++) {
            string memory t = ps[i].name;
            vm.serializeBytes32(t, "poolId", PoolId.unwrap(ps[i].key.toId()));
            vm.serializeUint(t, "fee", ps[i].key.fee);
            vm.serializeInt(t, "tickSpacing", ps[i].key.tickSpacing);
            vm.serializeAddress(t, "hooks", address(ps[i].key.hooks));
            if (ps[i].hooked) {
                vm.serializeUint(t, "kMinBps", cfgs[i].kMinBps);
                vm.serializeUint(t, "kMaxBps", cfgs[i].kMaxBps);
                vm.serializeUint(t, "kDefaultBps", cfgs[i].kDefaultBps);
                vm.serializeUint(t, "maxKStepBps", cfgs[i].maxKStepBps);
                vm.serializeUint(t, "brierDemoteBps", cfgs[i].brierDemoteBps);
                vm.serializeUint(t, "baseFee", cfgs[i].baseFee);
                vm.serializeUint(t, "conservativeFee", cfgs[i].conservativeFee);
                vm.serializeUint(t, "minSamples", cfgs[i].minSamples);
                vm.serializeUint(t, "staleBlocks", cfgs[i].staleBlocks);
                vm.serializeUint(t, "feeMax", cfgs[i].feeMax);
                vm.serializeUint(t, "arbThresholdPips", cfgs[i].arbThresholdPips);
            }
            string memory pj = vm.serializeBool(t, "hooked", ps[i].hooked);
            poolsJ = vm.serializeString("pools", t, pj);
        }
        string memory r = "root";
        vm.serializeUint(r, "chainId", block.chainid);
        vm.serializeAddress(r, "poolManager", address(d.manager));
        vm.serializeAddress(r, "hook", address(d.hook));
        vm.serializeAddress(r, "splitSwapRouter", address(d.router));
        vm.serializeAddress(r, "actor", actor);
        vm.serializeAddress(r, "attestor", d.attestor);
        vm.serializeAddress(r, "currency0", Currency.unwrap(d.c0));
        vm.serializeAddress(r, "currency1", Currency.unwrap(d.c1));
        vm.serializeBool(r, "wethIsToken0", d.wethIs0);
        vm.serializeUint(r, "sqrtPriceX96", sqrtP);
        vm.serializeInt(r, "liquidity", d.liquidity);
        string memory out = vm.serializeString(r, "pools", poolsJ);
        vm.writeJson(out, vm.envOr("BENCH_OUT", string.concat(vm.projectRoot(), "/../deployments/bench-v4.json")));
    }
}
