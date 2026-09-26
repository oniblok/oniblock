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

/// @notice Benchmark deployment (fresh anvil only): ONE OniblockHook instance with FOUR registered dynamic-fee pools
/// (distinguished by tickSpacing, each with its own PoolConfig) + one hookless 0.30% pool, identical full-range
/// liquidity L on all five, same mWETH/mUSDC tokens, same initial price.
///
///   pool      tickSpacing  config
///   fixed     60           hookless, static fee 3000 (0.30%)
///   detox     10           kMin = kMax = kDefault = DETOX_K (7000)  -> gap fee with constant k (Detox-style)
///   const     20           kMin = kMax = kDefault = CONST_K (5000)  -> Oniblock law, constant k
///   model     30           kMin 2000 / kMax 8000 / kDefault 5000    -> model-tuned k
///   gated     40           same as model, brierDemoteBps = BRIER_DEMOTE_BPS (2500)
///
/// One EOA (ACTOR, anvil #1) is both quoter and settler and also trades (arb + retail) so every tx of a block is
/// ordered by nonce (deterministic). Attestor = anvil #3. Env: INIT_PRICE_USD_E8, LIQUIDITY, BENCH_OUT, DETOX_K, CONST_K.
/// Model allowlisting (if the hook supports it) is done here via a low-level call so this script compiles against
/// both hook ABI versions.
contract DeployBench is DeployBase {
    uint256 internal constant ANVIL0_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

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
        c.staleBlocks = 5;
        c.sanityBandBps = 0;
        c.chainlinkFeed = address(0);
        c.brierDemoteBps = brier;
        // v3 threshold law: default baseFee + 300. The v1/v2 benchmark runners pass ARB_THRESHOLD_PIPS=0 so they
        // keep reproducing the law their frozen results were produced with (premium from the first pip).
        c.arbThresholdPips = uint24(vm.envOr("ARB_THRESHOLD_PIPS", uint256(c.baseFee) + 300));
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
        d.configDelay = 0; // no config timelock on the local bench chain

        vm.startBroadcast(pk);
        d.manager = _deployPoolManager(d.deployer); // artifact via CREATE2 (hook not compiled in the 44M-run profile)
        _deployTokens(d);
        MockRoleOracle roles = new MockRoleOracle(d.deployer);
        roles.setQuoter(actor, true);
        roles.setSettler(actor, true);
        d.roles = IRoleOracle(address(roles));
        _deployHook(d);

        uint32 detoxK = uint32(vm.envOr("DETOX_K", uint256(7000)));
        uint32 constK = uint32(vm.envOr("CONST_K", uint256(5000)));
        uint32 brier = uint32(vm.envOr("BRIER_DEMOTE_BPS", uint256(2500)));

        BenchPool[5] memory ps;
        ps[0] = BenchPool("fixed", PoolKey(d.c0, d.c1, 3000, 60, IHooks(address(0))), false);
        ps[1] = BenchPool("detox", _hk(d, 10), true);
        ps[2] = BenchPool("const", _hk(d, 20), true);
        ps[3] = BenchPool("model", _hk(d, 30), true);
        ps[4] = BenchPool("gated", _hk(d, 40), true);
        OniblockHook.PoolConfig[5] memory cfgs;
        cfgs[1] = _cfg(detoxK, detoxK, detoxK, 0);
        cfgs[2] = _cfg(constK, constK, constK, 0);
        cfgs[3] = _cfg(2000, 8000, 5000, brier);
        cfgs[4] = _cfg(2000, 8000, 5000, brier);

        uint160 sqrtP = PriceMath.priceX96ToSqrtPriceX96(PriceMath.usdToPriceX96(d.initUsdE8, d.wethIs0, 18, 6));
        d.liqRouter = new PoolModifyLiquidityTest(d.manager);
        d.router = new SplitSwapRouter(d.manager);
        d.weth.mint(d.deployer, 1e30);
        d.usdc.mint(d.deployer, 1e20);
        d.weth.approve(address(d.liqRouter), type(uint256).max);
        d.usdc.approve(address(d.liqRouter), type(uint256).max);
        // Trading balances for the actor (approval to the router is sent by the actor from TS).
        d.weth.mint(actor, 1e30);
        d.usdc.mint(actor, 1e20);

        bytes32[] memory nodes = vm.envOr("MODEL_NODES", ",", new bytes32[](0));
        for (uint256 i = 0; i < 5; i++) {
            if (ps[i].hooked) {
                d.hook.registerPool(ps[i].key, cfgs[i]);
            }
            d.manager.initialize(ps[i].key, sqrtP);
            if (ps[i].hooked) {
                // Newer hook versions gate attestations by a per-pool model allowlist; older ones have no such call.
                for (uint256 j = 0; j < nodes.length; j++) {
                    (bool ok,) = address(d.hook).call(
                        abi.encodeWithSignature("setModelAllowed(bytes32,bytes32,bool)", PoolId.unwrap(ps[i].key.toId()), nodes[j], true)
                    );
                    ok; // ignored on purpose (function absent on older hook versions)
                }
            }
            int24 ts = ps[i].key.tickSpacing;
            d.liqRouter.modifyLiquidity(
                ps[i].key, ModifyLiquidityParams(TickMath.minUsableTick(ts), TickMath.maxUsableTick(ts), d.liquidity, 0), ""
            );
        }
        vm.stopBroadcast();

        // ---- JSON
        string memory poolsJ;
        for (uint256 i = 0; i < 5; i++) {
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
                vm.serializeUint(t, "feeMax", cfgs[i].feeMax);
                vm.serializeUint(t, "arbThresholdPips", cfgs[i].arbThresholdPips);
            }
            string memory pj = vm.serializeBool(t, "hooked", ps[i].hooked);
            poolsJ = vm.serializeString("pools", t, pj);
        }
        string memory r = "root";
        vm.serializeUint(r, "chainId", block.chainid);
        vm.serializeUint(r, "deployBlock", block.number);
        vm.serializeAddress(r, "poolManager", address(d.manager));
        vm.serializeAddress(r, "hook", address(d.hook));
        vm.serializeAddress(r, "roleOracle", address(d.roles));
        vm.serializeAddress(r, "splitSwapRouter", address(d.router));
        vm.serializeAddress(r, "actor", actor);
        vm.serializeAddress(r, "attestor", d.attestor);
        vm.serializeAddress(r, "currency0", Currency.unwrap(d.c0));
        vm.serializeAddress(r, "currency1", Currency.unwrap(d.c1));
        vm.serializeBool(r, "wethIsToken0", d.wethIs0);
        vm.serializeUint(r, "initPriceUsdE8", d.initUsdE8);
        vm.serializeUint(r, "sqrtPriceX96", sqrtP);
        vm.serializeInt(r, "liquidity", d.liquidity);
        string memory out = vm.serializeString(r, "pools", poolsJ);
        vm.writeJson(out, vm.envOr("BENCH_OUT", string.concat(vm.projectRoot(), "/../deployments/bench.json")));
    }

    function _hk(Deployed memory d, int24 ts) internal pure returns (PoolKey memory) {
        return PoolKey(d.c0, d.c1, LPFeeLibrary.DYNAMIC_FEE_FLAG, ts, IHooks(address(d.hook)));
    }
}
