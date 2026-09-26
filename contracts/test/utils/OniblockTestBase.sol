// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import {OniblockHook} from "../../src/OniblockHook.sol";
import {IRoleOracle} from "../../src/interfaces/IRoleOracle.sol";
import {MockRoleOracle} from "../../src/mocks/MockRoleOracle.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {SplitSwapRouter} from "../../src/periphery/SplitSwapRouter.sol";
import {PriceMath} from "../../src/libraries/PriceMath.sol";

/// Test base. Deliberately does NOT use v4-core's Deployers (it imports PoolManager.sol, which would compile the
/// hook under PoolManager's 44M-run profile — review R-11). PoolManager is deployed from its own artifact instead,
/// so tests exercise the same (default-profile) hook bytecode as the deploy scripts.
abstract contract OniblockTestBase is Test {
    using StateLibrary for IPoolManager;

    uint160 constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.AFTER_ADD_LIQUIDITY_FLAG
            | Hooks.AFTER_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG | Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG
    );
    uint48 constant JIT_OFFSET = 10;
    uint16 constant JIT_WINDOW_MIN = 10;
    uint16 constant JIT_WINDOW_MAX = 100;
    int24 constant TICK_SPACING = 60;
    int24 constant FULL_LOWER = -887220;
    int24 constant FULL_UPPER = 887220;
    uint256 constant USD_E8 = 2500e8;
    int256 constant LP_LIQ = 5e16; // ~1000 WETH / 2.5M USDC full range at 2500
    bytes32 constant MODEL = keccak256("jev-v1.models.oniblock.eth");
    uint32 constant CAL_N = 10; // sample count of the calibration records tests write
    uint24 constant ARB_THRESHOLD = 3300; // baseFee (3000) + 300 pips

    IPoolManager manager;
    PoolModifyLiquidityTest modifyLiquidityRouter;
    PoolSwapTest swapRouter;
    Currency currency0;
    Currency currency1;

    OniblockHook hook;
    MockRoleOracle roles;
    SplitSwapRouter router;
    MockERC20 weth;
    MockERC20 usdc;
    bool wethIs0;

    address owner = address(this);
    address quoter = makeAddr("quoter");
    address settler = makeAddr("settler");
    address attestor;
    uint256 attestorPk;

    PoolKey pkey; // Oniblock pool
    PoolId pid;

    function setUp() public virtual {
        vm.roll(100);
        vm.warp(1_700_000_000);
        manager = IPoolManager(deployCode("out/PoolManager.sol/PoolManager.json", abi.encode(address(this))));
        modifyLiquidityRouter = new PoolModifyLiquidityTest(manager);
        swapRouter = new PoolSwapTest(manager);
        (attestor, attestorPk) = makeAddrAndKey("attestor");

        weth = new MockERC20("Mock WETH", "mWETH", 18);
        usdc = new MockERC20("Mock USDC", "mUSDC", 6);
        wethIs0 = address(weth) < address(usdc);
        (currency0, currency1) = wethIs0
            ? (Currency.wrap(address(weth)), Currency.wrap(address(usdc)))
            : (Currency.wrap(address(usdc)), Currency.wrap(address(weth)));

        roles = new MockRoleOracle(address(this));
        roles.setQuoter(quoter, true);
        roles.setSettler(settler, true);

        hook = _deployHook();
        router = new SplitSwapRouter(manager);
        _fundAndApprove(address(this));

        pkey = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, TICK_SPACING, IHooks(address(hook)));
        pid = pkey.toId();
        hook.registerPool(pkey, defaultConfig());
        manager.initialize(pkey, _sqrtAtUsd(USD_E8));
        _addLiq(pkey, LP_LIQ, 0);
        // MODEL is allowlisted and well calibrated (good Brier, n = CAL_N) so it has full [kMin, kMax] power.
        hook.setModelAllowed(pid, MODEL, true);
        _calibrate(MODEL, 1000);
        vm.roll(vm.getBlockNumber() + JIT_OFFSET + 1); // base LP is past the JIT window
    }

    // ------------------------------------------------------------------ helpers

    function defaultConfig() internal pure returns (OniblockHook.PoolConfig memory c) {
        c.baseFee = 3000;
        c.feeMax = 10000;
        c.conservativeFee = 5000;
        c.kMinBps = 2000;
        c.kMaxBps = 8000;
        c.kDefaultBps = 5000;
        c.maxKStepBps = 1000;
        c.staleBlocks = 5;
        c.sanityBandBps = 0;
        c.chainlinkFeed = address(0);
        c.chainlinkInverted = false;
        c.brierDemoteBps = 2500;
        c.chainlinkMaxAge = 2 hours;
        c.arbThresholdPips = ARB_THRESHOLD;
        // v5 JIT window: default = JIT_OFFSET so that tests written against the fixed 10-block wall still hold
        // (default attestations carry pJit = 0 => jitWindow = jitWindowMin = jitWindowDefault = 10).
        c.jitWindowMin = JIT_WINDOW_MIN;
        c.jitWindowMax = JIT_WINDOW_MAX;
        c.jitWindowDefault = uint16(JIT_OFFSET);
    }

    /// Fee law mirror (default config, arb direction, not stale): min(base + max(0, gap - threshold) * k / 1e4, feeMax).
    function _lawFee(uint256 gap, uint256 k) internal pure returns (uint24) {
        return _lawFee(3000, 10000, ARB_THRESHOLD, gap, k);
    }

    function _lawFee(uint256 base, uint256 feeMax, uint256 thr, uint256 gap, uint256 k) internal pure returns (uint24) {
        uint256 f = base + (gap > thr ? gap - thr : 0) * k / 10000;
        return uint24(f > feeMax ? feeMax : f);
    }

    /// Settler writes a calibration record (n = CAL_N) with the given Brier.
    function _calibrate(bytes32 model, uint32 brierBps) internal {
        vm.prank(settler);
        hook.setCalibration(model, brierBps, 6000, CAL_N);
    }

    function _deployHook() internal returns (OniblockHook h) {
        h = _deployHook(0);
    }

    function _deployHook(uint256 delay) internal returns (OniblockHook h) {
        bytes memory args = abi.encode(manager, owner, attestor, IRoleOracle(address(roles)), JIT_OFFSET, delay);
        (address addr, bytes32 salt) = HookMiner.find(address(this), HOOK_FLAGS, type(OniblockHook).creationCode, args);
        h = new OniblockHook{salt: salt}(manager, owner, attestor, IRoleOracle(address(roles)), JIT_OFFSET, delay);
        require(address(h) == addr, "hook addr");
    }

    function _fundAndApprove(address who) internal {
        weth.mint(who, 1e30);
        usdc.mint(who, 1e30);
        vm.startPrank(who);
        address[3] memory spenders = [address(router), address(modifyLiquidityRouter), address(swapRouter)];
        for (uint256 i; i < 3; i++) {
            weth.approve(spenders[i], type(uint256).max);
            usdc.approve(spenders[i], type(uint256).max);
        }
        vm.stopPrank();
    }

    function _priceX96AtUsd(uint256 usdE8) internal view returns (uint256) {
        return PriceMath.usdToPriceX96(usdE8, wethIs0, 18, 6);
    }

    function _sqrtAtUsd(uint256 usdE8) internal view returns (uint160) {
        return PriceMath.priceX96ToSqrtPriceX96(_priceX96AtUsd(usdE8));
    }

    function _poolX96(PoolId id) internal view returns (uint256) {
        (uint160 s,,,) = manager.getSlot0(id);
        return PriceMath.sqrtPriceX96ToPriceX96(s);
    }

    function _addLiq(PoolKey memory k, int256 liq, uint256 salt) internal returns (BalanceDelta) {
        return modifyLiquidityRouter.modifyLiquidity(
            k, ModifyLiquidityParams(FULL_LOWER, FULL_UPPER, liq, bytes32(salt)), ""
        );
    }

    /// Signed attestation with pJitBps = 0 (no JIT signal).
    function _attestation(PoolId id, uint64 bn, uint256 mid, uint32 p, uint32 c, bytes32 model, uint256 pk)
        internal
        view
        returns (OniblockHook.Attestation memory a)
    {
        return _attestation(id, bn, mid, p, c, 0, model, pk);
    }

    /// Signed attestation with an explicit JIT score (v5).
    function _attestation(
        PoolId id,
        uint64 bn,
        uint256 mid,
        uint32 p,
        uint32 c,
        uint32 pJit,
        bytes32 model,
        uint256 pk
    ) internal view returns (OniblockHook.Attestation memory a) {
        a = OniblockHook.Attestation(bn, mid, p, c, pJit, model, "");
        bytes32 digest = hook.attestationDigest(id, a);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        a.signature = abi.encodePacked(r, s, v);
    }

    /// Post a valid attestation for this block from the quoter.
    function _post(PoolKey memory k, uint256 mid, uint32 p, uint32 c) internal {
        OniblockHook.Attestation memory a = _attestation(k.toId(), uint64(vm.getBlockNumber()), mid, p, c, MODEL, attestorPk);
        vm.prank(quoter);
        hook.setAttestation(k, a);
    }

    /// Post a mid that is `bps` above (+) / below (-) the current pool price (in priceX96 terms), p/c chosen so that
    /// kFromScore == kDefault (5000) with the default config.
    function _postGap(int256 bps) internal returns (uint256 mid) {
        uint256 px = _poolX96(pid);
        mid = bps >= 0 ? px * (10000 + uint256(bps)) / 10000 : px * (10000 - uint256(-bps)) / 10000;
        _post(pkey, mid, 10000, 5000);
    }

    /// LP fee growth (both tokens) per unit liquidity.
    function _feeGrowth(PoolId id) internal view returns (uint256 g0, uint256 g1) {
        (g0, g1) = manager.getFeeGrowthGlobals(id);
    }

    /// LP fee revenue (raw tokens) accrued between two fee-growth snapshots at liquidity L.
    function _feesFromGrowth(uint256 before, uint256 after_, uint256 L) internal pure returns (uint256) {
        return FullMath.mulDiv(after_ - before, L, 1 << 128);
    }

    function _swapIn(bool zeroForOne, uint256 amountIn) internal returns (BalanceDelta) {
        return router.swap(pkey, zeroForOne, -int256(amountIn), 0, address(this));
    }

    /// Find the last Receipt log emitted by the hook.
    function _lastReceipt(Vm.Log[] memory logs)
        internal
        view
        returns (bool found, bool arbDir, uint32 gap, uint32 k, uint24 fee, int128 a0, int128 a1, bool stale)
    {
        bytes32 sig = OniblockHook.Receipt.selector;
        for (uint256 i = logs.length; i > 0; i--) {
            Vm.Log memory l = logs[i - 1];
            if (l.emitter == address(hook) && l.topics[0] == sig) {
                bool z;
                bytes32 model;
                (z, arbDir, gap, k, fee, a0, a1, model, stale) =
                    abi.decode(l.data, (bool, bool, uint32, uint32, uint24, int128, int128, bytes32, bool));
                return (true, arbDir, gap, k, fee, a0, a1, stale);
            }
        }
    }
}
