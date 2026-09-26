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
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {OniblockTestBase} from "./utils/OniblockTestBase.sol";
import {OniblockHook} from "../src/OniblockHook.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

contract OniblockHookTest is OniblockTestBase {
    using StateLibrary for IPoolManager;

    // ================================================================ allowlist & dynamic fee

    function test_permissions_matchSpec() public view {
        // HookMiner produced an address with exactly the merged permission set (BaseHook validates in ctor).
        assertEq(uint160(address(hook)) & 0x3FFF, HOOK_FLAGS);
    }

    function test_initialize_unregisteredPool_reverts() public {
        PoolKey memory k = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 10, IHooks(address(hook)));
        vm.expectRevert();
        manager.initialize(k, _sqrtAtUsd(USD_E8));
    }

    function test_initialize_staticFee_reverts() public {
        PoolKey memory k = PoolKey(currency0, currency1, 3000, TICK_SPACING, IHooks(address(hook)));
        vm.expectRevert(OniblockHook.NotDynamicFee.selector);
        hook.registerPool(k, defaultConfig());
        vm.expectRevert(); // wrapped NotDynamicFee from beforeInitialize
        manager.initialize(k, _sqrtAtUsd(USD_E8));
    }

    function test_registerPool_guards() public {
        PoolKey memory k = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 10, IHooks(address(hook)));
        vm.prank(quoter);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, quoter));
        hook.registerPool(k, defaultConfig());

        PoolKey memory wrong = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 10, IHooks(address(0xBEEF)));
        vm.expectRevert(OniblockHook.WrongHook.selector);
        hook.registerPool(wrong, defaultConfig());

        OniblockHook.PoolConfig memory c = defaultConfig();
        c.feeMax = 100_001;
        vm.expectRevert(OniblockHook.InvalidConfig.selector);
        hook.registerPool(k, c);
        c = defaultConfig();
        c.kMaxBps = 10000;
        vm.expectRevert(OniblockHook.InvalidConfig.selector);
        hook.registerPool(k, c);

        // already initialized pool cannot be re-registered
        vm.expectRevert(OniblockHook.PoolAlreadyInitialized.selector);
        hook.registerPool(pkey, defaultConfig());

        // registered + initialize works
        hook.registerPool(k, defaultConfig());
        manager.initialize(k, _sqrtAtUsd(USD_E8));
        (OniblockHook.PoolState memory st,,) = hook.poolState(k.toId());
        assertTrue(st.initialized);
        assertEq(st.kBps, 5000);
    }

    function test_overrideFlag_feeNotZero() public {
        (,,, uint24 lpFee) = manager.getSlot0(pid);
        assertEq(lpFee, 0, "dynamic pool stored fee is 0");
        vm.prank(address(manager));
        (,, uint24 ret) =
            hook.beforeSwap(address(this), pkey, SwapParams(true, -1e15, TickMath.MIN_SQRT_PRICE + 1), "");
        assertTrue(ret & LPFeeLibrary.OVERRIDE_FEE_FLAG != 0, "override flag");
        assertEq(ret & LPFeeLibrary.REMOVE_OVERRIDE_MASK, 5000, "stale -> conservative fee");
        // and fees actually accrue to LPs
        (uint256 g0, uint256 g1) = _feeGrowth(pid);
        _swapIn(true, 1e15);
        (uint256 h0, uint256 h1) = _feeGrowth(pid);
        assertGt(h0 + h1, g0 + g1);
    }

    function test_hooksOnlyCallableByManager() public {
        vm.expectRevert();
        hook.beforeSwap(address(this), pkey, SwapParams(true, -1e15, TickMath.MIN_SQRT_PRICE + 1), "");
    }

    // ================================================================ fee law

    function test_honestSwap_noGap_paysBase() public {
        _post(pkey, _poolX96(pid), 10000, 10000);
        (uint24 fee, bool arb, uint32 gap, bool stale) = hook.quoteFee(pkey, true);
        assertEq(gap, 0);
        assertFalse(arb);
        assertFalse(stale);
        assertEq(fee, 3000);
        vm.recordLogs();
        _swapIn(true, 1e15);
        (bool found,,,, uint24 f,,,) = _lastReceipt(vm.getRecordedLogs());
        assertTrue(found);
        assertEq(f, 3000);
    }

    function test_arbDirection_paysBasePlusKGap_reversePaysBase() public {
        // oracle 1% BELOW pool => pool too high => zeroForOne (selling token0) is the arb direction
        _postGap(-100);
        (uint24 fee, bool arb, uint32 gap,) = hook.quoteFee(pkey, true);
        assertTrue(arb);
        assertApproxEqAbs(gap, 10101, 2); // |p - 0.99p| / 0.99p
        assertEq(fee, 3000 + uint24(uint256(gap) * 5000 / 10000));
        (uint24 feeRev, bool arbRev,,) = hook.quoteFee(pkey, false);
        assertFalse(arbRev);
        assertEq(feeRev, 3000);

        // execute arb-direction swap and confirm LP fee revenue ~= amountIn * fee
        uint256 L = manager.getLiquidity(pid);
        (uint256 g0,) = _feeGrowth(pid);
        _swapIn(true, 1e15);
        (uint256 h0,) = _feeGrowth(pid);
        uint256 earned = _feesFromGrowth(g0, h0, L);
        assertApproxEqRel(earned, 1e15 * uint256(fee) / 1e6, 1e15); // 0.1%
    }

    function test_oracleAbovePool_oneForZeroIsArb() public {
        _postGap(200); // oracle 2% above => buying token0 (oneForZero) is arb
        (uint24 f1, bool a1, uint32 gap,) = hook.quoteFee(pkey, false);
        (uint24 f0, bool a0,,) = hook.quoteFee(pkey, true);
        assertTrue(a1);
        assertFalse(a0);
        assertEq(f0, 3000);
        assertApproxEqAbs(gap, 19607, 2);
        assertEq(f1, 10000); // 3000 + 20000*0.5 = 13000 -> capped at feeMax
    }

    function test_quoteFee_matchesExecutedFee() public {
        _postGap(-50);
        (uint24 q,,,) = hook.quoteFee(pkey, true);
        vm.recordLogs();
        BalanceDelta d = _swapIn(true, 3e15);
        (, bool arb, uint32 gap, uint32 k, uint24 fee, int128 a0, int128 a1, bool stale) =
            _lastReceipt(vm.getRecordedLogs());
        assertEq(fee, q);
        assertTrue(arb);
        assertEq(k, 5000);
        assertGt(gap, 0);
        assertFalse(stale);
        assertEq(a0, d.amount0());
        assertEq(a1, d.amount1());
    }

    function test_receipt_eventFields() public {
        _postGap(-100);
        (uint24 q, bool qa, uint32 qg, bool qs) = hook.quoteFee(pkey, true);
        vm.recordLogs();
        BalanceDelta d = _swapIn(true, 1e15);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(hook) || logs[i].topics[0] != OniblockHook.Receipt.selector) continue;
            seen = true;
            assertEq(logs[i].topics[1], PoolId.unwrap(pid));
            assertEq(uint256(logs[i].topics[2]), vm.getBlockNumber());
            assertEq(address(uint160(uint256(logs[i].topics[3]))), address(router));
            (bool z, bool arb, uint32 gap, uint32 k, uint24 fee, int128 a0, int128 a1, bytes32 model, bool stale) =
                abi.decode(logs[i].data, (bool, bool, uint32, uint32, uint24, int128, int128, bytes32, bool));
            assertTrue(z);
            assertEq(arb, qa);
            assertEq(gap, qg);
            assertEq(k, 5000);
            assertEq(fee, q);
            assertEq(a0, d.amount0());
            assertEq(a1, d.amount1());
            assertEq(model, MODEL);
            assertEq(stale, qs);
            assertLt(a0, 0); // swapper paid token0
            assertGt(a1, 0);
        }
        assertTrue(seen);
    }

    function test_emptyHookData_viaPoolSwapTest() public {
        _postGap(-100);
        (uint24 q,,,) = hook.quoteFee(pkey, true);
        vm.recordLogs();
        swapRouter.swap(
            pkey,
            SwapParams(true, -1e15, TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        (bool found,,,, uint24 fee,,,) = _lastReceipt(vm.getRecordedLogs());
        assertTrue(found);
        assertEq(fee, q);
    }

    // ================================================================ per-block anchor / split swaps

    function test_perBlockAnchor_splitSwapsDoNotReduceLpRevenue() public {
        _postGap(-100);
        uint256 L = manager.getLiquidity(pid);
        // Large enough to move the pool materially toward the oracle but NOT past it (~4 ETH closes the 1% gap):
        // since CONTRACT_FIXES_2 (N-01) flow that starts at/past the mid is not an arbitrage and pays baseFee,
        // so an overshooting one-shot (which pays the arb fee on its whole size) is not the right comparison.
        uint256 amt = 3e18;
        uint256 snap = vm.snapshotState();

        // (a) one swap
        (uint256 g0,) = _feeGrowth(pid);
        router.swap(pkey, true, -int256(amt), 0, address(this));
        (uint256 h0,) = _feeGrowth(pid);
        uint256 single = _feesFromGrowth(g0, h0, L);
        vm.revertToState(snap);

        // (b) 10 sub-swaps in ONE unlock, same block
        (g0,) = _feeGrowth(pid);
        router.swapSplit(pkey, true, -int256(amt), 10, 0, address(this));
        (h0,) = _feeGrowth(pid);
        uint256 split = _feesFromGrowth(g0, h0, L);
        vm.revertToState(snap);

        // (c) 10 sub-swaps in 10 separate txs, same block (anchor still applies)
        (g0,) = _feeGrowth(pid);
        for (uint256 i; i < 10; i++) {
            router.swap(pkey, true, -int256(amt / 10), 0, address(this));
        }
        (h0,) = _feeGrowth(pid);
        uint256 splitTxs = _feesFromGrowth(g0, h0, L);
        vm.revertToState(snap);

        // (d) control: the same 10 sub-swaps across 10 blocks (no anchor) => each sees a smaller gap
        (g0,) = _feeGrowth(pid);
        for (uint256 i; i < 3; i++) {
            router.swap(pkey, true, -int256(amt / 3), 0, address(this));
            vm.roll(vm.getBlockNumber() + 1);
        }
        (h0,) = _feeGrowth(pid);
        uint256 spread = _feesFromGrowth(g0, h0, L);

        emit log_named_uint("fees single", single);
        emit log_named_uint("fees split same unlock", split);
        emit log_named_uint("fees split same block txs", splitTxs);
        emit log_named_uint("fees spread over blocks", spread);
        assertApproxEqRel(split, single, 1e14);
        assertApproxEqRel(splitTxs, single, 1e14);
        assertGe(split + 10, single);
        assertLt(spread, single, "without the anchor the arb would pay less");
    }

    function test_anchor_sameDirKeepsAnchor_reverseAfterOvershootPricedLive() public {
        _postGap(-100);
        (uint24 arbFee,,,) = hook.quoteFee(pkey, true);
        (uint24 rev0, bool arbRev0,,) = hook.quoteFee(pkey, false);
        assertEq(rev0, 3000, "away from oracle => base");
        assertFalse(arbRev0);
        _swapIn(true, 20e18); // moves price toward the oracle and overshoots it (~-3.9% vs a -1% oracle)
        (uint24 again, bool arb,,) = hook.quoteFee(pkey, true);
        // N-01 (CONTRACT_FIXES_2): the live price is now PAST the mid for zeroForOne, so another zeroForOne swap
        // moves away from the oracle and pays baseFee despite the block's high-water mark.
        assertGt(arbFee, 3000);
        assertEq(again, 3000, "past the mid => not an arbitrage => base");
        assertFalse(arb);
        // the pool is now BELOW the oracle: oneForZero moves it back toward the oracle => priced from the live gap
        (OniblockHook.PoolState memory st,,) = hook.poolState(pid);
        uint256 px = _poolX96(pid);
        assertLt(px, st.oracleMidX96);
        uint256 liveGap = (st.oracleMidX96 - px) * 1e6 / st.oracleMidX96;
        (uint24 rev, bool arbRev, uint32 g,) = hook.quoteFee(pkey, false);
        assertTrue(arbRev);
        assertApproxEqAbs(g, liveGap, 1);
        uint256 expect = 3000 + uint256(g) * 5000 / 10000;
        assertEq(rev, expect > 10000 ? 10000 : expect);
        vm.roll(vm.getBlockNumber() + 1);
        (uint24 next,,,) = hook.quoteFee(pkey, true);
        assertLt(next, arbFee, "new block => fresh gap (zeroForOne now moves away from the oracle)");
    }

    // ================================================================ staleness

    function test_stale_noAttestation_conservativeFee() public {
        (uint24 fee, bool arb, uint32 gap, bool stale) = hook.quoteFee(pkey, true);
        assertEq(fee, 5000);
        assertFalse(arb);
        assertEq(gap, 0);
        assertTrue(stale);
    }

    function test_stale_afterStaleBlocks_conservativeFee_kDefault() public {
        // push k away from default first
        uint256 px = _poolX96(pid);
        _post(pkey, px * 99 / 100, 10000, 10000); // target 8000 -> 6000
        (OniblockHook.PoolState memory st,,) = hook.poolState(pid);
        assertEq(st.kBps, 6000);
        vm.roll(vm.getBlockNumber() + 5);
        (,, uint32 g, bool s) = hook.quoteFee(pkey, true);
        assertFalse(s, "5 blocks old still fresh");
        assertGt(g, 0);
        vm.roll(vm.getBlockNumber() + 1);
        vm.recordLogs();
        _swapIn(true, 1e15);
        (,, uint32 gap, uint32 k, uint24 fee,,, bool stale) = _lastReceipt(vm.getRecordedLogs());
        assertTrue(stale);
        assertEq(fee, 5000);
        assertEq(k, 5000);
        assertEq(gap, 0);
    }

    // ================================================================ setAttestation

    function test_setAttestation_nonQuoterRejected() public {
        OniblockHook.Attestation memory a =
            _attestation(pid, uint64(vm.getBlockNumber()), _poolX96(pid), 1, 1, MODEL, attestorPk);
        vm.expectRevert(OniblockHook.NotQuoter.selector);
        hook.setAttestation(pkey, a);
        // revoke (kill switch)
        roles.setQuoter(quoter, false);
        vm.prank(quoter);
        vm.expectRevert(OniblockHook.NotQuoter.selector);
        hook.setAttestation(pkey, a);
    }

    function test_setAttestation_badSignatureRejected() public {
        (, uint256 otherPk) = makeAddrAndKey("mallory");
        OniblockHook.Attestation memory a =
            _attestation(pid, uint64(vm.getBlockNumber()), _poolX96(pid), 1, 1, MODEL, otherPk);
        vm.prank(quoter);
        vm.expectRevert(OniblockHook.BadSignature.selector);
        hook.setAttestation(pkey, a);

        // valid sig but tampered field
        a = _attestation(pid, uint64(vm.getBlockNumber()), _poolX96(pid), 1, 1, MODEL, attestorPk);
        a.pToxicBps = 9999;
        vm.prank(quoter);
        vm.expectRevert(OniblockHook.BadSignature.selector);
        hook.setAttestation(pkey, a);

        // garbage signature
        a.signature = hex"1234";
        vm.prank(quoter);
        vm.expectRevert(OniblockHook.BadSignature.selector);
        hook.setAttestation(pkey, a);
    }

    function test_setAttestation_blockFreshness() public {
        uint256 mid = _poolX96(pid);
        OniblockHook.Attestation memory a = _attestation(pid, uint64(vm.getBlockNumber() - 2), mid, 1, 1, MODEL, attestorPk);
        vm.prank(quoter);
        vm.expectRevert(OniblockHook.AttestationBlockMismatch.selector);
        hook.setAttestation(pkey, a);

        a = _attestation(pid, uint64(vm.getBlockNumber() + 1), mid, 1, 1, MODEL, attestorPk);
        vm.prank(quoter);
        vm.expectRevert(OniblockHook.AttestationBlockMismatch.selector);
        hook.setAttestation(pkey, a);

        // previous block tolerated
        a = _attestation(pid, uint64(vm.getBlockNumber() - 1), mid, 1, 1, MODEL, attestorPk);
        vm.prank(quoter);
        hook.setAttestation(pkey, a);

        // a NEWER attestation may replace the (block-1) one within the same block (R-07) ...
        a = _attestation(pid, uint64(vm.getBlockNumber()), mid, 1, 1, MODEL, attestorPk);
        vm.prank(quoter);
        hook.setAttestation(pkey, a);
        // ... but not one with the same blockNumber
        a = _attestation(pid, uint64(vm.getBlockNumber()), mid, 2, 2, MODEL, attestorPk);
        vm.prank(quoter);
        vm.expectRevert(OniblockHook.AlreadyAttested.selector);
        hook.setAttestation(pkey, a);

        // replay of the same signed attestation in the next block is rejected (blockNumber not newer)
        vm.roll(vm.getBlockNumber() + 1);
        a = _attestation(pid, uint64(vm.getBlockNumber()), mid, 1, 1, MODEL, attestorPk);
        vm.prank(quoter);
        hook.setAttestation(pkey, a);
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(quoter);
        vm.expectRevert(OniblockHook.AlreadyAttested.selector);
        hook.setAttestation(pkey, a);
    }

    function test_setAttestation_invalidFields() public {
        OniblockHook.Attestation memory a = _attestation(pid, uint64(vm.getBlockNumber()), 0, 1, 1, MODEL, attestorPk);
        vm.prank(quoter);
        vm.expectRevert(OniblockHook.InvalidAttestation.selector);
        hook.setAttestation(pkey, a);
        a = _attestation(pid, uint64(vm.getBlockNumber()), 1, 10001, 1, MODEL, attestorPk);
        vm.prank(quoter);
        vm.expectRevert(OniblockHook.InvalidAttestation.selector);
        hook.setAttestation(pkey, a);
    }

    function test_attestationDigest_matchesManualEip712() public view {
        OniblockHook.Attestation memory a = OniblockHook.Attestation(123, 456, 7, 8, MODEL, "");
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Oniblock"),
                keccak256("1"),
                block.chainid,
                address(hook)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Attestation(bytes32 poolId,uint64 blockNumber,uint256 oracleMidX96,uint32 pToxicBps,uint32 confidenceBps,bytes32 modelNode)"
                ),
                PoolId.unwrap(pid),
                uint64(123),
                uint256(456),
                uint32(7),
                uint32(8),
                MODEL
            )
        );
        assertEq(hook.attestationDigest(pid, a), keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        assertEq(hook.domainSeparator(), domain);
    }

    function test_setAttestation_emitsEvent() public {
        uint256 mid = _poolX96(pid);
        OniblockHook.Attestation memory a =
            _attestation(pid, uint64(vm.getBlockNumber()), mid, 10000, 10000, MODEL, attestorPk);
        vm.expectEmit(true, true, true, true, address(hook));
        emit OniblockHook.AttestationPosted(pid, uint64(vm.getBlockNumber()), mid, 10000, 10000, 6000, MODEL, quoter);
        vm.prank(quoter);
        hook.setAttestation(pkey, a);
    }

    function test_kStepLimit() public {
        uint256 mid = _poolX96(pid);
        uint32[4] memory expected = [uint32(6000), 7000, 8000, 8000];
        for (uint256 i; i < 4; i++) {
            _post(pkey, mid, 10000, 10000); // target kMax = 8000
            (OniblockHook.PoolState memory st,,) = hook.poolState(pid);
            assertEq(st.kBps, expected[i]);
            vm.roll(vm.getBlockNumber() + 1);
        }
        // down: target kMin = 2000
        _post(pkey, mid, 0, 0);
        (OniblockHook.PoolState memory s2,,) = hook.poolState(pid);
        assertEq(s2.kBps, 7000);
    }

    function test_demotion_forcesKDefault() public {
        uint256 mid = _poolX96(pid);
        _post(pkey, mid, 10000, 10000);
        vm.roll(vm.getBlockNumber() + 1);
        _post(pkey, mid, 10000, 10000);
        (OniblockHook.PoolState memory st,,) = hook.poolState(pid);
        assertEq(st.kBps, 7000);

        vm.prank(settler);
        hook.setCalibration(MODEL, 2400, 6000, 50); // at/below threshold: fine
        assertFalse(hook.isDemoted(pid, MODEL));
        vm.prank(settler);
        hook.setCalibration(MODEL, 3000, 4000, 60); // brier 0.30 > 0.25
        assertTrue(hook.isDemoted(pid, MODEL));
        assertEq(hook.kFromScore(pid, 10000, 10000, MODEL), 5000);

        vm.roll(vm.getBlockNumber() + 1);
        _post(pkey, mid, 10000, 10000);
        (st,,) = hook.poolState(pid);
        assertEq(st.kBps, 5000, "demotion is immediate (bypasses step limit)");

        // another (allowlisted, seasoned, well-calibrated) model is unaffected
        bytes32 kev = keccak256("kev");
        assertEq(hook.kFromScore(pid, 10000, 10000, kev), 5000, "not allowlisted => no power");
        hook.setModelAllowed(pid, kev, true);
        assertEq(hook.kFromScore(pid, 10000, 10000, kev), 5000, "allowlisted but unseasoned => kDefault");
        _season(kev, 1500);
        assertEq(hook.kFromScore(pid, 10000, 10000, kev), 8000);
    }

    function test_setCalibration_onlySettler() public {
        vm.expectRevert(OniblockHook.NotSettler.selector);
        hook.setCalibration(MODEL, 1, 1, 1);
        vm.prank(quoter);
        vm.expectRevert(OniblockHook.NotSettler.selector);
        hook.setCalibration(MODEL, 1, 1, 1);
        vm.prank(settler);
        vm.expectEmit(true, false, false, true, address(hook));
        emit OniblockHook.CalibrationUpdated(MODEL, 1200, 7000, 42);
        hook.setCalibration(MODEL, 1200, 7000, 42);
        OniblockHook.Calibration memory c = hook.calibration(MODEL);
        assertEq(c.brierBps, 1200);
        assertEq(c.n, 42);
        vm.prank(settler);
        vm.expectRevert(OniblockHook.InvalidAttestation.selector);
        hook.setCalibration(MODEL, 10001, 1, 1);
    }

    function test_adminSetters() public {
        vm.prank(quoter);
        vm.expectRevert();
        hook.setAttestor(quoter);
        hook.setAttestor(quoter);
        assertEq(hook.attestor(), quoter);
        hook.setRoleOracle(roles);
        // Ownable2Step
        hook.transferOwnership(settler);
        assertEq(hook.owner(), address(this));
        vm.prank(settler);
        hook.acceptOwnership();
        assertEq(hook.owner(), settler);
    }

    // ================================================================ Chainlink sanity band

    function _enableChainlink(int256 answer) internal returns (MockAggregator feed) {
        feed = new MockAggregator(8, answer);
        OniblockHook.PoolConfig memory c = defaultConfig();
        c.chainlinkFeed = address(feed);
        c.chainlinkInverted = !wethIs0;
        c.sanityBandBps = 200; // 2%
        hook.updatePoolConfig(pid, c);
    }

    function test_chainlink_conversionMatchesConvention() public {
        _enableChainlink(int256(USD_E8));
        (bool ok, uint256 ref) = hook.chainlinkPriceX96(pid);
        assertTrue(ok);
        assertApproxEqRel(ref, _priceX96AtUsd(USD_E8), 1e12);
        assertApproxEqRel(ref, _poolX96(pid), 1e12);
    }

    function test_chainlink_outOfBandRejected_inBandAccepted() public {
        _enableChainlink(int256(USD_E8));
        OniblockHook.Attestation memory a =
            _attestation(pid, uint64(vm.getBlockNumber()), _priceX96AtUsd(2600e8), 1, 1, MODEL, attestorPk); // +4%
        vm.prank(quoter);
        vm.expectRevert(OniblockHook.OutOfSanityBand.selector);
        hook.setAttestation(pkey, a);
        a = _attestation(pid, uint64(vm.getBlockNumber()), _priceX96AtUsd(2420e8), 1, 1, MODEL, attestorPk); // -3.2%
        vm.prank(quoter);
        vm.expectRevert(OniblockHook.OutOfSanityBand.selector);
        hook.setAttestation(pkey, a);
        a = _attestation(pid, uint64(vm.getBlockNumber()), _priceX96AtUsd(2530e8), 1, 1, MODEL, attestorPk); // +1.2%
        vm.prank(quoter);
        hook.setAttestation(pkey, a);
    }

    function test_chainlink_staleOrBrokenFeedRejectsAttestation_swapStillWorks() public {
        MockAggregator feed = _enableChainlink(int256(USD_E8));
        vm.warp(vm.getBlockTimestamp() + 2 days);
        OniblockHook.Attestation memory a =
            _attestation(pid, uint64(vm.getBlockNumber()), _poolX96(pid), 1, 1, MODEL, attestorPk);
        vm.prank(quoter);
        vm.expectRevert(OniblockHook.ChainlinkInvalid.selector);
        hook.setAttestation(pkey, a);
        feed.set(int256(USD_E8));
        feed.setBroken(true);
        vm.prank(quoter);
        vm.expectRevert(OniblockHook.ChainlinkInvalid.selector);
        hook.setAttestation(pkey, a);
        feed.setBroken(false);
        feed.set(-1);
        vm.prank(quoter);
        vm.expectRevert(OniblockHook.ChainlinkInvalid.selector);
        hook.setAttestation(pkey, a);
        // swap path never touches Chainlink
        _swapIn(true, 1e15);
    }

    /// The other token order (exercises the inverted conversion path whichever order setUp produced).
    function test_chainlink_otherTokenOrder() public {
        MockERC20 w2;
        MockERC20 u2;
        for (uint256 i; i < 20; i++) {
            w2 = new MockERC20("W2", "W2", 18);
            u2 = new MockERC20("U2", "U2", 6);
            if ((address(w2) < address(u2)) != wethIs0) break;
        }
        bool w2Is0 = address(w2) < address(u2);
        require(w2Is0 != wethIs0, "could not flip order");
        (Currency c0, Currency c1) = w2Is0
            ? (Currency.wrap(address(w2)), Currency.wrap(address(u2)))
            : (Currency.wrap(address(u2)), Currency.wrap(address(w2)));
        PoolKey memory k = PoolKey(c0, c1, LPFeeLibrary.DYNAMIC_FEE_FLAG, TICK_SPACING, IHooks(address(hook)));
        MockAggregator feed = new MockAggregator(8, int256(USD_E8));
        OniblockHook.PoolConfig memory c = defaultConfig();
        c.chainlinkFeed = address(feed);
        c.chainlinkInverted = !w2Is0;
        c.sanityBandBps = 100;
        hook.registerPool(k, c);
        uint256 px = _priceX96For(w2Is0, USD_E8);
        manager.initialize(k, uint160(_sqrt(px << 96)));
        (bool ok, uint256 ref) = hook.chainlinkPriceX96(k.toId());
        assertTrue(ok);
        assertApproxEqRel(ref, px, 1e12);
    }

    function _priceX96For(bool baseIs0, uint256 usdE8) internal pure returns (uint256) {
        return baseIs0 ? usdE8 * 1e6 * (1 << 96) / 1e26 : (1e26 * (1 << 96)) / (usdE8 * 1e6);
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    // ================================================================ fuzz

    function testFuzz_kFromScore_bounds(uint32 p, uint32 c) public view {
        uint32 k = hook.kFromScore(pid, p, c, MODEL);
        assertGe(k, 2000);
        assertLe(k, 8000);
        uint32 pc = p > 10000 ? 10000 : p;
        uint32 cc = c > 10000 ? 10000 : c;
        assertEq(k, 2000 + uint32(uint256(6000) * pc * cc / 1e8));
    }

    function testFuzz_kFromScore_demoted(uint32 p, uint32 c, uint32 brier) public {
        brier = uint32(bound(brier, 2501, 10000));
        vm.prank(settler);
        hook.setCalibration(MODEL, brier, 0, 1);
        assertEq(hook.kFromScore(pid, p, c, MODEL), 5000);
    }

    function testFuzz_feeNeverExceedsFeeMax(uint256 midSeed, uint32 kMax, uint32 p, uint24 feeMax, bool z) public {
        feeMax = uint24(bound(feeMax, 5000, 100_000));
        kMax = uint32(bound(kMax, 2000, 9999));
        OniblockHook.PoolConfig memory c = defaultConfig();
        c.feeMax = feeMax;
        c.kMaxBps = kMax;
        c.kDefaultBps = 2000;
        c.maxKStepBps = 10000;
        hook.updatePoolConfig(pid, c);
        uint256 mid = bound(midSeed, 1, (1 << 224) - 1);
        _post(pkey, mid, p % 10001, 10000);
        (uint24 fee,,,) = hook.quoteFee(pkey, z);
        assertLe(fee, feeMax);
        vm.recordLogs();
        _swapIn(z, z ? 1e12 : 1e3);
        (,,,, uint24 executed,,,) = _lastReceipt(vm.getRecordedLogs());
        assertEq(executed, fee);
        assertLe(executed, feeMax);
    }

    function testFuzz_swapsNeverRevert(uint256 midSeed, uint8 rollBy, bool post, bool z, uint256 amt, uint8 parts)
        public
    {
        if (post) _post(pkey, bound(midSeed, 1, (1 << 224) - 1), uint32(midSeed % 10001), uint32(amt % 10001));
        vm.roll(vm.getBlockNumber() + (rollBy % 12));
        amt = z ? bound(amt, 1, 5e18) : bound(amt, 1, 1e10);
        parts = uint8(bound(parts, 1, 8));
        router.swapSplit(pkey, z, -int256(amt), parts, 0, address(this));
        router.swap(pkey, !z, (z ? int256(-1e6) : int256(-1e14)), 0, address(this));
    }

    /// Extreme pool prices across the full sqrtPrice range: quoteFee + swap never revert.
    function testFuzz_extremePrices_noRevert(uint160 sqrtP, uint256 midSeed, bool z) public {
        sqrtP = uint160(bound(sqrtP, TickMath.MIN_SQRT_PRICE, TickMath.MAX_SQRT_PRICE - 1));
        PoolKey memory k = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 200, IHooks(address(hook)));
        hook.registerPool(k, defaultConfig());
        hook.setModelAllowed(k.toId(), MODEL, true);
        manager.initialize(k, sqrtP);
        OniblockHook.Attestation memory a =
            _attestation(k.toId(), uint64(vm.getBlockNumber()), bound(midSeed, 1, (1 << 224) - 1), 5000, 5000, MODEL, attestorPk);
        vm.prank(quoter);
        hook.setAttestation(k, a);
        (uint24 fee,,,) = hook.quoteFee(k, z);
        assertLe(fee, 10000);
        // zero-liquidity pool swap with a tight price limit: exercises before/afterSwap hooks without reverting
        uint160 limit = z ? sqrtP - 1 : sqrtP + 1;
        if (limit <= TickMath.MIN_SQRT_PRICE || limit >= TickMath.MAX_SQRT_PRICE) return;
        router.swap(k, z, -1000, limit, address(this));
    }
}

