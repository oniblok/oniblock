// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";

import {OniblockTestBase} from "../utils/OniblockTestBase.sol";
import {OniblockHook} from "../../src/OniblockHook.sol";
import {SplitSwapRouter} from "../../src/periphery/SplitSwapRouter.sol";

/// Stateful handler: random swaps (single/split, both directions, price-limited), attestations (incl. same-block
/// replacements, both models), block rolls, calibration writes, and a narrow-range JIT LP that is often the only
/// in-range liquidity (so penalties get parked and flushed).
contract Handler is Test {
    using StateLibrary for IPoolManager;

    OniblockHook public hook;
    IPoolManager public manager;
    SplitSwapRouter public router;
    PoolModifyLiquidityTest public lpRouter;
    PoolKey public key;
    PoolId public id;
    address quoter;
    address settler;
    uint256 attestorPk;
    bytes32[2] models;
    int24 lower;
    int24 upper;

    uint256 public swapReverts;
    bytes public lastErr;
    uint256 public swaps;
    uint256 public feeViolations;
    uint256 public quoteMismatches;
    uint256 public parks;
    uint256 public flushes;

    constructor(
        OniblockHook h,
        IPoolManager m,
        SplitSwapRouter r,
        PoolModifyLiquidityTest l,
        PoolKey memory k,
        address q,
        address s,
        uint256 pk,
        bytes32 m0,
        bytes32 m1,
        int24 lo,
        int24 hi
    ) {
        hook = h;
        manager = m;
        router = r;
        lpRouter = l;
        key = k;
        id = k.toId();
        quoter = q;
        settler = s;
        attestorPk = pk;
        models = [m0, m1];
        lower = lo;
        upper = hi;
    }

    function _poolX96() internal view returns (uint256) {
        (uint160 s,,,) = manager.getSlot0(id);
        return uint256(s) * uint256(s) >> 96;
    }

    function swap(uint256 seed, bool z, uint256 amt, uint8 parts) external {
        amt = bound(amt, 1, 2e17);
        parts = uint8(bound(parts, 1, 4));
        (uint160 cur,,,) = manager.getSlot0(id);
        uint160 lim = TickMath.getSqrtPriceAtTick(z ? lower + 10 : upper - 10);
        if (z ? lim >= cur : lim <= cur) {
            z = !z; // keep the price inside the JIT range: go the other way
            lim = TickMath.getSqrtPriceAtTick(z ? lower + 10 : upper - 10);
        }
        (uint24 q,,,) = hook.quoteFee(key, z);
        uint256 pend = hook.pendingPenalty0(id) + hook.pendingPenalty1(id);
        vm.recordLogs();
        try router.swapSplit(key, z, -int256(amt), parts, lim, address(this)) {
            if (pend != 0 && hook.pendingPenalty0(id) + hook.pendingPenalty1(id) == 0) flushes++;
            swaps++;
        } catch (bytes memory err) {
            // PoolManager's PriceLimitAlreadyExceeded (split sub-swap after an earlier part hit the limit in an
            // empty range) is a router/test artifact raised before the hook runs; not counted.
            if (bytes4(err) == bytes4(0x7c9c6e8f)) return;
            swapReverts++;
            lastErr = err;
            return;
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        OniblockHook.PoolConfig memory c = hook.poolConfig(id);
        bool first = true;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(hook) || logs[i].topics[0] != OniblockHook.Receipt.selector) continue;
            (, bool arb, uint32 gap, uint32 k, uint24 fee,,,, bool stale) =
                abi.decode(logs[i].data, (bool, bool, uint32, uint32, uint24, int128, int128, bytes32, bool));
            if (first && fee != q) quoteMismatches++;
            first = false;
            if (fee > c.feeMax) feeViolations++;
            if (stale) {
                if (fee != c.conservativeFee) feeViolations++;
            } else {
                uint256 f = uint256(c.baseFee) + (gap > c.arbThresholdPips ? uint256(gap - c.arbThresholdPips) : 0) * k / 10000;
                if (!arb) f = c.baseFee;
                else if (f > c.feeMax) f = c.feeMax;
                // N-07 floor: a block un-staled by a same-block attestation never charges below conservativeFee
                if (fee != f && !(fee == c.conservativeFee && c.conservativeFee > f)) feeViolations++;
            }
        }
        seed;
    }

    function attest(uint256 seed) external {
        (OniblockHook.PoolState memory st,,) = hook.poolState(id);
        uint64 bn = seed % 3 == 0 ? uint64(block.number - 1) : uint64(block.number);
        if (bn <= st.lastAttestBlock) return;
        uint256 mid = _poolX96() * (9850 + (seed >> 8) % 300) / 10000 + 1;
        OniblockHook.Attestation memory a = OniblockHook.Attestation(
            bn,
            mid,
            uint32((seed >> 32) % 10001),
            uint32((seed >> 48) % 10001),
            uint32((seed >> 80) % 10001),
            models[(seed >> 64) % 2],
            ""
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorPk, hook.attestationDigest(id, a));
        a.signature = abi.encodePacked(r, s, v);
        vm.prank(quoter);
        hook.setAttestation(key, a);
    }

    function roll(uint8 n) external {
        vm.roll(block.number + 1 + (n % 4));
    }

    function calibrate(uint256 seed) external {
        vm.prank(settler);
        hook.setCalibration(models[seed % 2], uint32((seed >> 8) % 10001), 0, uint32((seed >> 24) % 21));
    }

    function jitAdd(uint256 liq) external {
        liq = bound(liq, 1e14, 1e17);
        lpRouter.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, int256(liq), bytes32(uint256(7))), "");
    }

    function jitRemove() external {
        bytes32 posKey = keccak256(abi.encodePacked(address(lpRouter), lower, upper, bytes32(uint256(7))));
        uint128 liq = manager.getPositionLiquidity(id, posKey);
        if (liq == 0) return;
        uint256 p0 = hook.pendingPenalty0(id) + hook.pendingPenalty1(id);
        lpRouter.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, -int256(uint256(liq)), bytes32(uint256(7))), "");
        if (hook.pendingPenalty0(id) + hook.pendingPenalty1(id) > p0) parks++;
    }
}

