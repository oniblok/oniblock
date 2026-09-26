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
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {OniblockTestBase} from "./utils/OniblockTestBase.sol";
import {OniblockHook} from "../src/OniblockHook.sol";

/// v5 "the AI decides the JIT window" (docs/review/V5_JIT_HEAD_SPEC.md §2): the attestation's pJitBps sets the
/// pool's JIT penalty window, window = min + (max - min) * pJit * c (default config: 10..100, default 10), gated
/// by the JIT head's own calibration record (jitCalibrationKey); positions are judged by the window in force when
/// their liquidity was added.
contract JitWindowTest is OniblockTestBase {
    using StateLibrary for IPoolManager;

    int256 constant JIT_LIQ = 2e17; // 4x the resident LP
    bytes32 constant OTHER = keccak256("heuristic-v1.models.oniblock.eth");

    // ------------------------------------------------------------------ helpers

    /// Settler seasons a model's JIT head (n = MIN_SAMPLES) with the given Brier.
    function _seasonJit(bytes32 model, uint32 brierBps) internal {
        bytes32 key = hook.jitCalibrationKey(model); // read first: a prank applies to the next external call
        vm.prank(settler);
        hook.setCalibration(key, brierBps, 6000, MIN_SAMPLES);
    }

    /// Post an attestation for this block at the current pool price with (pToxic = 1, confidence = c, pJit).
    function _postJit(uint32 pJit, uint32 c) internal {
        OniblockHook.Attestation memory a =
            _attestation(pid, uint64(vm.getBlockNumber()), _poolX96(pid), 10000, c, pJit, MODEL, attestorPk);
        vm.prank(quoter);
        hook.setAttestation(pkey, a);
    }

    function _next() internal {
        vm.roll(vm.getBlockNumber() + 1);
    }

    function _stored() internal view returns (uint16 window, uint32 pJit) {
        (OniblockHook.PoolState memory st,,) = hook.poolState(pid);
        return (st.jitWindow, st.pJitBps);
    }

    function _posKey(uint256 salt) internal view returns (bytes32) {
        return Position.calculatePositionKey(address(modifyLiquidityRouter), FULL_LOWER, FULL_UPPER, bytes32(salt));
    }

    /// Adds JIT liquidity (salt) now, swaps to accrue token0 fees, rolls `hold` blocks and removes it. Returns the
    /// fees the JIT position accrued and what its removal donated to the resident LP (0 = no penalty).
    function _cycle(uint256 salt, uint256 hold) internal returns (uint256 accrued, uint256 donated) {
        uint256 residentL = manager.getLiquidity(pid);
        _addLiq(pkey, JIT_LIQ, salt);
        (uint256 g0,) = _feeGrowth(pid);
        _swapIn(true, 10e18); // token0 in => fees in token0
        (uint256 h0,) = _feeGrowth(pid);
        accrued = _feesFromGrowth(g0, h0, uint256(JIT_LIQ));
        assertGt(accrued, 0);
        vm.roll(vm.getBlockNumber() + hold);
        (g0,) = _feeGrowth(pid);
        _addLiq(pkey, -JIT_LIQ, salt);
        (h0,) = _feeGrowth(pid);
        donated = _feesFromGrowth(g0, h0, residentL);
    }

    /// Last JitPenalty emitted by the hook.
    function _lastJitPenalty(Vm.Log[] memory logs)
        internal
        view
        returns (bool found, address sender, bytes32 posKey, uint48 addedBlock, uint16 window, uint256 p0, uint256 p1)
    {
        bytes32 sig = OniblockHook.JitPenalty.selector;
        for (uint256 i = logs.length; i > 0; i--) {
            Vm.Log memory l = logs[i - 1];
            if (l.emitter == address(hook) && l.topics[0] == sig) {
                assertEq(l.topics[1], PoolId.unwrap(pid));
                sender = address(uint160(uint256(l.topics[2])));
                (posKey, addedBlock, window, p0, p1) = abi.decode(l.data, (bytes32, uint48, uint16, uint256, uint256));
                return (true, sender, posKey, addedBlock, window, p0, p1);
            }
        }
    }

    // ------------------------------------------------------------------ calibration key / demotion

    function test_jitCalibrationKey_matchesFormula() public view {
        assertEq(hook.jitCalibrationKey(MODEL), keccak256(abi.encodePacked(MODEL, keccak256("jit"))));
        assertTrue(hook.jitCalibrationKey(MODEL) != MODEL, "JIT record is separate from the arb record");
    }

    function test_jitDemotion_unseasoned_brier_allowlist() public {
        // setUp seasons MODEL's arb head only: the JIT head is unseasoned (n = 0 < minSamples)
        assertFalse(hook.isDemoted(pid, MODEL));
        assertTrue(hook.isJitDemoted(pid, MODEL), "unseasoned JIT head");
        _seasonJit(MODEL, 1000);
        assertFalse(hook.isJitDemoted(pid, MODEL), "seasoned, good Brier");
        _seasonJit(MODEL, 4000); // Brier 0.40 > 0.25
        assertTrue(hook.isJitDemoted(pid, MODEL), "Brier demotion");
        // parent not allowlisted => demoted even with a perfect JIT record
        _seasonJit(OTHER, 0);
        assertTrue(hook.isJitDemoted(pid, OTHER));
        hook.setModelAllowed(pid, OTHER, true);
        assertFalse(hook.isJitDemoted(pid, OTHER));
        hook.setModelAllowed(pid, OTHER, false);
        assertTrue(hook.isJitDemoted(pid, OTHER));
    }

    // ------------------------------------------------------------------ jitWindowFromScore / setAttestation

    function test_windowFromScore_formula_and_defaults() public {
        _seasonJit(MODEL, 1000);
        assertEq(hook.jitWindowFromScore(pid, 0, 10000, MODEL), 10, "p = 0 => min");
        assertEq(hook.jitWindowFromScore(pid, 10000, 10000, MODEL), 100, "p = c = 1 => max");
        assertEq(hook.jitWindowFromScore(pid, 5000, 8000, MODEL), 46, "10 + 90 * 0.5 * 0.8");
        assertEq(hook.jitWindowFromScore(pid, 10000, 3334, MODEL), 40);
        assertEq(hook.jitWindowFromScore(pid, 20000, 20000, MODEL), 100, "inputs clamped to BPS");
        // demoted / unseasoned / not allowlisted => default (10 here, distinct from min only by config)
        assertEq(hook.jitWindowFromScore(pid, 10000, 10000, OTHER), 10, "parent not allowlisted => default");
        _seasonJit(MODEL, 4000);
        assertEq(hook.jitWindowFromScore(pid, 10000, 10000, MODEL), 10, "demoted => default");
    }

    function test_attestation_setsWindow_andEvent() public {
        _seasonJit(MODEL, 1000);
        (uint16 w0, uint32 p0) = _stored();
        assertEq(w0, 10, "pool starts at jitWindowDefault");
        assertEq(p0, 0);

        uint256 mid = _poolX96(pid);
        uint64 bn = uint64(vm.getBlockNumber());
        OniblockHook.Attestation memory a = _attestation(pid, bn, mid, 10000, 8000, 5000, MODEL, attestorPk);
        vm.expectEmit(true, true, true, true, address(hook));
        emit OniblockHook.AttestationPosted(pid, bn, mid, 10000, 8000, 6000, MODEL, quoter, 5000, 46);
        vm.prank(quoter);
        hook.setAttestation(pkey, a);
        (uint16 w1, uint32 p1) = _stored();
        assertEq(w1, 46);
        assertEq(p1, 5000);

        // not step-limited: 46 -> 100 -> 10 in consecutive blocks
        _next();
        _postJit(10000, 10000);
        (uint16 w2,) = _stored();
        assertEq(w2, 100);
        _next();
        _postJit(0, 10000);
        (uint16 w3,) = _stored();
        assertEq(w3, 10);
    }

    function test_attestation_unseasonedOrDemotedJitHead_default() public {
        _postJit(10000, 10000); // JIT head never seasoned
        (uint16 w,) = _stored();
        assertEq(w, 10, "unseasoned JIT head => default");
        _next();
        _seasonJit(MODEL, 4000); // demoted
        _postJit(10000, 10000);
        (w,) = _stored();
        assertEq(w, 10, "demoted JIT head => default");
    }

    /// The two heads are gated independently: a demoted arb head keeps k at kDefault while a seasoned JIT head
    /// still sets the window, and vice versa.
    function test_headsAreIndependent() public {
        _seasonJit(MODEL, 1000);
        _season(MODEL, 4000); // arb head demoted
        _postJit(10000, 10000);
        (OniblockHook.PoolState memory st,,) = hook.poolState(pid);
        assertEq(st.kBps, 5000, "arb head demoted => kDefault");
        assertEq(st.jitWindow, 100, "JIT head seasoned => formula");
    }

    function test_pJitAboveBps_reverts() public {
        OniblockHook.Attestation memory a =
            _attestation(pid, uint64(vm.getBlockNumber()), _poolX96(pid), 10000, 10000, 10001, MODEL, attestorPk);
        vm.prank(quoter);
        vm.expectRevert(OniblockHook.InvalidAttestation.selector);
        hook.setAttestation(pkey, a);
    }

    function test_digest_includesPJit() public {
        uint64 bn = uint64(vm.getBlockNumber());
        uint256 mid = _poolX96(pid);
        OniblockHook.Attestation memory a = _attestation(pid, bn, mid, 10000, 10000, 1000, MODEL, attestorPk);
        OniblockHook.Attestation memory b = _attestation(pid, bn, mid, 10000, 10000, 2000, MODEL, attestorPk);
        assertTrue(hook.attestationDigest(pid, a) != hook.attestationDigest(pid, b));
        b.signature = a.signature; // signed over pJit 1000, posted with 2000
        vm.prank(quoter);
        vm.expectRevert(OniblockHook.BadSignature.selector);
        hook.setAttestation(pkey, b);
        vm.prank(quoter);
        hook.setAttestation(pkey, a); // the genuine one is accepted
    }

    // ------------------------------------------------------------------ per-position window

    /// Under a 40-block window a JIT removed 11 blocks after adding (past the old 10-block wall) forfeits 29/40 of
    /// its fees; removed at +41 it keeps everything.
    function test_window40_removeAt11_penalised_at41_not() public {
        _seasonJit(MODEL, 1000);
        _postJit(10000, 3334); // 10 + 90 * 0.3334 = 40
        (uint16 w,) = _stored();
        assertEq(w, 40);
        uint48 added = uint48(vm.getBlockNumber());

        vm.recordLogs();
        (uint256 accrued, uint256 donated) = _cycle(1, 11);
        assertApproxEqRel(donated, accrued * 29 / 40, 1e15, "linear decay over the position's window");
        (bool found, address sender, bytes32 posKey, uint48 addedBlock, uint16 window, uint256 p0, uint256 p1) =
            _lastJitPenalty(vm.getRecordedLogs());
        assertTrue(found, "JitPenalty emitted");
        assertEq(sender, address(modifyLiquidityRouter));
        assertEq(posKey, _posKey(1));
        assertEq(addedBlock, added);
        assertEq(window, 40);
        assertApproxEqAbs(p0, donated, 2);
        assertEq(p1, 0);

        // fresh attestation (the previous one went stale during the hold), same window, held past it
        _next();
        _postJit(10000, 3334);
        vm.recordLogs();
        (accrued, donated) = _cycle(2, 41);
        assertEq(donated, 0, "held past the window: no penalty");
        (found,,,,,,) = _lastJitPenalty(vm.getRecordedLogs());
        assertFalse(found, "no JitPenalty");
    }

    /// Honest LP added under window 10 and removed at +15 is not penalised even though the window rose to 100.
    function test_windowAtAdd_laterRise_doesNotTrapEarlierLiquidity() public {
        _seasonJit(MODEL, 1000);
        _postJit(0, 10000); // window = min = 10
        uint256 residentL = manager.getLiquidity(pid);
        _addLiq(pkey, JIT_LIQ, 7);
        _swapIn(true, 10e18);

        _next();
        _postJit(10000, 10000); // window rises to 100 for liquidity added from now on
        (uint16 w,) = _stored();
        assertEq(w, 100);

        vm.roll(vm.getBlockNumber() + 14); // +15 since the add
        (uint256 g0,) = _feeGrowth(pid);
        vm.recordLogs();
        _addLiq(pkey, -JIT_LIQ, 7);
        (uint256 h0,) = _feeGrowth(pid);
        assertEq(_feesFromGrowth(g0, h0, residentL), 0, "judged by the 10-block window in force at add");
        (bool found,,,,,,) = _lastJitPenalty(vm.getRecordedLogs());
        assertFalse(found);
    }

    /// The mirror image: liquidity added under window 100 stays under it when the window later drops to 10.
    function test_windowAtAdd_laterDrop_doesNotFreeEarlierLiquidity() public {
        _seasonJit(MODEL, 1000);
        _postJit(10000, 10000); // 100
        uint256 residentL = manager.getLiquidity(pid);
        _addLiq(pkey, JIT_LIQ, 7);
        (uint256 g0,) = _feeGrowth(pid);
        _swapIn(true, 10e18);
        (uint256 h0,) = _feeGrowth(pid);
        uint256 accrued = _feesFromGrowth(g0, h0, uint256(JIT_LIQ));

        _next();
        _postJit(0, 10000); // 10 for new adds
        vm.roll(vm.getBlockNumber() + 49); // +50 since the add
        (g0,) = _feeGrowth(pid);
        vm.recordLogs();
        _addLiq(pkey, -JIT_LIQ, 7);
        (h0,) = _feeGrowth(pid);
        assertApproxEqRel(_feesFromGrowth(g0, h0, residentL), accrued / 2, 1e15, "50/100 of the fees forfeited");
        (bool found,,,, uint16 window,,) = _lastJitPenalty(vm.getRecordedLogs());
        assertTrue(found);
        assertEq(window, 100);
    }

    /// Re-adding inside a running window keeps the larger window (withholding the new fees, as in OZ); once the
    /// window has expired a re-add starts afresh under the window in force then.
    function test_reAdd_insideWindowKeepsLarger_afterExpiryStartsFresh() public {
        _seasonJit(MODEL, 1000);
        _postJit(10000, 10000); // 100
        uint256 residentL = manager.getLiquidity(pid);
        _addLiq(pkey, JIT_LIQ, 3);
        _swapIn(true, 10e18);

        vm.roll(vm.getBlockNumber() + 3);
        _postJit(0, 10000); // 10 for new adds
        _addLiq(pkey, 1e10, 3); // inside the 100 window: fees withheld, window stays 100
        BalanceDelta withheld = hook.getWithheldFees(pid, _posKey(3));
        assertGt(withheld.amount0(), 0, "re-add inside the window withholds fees");

        vm.roll(vm.getBlockNumber() + 47); // 50 since the last add
        vm.recordLogs();
        (uint256 g0,) = _feeGrowth(pid);
        _addLiq(pkey, -(JIT_LIQ + 1e10), 3);
        (uint256 h0,) = _feeGrowth(pid);
        assertGt(_feesFromGrowth(g0, h0, residentL), 0, "still penalised under the 100 window");
        (bool found,,,, uint16 window,,) = _lastJitPenalty(vm.getRecordedLogs());
        assertTrue(found);
        assertEq(window, 100, "the larger window is kept");

        // after the window has expired, the same position key re-added under 10 is a fresh 10-block position
        vm.roll(vm.getBlockNumber() + 100);
        _postJit(0, 10000);
        vm.recordLogs();
        (, uint256 donated) = _cycle(3, 15);
        assertEq(donated, 0, "fresh add under 10, removed at +15: no penalty");
        (found,,,,,,) = _lastJitPenalty(vm.getRecordedLogs());
        assertFalse(found);
    }

    /// With the attestation stale, liquidity added now is judged by jitWindowDefault (10), whatever was attested.
    function test_staleAttestation_addsUseDefault() public {
        _seasonJit(MODEL, 1000);
        _postJit(10000, 10000); // 100
        vm.roll(vm.getBlockNumber() + 6); // staleBlocks = 5 => stale
        (,, bool staleNow) = hook.poolState(pid);
        assertTrue(staleNow);
        vm.recordLogs();
        (, uint256 donated) = _cycle(4, 15);
        assertEq(donated, 0, "added under the default 10-block window: +15 is free");
        (bool found,,,,,,) = _lastJitPenalty(vm.getRecordedLogs());
        assertFalse(found);
    }

    /// Same-block add/remove under the default window still forfeits everything (the v4 behaviour is preserved
    /// when no JIT head is seasoned), and JitPenalty reports window = jitWindowDefault.
    function test_defaultWindow_sameBlock_forfeitsAll() public {
        vm.recordLogs();
        (uint256 accrued, uint256 donated) = _cycle(5, 0);
        assertApproxEqRel(donated, accrued, 1e15);
        (bool found,,,, uint16 window,,) = _lastJitPenalty(vm.getRecordedLogs());
        assertTrue(found);
        assertEq(window, 10);
    }

    /// The parked-penalty path (last in-range LP exits inside the window) also emits JitPenalty.
    function test_parkedPenalty_emitsJitPenalty() public {
        PoolKey memory k = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 10, IHooks(address(hook)));
        PoolId id = k.toId();
        hook.registerPool(k, defaultConfig());
        manager.initialize(k, _sqrtAtUsd(USD_E8));
        (OniblockHook.PoolState memory st,,) = hook.poolState(id);
        assertEq(st.jitWindow, 10, "init => jitWindowDefault");

        modifyLiquidityRouter.modifyLiquidity(k, ModifyLiquidityParams(-887270, 887270, JIT_LIQ, 0), "");
        router.swap(k, true, -1e18, 0, address(this));
        vm.recordLogs();
        modifyLiquidityRouter.modifyLiquidity(k, ModifyLiquidityParams(-887270, 887270, -JIT_LIQ, 0), "");
        assertGt(hook.pendingPenalty0(id), 0, "penalty parked");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool saw;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == OniblockHook.JitPenalty.selector) {
                assertEq(logs[i].topics[1], PoolId.unwrap(id));
                (,, uint16 window, uint256 p0,) = abi.decode(logs[i].data, (bytes32, uint48, uint16, uint256, uint256));
                assertEq(window, 10);
                assertEq(p0, hook.pendingPenalty0(id));
                saw = true;
            }
        }
        assertTrue(saw);
    }

    // ------------------------------------------------------------------ config

    function test_config_validation() public {
        PoolKey memory k = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 10, IHooks(address(hook)));
        OniblockHook.PoolConfig memory c = defaultConfig();
        c.jitWindowMin = 0;
        vm.expectRevert(OniblockHook.InvalidConfig.selector);
        hook.registerPool(k, c);
        c = defaultConfig();
        c.jitWindowMin = 20; // > default (10)
        vm.expectRevert(OniblockHook.InvalidConfig.selector);
        hook.registerPool(k, c);
        c = defaultConfig();
        c.jitWindowDefault = 200; // > max (100)
        vm.expectRevert(OniblockHook.InvalidConfig.selector);
        hook.registerPool(k, c);
        c = defaultConfig();
        c.jitWindowDefault = 200;
        vm.expectRevert(OniblockHook.InvalidConfig.selector);
        hook.updatePoolConfig(pid, c);
        // boundaries are fine: min == default == max
        c = defaultConfig();
        c.jitWindowMin = 25;
        c.jitWindowDefault = 25;
        c.jitWindowMax = 25;
        hook.registerPool(k, c);
        assertEq(hook.poolConfig(k.toId()).jitWindowMax, 25);
    }

    /// updatePoolConfig clamps the stored window into the new [min, max] (like k).
    function test_updatePoolConfig_clampsStoredWindow() public {
        _seasonJit(MODEL, 1000);
        _postJit(10000, 10000); // 100
        OniblockHook.PoolConfig memory c = defaultConfig();
        c.jitWindowMax = 50;
        hook.updatePoolConfig(pid, c); // delay 0 => immediate
        (uint16 w,) = _stored();
        assertEq(w, 50);
    }
}

