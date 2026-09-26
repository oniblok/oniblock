// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Test.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

import {OniblockHook} from "../src/OniblockHook.sol";
import {OniblockTestBase} from "./utils/OniblockTestBase.sol";

/// v3 threshold fee law (docs/review/V3_THRESHOLD_BUILD.md):
///   arb direction, not stale: fee = min(base + max(0, gapHW - arbThresholdPips) * k / 1e4, feeMax)
///   below the threshold the pool is exactly a baseFee pool in both directions.
contract ThresholdLawTest is OniblockTestBase {
    /// Post a mid so that the pool sits `gapPips` ABOVE it (zeroForOne = arb direction) or BELOW it (oneForZero).
    /// k = kDefault (5000) via p/c.
    function _postGapPips(uint256 gapPips, bool poolAbove) internal returns (uint256 mid) {
        uint256 px = _poolX96(pid);
        mid = poolAbove ? px * 1e6 / (1e6 + gapPips) : px * 1e6 / (1e6 - gapPips) + 1;
        _post(pkey, mid, 10000, 5000);
    }

    function _receipts(Vm.Log[] memory logs)
        internal
        view
        returns (uint256 n, bool[] memory arb, uint32[] memory gap, uint24[] memory fee)
    {
        arb = new bool[](logs.length);
        gap = new uint32[](logs.length);
        fee = new uint24[](logs.length);
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(hook) || logs[i].topics[0] != OniblockHook.Receipt.selector) continue;
            (, arb[n], gap[n],, fee[n],,,,) =
                abi.decode(logs[i].data, (bool, bool, uint32, uint32, uint24, int128, int128, bytes32, bool));
            n++;
        }
    }

    // ------------------------------------------------------------------ below / at / above the threshold

    function test_belowThreshold_baseFee_bothDirections_poolAbove() public {
        _postGapPips(2000, true); // 0.20% gap < 0.33% threshold
        (uint24 fz, bool az, uint32 gz, bool stale) = hook.quoteFee(pkey, true);
        (uint24 fo, bool ao,,) = hook.quoteFee(pkey, false);
        assertFalse(stale);
        assertTrue(az, "toward direction is still classified arbDir");
        assertApproxEqAbs(gz, 2000, 2);
        assertEq(fz, 3000, "below threshold: base");
        assertFalse(ao);
        assertEq(fo, 3000);
        // executed == quoted; Receipt carries the raw gap
        vm.recordLogs();
        _swapIn(true, 1e15);
        (, bool arb, uint32 gap,, uint24 fee,,,) = _lastReceipt(vm.getRecordedLogs());
        assertTrue(arb);
        assertEq(gap, gz, "raw gap reported");
        assertEq(fee, 3000);
    }

    function test_belowThreshold_baseFee_bothDirections_poolBelow() public {
        _postGapPips(3000, false); // pool 0.30% below the mid: oneForZero is toward
        (uint24 fo, bool ao, uint32 go,) = hook.quoteFee(pkey, false);
        (uint24 fz, bool az,,) = hook.quoteFee(pkey, true);
        assertTrue(ao);
        assertApproxEqAbs(go, 3000, 2);
        assertEq(fo, 3000);
        assertFalse(az);
        assertEq(fz, 3000);
        vm.recordLogs();
        _swapIn(false, 1e6);
        (,,,, uint24 fee,,,) = _lastReceipt(vm.getRecordedLogs());
        assertEq(fee, 3000);
    }

    function test_atThreshold_baseFee() public {
        _postGapPips(ARB_THRESHOLD, true);
        (uint24 fz,, uint32 g,) = hook.quoteFee(pkey, true);
        assertLe(g, ARB_THRESHOLD + 1);
        assertEq(fz, _lawFee(g, 5000));
        assertLe(fz, 3000, "at the threshold: base (<= 1 pip rounding => +0)");
    }

    function test_justAboveThreshold_smallPremium() public {
        _postGapPips(ARB_THRESHOLD + 200, true); // 0.35% gap
        (uint24 fz, bool az, uint32 g,) = hook.quoteFee(pkey, true);
        assertTrue(az);
        assertApproxEqAbs(g, ARB_THRESHOLD + 200, 2);
        assertEq(fz, _lawFee(g, 5000));
        assertApproxEqAbs(fz, 3100, 2, "3000 + 200 * 0.5");
        vm.recordLogs();
        _swapIn(true, 1e15);
        (,,,, uint24 fee,,,) = _lastReceipt(vm.getRecordedLogs());
        assertEq(fee, fz);
        (uint24 fo,,,) = hook.quoteFee(pkey, false);
        assertEq(fo, 3000, "away direction: base");
    }

    function test_largeGap_hitsCap() public {
        _postGapPips(50_000, false); // 5% gap: 3000 + (50000 - 3300) * 0.5 > feeMax
        (uint24 fo, bool ao,,) = hook.quoteFee(pkey, false);
        assertTrue(ao);
        assertEq(fo, 10000);
        vm.recordLogs();
        _swapIn(false, 1e6);
        (,,,, uint24 fee,,,) = _lastReceipt(vm.getRecordedLogs());
        assertEq(fee, 10000);
    }

    function test_thresholdZero_isV2Law() public {
        OniblockHook.PoolConfig memory c = defaultConfig();
        c.arbThresholdPips = 0;
        hook.updatePoolConfig(pid, c); // delay 0 => immediate
        _postGapPips(2000, true);
        (uint24 fz,, uint32 g,) = hook.quoteFee(pkey, true);
        assertEq(fz, 3000 + uint24(uint256(g) * 5000 / 10000), "threshold 0 = premium from the first pip");
    }

    /// Stale => conservativeFee regardless of the threshold; N-07 floor still applies below the threshold.
    function test_stale_and_N07Floor_belowThreshold() public {
        (uint24 f,,, bool stale) = hook.quoteFee(pkey, true);
        assertTrue(stale);
        assertEq(f, 5000);
        _swapIn(true, 1e12); // first touch of this block: stale anchor
        _postGapPips(1000, true); // fresh, below threshold, same block => un-stales, floored at conservativeFee
        (uint24 f2, bool a2,, bool st2) = hook.quoteFee(pkey, true);
        assertFalse(st2);
        assertTrue(a2);
        assertEq(f2, 5000, "N-07: never below the fee already charged in this block");
        vm.roll(vm.getBlockNumber() + 1);
        (uint24 f3,,,) = hook.quoteFee(pkey, true);
        assertEq(f3, 3000, "next block: below threshold => base");
    }

    // ------------------------------------------------------------------ split resistance above the threshold

    function test_splitResistance_aboveThreshold() public {
        _postGapPips(10_000, true); // 1% gap, pool above => zeroForOne
        (uint24 q,, uint32 g,) = hook.quoteFee(pkey, true);
        assertEq(q, _lawFee(g, 5000));
        assertGt(q, 3000);
        // a split arb that walks the pool most of the way to the mid (live gap drops below the threshold for the
        // later parts): every part pays the first part's (high-water) fee
        vm.recordLogs();
        router.swapSplit(pkey, true, -int256(wethIs0 ? uint256(4e18) : uint256(10_000e6)), 6, 0, address(this));
        (uint256 n, bool[] memory arb,, uint24[] memory fee) = _receipts(vm.getRecordedLogs());
        assertEq(n, 6);
        for (uint256 i; i < n; i++) {
            assertTrue(arb[i]);
            assertEq(fee[i], q, "split part pays the high-water fee");
        }
        (OniblockHook.PoolState memory st,,) = hook.poolState(pid);
        uint256 px = _poolX96(pid);
        if (px > st.oracleMidX96) {
            uint256 live = (px - st.oracleMidX96) * 1e6 / st.oracleMidX96;
            if (live > 0) {
                (uint24 after_,,,) = hook.quoteFee(pkey, true);
                assertEq(after_, q, "rest of the block keeps the high-water fee while toward");
            }
        }
    }

    // ------------------------------------------------------------------ config validation + timelock

    function test_thresholdValidation() public {
        PoolKey memory k = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 30, IHooks(address(hook)));
        OniblockHook.PoolConfig memory c = defaultConfig();
        c.arbThresholdPips = c.feeMax + 1;
        vm.expectRevert(OniblockHook.InvalidConfig.selector);
        hook.registerPool(k, c);
        vm.expectRevert(OniblockHook.InvalidConfig.selector);
        hook.updatePoolConfig(pid, c);
        c.arbThresholdPips = c.feeMax; // edge: allowed
        hook.registerPool(k, c);
        assertEq(hook.poolConfig(k.toId()).arbThresholdPips, c.feeMax);
        c.arbThresholdPips = 0; // allowed (v2 law)
        hook.updatePoolConfig(pid, c);
        assertEq(hook.poolConfig(pid).arbThresholdPips, 0);
    }

    function test_threshold_updatePoolConfig_timelocked() public {
        OniblockHook h = _deployHook(1 hours);
        PoolKey memory k = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, TICK_SPACING, IHooks(address(h)));
        PoolId id = k.toId();
        h.registerPool(k, defaultConfig());
        manager.initialize(k, _sqrtAtUsd(USD_E8));
        h.setModelAllowed(id, MODEL, true);
        uint256 px = _poolX96(id);
        uint256 mid = px * 1e6 / (1e6 + 5000); // 0.5% gap
        OniblockHook.Attestation memory a = OniblockHook.Attestation(uint64(vm.getBlockNumber()), mid, 0, 0, MODEL, "");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorPk, h.attestationDigest(id, a));
        a.signature = abi.encodePacked(r, s, v);
        vm.prank(quoter);
        h.setAttestation(k, a);
        (uint24 f0,, uint32 g,) = h.quoteFee(k, true);
        assertEq(f0, _lawFee(g, 5000)); // unseasoned => kDefault

        OniblockHook.PoolConfig memory c = defaultConfig();
        c.arbThresholdPips = 8000; // raise the threshold above the gap
        h.updatePoolConfig(id, c); // queued
        assertEq(h.poolConfig(id).arbThresholdPips, ARB_THRESHOLD, "not applied before the delay");
        (uint24 f1,,,) = h.quoteFee(k, true);
        assertEq(f1, f0);
        vm.warp(vm.getBlockTimestamp() + 30 minutes);
        vm.expectRevert();
        h.updatePoolConfig(id, c); // too early
        vm.warp(vm.getBlockTimestamp() + 31 minutes);
        h.updatePoolConfig(id, c); // executes
        assertEq(h.poolConfig(id).arbThresholdPips, 8000);
        (uint24 f2,,,) = h.quoteFee(k, true);
        assertEq(f2, 3000, "gap now below the raised threshold => base");
    }

    // ------------------------------------------------------------------ fuzz: law mirror

    function testFuzz_thresholdLaw(uint256 gapPips, uint24 thr, bool poolAbove) public {
        gapPips = bound(gapPips, 1, 60_000);
        thr = uint24(bound(thr, 0, 10000));
        OniblockHook.PoolConfig memory c = defaultConfig();
        c.arbThresholdPips = thr;
        hook.updatePoolConfig(pid, c);
        _postGapPips(gapPips, poolAbove);
        (uint24 fT, bool aT, uint32 g,) = hook.quoteFee(pkey, poolAbove);
        (uint24 fA,,,) = hook.quoteFee(pkey, !poolAbove);
        assertEq(fA, 3000, "away: base");
        if (g == 0) {
            assertEq(fT, 3000);
            return;
        }
        assertTrue(aT);
        assertEq(fT, _lawFee(3000, 10000, thr, g, 5000));
        if (g <= thr) assertEq(fT, 3000, "at/below threshold: base");
        vm.recordLogs();
        _swapIn(poolAbove, poolAbove == wethIs0 ? 1e12 : 1e3);
        (,, uint32 rg,, uint24 fee,,,) = _lastReceipt(vm.getRecordedLogs());
        assertEq(fee, fT, "executed == quoted");
        assertEq(rg, g);
    }
}