contract Review2InvariantsTest is OniblockTestBase {
    using StateLibrary for IPoolManager;

    Handler handler;
    int24 lowerT;
    int24 upperT;
    PoolKey k2;
    PoolId id2;

    function setUp() public override {
        super.setUp();
        // narrow-range pool with only JIT liquidity (so exits park penalties and swaps flush them)
        k2 = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 10, IHooks(address(hook)));
        id2 = k2.toId();
        hook.registerPool(k2, defaultConfig());
        manager.initialize(k2, _sqrtAtUsd(USD_E8));
        bytes32 m2 = keccak256("heuristic-v1.models.oniblock.eth");
        hook.setModelAllowed(id2, MODEL, true);
        hook.setModelAllowed(id2, m2, true);
        (, int24 tick,,) = manager.getSlot0(id2);
        tick = (tick / 10) * 10;
        (lowerT, upperT) = (tick - 100, tick + 100);
        handler = new Handler(
            hook, manager, router, modifyLiquidityRouter, k2, quoter, settler, attestorPk, MODEL, m2, tick - 100, tick + 100
        );
        _fundAndApprove(address(handler));
        vm.startPrank(address(handler));
        // handler pays via router (payer = msg.sender) and via lpRouter (payer = msg.sender)
        vm.stopPrank();
        targetContract(address(handler));
    }

    /// ERC-6909 claims held by the hook always cover the parked penalties (== unless someone donates claims).
    function invariant_claimsCoverPendingPenalties() public view {
        uint256 b0 = manager.balanceOf(address(hook), currency0.toId());
        uint256 b1 = manager.balanceOf(address(hook), currency1.toId());
        // pendings across both pools (pid never parks: full-range base LP)
        // + fees withheld (OZ LiquidityPenaltyHook) from the JIT position on re-adds inside the window
        bytes32 posKey = keccak256(abi.encodePacked(address(modifyLiquidityRouter), lowerT, upperT, bytes32(uint256(7))));
        BalanceDelta w = hook.getWithheldFees(id2, posKey);
        assertEq(b0, hook.pendingPenalty0(id2) + hook.pendingPenalty0(pid) + uint256(int256(w.amount0())), "claims0 == pending0 + withheld0");
        assertEq(b1, hook.pendingPenalty1(id2) + hook.pendingPenalty1(pid) + uint256(int256(w.amount1())), "claims1 == pending1 + withheld1");
    }

    function invariant_feeLawAndNoRevert() public view {
        assertEq(handler.swapReverts(), 0, "swap path reverted");
        assertEq(handler.feeViolations(), 0, "fee law / feeMax violated");
        assertEq(handler.quoteMismatches(), 0, "quote != executed");
    }

    function invariant_quotesBounded() public view {
        OniblockHook.PoolConfig memory c = hook.poolConfig(id2);
        (uint24 a,,,) = hook.quoteFee(k2, true);
        (uint24 b,,,) = hook.quoteFee(k2, false);
        assertLe(a, c.feeMax);
        assertLe(b, c.feeMax);
        assertGe(a, c.baseFee < c.conservativeFee ? c.baseFee : c.conservativeFee);
        (OniblockHook.PoolState memory st,,) = hook.poolState(id2);
        assertGe(st.kBps, c.kMinBps);
        assertLe(st.kBps, c.kMaxBps);
    }

    function afterInvariant() public {
        emit log_named_uint("swaps", handler.swaps());
        emit log_named_uint("parks", handler.parks());
        emit log_named_uint("flushes", handler.flushes());
    }
}

