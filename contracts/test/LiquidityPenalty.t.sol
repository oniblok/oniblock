// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Test.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Position} from "@uniswap/v4-core/src/libraries/Position.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {OniblockTestBase} from "./utils/OniblockTestBase.sol";
import {OniblockHook} from "../src/OniblockHook.sol";

/// JIT protection (OpenZeppelin LiquidityPenaltyHook logic merged into OniblockHook).
contract LiquidityPenaltyTest is OniblockTestBase {
    using StateLibrary for IPoolManager;

    int256 constant JIT_LIQ = 2e17; // 4x the resident LP
    uint256 constant JIT_SALT = 1;

    function _jitCycle(uint256 rollBeforeRemove)
        internal
        returns (uint256 jitAccrued0, uint256 donated0, uint256 residentL)
    {
        residentL = manager.getLiquidity(pid);
        _addLiq(pkey, JIT_LIQ, JIT_SALT);
        uint256 L = manager.getLiquidity(pid);
        (uint256 g0,) = _feeGrowth(pid);
        _swapIn(true, 10e18); // token0 in => fees in token0
        (uint256 h0,) = _feeGrowth(pid);
        jitAccrued0 = _feesFromGrowth(g0, h0, uint256(JIT_LIQ));
        assertEq(L, residentL + uint256(JIT_LIQ));

        vm.roll(vm.getBlockNumber() + rollBeforeRemove);
        (g0,) = _feeGrowth(pid);
        _addLiq(pkey, -JIT_LIQ, JIT_SALT);
        (h0,) = _feeGrowth(pid);
        donated0 = _feesFromGrowth(g0, h0, residentL);
    }

    function test_jit_sameBlock_forfeitsAllFeesToInRangeLPs() public {
        vm.recordLogs();
        (uint256 accrued, uint256 donated,) = _jitCycle(0);
        assertGt(accrued, 0);
        assertApproxEqRel(donated, accrued, 1e15, "100% penalty donated to resident LP");
        // PoolManager Donate event from the hook
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawDonate;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(manager) && logs[i].topics[0] == IPoolManager.Donate.selector) {
                assertEq(address(uint160(uint256(logs[i].topics[2]))), address(hook));
                sawDonate = true;
            }
        }
        assertTrue(sawDonate);
    }

    function test_jit_halfWindow_linearDecay() public {
        (uint256 accrued, uint256 donated,) = _jitCycle(JIT_OFFSET / 2);
        assertApproxEqRel(donated, accrued / 2, 1e15);
    }

    function test_jit_afterWindow_noPenalty() public {
        (uint256 accrued, uint256 donated,) = _jitCycle(JIT_OFFSET);
        assertGt(accrued, 0);
        assertEq(donated, 0);
    }

    function test_jit_reAddWithinWindow_withholdsThenReturns() public {
        _addLiq(pkey, JIT_LIQ, JIT_SALT);
        _swapIn(true, 10e18);
        _addLiq(pkey, 1e10, JIT_SALT); // re-add inside the window: fees are withheld by the hook
        bytes32 posKey = Position.calculatePositionKey(address(modifyLiquidityRouter), FULL_LOWER, FULL_UPPER, bytes32(JIT_SALT));
        BalanceDelta withheld = hook.getWithheldFees(pid, posKey);
        assertGt(withheld.amount0(), 0);
        // wait out the window: removal returns withheld fees, no penalty
        vm.roll(vm.getBlockNumber() + JIT_OFFSET);
        (uint256 g0,) = _feeGrowth(pid);
        _addLiq(pkey, -(JIT_LIQ + 1e10), JIT_SALT);
        (uint256 h0,) = _feeGrowth(pid);
        assertEq(h0, g0, "no donation");
        assertEq(BalanceDelta.unwrap(hook.getWithheldFees(pid, posKey)), 0);
    }

    function test_residentLp_noPenalty() public {
        // resident LP (salt 0) added in setUp, well past the window
        (uint256 g0,) = _feeGrowth(pid);
        _swapIn(true, 1e18);
        (uint256 m0,) = _feeGrowth(pid);
        assertGt(m0, g0);
        _addLiq(pkey, -LP_LIQ / 2, 0);
        (uint256 h0,) = _feeGrowth(pid);
        assertEq(h0, m0);
    }

    /// Last in-range LP exits inside the window: withdrawal does NOT revert; the penalty is parked in the hook
    /// (ERC-6909 claims) and donated on the next swap that finds in-range liquidity.
    function test_jit_lastLpExit_parksPenalty_thenDonatesOnNextSwap() public {
        PoolKey memory k = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 10, IHooks(address(hook)));
        PoolId id = k.toId();
        hook.registerPool(k, defaultConfig());
        manager.initialize(k, _sqrtAtUsd(USD_E8));

        // JIT is the only LP
        modifyLiquidityRouter.modifyLiquidity(k, ModifyLiquidityParams(-887270, 887270, JIT_LIQ, 0), "");
        router.swap(k, true, -1e18, 0, address(this));
        modifyLiquidityRouter.modifyLiquidity(k, ModifyLiquidityParams(-887270, 887270, -JIT_LIQ, 0), "");
        assertEq(manager.getLiquidity(id), 0);
        uint256 p0 = hook.pendingPenalty0(id);
        assertGt(p0, 0, "penalty parked");
        assertEq(manager.balanceOf(address(hook), currency0.toId()), p0, "held as ERC-6909 claims");

        // no liquidity in range: a swap does not flush (and does not revert)
        (uint160 sp,,,) = manager.getSlot0(id);
        router.swap(k, false, -1e3, sp + sp / 100000, address(this));
        assertEq(hook.pendingPenalty0(id), p0);

        // a new LP arrives; next swap donates the parked penalty to it
        vm.roll(vm.getBlockNumber() + 1);
        modifyLiquidityRouter.modifyLiquidity(k, ModifyLiquidityParams(-887270, 887270, LP_LIQ, bytes32(uint256(7))), "");
        (uint256 g0,) = manager.getFeeGrowthGlobals(id);
        vm.recordLogs();
        router.swap(k, false, -1e6, 0, address(this)); // token1 in: token0 growth only from donation
        (uint256 h0,) = manager.getFeeGrowthGlobals(id);
        assertEq(hook.pendingPenalty0(id), 0);
        assertEq(manager.balanceOf(address(hook), currency0.toId()), 0);
        assertApproxEqAbs(_feesFromGrowth(g0, h0, uint256(LP_LIQ)), p0, 2);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool saw;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == OniblockHook.PenaltyDonated.selector) saw = true;
        }
        assertTrue(saw);
    }
}