/// Gas: swap through the Oniblock pool vs an identical hookless 0.30% pool.
contract OniblockGasTest is OniblockTestBase {
    using StateLibrary for IPoolManager;

    function test_gas_swapWithHook_vsHookless() public {
        PoolKey memory vanilla = PoolKey(currency0, currency1, 3000, TICK_SPACING, IHooks(address(0)));
        manager.initialize(vanilla, _sqrtAtUsd(USD_E8));
        _addLiq(vanilla, LP_LIQ, 0);
        vm.roll(vm.getBlockNumber() + 1);
        _postGap(-50);
        // warm both pools' token/storage similarly with one swap in the previous block
        router.swap(vanilla, false, -1e6, 0, address(this));
        _swapIn(false, 1e6);
        vm.roll(vm.getBlockNumber() + 1);
        OniblockHook.Attestation memory a =
            _attestation(pid, uint64(vm.getBlockNumber()), _poolX96(pid) * 995 / 1000, 10000, 5000, MODEL, attestorPk);
        vm.prank(quoter);
        hook.setAttestation(pkey, a);

        uint256 g = gasleft();
        router.swap(vanilla, true, -1e15, 0, address(this));
        uint256 gVanilla = g - gasleft();
        g = gasleft();
        _swapIn(true, 1e15); // first swap of the block: writes the anchor
        uint256 gFirst = g - gasleft();
        g = gasleft();
        _swapIn(true, 1e15); // later swap in the same block: reads the anchor
        uint256 gLater = g - gasleft();
        emit log_named_uint("gas swap hookless 0.30%", gVanilla);
        emit log_named_uint("gas swap oniblock first-in-block", gFirst);
        emit log_named_uint("gas swap oniblock later-in-block", gLater);
        emit log_named_uint("gas overhead first-in-block", gFirst - gVanilla);
    }
}
