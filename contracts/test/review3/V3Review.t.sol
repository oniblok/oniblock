// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Test.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {OniblockHook} from "../../src/OniblockHook.sol";
import {IRoleOracle} from "../../src/interfaces/IRoleOracle.sol";
import {OniblockTestBase} from "../utils/OniblockTestBase.sol";

/// Reviewer prototype (NOT production code) of the recommended "mid-only" refresh path (V3_REVIEW.md, fix F-1 spec):
/// updates the mid / freshness without touching k or the credited model; re-checks the stored model's demotion.
contract MidOnlyHook is OniblockHook {
    bytes32 public constant MID_TYPEHASH =
        keccak256("MidAttestation(bytes32 poolId,uint64 blockNumber,uint256 oracleMidX96)");

    event MidRefreshed(
        PoolId indexed id, uint64 indexed blockNumber, uint256 oracleMidX96, uint32 kBps, bytes32 indexed modelNode, address quoter
    );

    constructor(IPoolManager pm, address o, address att, IRoleOracle ro, uint48 off, uint256 d)
        OniblockHook(pm, o, att, ro, off, d)
    {}

    function midDigest(PoolId id, uint64 bn, uint256 mid) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(MID_TYPEHASH, PoolId.unwrap(id), bn, mid)));
    }

    function refreshMid(PoolKey calldata key, uint64 bn, uint256 mid, bytes calldata sig) external {
        PoolId id = key.toId();
        PoolState storage st = _state[id];
        if (!st.initialized) revert PoolNotInitialized();
        if (!roleOracle.isQuoter(msg.sender)) revert NotQuoter();
        if (bn != block.number && uint256(bn) + 1 != block.number) revert AttestationBlockMismatch();
        if (bn <= st.lastAttestBlock) revert AlreadyAttested();
        if (mid == 0 || mid >= MAX_MID_X96) revert InvalidAttestation();
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(midDigest(id, bn, mid), sig);
        if (err != ECDSA.RecoverError.NoError || signer != attestor) revert BadSignature();
        PoolConfig memory cfg = _config[id];
        _checkSanityBand(cfg, st, mid);
        uint32 k = st.kBps;
        if (isDemoted(id, st.modelNode)) k = cfg.kDefaultBps; // demotion parity with setAttestation
        uint256 prevMid = st.oracleMidX96;
        st.kBps = k;
        st.oracleMidX96 = mid;
        st.lastAttestBlock = bn;
        st.lastPostBlock = uint64(block.number);
        BlockAnchor storage anc = _anchor[id];
        if (anc.blockNumber == block.number) {
            if (anc.stale || k >= anc.kBps) {
                if (anc.stale) {
                    anc.stale = false;
                    anc.conservativeFloor = true;
                }
                anc.kBps = k;
                anc.attestBlock = bn;
                anc.modelNode = st.modelNode;
                anc.pinnedMid = false;
            } else if (!anc.pinnedMid) {
                _pinnedMid[id] = prevMid;
                anc.pinnedMid = true;
            }
        }
        emit MidRefreshed(id, bn, mid, k, st.modelNode, msg.sender);
    }
}

