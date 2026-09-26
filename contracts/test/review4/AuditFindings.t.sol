// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {OniblockTestBase} from "../utils/OniblockTestBase.sol";
import {OniblockHook} from "../../src/OniblockHook.sol";

/// Regression tests pinning behaviour documented in response to external audit findings.
contract AuditFindingsTest is OniblockTestBase {
    function _k() internal view returns (uint32) {
        (OniblockHook.PoolState memory st,,) = hook.poolState(pid);
        return st.kBps;
    }

    /// v4 "the AI decides" config: no floor, no default power, one post spans [0, kMax], no gap threshold.
    function _v4() internal {
        OniblockHook.PoolConfig memory c = defaultConfig();
        c.kMinBps = 0;
        c.kDefaultBps = 0;
        c.maxKStepBps = 8000;
        c.arbThresholdPips = 0;
        hook.updatePoolConfig(pid, c);
    }

    // Documents an accepted oracle-latency limit (docs/DESIGN.md §12): an arb that lands before this block's keeper
    // post is priced against the previous, still-fresh mid (baseFee, not conservativeFee) for up to staleBlocks.
    function test_audit_arbBeforeKeeper_paysBaseFee() public {
        _v4();
        uint256 px = _poolX96(pid);
        uint256 postBlock = vm.getBlockNumber();
        _post(pkey, px, 10000, 10000); // mid == pool price, k = kMax = 8000
        assertEq(_k(), 8000);

        vm.roll(postBlock + 1);
        uint256 newMid = px * 101 / 100; // CEX moves +1%: oneForZero is the arb direction
        bool zeroForOne = false;

        // Keeper posts first: the same arb is quoted at feeMax.
        uint256 snap = vm.snapshotState();
        _post(pkey, newMid, 10000, 10000);
        (uint24 keeperFirstFee,,,) = hook.quoteFee(pkey, zeroForOne);
        assertEq(keeperFirstFee, 10000, "keeper first: feeMax");
        vm.revertToState(snap);

        // Arb lands first: priced vs the old mid (gap 0) -> baseFee, below conservativeFee (5000).
        vm.recordLogs();
        _swapIn(zeroForOne, zeroForOne == wethIs0 ? 1e18 : 2500e6);
        (,,,, uint24 fee,,, bool stale) = _lastReceipt(vm.getRecordedLogs());
        assertFalse(stale);
        assertEq(fee, 3000, "arb before keeper pays baseFee");

        // No further posts: the old mid stays fresh through postBlock + staleBlocks, then goes stale.
        vm.roll(postBlock + 5);
        (,,, bool staleAtLimit) = hook.quoteFee(pkey, zeroForOne);
        assertFalse(staleAtLimit, "fresh at postBlock + staleBlocks");
        vm.roll(postBlock + 6);
        (,,, bool staleAfter) = hook.quoteFee(pkey, zeroForOne);
        assertTrue(staleAfter, "stale after staleBlocks");
    }
}
