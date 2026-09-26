// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {OniblockHook} from "../src/OniblockHook.sol";
import {OniblockTestBase} from "./utils/OniblockTestBase.sol";

/// v4 "the AI decides the fee" configuration (docs/review/V4_AI_DECIDES.md), no contract change:
///   arbThresholdPips = 0, kMinBps = 0, kDefaultBps = 0, kMaxBps = 8000, maxKStepBps = 8000
///   => k = 8000 * p * c / 1e8 ; fee (arb direction) = base + gap * k / 1e4
/// A "no profitable arbitrage" score (p = 0) makes the pool exactly a base-fee pool; a demoted or non-allowlisted model
/// has no power (k = kDefault = 0); k can go 0 -> high -> 0 in consecutive blocks.
contract V4AiDecidesTest is OniblockTestBase {
    function _v4Config() internal pure returns (OniblockHook.PoolConfig memory c) {
        c = defaultConfig();
        c.kMinBps = 0;
        c.kDefaultBps = 0;
        c.kMaxBps = 8000;
        c.maxKStepBps = 8000;
        c.arbThresholdPips = 0;
    }

    function setUp() public override {
        super.setUp();
        hook.updatePoolConfig(pid, _v4Config()); // configDelay 0 => immediate; stored k clamped into [0, 8000]
    }

    /// Post (p, c) with the pool `gapPips` above the posted mid (zeroForOne = toward the mid = arb direction).
    function _postAbove(uint256 gapPips, uint32 p, uint32 c, bytes32 model) internal {
        uint256 px = _poolX96(pid);
        uint256 mid = px * 1e6 / (1e6 + gapPips);
        OniblockHook.Attestation memory a = _attestation(pid, uint64(vm.getBlockNumber()), mid, p, c, model, attestorPk);
        vm.prank(quoter);
        hook.setAttestation(pkey, a);
    }

    function _next() internal {
        vm.roll(vm.getBlockNumber() + 1);
    }

    function test_v4_configAccepted() public view {
        OniblockHook.PoolConfig memory c = hook.poolConfig(pid);
        assertEq(c.kMinBps, 0);
        assertEq(c.kDefaultBps, 0);
        assertEq(c.arbThresholdPips, 0);
        assertEq(hook.kFromScore(pid, 0, 10000, MODEL), 0, "p = 0 -> k = 0");
        assertEq(hook.kFromScore(pid, 300, 3000, MODEL), 72, "calm Jev (p .03, c .30) -> k = 0.0072");
        assertEq(hook.kFromScore(pid, 9300, 7000, MODEL), 5208, "toxic Jev (p .93, c .70) -> k = 0.52");
    }

    function test_v4_noArb_pZero_isExactlyBase_bothDirections() public {
        _postAbove(2000, 0, 10000, MODEL);
        (uint24 fz, bool az, uint32 gz, bool stale) = hook.quoteFee(pkey, true);
        (uint24 fo, bool ao,,) = hook.quoteFee(pkey, false);
        assertFalse(stale);
        assertTrue(az);
        assertApproxEqAbs(gz, 2000, 2);
        assertEq(fz, 3000, "model says calm: base fee in the arb direction");
        assertFalse(ao);
        assertEq(fo, 3000);
        vm.recordLogs();
        _swapIn(true, 1e15);
        (,,, uint32 k, uint24 fee,,,) = _lastReceipt(vm.getRecordedLogs());
        assertEq(k, 0);
        assertEq(fee, 3000, "executed == base");
    }

    function test_v4_kFollowsModel_withinOneBlock_upAndDown() public {
        _postAbove(2000, 0, 10000, MODEL);
        (uint24 f0,,,) = hook.quoteFee(pkey, true);
        assertEq(f0, 3000);
        _next();
        _postAbove(2000, 9300, 7000, MODEL); // toxic: 0 -> 5208 in one attestation (step 8000)
        (uint24 f1,, uint32 g1,) = hook.quoteFee(pkey, true);
        assertEq(f1, _lawFee(3000, 10000, 0, g1, 5208), "toxic: base + k*gap");
        assertGt(f1, 3000);
        _next();
        _postAbove(2000, 0, 10000, MODEL); // calm again: back to k = 0 next block
        (uint24 f2,,,) = hook.quoteFee(pkey, true);
        assertEq(f2, 3000, "calm again: base");
    }

    function test_v4_untrustedModel_hasNoPower() public {
        bytes32 fresh = keccak256("heuristic-v1.models.oniblock.eth");
        assertTrue(hook.isDemoted(pid, fresh), "not allowlisted => no power");
        hook.setModelAllowed(pid, fresh, true); // allowlisted, never calibrated => active
        assertFalse(hook.isDemoted(pid, fresh), "no record => active");
        _next();
        _calibrate(MODEL, 4000); // Brier 0.40 > 0.25 => demoted
        _postAbove(3000, 10000, 10000, MODEL);
        (uint24 f2,,,) = hook.quoteFee(pkey, true);
        assertEq(f2, 3000, "demoted: base");
    }

    function testFuzz_v4_quoteEqualsLaw(uint32 p, uint32 c, uint16 gapPips) public {
        p = uint32(bound(p, 0, 10000));
        c = uint32(bound(c, 0, 10000));
        uint256 g = bound(gapPips, 1, 9000);
        _postAbove(g, p, c, MODEL);
        uint256 k = uint256(8000) * p * c / 1e8;
        (uint24 f,, uint32 gq, bool stale) = hook.quoteFee(pkey, true);
        assertFalse(stale);
        assertEq(f, _lawFee(3000, 10000, 0, gq, k));
        if (p == 0 || c == 0) assertEq(f, 3000);
    }
}
