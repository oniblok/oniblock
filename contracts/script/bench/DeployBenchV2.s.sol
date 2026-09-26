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

/// @notice Benchmark v2 deployment (fresh anvil only): six MARKETS, each = one hookless 0.30% pool + one competitor,
/// identical full-range liquidity L on all twelve pools, same tokens, same initial price. ONE OniblockHook instance;
/// hooked pools are distinguished by tickSpacing, hookless ones too (60..66, fee 3000).
///
///   market   vanilla (ts)   competitor (ts)  competitor config
///   control  v_control_a 60 v_control_b 61   hookless 0.30% (vanilla vs vanilla; = "fixed-fee competitor")
///   detox    v_detox 62     detox 10         kMin = kMax = kDefault = DETOX_K (7000)
///   const    v_const 63     const 20         kMin = kMax = kDefault = CONST_K (5000)
///   mjev     v_mjev 64      mjev 30          kMin 2000 / kMax 8000 / kDefault 5000, Brier gate (Jev-scored)
///   mheur    v_mheur 65     mheur 50         same as mjev (heuristic-scored, separate model node)
///   gated    v_gated 66     gated 40         same as mjev (Jev-scored, degraded in the 2nd half)
///
/// Env: INIT_PRICE_USD_E8, LIQUIDITY, BENCH_OUT, DETOX_K, CONST_K, STALE_BLOCKS, BRIER_DEMOTE_BPS,
/// MODEL_NODES (allowlisted on every hooked pool).
contract DeployBenchV2 is DeployBase {
    uint256 internal constant ANVIL0_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant N = 12;

    struct BenchPool {
        string name;
        PoolKey key;
        bool hooked;
    }

    function _cfg(uint32 kMin, uint32 kMax, uint32 kDef, uint32 brier) internal view returns (OniblockHook.PoolConfig memory c) {
        c = _configFromEnv(address(0), false, 0);
        c.baseFee = 3000;
        c.feeMax = uint24(vm.envOr("FEE_MAX", uint256(10000)));
        c.conservativeFee = 5000;
        c.kMinBps = kMin;
        c.kMaxBps = kMax;
        c.kDefaultBps = kDef;
        c.maxKStepBps = uint32(vm.envOr("MAX_K_STEP_BPS", uint256(1000)));
        c.staleBlocks = uint16(vm.envOr("STALE_BLOCKS", uint256(15)));
        c.sanityBandBps = 0;
        c.chainlinkFeed = address(0);
        c.brierDemoteBps = brier;
        // v3 threshold law: default baseFee + 300. The v1/v2 benchmark runners pass ARB_THRESHOLD_PIPS=0 so they
        // keep reproducing the law their frozen results were produced with (premium from the first pip).
        c.arbThresholdPips = uint24(vm.envOr("ARB_THRESHOLD_PIPS", uint256(c.baseFee) + 300));
    }

    function _vanilla(Deployed memory d, string memory name, int24 ts) internal pure returns (BenchPool memory) {
        return BenchPool(name, PoolKey(d.c0, d.c1, 3000, ts, IHooks(address(0))), false);
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

        uint32 brier = uint32(vm.envOr("BRIER_DEMOTE_BPS", uint256(2500)));
        BenchPool[N] memory ps;
        OniblockHook.PoolConfig[N] memory cfgs;
        ps[0] = _vanilla(d, "v_control_a", 60);
        ps[1] = _vanilla(d, "v_control_b", 61);
        ps[2] = _vanilla(d, "v_detox", 62);
        ps[3] = _hooked(d, "detox", 10);
        ps[4] = _vanilla(d, "v_const", 63);
        ps[5] = _hooked(d, "const", 20);
        ps[6] = _vanilla(d, "v_mjev", 64);
        ps[7] = _hooked(d, "mjev", 30);
        ps[8] = _vanilla(d, "v_mheur", 65);
        ps[9] = _hooked(d, "mheur", 50);
        ps[10] = _vanilla(d, "v_gated", 66);
        ps[11] = _hooked(d, "gated", 40);
        {
            uint32 detoxK = uint32(vm.envOr("DETOX_K", uint256(7000)));
            uint32 constK = uint32(vm.envOr("CONST_K", uint256(5000)));
            cfgs[3] = _cfg(detoxK, detoxK, detoxK, 0);
            cfgs[5] = _cfg(constK, constK, constK, 0);
            cfgs[7] = _cfg(2000, 8000, 5000, brier);
            cfgs[9] = _cfg(2000, 8000, 5000, brier);
            cfgs[11] = _cfg(2000, 8000, 5000, brier);
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
                vm.serializeUint(t, "brierDemoteBps", cfgs[i].brierDemoteBps);
                vm.serializeUint(t, "baseFee", cfgs[i].baseFee);
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
        vm.writeJson(out, vm.envOr("BENCH_OUT", string.concat(vm.projectRoot(), "/../deployments/bench-v2.json")));
    }
}
