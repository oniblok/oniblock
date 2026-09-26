// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Test.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {OniblockTestBase} from "../utils/OniblockTestBase.sol";
import {OniblockHook} from "../../src/OniblockHook.sol";
import {IRoleOracle} from "../../src/interfaces/IRoleOracle.sol";
import {MockAggregator} from "../../src/mocks/MockAggregator.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

/// Reviewer PoCs for docs/review/CONTRACT_REVIEW_1.md, updated to assert the FIXED behaviour
/// (docs/review/CONTRACT_FIXES_1.md). R-08 (parked-penalty redirect) is documented, not changed: its PoC still
/// reproduces and serves as a regression marker.
contract ReviewFindingsTest is OniblockTestBase {
    using StateLibrary for IPoolManager;

    bytes32 constant MODEL2 = keccak256("jev-v1-renamed.models.oniblock.eth");

    function _postAs(bytes32 model, uint256 mid, uint32 p, uint32 c) internal {
        OniblockHook.Attestation memory a =
            _attestation(pid, uint64(vm.getBlockNumber()), mid, p, c, model, attestorPk);
        vm.prank(quoter);
        hook.setAttestation(pkey, a);
    }

    function _k() internal view returns (uint32) {
        (OniblockHook.PoolState memory st,,) = hook.poolState(pid);
        return st.kBps;
    }

    function _receiptModel(Vm.Log[] memory logs) internal view returns (bytes32 model, uint32 k, uint32 gap) {
        for (uint256 i = logs.length; i > 0; i--) {
            Vm.Log memory l = logs[i - 1];
            if (l.emitter == address(hook) && l.topics[0] == OniblockHook.Receipt.selector) {
                (,, gap, k,,,, model,) =
                    abi.decode(l.data, (bool, bool, uint32, uint32, uint24, int128, int128, bytes32, bool));
                return (model, k, gap);
            }
        }
    }

    function _allowAndSeason(bytes32 model, uint32 brier) internal {
        hook.setModelAllowed(pid, model, true);
        _season(model, brier);
    }

    // ------------------------------------------------------------------------------------------------ R-01 (High)
    /// FIXED: rotating to a fresh modelNode no longer escapes demotion — a non-allowlisted node is rejected.
    function test_fix_R01_rotationToNewNode_rejected() public {
        uint256 mid = _poolX96(pid);
        vm.prank(settler);
        hook.setCalibration(MODEL, 9000, 1000, 500); // terrible model, well calibrated sample
        assertTrue(hook.isDemoted(pid, MODEL));
        _postAs(MODEL, mid, 10000, 10000);
        assertEq(_k(), 5000, "demoted => kDefault");

        assertTrue(hook.isDemoted(pid, MODEL2), "not allowlisted => no power");
        assertEq(hook.kFromScore(pid, 10000, 10000, MODEL2), 5000);
        vm.roll(vm.getBlockNumber() + 1);
        OniblockHook.Attestation memory a =
            _attestation(pid, uint64(vm.getBlockNumber()), mid, 10000, 10000, MODEL2, attestorPk);
        vm.prank(quoter);
        vm.expectRevert(OniblockHook.ModelNotAllowed.selector);
        hook.setAttestation(pkey, a);
        assertEq(_k(), 5000);
    }

    /// FIXED: an allowlisted but unseasoned node (n < minSamples) is capped at kDefault, even with a great Brier.
    function test_fix_R01_allowedButUnseasoned_cappedAtKDefault() public {
        uint256 mid = _poolX96(pid);
        hook.setModelAllowed(pid, MODEL2, true);
        vm.prank(settler);
        hook.setCalibration(MODEL2, 100, 9000, MIN_SAMPLES - 1); // excellent but too few samples
        assertTrue(hook.isDemoted(pid, MODEL2));
        for (uint256 i; i < 4; i++) {
            _postAs(MODEL2, mid, 10000, 10000);
            assertEq(_k(), 5000, "unseasoned => kDefault");
            vm.roll(vm.getBlockNumber() + 1);
        }
    }

    /// FIXED: once seasoned with a good Brier, the node reaches the computed (step-limited) k.
    function test_fix_R01_seasonedGoodModel_reachesComputedK() public {
        uint256 mid = _poolX96(pid);
        _allowAndSeason(MODEL2, 1200);
        assertFalse(hook.isDemoted(pid, MODEL2));
        assertEq(hook.kFromScore(pid, 10000, 10000, MODEL2), 8000);
        uint32[3] memory expected = [uint32(6000), 7000, 8000];
        for (uint256 i; i < 3; i++) {
            _postAs(MODEL2, mid, 10000, 10000);
            assertEq(_k(), expected[i]);
            vm.roll(vm.getBlockNumber() + 1);
        }
    }

    /// FIXED: a demoted model stays demoted — also if the settler resets its record (n = 0 => unseasoned) and the
    /// operator switches to another allowlisted-but-unseasoned node.
    function test_fix_R01_demotedStaysDemoted() public {
        uint256 mid = _poolX96(pid);
        for (uint256 i; i < 2; i++) {
            _postAs(MODEL, mid, 10000, 10000);
            vm.roll(vm.getBlockNumber() + 1);
        }
        assertEq(_k(), 7000);
        _season(MODEL, 4000); // bad Brier
        _postAs(MODEL, mid, 10000, 10000);
        assertEq(_k(), 5000, "demotion immediate");
        vm.prank(settler);
        hook.setCalibration(MODEL, 0, 0, 0); // record wiped
        assertTrue(hook.isDemoted(pid, MODEL), "n = 0 < minSamples => still no power");
        hook.setModelAllowed(pid, MODEL2, true); // fresh node
        for (uint256 i; i < 3; i++) {
            vm.roll(vm.getBlockNumber() + 1);
            _postAs(i % 2 == 0 ? MODEL2 : MODEL, mid, 10000, 10000);
            assertEq(_k(), 5000);
        }
        // owner can also revoke a node outright
        hook.setModelAllowed(pid, MODEL2, false);
        vm.roll(vm.getBlockNumber() + 1);
        OniblockHook.Attestation memory a =
            _attestation(pid, uint64(vm.getBlockNumber()), mid, 10000, 10000, MODEL2, attestorPk);
        vm.prank(quoter);
        vm.expectRevert(OniblockHook.ModelNotAllowed.selector);
        hook.setAttestation(pkey, a);
    }

    function test_fix_R01_setModelAllowed_guards() public {
        vm.prank(quoter);
        vm.expectRevert();
        hook.setModelAllowed(pid, MODEL2, true);
        PoolId unknown = PoolId.wrap(bytes32(uint256(123)));
        vm.expectRevert(OniblockHook.PoolNotRegistered.selector);
        hook.setModelAllowed(unknown, MODEL2, true);
        vm.expectEmit(true, true, false, true, address(hook));
        emit OniblockHook.ModelAllowed(pid, MODEL2, true);
        hook.setModelAllowed(pid, MODEL2, true);
        assertTrue(hook.modelAllowed(pid, MODEL2));
    }

    // ------------------------------------------------------------------------------------------------ R-02 (Medium)
    /// FIXED: after an intra-block displacement away from the oracle, the reverse (now toward-oracle) swap is priced
    /// from the live gap against the stored mid; quote == executed; a split backrun cannot shrink it (high-water).
    function test_fix_R02_intraBlockDisplacement_backrunPaysLiveGap() public {
        _post(pkey, _poolX96(pid), 10000, 5000); // oracle == pool, k = 5000
        vm.roll(vm.getBlockNumber() + 1);

        _swapIn(true, 30e18); // first swap of the block pushes the pool well below the oracle
        uint256 px = _poolX96(pid);
        (OniblockHook.PoolState memory st,,) = hook.poolState(pid);
        uint256 liveGap = (st.oracleMidX96 - px) * 1e6 / st.oracleMidX96;
        assertGt(liveGap, 10_000, "pool now >1% below oracle");

        (uint24 feeNow, bool arbNow, uint32 gapNow,) = hook.quoteFee(pkey, false);
        assertTrue(arbNow, "backrun is classified as arb in the same block");
        assertApproxEqAbs(gapNow, liveGap, 1);
        uint256 expect = 3000 + uint256(gapNow) * 5000 / 10000;
        assertEq(feeNow, expect > 10000 ? 10000 : expect);

        // split backrun: every part pays the first part's fee (high-water), receipts carry the gap used
        vm.recordLogs();
        router.swapSplit(pkey, false, -int256(uint256(40_000e6)), 4, 0, address(this));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 seen;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(hook) || logs[i].topics[0] != OniblockHook.Receipt.selector) continue;
            (, bool arb, uint32 gap, uint32 k, uint24 fee,,,,) =
                abi.decode(logs[i].data, (bool, bool, uint32, uint32, uint24, int128, int128, bytes32, bool));
            assertTrue(arb);
            assertEq(fee, feeNow);
            assertEq(gap, gapNow);
            assertEq(k, 5000);
            seen++;
        }
        assertEq(seen, 4);
        // the original (anchored) direction still pays base: it was never toward the oracle this block
        (uint24 f0, bool a0,,) = hook.quoteFee(pkey, true);
        if (_poolX96(pid) < st.oracleMidX96) {
            assertFalse(a0);
            assertEq(f0, 3000);
        }
    }

    // ------------------------------------------------------------------------------------------------ R-03 (Medium)
    /// FIXED: the Receipt credits the model whose attestation (k) is in force in the block's anchor. A lower-k
    /// attestation by another model in the same block does not take over the anchor.
    function test_fix_R03_receiptModelNode_matchesAnchor() public {
        _allowAndSeason(MODEL2, 1000);
        uint256 mid = _poolX96(pid) * 99 / 100;
        _postAs(MODEL, mid, 10000, 10000); // k -> 6000 under MODEL
        uint64 attestBlockModel = uint64(vm.getBlockNumber());
        vm.roll(vm.getBlockNumber() + 1);

        _swapIn(true, 1e15); // anchor this block with MODEL's k = 6000
        _postAs(MODEL2, mid, 0, 0); // MODEL2 posts in the same block: k -> 5000 (next block)
        assertEq(_k(), 5000);

        vm.recordLogs();
        _swapIn(true, 1e15);
        (bytes32 model, uint32 k,) = _receiptModel(vm.getRecordedLogs());
        assertEq(model, MODEL, "receipt credits the anchored model");
        assertEq(k, 6000);
        (, OniblockHook.Anchor memory anc,) = hook.poolState(pid);
        assertEq(anc.modelNode, MODEL);
        assertEq(anc.attestBlock, attestBlockModel);
        assertEq(anc.kBps, 6000);

        // next block: MODEL2's attestation is in force
        vm.roll(vm.getBlockNumber() + 1);
        vm.recordLogs();
        _swapIn(true, 1e15);
        (model, k,) = _receiptModel(vm.getRecordedLogs());
        assertEq(model, MODEL2);
        assertEq(k, 5000);
    }

    /// FIXED: a higher-k attestation later in the same block takes over the anchor (monotone up) and is credited.
    function test_fix_R03_R05_higherKAttestationTakesOverAnchor() public {
        _allowAndSeason(MODEL2, 1000);
        uint256 mid = _poolX96(pid) * 99 / 100;
        _postAs(MODEL, mid, 0, 0); // k 5000 -> 4000
        vm.roll(vm.getBlockNumber() + 1);
        _swapIn(true, 1e15); // anchor: MODEL, k 4000
        (uint24 before,,,) = hook.quoteFee(pkey, true);
        _postAs(MODEL2, mid, 10000, 10000); // k 4000 -> 5000
        (uint24 afterFee,,,) = hook.quoteFee(pkey, true);
        assertGt(afterFee, before, "fee raised within the block");
        vm.recordLogs();
        _swapIn(true, 1e15);
        (bytes32 model, uint32 k,) = _receiptModel(vm.getRecordedLogs());
        assertEq(model, MODEL2);
        assertEq(k, 5000);
    }

    /// Stale receipts belong to no model.
    function test_fix_R03_staleReceipt_noModel() public {
        vm.recordLogs();
        _swapIn(true, 1e15);
        (bytes32 model,,) = _receiptModel(vm.getRecordedLogs());
        assertEq(model, bytes32(0));
    }

    // ------------------------------------------------------------------------------------------------ R-05 (Low)
    /// FIXED: a dust swap before the keeper's attestation no longer freezes the old mid: the new mid is used for the
    /// live gap and the arb pays base + k*gap in the same block.
    function test_fix_R05_dustSwapNoLongerFreezesOldMid() public {
        _post(pkey, _poolX96(pid), 10000, 5000); // gap 0
        vm.roll(vm.getBlockNumber() + 1);
        uint256 snap = vm.snapshotState();

        // (a) no dust: keeper posts first
        _post(pkey, _poolX96(pid) * 99 / 100, 10000, 5000);
        (uint24 feeHonest, bool arbHonest,,) = hook.quoteFee(pkey, true);
        assertTrue(arbHonest);
        assertGt(feeHonest, 3000);
        vm.revertToState(snap);

        // (b) dust swap lands first, then the keeper, then the arb: same fee as (a)
        _swapIn(false, 1);
        _post(pkey, _poolX96(pid) * 99 / 100, 10000, 5000);
        (uint24 feeDust, bool arbDust,,) = hook.quoteFee(pkey, true);
        assertTrue(arbDust);
        assertApproxEqAbs(feeDust, feeHonest, 1);
        vm.recordLogs();
        _swapIn(true, 1e15);
        (bool found,,,, uint24 fee,,,) = _lastReceipt(vm.getRecordedLogs());
        assertTrue(found);
        assertEq(fee, feeDust);
    }

    /// A later attestation can never LOWER the current block's fee (split resistance holds across attestations).
    function test_fix_R05_laterAttestationNeverLowersFee() public {
        uint256 px = _poolX96(pid);
        _post(pkey, px * 98 / 100, 10000, 10000); // k 6000, gap ~2%
        vm.roll(vm.getBlockNumber() + 1);
        _swapIn(true, 1e15);
        (uint24 f1,,,) = hook.quoteFee(pkey, true);
        _post(pkey, _poolX96(pid), 0, 0); // mid == pool, k target 2000 => 5000
        (uint24 f2, bool arb,,) = hook.quoteFee(pkey, true);
        assertTrue(arb);
        assertEq(f2, f1, "fee unchanged within the block");
    }

    // ------------------------------------------------------------------------------------------------ R-06 (Low)
    /// FIXED: updatePoolConfig clamps the stored k into the new bounds and clears the anchor.
    function test_fix_R06_updatePoolConfig_clampsK_clearsAnchor() public {
        uint256 mid = _poolX96(pid);
        for (uint256 i; i < 3; i++) {
            _post(pkey, mid, 10000, 10000);
            vm.roll(vm.getBlockNumber() + 1);
        }
        assertEq(_k(), 8000);
        _post(pkey, mid * 99 / 100, 10000, 10000);
        _swapIn(true, 1e15); // anchor under the old config (feeMax 10000)
        OniblockHook.PoolConfig memory c = defaultConfig();
        c.kMinBps = 1000;
        c.kMaxBps = 3000;
        c.kDefaultBps = 2000;
        c.feeMax = 4000;
        c.conservativeFee = 4000;
        hook.updatePoolConfig(pid, c);
        assertEq(_k(), 3000, "clamped to the new kMax");
        (, OniblockHook.Anchor memory anc,) = hook.poolState(pid);
        assertEq(anc.kBps, 3000, "re-anchored under the new config");
        (uint24 fee,,,) = hook.quoteFee(pkey, true);
        assertLe(fee, 4000);
        c.kMinBps = 3500;
        c.kMaxBps = 9000;
        c.kDefaultBps = 5000;
        c.feeMax = 10000;
        c.conservativeFee = 5000;
        hook.updatePoolConfig(pid, c);
        assertEq(_k(), 3500, "clamped to the new kMin");
    }

    // ------------------------------------------------------------------------------------------------ R-07 (Low)
    /// FIXED: an older (block-1) attestation no longer burns the slot: a newer one replaces it in the same block.
    function test_fix_R07_newerAttestationReplacesOlder() public {
        address quoter2 = makeAddr("quoter2");
        roles.setQuoter(quoter2, true);
        uint256 bn = vm.getBlockNumber();
        OniblockHook.Attestation memory old = _attestation(pid, uint64(bn), _poolX96(pid), 0, 0, MODEL, attestorPk);
        vm.roll(bn + 1);
        uint256 freshMid = _poolX96(pid) * 99 / 100;
        OniblockHook.Attestation memory fresh =
            _attestation(pid, uint64(bn + 1), freshMid, 10000, 10000, MODEL, attestorPk);
        vm.prank(quoter2);
        hook.setAttestation(pkey, old);
        vm.prank(quoter);
        hook.setAttestation(pkey, fresh);
        (OniblockHook.PoolState memory st,,) = hook.poolState(pid);
        assertEq(st.lastAttestBlock, bn + 1);
        assertEq(st.oracleMidX96, freshMid);
        // the old one cannot come back
        vm.prank(quoter2);
        vm.expectRevert(OniblockHook.AlreadyAttested.selector);
        hook.setAttestation(pkey, old);
    }

    // ------------------------------------------------------------------------------------------------ R-04
    function _timelockedHook() internal returns (OniblockHook h, PoolKey memory k, PoolId id) {
        h = _deployHook(1 hours);
        k = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, TICK_SPACING, IHooks(address(h)));
        id = k.toId();
        h.registerPool(k, defaultConfig());
        manager.initialize(k, _sqrtAtUsd(USD_E8));
    }

    /// FIXED: owner config / attestor / oracle changes are queued and only execute after configDelay.
    function test_fix_R04_timelock_queueExecuteCancel() public {
        (OniblockHook h,, PoolId id) = _timelockedHook();
        assertEq(h.configDelay(), 1 hours);
        OniblockHook.PoolConfig memory c = defaultConfig();
        c.baseFee = 10000;

        // queue
        bytes32 qid = keccak256(abi.encodeCall(OniblockHook.updatePoolConfig, (id, c)));
        vm.expectEmit(true, false, false, false, address(h));
        emit OniblockHook.ChangeQueued(qid, 0, "");
        h.updatePoolConfig(id, c);
        assertEq(h.poolConfig(id).baseFee, 3000, "not applied yet");
        uint256 t0 = vm.getBlockTimestamp();
        assertEq(h.queuedEta(qid), t0 + 1 hours);
        // too early
        vm.warp(t0 + 30 minutes);
        vm.expectRevert(abi.encodeWithSelector(OniblockHook.TimelockNotReady.selector, h.queuedEta(qid)));
        h.updatePoolConfig(id, c);
        // execute
        vm.warp(t0 + 1 hours);
        h.updatePoolConfig(id, c);
        assertEq(h.poolConfig(id).baseFee, 10000);
        assertEq(h.queuedEta(qid), 0);

        // attestor: queue then cancel
        h.setAttestor(quoter);
        bytes32 aid = keccak256(abi.encodeCall(OniblockHook.setAttestor, (quoter)));
        assertGt(h.queuedEta(aid), 0);
        h.cancelQueued(aid);
        vm.warp(t0 + 3 hours);
        h.setAttestor(quoter); // re-queues instead of executing
        assertEq(h.attestor(), attestor);
        vm.warp(t0 + 4 hours);
        h.setAttestor(quoter);
        assertEq(h.attestor(), quoter);

        // role oracle
        h.setRoleOracle(IRoleOracle(address(0xB0B)));
        assertEq(address(h.roleOracle()), address(roles));
        vm.warp(t0 + 5 hours);
        h.setRoleOracle(IRoleOracle(address(0xB0B)));
        assertEq(address(h.roleOracle()), address(0xB0B));

        // only owner
        vm.prank(quoter);
        vm.expectRevert();
        h.cancelQueued(aid);
    }

    // ------------------------------------------------------------------------------------------------ R-10
    function test_fix_R10_chainlinkMaxAgeConfig_andStrictDecimals() public {
        MockAggregator feed = new MockAggregator(8, int256(USD_E8));
        OniblockHook.PoolConfig memory c = defaultConfig();
        c.chainlinkFeed = address(feed);
        c.chainlinkInverted = !wethIs0;
        c.sanityBandBps = 200;
        c.chainlinkMaxAge = 0;
        vm.expectRevert(OniblockHook.InvalidConfig.selector);
        hook.updatePoolConfig(pid, c);
        c.chainlinkMaxAge = 2 hours;
        hook.updatePoolConfig(pid, c);
        uint256 t0 = vm.getBlockTimestamp();
        vm.warp(t0 + 2 hours);
        (bool ok,) = hook.chainlinkPriceX96(pid);
        assertTrue(ok, "within max age");
        vm.warp(t0 + 2 hours + 1);
        (ok,) = hook.chainlinkPriceX96(pid);
        assertFalse(ok, "older than 2h");

        // strict decimals: a token without decimals() is rejected when a feed is configured
        address noDecimals = address(roles); // a contract with no decimals()
        (Currency a, Currency b) = noDecimals < address(usdc)
            ? (Currency.wrap(noDecimals), Currency.wrap(address(usdc)))
            : (Currency.wrap(address(usdc)), Currency.wrap(noDecimals));
        PoolKey memory k = PoolKey(a, b, LPFeeLibrary.DYNAMIC_FEE_FLAG, TICK_SPACING, IHooks(address(hook)));
        vm.expectRevert(OniblockHook.InvalidConfig.selector);
        hook.registerPool(k, c);
        hook.registerPool(k, defaultConfig()); // no feed => 18-decimals fallback is harmless
    }

    // ------------------------------------------------------------------------------------------------ R-08 (Low)
    /// Parked penalty goes to whoever is in range at the next swap. A JIT who also holds an old out-of-range
    /// position can exit as the only in-range LP, then move the price into its own old position and collect the
    /// whole parked penalty (the OZ original would revert the exit instead).
    /// NOT CHANGED (documented, R-08): still reproduces.
    function test_poc_R08_parkedPenaltyRedirectedToOwnOldPosition() public {
        PoolKey memory k = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 10, IHooks(address(hook)));
        PoolId id = k.toId();
        hook.registerPool(k, defaultConfig());
        manager.initialize(k, _sqrtAtUsd(USD_E8));
        (, int24 tick,,) = manager.getSlot0(id);
        tick = (tick / 10) * 10;
        // old secondary position just ABOVE the current price (out of range), aged past the window
        modifyLiquidityRouter.modifyLiquidity(k, ModifyLiquidityParams(tick + 200, tick + 400, 1e15, bytes32(uint256(9))), "");
        vm.roll(vm.getBlockNumber() + JIT_OFFSET + 1);
        // JIT: the only in-range liquidity
        modifyLiquidityRouter.modifyLiquidity(k, ModifyLiquidityParams(tick - 100, tick + 100, 1e17, 0), "");
        router.swap(k, true, -1e16, 0, address(this)); // fees accrue in token0 to JIT only
        modifyLiquidityRouter.modifyLiquidity(k, ModifyLiquidityParams(tick - 100, tick + 100, -1e17, 0), "");
        uint256 p0 = hook.pendingPenalty0(id);
        assertGt(p0, 0, "parked");

        // move price up into the old secondary position -> afterSwap flushes the penalty to it
        (uint256 g0,) = manager.getFeeGrowthGlobals(id);
        router.swap(k, false, -1e12, TickMath.getSqrtPriceAtTick(tick + 300), address(this));
        (uint256 h0,) = manager.getFeeGrowthGlobals(id);
        assertEq(hook.pendingPenalty0(id), 0);
        assertApproxEqAbs(_feesFromGrowth(g0, h0, 1e15), p0, 2, "entire penalty to the attacker's own position");
    }

    // ------------------------------------------------------------------------------------------------ fuzz
    uint256 internal _swappedBlock;
    uint24[2] internal _monoFee;

    /// Fees locked in by executed swaps never fall within a block: after a swap in direction d executed at fee f,
    /// every later quote for d in the same block (absent a config change) is >= f. (Pure quotes before a swap are
    /// not binding: a newer mid may legitimately lower them.)
    function _firstReceipt(Vm.Log[] memory logs)
        internal
        view
        returns (bool found, bool arb, uint32 gap, uint32 k, uint24 fee, bool stale)
    {
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(hook) || logs[i].topics[0] != OniblockHook.Receipt.selector) continue;
            (, arb, gap, k, fee,,,, stale) =
                abi.decode(logs[i].data, (bool, bool, uint32, uint32, uint24, int128, int128, bytes32, bool));
            return (true, arb, gap, k, fee, stale);
        }
    }

    /// Since CONTRACT_FIXES_2 (N-01) the only allowed drop is to the non-arbitrage fee (baseFee, or conservativeFee
    /// in a block un-staled by a same-block attestation) when the live price is at/past the mid for that direction.
    function _checkMonotone() internal {
        if (_swappedBlock != vm.getBlockNumber()) return;
        OniblockHook.PoolConfig memory c = hook.poolConfig(pid);
        for (uint256 d; d < 2; d++) {
            (uint24 q, bool arb,, bool stale) = hook.quoteFee(pkey, d == 0);
            if (!arb && !stale) {
                assertTrue(q == c.baseFee || q == c.conservativeFee, "non-arb quote is base (or floor)");
                continue;
            }
            assertGe(q, _monoFee[d], "locked-in fee fell within a block");
        }
    }

    /// Swap path never reverts, quoteFee == executed fee, every Receipt obeys the fee law with the (gap, k) it
    /// reports, and fees never fall within a block — across random interleavings of: attestations (any mid, either
    /// model, same-block-after-swap, block-1 then newer same-block replacements), rolls, config updates, calibration
    /// changes (seasoned / unseasoned / demoted), allowlist toggles, JIT add/remove, split swaps in both directions.
    function testFuzz_review_swapPathNeverReverts_quoteMatches(uint256 seed) public {
        hook.setModelAllowed(pid, MODEL2, true);
        for (uint256 step; step < 16; step++) {
            uint256 r = uint256(keccak256(abi.encode(seed, step)));
            uint256 op = r % 8;
            if (op == 0) {
                (OniblockHook.PoolState memory st,,) = hook.poolState(pid);
                uint256 bn = vm.getBlockNumber();
                uint64 ab = (r >> 4) % 3 == 0 ? uint64(bn - 1) : uint64(bn);
                bytes32 model = (r >> 40) % 2 == 0 ? MODEL : MODEL2;
                if (ab > st.lastAttestBlock && hook.modelAllowed(pid, model)) {
                    uint256 mid = (r >> 8) % 4 == 0
                        ? bound(r >> 16, 1, (1 << 224) - 1)
                        : _poolX96(pid) * (9800 + ((r >> 16) % 400)) / 10000 + 1;
                    OniblockHook.Attestation memory a = _attestation(
                        pid, ab, mid, uint32((r >> 48) % 10001), uint32((r >> 64) % 10001), model, attestorPk
                    );
                    vm.prank(quoter);
                    hook.setAttestation(pkey, a);
                }
            } else if (op == 1) {
                vm.roll(vm.getBlockNumber() + 1 + ((r >> 8) % 7));
            } else if (op == 2) {
                OniblockHook.PoolConfig memory c = defaultConfig();
                c.feeMax = uint24(bound(r >> 8, 0, 100_000));
                c.baseFee = uint24(bound(r >> 32, 0, c.feeMax));
                c.conservativeFee = uint24(bound(r >> 56, 0, c.feeMax));
                c.kMaxBps = uint32(bound(r >> 80, 0, 9999));
                c.kMinBps = uint32(bound(r >> 96, 0, c.kMaxBps));
                c.kDefaultBps = uint32(bound(r >> 112, c.kMinBps, c.kMaxBps));
                c.staleBlocks = uint16(bound(r >> 128, 1, 10));
                c.maxKStepBps = uint32(bound(r >> 144, 0, 10000));
                c.minSamples = uint32(bound(r >> 160, 1, 20)); // N-04: >= 1
                hook.updatePoolConfig(pid, c);
                (OniblockHook.PoolState memory st,,) = hook.poolState(pid);
                assertGe(st.kBps, c.kMinBps);
                assertLe(st.kBps, c.kMaxBps);
                _swappedBlock = 0; // config changes clear the anchor and may lower fees
            } else if (op == 3) {
                vm.prank(settler);
                hook.setCalibration(
                    (r >> 4) % 2 == 0 ? MODEL : MODEL2, uint32((r >> 8) % 10001), 0, uint32((r >> 24) % 21)
                );
            } else if (op == 4) {
                if ((r >> 8) % 3 == 0) hook.setModelAllowed(pid, MODEL2, (r >> 12) % 2 == 0);
                else _addLiq(pkey, int256(1e15 + (r >> 16) % 1e17), 42);
            } else if (op == 5) {
                bytes32 posKey = keccak256(abi.encodePacked(address(modifyLiquidityRouter), FULL_LOWER, FULL_UPPER, bytes32(uint256(42))));
                uint128 liq = manager.getPositionLiquidity(pid, posKey);
                if (liq > 0) _addLiq(pkey, -int256(uint256(liq)), 42);
            } else {
                bool z = (r >> 8) % 2 == 0;
                (uint24 q,,,) = hook.quoteFee(pkey, z);
                uint256 amt = z ? bound(r >> 16, 1, 5e18) : bound(r >> 16, 1, 1e10);
                vm.recordLogs();
                router.swapSplit(pkey, z, -int256(amt), 1 + (r >> 80) % 4, 0, address(this));
                // First Receipt of the (split) swap: later parts that start at/past the mid pay base (N-01).
                (bool found, bool arb, uint32 gap, uint32 k, uint24 fee, bool stale) = _firstReceipt(vm.getRecordedLogs());
                if (_swappedBlock != vm.getBlockNumber()) {
                    _swappedBlock = vm.getBlockNumber();
                    _monoFee[0] = 0;
                    _monoFee[1] = 0;
                }
                if (fee > _monoFee[z ? 0 : 1]) _monoFee[z ? 0 : 1] = fee;
                assertTrue(found);
                assertEq(fee, q, "quoteFee == executed");
                OniblockHook.PoolConfig memory c = hook.poolConfig(pid);
                if (stale) {
                    assertEq(fee, c.conservativeFee);
                } else {
                    uint256 f = uint256(c.baseFee) + uint256(gap) * k / 10000;
                    if (!arb) f = c.baseFee;
                    else if (f > c.feeMax) f = c.feeMax;
                    // N-07: conservativeFee floor in a block un-staled by a same-block attestation
                    assertTrue(fee == f || (fee == c.conservativeFee && c.conservativeFee > f), "fee law");
                }
            }
            _checkMonotone();
        }
    }
}
