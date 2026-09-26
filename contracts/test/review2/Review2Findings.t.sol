// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Test.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";

import {OniblockTestBase} from "../utils/OniblockTestBase.sol";
import {OniblockHook} from "../../src/OniblockHook.sol";
import {IRoleOracle} from "../../src/interfaces/IRoleOracle.sol";
import {PriceMath} from "../../src/libraries/PriceMath.sol";

/// Round-2 reviewer PoCs (docs/review/CONTRACT_REVIEW_2.md), updated by docs/review/CONTRACT_FIXES_2.md: fixed
/// findings now assert the FIXED behaviour (`*_fixed`); documented findings (N-02 residual, N-03, N-06, N-09, N-10,
/// N-12, N-13) still reproduce and are marked DOCUMENTED.
contract Review2FindingsTest is OniblockTestBase {
    using StateLibrary for IPoolManager;

    bytes32 constant MODEL2 = keccak256("heuristic-v1.models.oniblock.eth");

    // ------------------------------------------------------------------ helpers
    function _postAs(bytes32 model, uint256 mid, uint32 p, uint32 c) internal {
        _postAsAt(model, uint64(vm.getBlockNumber()), mid, p, c);
    }

    function _postAsAt(bytes32 model, uint64 bn, uint256 mid, uint32 p, uint32 c) internal {
        OniblockHook.Attestation memory a = _attestation(pid, bn, mid, p, c, model, attestorPk);
        vm.prank(quoter);
        hook.setAttestation(pkey, a);
    }

    function _k() internal view returns (uint32) {
        (OniblockHook.PoolState memory st,,) = hook.poolState(pid);
        return st.kBps;
    }

    function _mid() internal view returns (uint256) {
        (OniblockHook.PoolState memory st,,) = hook.poolState(pid);
        return st.oracleMidX96;
    }

    /// Swap (huge exact-in, price-limited) until the pool price is exactly `targetX96`.
    function _pushTo(uint256 targetX96) internal returns (uint24 fee) {
        uint160 lim = PriceMath.priceX96ToSqrtPriceX96(targetX96);
        bool z = targetX96 < _poolX96(pid);
        vm.recordLogs();
        router.swap(pkey, z, -int256(1e30), lim, address(this));
        (,,,, fee,,,) = _lastReceipt(vm.getRecordedLogs());
    }

    /// Execute a small retail swap and return the fee it paid (pips) plus arbDir / gap from its Receipt.
    function _retail(bool z) internal returns (uint24 fee, bool arb, uint32 gap) {
        vm.recordLogs();
        _swapIn(z, z == wethIs0 ? 1e18 : 2500e6); // ~1 ETH / 2,500 USDC notional
        (, arb, gap,, fee,,,) = _lastReceipt(vm.getRecordedLogs());
    }

    function _liveGap() internal view returns (uint256) {
        uint256 m = _mid();
        uint256 p = _poolX96(pid);
        return (p > m ? p - m : m - p) * 1e6 / m;
    }

    // ================================================================== R-01 variants

    /// FINDING N-03 (trust): the keeper can post a demoted model's scores under ANOTHER allowlisted, seasoned node.
    /// The allowlist bounds *which* identities it can claim, not *which model produced the score*.
    function test_r2_R01_keeperRelabelsScoresAsOtherSeasonedNode() public {
        uint256 mid = _poolX96(pid);
        hook.setModelAllowed(pid, MODEL2, true);
        _season(MODEL2, 1000); // the fallback node is seasoned and good
        _season(MODEL, 4000); // primary is demoted
        assertTrue(hook.isDemoted(pid, MODEL));
        for (uint256 i; i < 3; i++) {
            _postAs(MODEL2, mid, 10000, 10000); // same (demoted) scores, relabelled
            vm.roll(vm.getBlockNumber() + 1);
        }
        assertEq(_k(), 8000, "demoted model's scores reach kMax under the fallback node");
    }

    /// v5 demo decision (reverses N-04): minSamples = 0 is ALLOWED and means "no probation": an allowlisted node with
    /// no record has power over k from its first attestation. Brier demotion still applies once graded, the
    /// allowlist still gates which nodes may post, and minSamples >= 1 restores probation.
    function test_r2_R01_minSamplesZero_meansNoProbation() public {
        OniblockHook.PoolConfig memory c = defaultConfig();
        c.minSamples = 0;
        hook.updatePoolConfig(pid, c);
        hook.setModelAllowed(pid, MODEL2, true); // brand-new node, no record
        assertFalse(hook.isDemoted(pid, MODEL2), "no probation: unrecorded allowlisted node is active");
        _season(MODEL, 4000); // Brier 0.40 > brierDemoteBps
        assertTrue(hook.isDemoted(pid, MODEL), "Brier demotion still applies");
        assertTrue(hook.isDemoted(pid, bytes32(uint256(0xdead))), "not allowlisted => demoted");
        c.minSamples = 1;
        hook.updatePoolConfig(pid, c);
        assertTrue(hook.isDemoted(pid, MODEL2), "minSamples >= 1 restores probation");
    }

    /// INFO: calibration is keyed by modelNode only (global); the allowlist / minSamples / Brier threshold are
    /// per pool. A node seasoned anywhere has instant (step-limited) power on any pool that allowlists it.
    function test_r2_R01_calibrationIsGlobal() public {
        PoolKey memory k2 = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 10, IHooks(address(hook)));
        hook.registerPool(k2, defaultConfig());
        manager.initialize(k2, _sqrtAtUsd(USD_E8));
        hook.setModelAllowed(k2.toId(), MODEL, true);
        assertFalse(hook.isDemoted(k2.toId(), MODEL), "seasoned on pool 1 => seasoned on pool 2");
        _season(MODEL, 4000);
        assertTrue(hook.isDemoted(k2.toId(), MODEL) && hook.isDemoted(pid, MODEL), "demotion is global too");
    }

    // ================================================================== R-02 running max: economics

    /// FIXED N-01: honest block = whale buy pushes pool +G, arb restores it (pays the arb fee, correct), then a
    /// retail seller in the same direction pays baseFee, because the live price is back at the mid (the swap cannot
    /// be an arbitrage toward the oracle) — the high-water mark no longer applies.
    function test_r2_R02_retailAfterWhaleAndArb_paysBase_fixed() public {
        uint256[3] memory gBps = [uint256(50), 100, 200];
        for (uint256 i; i < 3; i++) {
            vm.roll(vm.getBlockNumber() + 1);
            uint256 mid = _poolX96(pid);
            _post(pkey, mid, 10000, 5000); // oracle == pool, k = 5000 (kDefault)
            vm.roll(vm.getBlockNumber() + 1);
            // whale moves price AWAY (pays base)
            uint256 away = wethIs0 ? mid * (10000 + gBps[i]) / 10000 : mid * (10000 - gBps[i]) / 10000;
            uint24 whaleFee = _pushTo(away);
            assertEq(whaleFee, 3000);
            // arb restores to the mid (pays base + k*G)
            uint24 arbFee = _pushTo(mid);
            assertLe(_liveGap(), 1, "pool back at the oracle");
            // retail in the arb direction, later in the block
            bool arbZ = away > mid; // toward-oracle = zeroForOne iff pool was above the mid
            (uint24 retailFee, bool arb, uint32 gap) = _retail(arbZ);
            assertGt(arbFee, 3000, "the arb itself paid the gap fee");
            assertFalse(arb);
            assertEq(gap, 0);
            assertEq(retailFee, 3000, "retail after the arb pays base");
            // opposite-direction retail pays base (never displaced past the mid)
            (uint24 other,,) = _retail(!arbZ);
            emit log_named_uint("G (bps)", gBps[i]);
            emit log_named_uint("  arb fee (pips)", arbFee);
            emit log_named_uint("  retail fee arb-dir (pips)", retailFee);
            emit log_named_uint("  retail fee other-dir (pips)", other);
            emit log_named_uint("  excess over base per $2,500 trade (cents)", (uint256(retailFee) - 3000) * 2500 * 100 / 1e6);
        }
    }

    /// FIXED N-01b: after an overshoot only the direction that moves the LIVE price toward the mid pays an arb fee
    /// (from the high-water mark); back at the mid both directions pay base.
    function test_r2_R02_overshoot_onlyLiveTowardElevated_fixed() public {
        uint256 mid = _poolX96(pid);
        _post(pkey, mid, 10000, 5000);
        vm.roll(vm.getBlockNumber() + 1);
        _pushTo(mid * 101 / 100); // +1%
        _pushTo(mid * 99 / 100); // overshoot to -1% (records the +1% high-water for the first toward direction)
        bool towardNow = _poolX96(pid) > mid; // direction that moves the live price back up/down to the mid
        (uint24 fT, bool aT,,) = hook.quoteFee(pkey, towardNow);
        (uint24 fA, bool aA,,) = hook.quoteFee(pkey, !towardNow);
        assertTrue(aT);
        assertApproxEqAbs(fT, _lawFee(10000, 5000), 1); // +1% high-water gap: 3000 + (10000 - 3300) * 0.5
        assertFalse(aA, "past the mid for this direction => base");
        assertEq(fA, 3000);
        _pushTo(mid); // back to the mid
        (uint24 fz,,,) = hook.quoteFee(pkey, true);
        (uint24 fo,,,) = hook.quoteFee(pkey, false);
        assertEq(_liveGap(), 0);
        assertEq(fz, 3000);
        assertEq(fo, 3000);
    }

    /// DOCUMENTED residual N-02: the sole/dominant LP can round-trip the price at ~zero net cost (the fees go to
    /// itself). Back exactly at the mid both directions now pay base (N-01 fix); but by leaving the pool at mid+eps
    /// the griefer keeps the toward direction at the inflated high-water fee (feeMax) for the rest of the block.
    function test_r2_R02_dominantLP_residual_N02() public {
        uint256 mid = _poolX96(pid);
        _post(pkey, mid, 10000, 5000);
        vm.roll(vm.getBlockNumber() + 1);
        (uint256 g0a, uint256 g1a) = _feeGrowth(pid);
        uint256 w0 = weth.balanceOf(address(this));
        uint256 u0 = usdc.balanceOf(address(this));
        _pushTo(mid * 102 / 100); // +2%, base
        _pushTo(mid * 98 / 100); // -2%, pays feeMax on the toward part
        _pushTo(mid); // back, pays feeMax
        (uint24 fz,,,) = hook.quoteFee(pkey, true);
        (uint24 fo,,,) = hook.quoteFee(pkey, false);
        assertEq(fz, 3000, "at the mid: base (fixed)");
        assertEq(fo, 3000, "at the mid: base (fixed)");
        uint256 eps = wethIs0 ? mid * 1001 / 1000 : mid * 999 / 1000; // leave WETH 0.1% rich vs the oracle
        _pushTo(eps); // away move from the mid: pays base
        (uint256 g0b, uint256 g1b) = _feeGrowth(pid);
        bool towardZ = _poolX96(pid) > mid;
        (fz,,,) = hook.quoteFee(pkey, towardZ);
        (fo,,,) = hook.quoteFee(pkey, !towardZ);
        assertEq(fz, 10000, "toward direction at feeMax (high-water 2%) although the live gap is 0.1%");
        assertEq(fo, 3000, "other direction base");
        // LP-side accounting: swapper loss vs fees accrued to the (sole) LP position
        uint256 L = uint256(LP_LIQ);
        int256 dW = int256(weth.balanceOf(address(this))) - int256(w0);
        int256 dU = int256(usdc.balanceOf(address(this))) - int256(u0);
        uint256 f0 = _feesFromGrowth(g0a, g0b, L);
        uint256 f1 = _feesFromGrowth(g1a, g1b, L);
        (uint256 fW, uint256 fU) = wethIs0 ? (f0, f1) : (f1, f0);
        int256 netW = dW + int256(fW);
        int256 netU = dU + int256(fU);
        // value in USDC (6 dec) at 2,500
        int256 netUsd = netU + netW * 2500 / 1e12;
        int256 grossFeesUsd = int256(fU) + int256(fW) * 2500 / 1e12;
        emit log_named_int("swapper token delta (USDC-equiv, 6dec)", dU + dW * 2500 / 1e12);
        emit log_named_int("fees accrued to sole LP (USDC-equiv)", grossFeesUsd);
        emit log_named_int("net cost to a sole-LP griefer (USDC-equiv)", -netUsd);
        assertLt(-netUsd, grossFeesUsd / 20, "net cost < 5% of gross fees: griefing ~free for a sole LP");
        (uint24 retailFee,,) = _retail(towardZ);
        assertEq(retailFee, 10000, "honest toward-direction retail pays 3.3x base (fair: 3500)");
    }

    /// VERIFY: split resistance with the running max + the N-01 live-side check. The reference is the honest
    /// decomposition "toward part to the mid at the law fee, then the remainder (past the mid, not an arbitrage)
    /// at baseFee" (== one swap when the amount does not reach the mid). A 2..6-way split never beats it, and when
    /// the amount does not reach the mid a split never beats the single swap.
    function testFuzz_r2_R02_splitNeverCheaper(uint256 parts, uint256 amt, bool z, int256 gapBps) public {
        parts = bound(parts, 2, 6);
        gapBps = bound(gapBps, -150, 150);
        amt = z == wethIs0 ? bound(amt, 1e16, 20e18) : bound(amt, 1e7, 50_000e6);
        uint256 mid = _postGap(gapBps);
        vm.roll(vm.getBlockNumber() + 1);
        bool toward = z ? _poolX96(pid) > mid : _poolX96(pid) < mid;
        uint256 snap = vm.snapshotState();
        int256 outRef;
        if (toward) {
            BalanceDelta a = router.swap(pkey, z, -int256(amt), PriceMath.priceX96ToSqrtPriceX96(mid), address(this));
            uint256 used = uint256(int256(-(z ? a.amount0() : a.amount1())));
            outRef = z ? a.amount1() : a.amount0();
            if (used < amt) {
                BalanceDelta b = router.swap(pkey, z, -int256(amt - used), 0, address(this));
                outRef += z ? b.amount1() : b.amount0();
            }
        } else {
            BalanceDelta a = router.swap(pkey, z, -int256(amt), 0, address(this));
            outRef = z ? a.amount1() : a.amount0();
        }
        vm.revertToState(snap);
        BalanceDelta d1 = router.swap(pkey, z, -int256(amt), 0, address(this));
        vm.revertToState(snap);
        BalanceDelta dn = router.swapSplit(pkey, z, -int256(amt), parts, 0, address(this));
        int128 out1 = z ? d1.amount1() : d1.amount0();
        int128 outN = z ? dn.amount1() : dn.amount0();
        // Tolerance: the live-side check treats a live gap < 1 pip as "at the mid", so the last < 1e-6 of price
        // movement toward the mid can be bought at base by a split (bounded, <= 1 ppm of output).
        assertLe(outN, outRef + outRef / 1e6 + 2, "split must not beat the honest decomposition");
        if (outRef == out1) assertLe(outN, out1 + out1 / 1e6 + 2, "split must not receive more output than one swap");
    }

    /// VERIFY: a trader cannot lower its own fee by first nudging the price (dust in either direction) — gaps only go up.
    function test_r2_R02_dustPrenudgeCannotLowerArbFee() public {
        _postGap(100); // pool 1% away from the mid
        vm.roll(vm.getBlockNumber() + 1);
        bool arbZ = _poolX96(pid) > _mid();
        (uint24 q0,,,) = hook.quoteFee(pkey, arbZ);
        _swapIn(!arbZ, 1e6);
        _swapIn(arbZ, 1e6);
        (uint24 q1,,,) = hook.quoteFee(pkey, arbZ);
        assertGe(q1, q0);
    }

    // ================================================================== same-block attestation replacement

    /// FIXED (N-05) + DOCUMENTED (N-06): after a swap locked the fees, a LOWER-k same-block attestation changes
    /// nothing in this block (the anchor keeps its own k, model and mid). A HIGHER-k one takes over (k, model, mid):
    /// with its mid on the other side of the pool it raises the other direction (N-06) and — since the live price
    /// is now past the new mid for the old arb direction — that direction pays base (N-01; attestor trusted).
    function test_r2_A01_sameBlockAttestation_lowerKPinned_higherKTakesOver() public {
        _postGap(100); // k 5000 (p=1, c=0.5 -> kFromScore = 5000)
        vm.roll(vm.getBlockNumber() + 1);
        _postAs(MODEL, _mid(), 10000, 10000); // k 6000
        bool arbZ = _poolX96(pid) > _mid();
        _swapIn(arbZ, 1e6); // lock
        (uint24 qArb,,,) = hook.quoteFee(pkey, arbZ);
        (uint24 qOther,,,) = hook.quoteFee(pkey, !arbZ);
        assertEq(qOther, 3000);
        // same-block newer attestation? blockNumber must be strictly newer: already used current block, so roll
        // the "previous block" trick is unavailable; emulate with a fresh block where the keeper posts late:
        vm.roll(vm.getBlockNumber() + 1);
        _swapIn(arbZ, 1e6); // lock this block with the stored mid
        (qArb,,,) = hook.quoteFee(pkey, arbZ);
        // keeper posts in the same block a mid on the OTHER side of the pool, with minimal k
        uint256 p = _poolX96(pid);
        uint256 newMid = arbZ ? p * 10100 / 10000 : p * 9900 / 10000;
        _postAs(MODEL, newMid, 0, 0); // target kMin -> step down 1000
        (uint24 qArb2,,,) = hook.quoteFee(pkey, arbZ);
        (uint24 qOther2,,, ) = hook.quoteFee(pkey, !arbZ);
        assertEq(qArb2, qArb, "locked direction unchanged");
        assertEq(qOther2, 3000, "lower-k attestation's mid does not drive this block (N-05 fixed)");
        (OniblockHook.PoolState memory st, OniblockHook.Anchor memory anc,) = hook.poolState(pid);
        assertLt(st.kBps, anc.kBps, "anchor kept the higher k");
        assertEq(st.oracleMidX96, newMid, "stored for the next block");
        // two blocks later: a higher-k attestation posted after the first swap takes over, mid included (N-06)
        vm.roll(vm.getBlockNumber() + 2);
        _postAsAt(MODEL, uint64(vm.getBlockNumber() - 1), _poolX96(pid) * (arbZ ? 9900 : 10100) / 10000, 10000, 10000);
        _swapIn(arbZ, 1e6); // anchor
        (uint24 qA,,,) = hook.quoteFee(pkey, arbZ);
        assertGt(qA, 3000);
        uint256 p2 = _poolX96(pid);
        _postAs(MODEL, arbZ ? p2 * 10100 / 10000 : p2 * 9900 / 10000, 10000, 10000); // k steps up: takes over
        (uint24 qA2, bool aA2,,) = hook.quoteFee(pkey, arbZ);
        (uint24 qO2, bool aO2,,) = hook.quoteFee(pkey, !arbZ);
        assertTrue(aO2 && qO2 > 3000, "N-06: other direction raised by the new mid");
        assertFalse(aA2);
        assertEq(qA2, 3000, "old arb direction is past the new mid => base");
    }

    /// FIXED N-05: a lower-k attestation in an anchored block neither takes over the anchor's k/model NOR its mid:
    /// Receipts of this block reflect exactly the anchored attestation; the new one applies from the next block.
    function test_r2_A02_lowerKAttestation_doesNotMixAttribution_fixed() public {
        hook.setModelAllowed(pid, MODEL2, true);
        _season(MODEL2, 1000);
        _postGap(100);
        vm.roll(vm.getBlockNumber() + 1);
        _postAs(MODEL, _mid(), 10000, 10000); // k 6000 under MODEL, block B
        vm.roll(vm.getBlockNumber() + 1);
        bool arbZ = _poolX96(pid) > _mid();
        _swapIn(!arbZ, 1e6); // anchor block B+1 with MODEL/k=6000; away-direction dust
        uint256 p = _poolX96(pid);
        uint256 newMid = arbZ ? p * 10100 / 10000 : p * 9900 / 10000; // MODEL2 says the pool is on the other side
        _postAs(MODEL2, newMid, 0, 0); // k steps down to 5000 < 6000
        vm.recordLogs();
        _swapIn(!arbZ, 1e6); // now "toward" per MODEL2's mid
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = logs.length; i > 0; i--) {
            Vm.Log memory l = logs[i - 1];
            if (l.emitter == address(hook) && l.topics[0] == OniblockHook.Receipt.selector) {
                (, bool arb, uint32 gap, uint32 k,,,, bytes32 model,) =
                    abi.decode(l.data, (bool, bool, uint32, uint32, uint24, int128, int128, bytes32, bool));
                assertFalse(arb, "away per MODEL's (anchored) mid");
                assertEq(gap, 0);
                assertEq(k, 6000, "k from MODEL");
                assertEq(model, MODEL);
                // next block: MODEL2's attestation (mid + k + model) is in force
                vm.roll(vm.getBlockNumber() + 1);
                (, OniblockHook.Anchor memory anc,) = hook.poolState(pid);
                assertEq(anc.modelNode, MODEL2);
                assertEq(anc.kBps, 5000);
                (, bool arb2,,) = hook.quoteFee(pkey, !arbZ);
                assertTrue(arb2, "toward per MODEL2's mid from the next block");
                return;
            }
        }
        revert("no receipt");
    }

    /// FIXED N-07: if the first touch of a block finds the mid stale, a fresh attestation later in that block
    /// un-stales the anchor: the rest of the block is priced by the law under the new attestation, floored at
    /// conservativeFee (what the block already charged). A dust front-run no longer caps the arb at 5000.
    function test_r2_A03_staleDust_freshAttestationUnstales_fixed() public {
        _postGap(300);
        vm.roll(vm.getBlockNumber() + 6); // > staleBlocks
        _swapIn(true, 1e6); // dust front-run: anchor is stale for this block
        (uint24 q0,,, bool s0) = hook.quoteFee(pkey, true);
        assertTrue(s0);
        assertEq(q0, 5000);
        _postGap(300); // keeper's fresh attestation lands, 3% gap
        bool arbZ = _poolX96(pid) > _mid();
        (uint24 q, bool arb,, bool stale) = hook.quoteFee(pkey, arbZ);
        assertFalse(stale);
        assertTrue(arb);
        assertEq(q, 10000, "arb pays the law (feeMax) for the rest of the block");
        (uint24 qo, bool arbo,,) = hook.quoteFee(pkey, !arbZ);
        assertFalse(arbo);
        assertEq(qo, 5000, "non-arb direction floored at conservativeFee (never below the block's locked fee)");
        vm.recordLogs();
        _swapIn(arbZ, 1e6);
        (, bool rArb,,, uint24 rFee,,, bool rStale) = _lastReceipt(vm.getRecordedLogs());
        assertTrue(rArb && !rStale);
        assertEq(rFee, 10000);
        (, OniblockHook.Anchor memory anc,) = hook.poolState(pid);
        assertEq(anc.modelNode, MODEL, "receipt credited to the fresh attestation's model");
        vm.roll(vm.getBlockNumber() + 1);
        (qo,,,) = hook.quoteFee(pkey, !arbZ);
        assertEq(qo, 3000, "floor only for the un-staled block");
    }

    /// INFO N-10: two attestations in one block (block-1 then block) apply two k steps in one block.
    function test_r2_A04_twoAttestationsOneBlock_doubleStep() public {
        uint256 mid = _poolX96(pid);
        vm.roll(vm.getBlockNumber() + 1);
        uint64 bn = uint64(vm.getBlockNumber());
        _postAsAt(MODEL, bn - 1, mid, 10000, 10000);
        _postAsAt(MODEL, bn, mid, 10000, 10000);
        assertEq(_k(), 7000, "5000 -> 7000 within one block (maxKStep 1000)");
    }

    // ================================================================== timelock

    function _tlHook() internal returns (OniblockHook h, PoolId id) {
        h = _deployHook(1 hours);
        PoolKey memory k = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, TICK_SPACING, IHooks(address(h)));
        id = k.toId();
        h.registerPool(k, defaultConfig());
        manager.initialize(k, _sqrtAtUsd(USD_E8));
    }

    /// FIXED N-08: queued changes expire TIMELOCK_GRACE after their eta. A year-old entry re-queues (fresh
    /// ChangeQueued + full delay) instead of executing.
    function test_r2_T01_queuedChangeExpires_fixed() public {
        (OniblockHook h, PoolId id) = _tlHook();
        OniblockHook.PoolConfig memory evil = defaultConfig();
        evil.baseFee = 100_000;
        evil.feeMax = 100_000;
        evil.conservativeFee = 100_000;
        OniblockHook.PoolConfig memory nice = defaultConfig();
        nice.baseFee = 2500;
        h.updatePoolConfig(id, evil); // queued, then "forgotten"
        h.updatePoolConfig(id, nice); // queued too
        vm.warp(vm.getBlockTimestamp() + 2 hours);
        h.updatePoolConfig(id, nice); // executes
        assertEq(h.poolConfig(id).baseFee, 2500);
        vm.warp(vm.getBlockTimestamp() + 365 days); // a year later
        h.updatePoolConfig(id, evil); // expired => re-queued, not executed
        assertEq(h.poolConfig(id).baseFee, 2500, "expired entry did not execute");
        bytes32 q = keccak256(abi.encodeCall(OniblockHook.updatePoolConfig, (id, evil)));
        assertEq(h.queuedEta(q), vm.getBlockTimestamp() + 1 hours, "fresh notice, full delay");
        // boundary: executable up to eta + grace, re-queued after
        vm.warp(h.queuedEta(q) + h.TIMELOCK_GRACE());
        h.updatePoolConfig(id, evil);
        assertEq(h.poolConfig(id).baseFee, 100_000, "executes inside the grace window");
        h.updatePoolConfig(id, nice); // queue
        vm.warp(vm.getBlockTimestamp() + 1 hours + h.TIMELOCK_GRACE() + 1);
        h.updatePoolConfig(id, nice);
        assertEq(h.poolConfig(id).baseFee, 100_000, "one second past the grace window: re-queued");
    }

    /// VERIFY: a queued change cannot be executed with different params (different params => new queue entry);
    /// executed changes cannot be replayed (the identical call re-queues).
    function test_r2_T02_paramsBoundAndNoReplay() public {
        (OniblockHook h, PoolId id) = _tlHook();
        OniblockHook.PoolConfig memory a = defaultConfig();
        a.baseFee = 2000;
        OniblockHook.PoolConfig memory b = defaultConfig();
        b.baseFee = 9000;
        h.updatePoolConfig(id, a);
        vm.warp(vm.getBlockTimestamp() + 2 hours);
        h.updatePoolConfig(id, b); // queues b, does not execute
        assertEq(h.poolConfig(id).baseFee, 3000);
        h.updatePoolConfig(id, a);
        assertEq(h.poolConfig(id).baseFee, 2000);
        vm.warp(vm.getBlockTimestamp() + 2 hours);
        h.updatePoolConfig(id, a); // re-queues
        bytes32 qa = keccak256(abi.encodeCall(OniblockHook.updatePoolConfig, (id, a)));
        assertGt(h.queuedEta(qa), vm.getBlockTimestamp());
    }

    /// INFO N-09: the queue id is keccak256(msg.data), so the same logical call with trailing bytes is a separate
    /// entry; cancelling the canonical id leaves the variant live. Watchers must track every ChangeQueued payload.
    function test_r2_T03_nonCanonicalCalldataSeparateEntry() public {
        (OniblockHook h,) = _tlHook();
        bytes memory canon = abi.encodeCall(OniblockHook.setAttestor, (quoter));
        bytes memory variant = abi.encodePacked(canon, bytes32(uint256(1)));
        (bool ok1,) = address(h).call(canon);
        (bool ok2,) = address(h).call(variant);
        assertTrue(ok1 && ok2);
        h.cancelQueued(keccak256(canon));
        vm.warp(vm.getBlockTimestamp() + 2 hours);
        (bool ok3,) = address(h).call(variant);
        assertTrue(ok3);
        assertEq(h.attestor(), quoter, "variant executed although the canonical entry was cancelled");
    }

    /// DOCUMENTED (N-09): entries survive an ownership transfer (not bound to the proposer); the new owner should
    /// cancel entries it does not endorse (each entry also expires TIMELOCK_GRACE after its eta).
    function test_r2_T04_queueSurvivesOwnershipTransfer() public {
        (OniblockHook h,) = _tlHook();
        h.setAttestor(quoter);
        address safe = makeAddr("safe");
        h.transferOwnership(safe);
        vm.prank(safe);
        h.acceptOwnership();
        vm.warp(vm.getBlockTimestamp() + 2 hours);
        vm.prank(safe);
        h.setAttestor(quoter);
        assertEq(h.attestor(), quoter);
    }

    /// INFO: executing a config update mid-block deletes the anchor, so fees locked by earlier swaps can fall.
    function test_r2_T05_configUpdateMidBlockResetsHighWater() public {
        _postGap(100);
        vm.roll(vm.getBlockNumber() + 1);
        bool arbZ = _poolX96(pid) > _mid();
        _swapIn(arbZ, 50e18 * (wethIs0 == arbZ ? 1 : 0) + 1e6); // closes part of the gap
        (uint24 q0,,,) = hook.quoteFee(pkey, arbZ);
        hook.updatePoolConfig(pid, defaultConfig()); // identical config, delay 0
        (uint24 q1,,,) = hook.quoteFee(pkey, arbZ);
        assertLe(q1, q0);
    }

    // ================================================================== gas

    function test_r2_gas_highWaterPaths() public {
        _postGap(50);
        router.swap(pkey, false, -1e6, 0, address(this));
        vm.roll(vm.getBlockNumber() + 1);
        _postGap(50);
        bool arbZ = _poolX96(pid) > _mid();
        uint256 g = gasleft();
        _swapIn(arbZ, arbZ == wethIs0 ? 1e15 : 1e6);
        emit log_named_uint("first-in-block (anchor create, 2 slots)", g - gasleft());
        g = gasleft();
        _swapIn(arbZ, arbZ == wethIs0 ? 1e15 : 1e6);
        emit log_named_uint("later, no high-water change", g - gasleft());
        _swapIn(!arbZ, !arbZ == wethIs0 ? 5e18 : 20_000e6); // big away move
        g = gasleft();
        _swapIn(arbZ, arbZ == wethIs0 ? 1e15 : 1e6);
        emit log_named_uint("later, high-water raise (1 SSTORE)", g - gasleft());
        g = gasleft();
        hook.quoteFee(pkey, arbZ);
        emit log_named_uint("quoteFee view", g - gasleft());
    }
}