contract V3ReviewTest is OniblockTestBase {
    bytes32 constant RULE = keccak256("rule-v1.models.oniblock.eth");

    function _postAs(bytes32 model, uint256 mid, uint32 p, uint32 c) internal {
        OniblockHook.Attestation memory a = _attestation(pid, uint64(vm.getBlockNumber()), mid, p, c, model, attestorPk);
        vm.prank(quoter);
        hook.setAttestation(pkey, a);
    }

    function _k() internal view returns (uint32 k) {
        (OniblockHook.PoolState memory st,,) = hook.poolState(pid);
        k = st.kBps;
    }

    function _next() internal {
        vm.roll(vm.getBlockNumber() + 1);
    }

    // ------------------------------------------------------------ F-1 (known open issue): rule-v1 resets k

    /// A seasoned model walks k to kMax (8000); ONE rule-v1 post (allowlisted, never graded => unseasoned) pins k back
    /// to kDefault (5000); the next model post can only reach 6000 (maxKStepBps 1000). With a rule post between
    /// every pair of model posts, k never leaves [kDefault - step, kDefault + step].
    function test_F1_rulePostResetsModelK() public {
        hook.setModelAllowed(pid, RULE, true);
        uint256 mid = _poolX96(pid);
        for (uint256 i; i < 3; i++) {
            _postAs(MODEL, mid, 10000, 10000);
            _next();
        }
        assertEq(_k(), 8000, "model reached kMax");
        _postAs(RULE, mid, 1000, 10000);
        assertEq(_k(), 5000, "rule-v1 post pins kDefault");
        _next();
        _postAs(MODEL, mid, 10000, 10000);
        assertEq(_k(), 6000, "model can only step 1000 from kDefault");
        // alternating rule/model: k oscillates 5000 <-> 6000 forever
        for (uint256 i; i < 4; i++) {
            _next();
            _postAs(RULE, mid, 1000, 10000);
            assertEq(_k(), 5000);
            _next();
            _postAs(MODEL, mid, 10000, 10000);
            assertEq(_k(), 6000);
        }
    }

    // ------------------------------------------------------------ new default: threshold 0, kMin 0 ("Jev decides")

    function _jevDecidesConfig() internal pure returns (OniblockHook.PoolConfig memory c) {
        c = defaultConfig();
        c.arbThresholdPips = 0;
        c.kMinBps = 0;
    }

    /// kMin = 0 and threshold = 0 validate; with k = 0 the arb direction pays EXACTLY base (quote == executed), even
    /// at a large gap. It takes ceil(5000/maxKStep) = 5 posts to walk from kDefault to 0 (and back up).
    function test_kMin0_thr0_kZeroPaysExactlyBase_andStepLag() public {
        hook.updatePoolConfig(pid, _jevDecidesConfig()); // delay 0
        uint256 px = _poolX96(pid);
        uint256 mid = px * 1e6 / (1e6 + 20_000); // pool 2% above mid: zeroForOne is arb
        uint256 posts;
        while (_k() != 0) {
            _postAs(MODEL, mid, 0, 10000); // Jev: "not toxic" => target k = kMin = 0
            _next();
            posts++;
        }
        assertEq(posts, 5, "step lag: 5 blocks to switch the premium off");
        _postAs(MODEL, mid, 0, 10000);
        (uint24 f, bool arb, uint32 gap, bool stale) = hook.quoteFee(pkey, true);
        assertTrue(arb);
        assertFalse(stale);
        assertApproxEqAbs(gap, 20_000, 3);
        assertEq(f, 3000, "k = 0 => base");
        vm.recordLogs();
        _swapIn(true, 1e15);
        (, bool arbR, uint32 gapR, uint32 kR, uint24 feeR,,, bool staleR) = _lastReceipt(vm.getRecordedLogs());
        assertTrue(arbR);
        assertFalse(staleR);
        assertEq(kR, 0);
        assertEq(gapR, gap);
        assertEq(feeR, 3000, "executed == quoted == base");
        // switching back ON is equally slow: Jev says max toxicity, k only reaches 1000 next block
        _next();
        _postAs(MODEL, _poolX96(pid) * 1e6 / (1e6 + 20_000), 10000, 10000);
        assertEq(_k(), 1000, "one step from 0");
        (f,,,) = hook.quoteFee(pkey, true);
        assertLt(f, 3000 + 2000 + 1, "premium still ~1/8 of kMax on the first volatile block");
    }

    /// k = 0 does NOT bypass the stale / N-07 conservative floor (expected; documents the only non-base fees at k=0).
    function test_kMin0_staleAndFloorStillConservative() public {
        OniblockHook.PoolConfig memory c = _jevDecidesConfig();
        c.kDefaultBps = 0; // demoted/unseasoned => vanilla pool
        hook.updatePoolConfig(pid, c);
        uint256 mid = _poolX96(pid);
        _postAs(MODEL, mid, 0, 10000);
        vm.roll(vm.getBlockNumber() + 10); // stale
        (uint24 f,,, bool stale) = hook.quoteFee(pkey, false);
        assertTrue(stale);
        assertEq(f, 5000, "stale => conservativeFee even with kMin = kDefault = 0");
        _swapIn(false, 1e6); // first touch stale
        _postAs(MODEL, mid, 0, 10000); // un-stales, k = 0
        (f,,, stale) = hook.quoteFee(pkey, false);
        assertFalse(stale);
        assertEq(f, 5000, "N-07 floor for the rest of the block");
        _next();
        (f,,,) = hook.quoteFee(pkey, false);
        assertEq(f, 3000);
    }

    /// kDefault = 0 is accepted: an unseasoned or demoted model runs the pool as a vanilla pool.
    function test_kDefault0_unseasonedIsVanilla() public {
        OniblockHook.PoolConfig memory c = _jevDecidesConfig();
        c.kDefaultBps = 0;
        hook.updatePoolConfig(pid, c);
        bytes32 fresh = keccak256("new-model");
        hook.setModelAllowed(pid, fresh, true);
        uint256 mid = _poolX96(pid) * 1e6 / (1e6 + 20_000);
        _postAs(fresh, mid, 10000, 10000);
        assertEq(_k(), 0);
        (uint24 f, bool arb,,) = hook.quoteFee(pkey, true);
        assertTrue(arb);
        assertEq(f, 3000);
    }

    /// Fuzz: threshold 0, kMin 0, any k in [0, kMax], any gap: quote == executed == law; k == 0 => base.
    function testFuzz_kMin0_thr0_law(uint256 gapPips, uint32 p, uint32 conf, uint8 steps) public {
        hook.updatePoolConfig(pid, _jevDecidesConfig());
        gapPips = bound(gapPips, 1, 60_000);
        p = uint32(bound(p, 0, 10000));
        conf = uint32(bound(conf, 0, 10000));
        steps = uint8(bound(steps, 1, 9));
        uint256 mid = _poolX96(pid) * 1e6 / (1e6 + gapPips);
        for (uint256 i; i < steps; i++) {
            _postAs(MODEL, mid, p, conf);
            _next();
        }
        _postAs(MODEL, mid, p, conf);
        uint32 k = _k();
        (uint24 f, bool arb, uint32 gap,) = hook.quoteFee(pkey, true);
        if (!arb) return;
        assertEq(f, _lawFee(3000, 10000, 0, gap, k));
        if (k == 0) assertEq(f, 3000);
        vm.recordLogs();
        _swapIn(true, 1e14);
        (,,,, uint24 feeR,,,) = _lastReceipt(vm.getRecordedLogs());
        assertEq(feeR, f);
    }

    // ------------------------------------------------------------ F-4: Receipt recomputability depends on config history

    /// A Receipt emitted under threshold 3300 cannot be re-derived from the CURRENT poolConfig after a (timelocked)
    /// threshold change: the verifier needs the threshold in force at the swap block (PoolConfigUpdated history).
    function test_F4_receiptNotRecomputableFromCurrentConfig() public {
        uint256 mid = _poolX96(pid) * 1e6 / (1e6 + 5000); // 0.5% gap
        _postAs(MODEL, mid, 10000, 5000); // k = kDefault 5000 (not a step)
        vm.recordLogs();
        _swapIn(true, 1e14);
        (,, uint32 gap, uint32 k, uint24 fee,,,) = _lastReceipt(vm.getRecordedLogs());
        assertEq(fee, _lawFee(3000, 10000, 3300, gap, k));
        OniblockHook.PoolConfig memory c = defaultConfig();
        c.arbThresholdPips = 0;
        hook.updatePoolConfig(pid, c);
        uint24 thrNow = hook.poolConfig(pid).arbThresholdPips;
        assertTrue(_lawFee(3000, 10000, thrNow, gap, k) != fee, "recompute with current config mismatches");
    }

    // ------------------------------------------------------------ F-1 fix prototype: mid-only refresh keeps k

    MidOnlyHook h2;
    PoolKey k2;
    PoolId id2;

    function _deployMidOnly() internal {
        bytes memory args = abi.encode(manager, owner, attestor, IRoleOracle(address(roles)), JIT_OFFSET, uint256(0));
        (address addr, bytes32 salt) = HookMiner.find(address(this), HOOK_FLAGS, type(MidOnlyHook).creationCode, args);
        h2 = new MidOnlyHook{salt: salt}(manager, owner, attestor, IRoleOracle(address(roles)), JIT_OFFSET, 0);
        require(address(h2) == addr);
        k2 = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, TICK_SPACING, IHooks(address(h2)));
        id2 = k2.toId();
        h2.registerPool(k2, defaultConfig());
        manager.initialize(k2, _sqrtAtUsd(USD_E8));
        h2.setModelAllowed(id2, MODEL, true);
        vm.prank(settler);
        h2.setCalibration(MODEL, 1000, 6000, MIN_SAMPLES);
    }

    function _post2(uint256 mid, uint32 p, uint32 c) internal {
        OniblockHook.Attestation memory a = OniblockHook.Attestation(uint64(vm.getBlockNumber()), mid, p, c, 0, MODEL, "");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorPk, h2.attestationDigest(id2, a));
        a.signature = abi.encodePacked(r, s, v);
        vm.prank(quoter);
        h2.setAttestation(k2, a);
    }

    function _refresh2(uint256 mid) internal {
        uint64 bn = uint64(vm.getBlockNumber());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorPk, h2.midDigest(id2, bn, mid));
        vm.prank(quoter);
        h2.refreshMid(k2, bn, mid, abi.encodePacked(r, s, v));
    }

    function _k2() internal view returns (uint32 k) {
        (OniblockHook.PoolState memory st,,) = h2.poolState(id2);
        k = st.kBps;
    }

    function test_F1fix_midOnlyKeepsK_andRechecksDemotion() public {
        _deployMidOnly();
        uint256 mid = 1 << 96;
        for (uint256 i; i < 3; i++) {
            _post2(mid, 10000, 10000);
            _next();
        }
        assertEq(_k2(), 8000);
        uint256 gasBefore = gasleft();
        _refresh2(mid + 1);
        uint256 gasMid = gasBefore - gasleft();
        assertEq(_k2(), 8000, "mid-only refresh keeps the model's k");
        (OniblockHook.PoolState memory st,,) = h2.poolState(id2);
        assertEq(st.oracleMidX96, mid + 1);
        assertEq(st.modelNode, MODEL, "credited model unchanged");
        _next();
        gasBefore = gasleft();
        _post2(mid, 10000, 10000);
        uint256 gasFull = gasBefore - gasleft();
        emit log_named_uint("gas refreshMid (incl. sign/prank overhead)", gasMid);
        emit log_named_uint("gas setAttestation (incl. sign/prank overhead)", gasFull);
        // replay of the same mid signature is rejected (shared monotonic lastAttestBlock)
        _next();
        _refresh2(mid);
        uint64 bn = uint64(vm.getBlockNumber());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorPk, h2.midDigest(id2, bn, mid));
        vm.prank(quoter);
        vm.expectRevert(OniblockHook.AlreadyAttested.selector);
        h2.refreshMid(k2, bn, mid, abi.encodePacked(r, s, v));
        // a full-attestation signature cannot be used as a mid-only one (different typehash)
        _next();
        OniblockHook.Attestation memory a = OniblockHook.Attestation(uint64(vm.getBlockNumber()), mid, 0, 0, 0, MODEL, "");
        (v, r, s) = vm.sign(attestorPk, h2.attestationDigest(id2, a));
        vm.prank(quoter);
        vm.expectRevert(OniblockHook.BadSignature.selector);
        h2.refreshMid(k2, uint64(vm.getBlockNumber()), mid, abi.encodePacked(r, s, v));
        // demotion after the fact is enforced at the next mid-only refresh (k -> kDefault)
        vm.prank(settler);
        h2.setCalibration(MODEL, 9000, 1000, MIN_SAMPLES);
        _refresh2(mid);
        assertEq(_k2(), 5000, "demoted since last model post => kDefault");
        // non-quoter rejected
        _next();
        bn = uint64(vm.getBlockNumber());
        (v, r, s) = vm.sign(attestorPk, h2.midDigest(id2, bn, mid));
        vm.expectRevert(OniblockHook.NotQuoter.selector);
        h2.refreshMid(k2, bn, mid, abi.encodePacked(r, s, v));
    }
}
