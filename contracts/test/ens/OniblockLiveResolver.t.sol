// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";

import {OniblockTestBase} from "../utils/OniblockTestBase.sol";
import {OniblockHook} from "../../src/OniblockHook.sol";
import {OniblockLiveResolver} from "../../src/ens/OniblockLiveResolver.sol";
import {DnsNameLib} from "../../src/ens/DnsNameLib.sol";
import {EnsV2Lib} from "../../src/roles/EnsV2Lib.sol";
import {IEnsProfiles, IEnsAddressProfile, IEnsMulticallable} from "../../src/interfaces/ens/IEnsV2.sol";

/// External wrappers so reverts of the internal library can be asserted.
contract DnsNameLibHarness {
    function nextLabel(bytes memory name, uint256 offset) external pure returns (uint8, uint256) {
        return DnsNameLib.nextLabel(name, offset);
    }

    function readLabel(bytes memory name, uint256 offset) external pure returns (string memory, uint256) {
        return DnsNameLib.readLabel(name, offset);
    }

    function labelhash(bytes memory name, uint256 offset) external pure returns (bytes32, uint256) {
        return DnsNameLib.labelhash(name, offset);
    }

    function namehash(bytes memory name, uint256 offset) external pure returns (bytes32) {
        return DnsNameLib.namehash(name, offset);
    }

    function countLabels(bytes memory name, uint256 offset) external pure returns (uint256) {
        return DnsNameLib.countLabels(name, offset);
    }

    function isValid(bytes memory name) external pure returns (bool) {
        return DnsNameLib.isValid(name);
    }

    function suffixEquals(bytes memory name, uint256 offset, bytes memory suffix) external pure returns (bool) {
        return DnsNameLib.suffixEquals(name, offset, suffix);
    }
}

/// OniblockLiveResolver against a real hook (OniblockTestBase): every record is read from the hook's storage.
contract OniblockLiveResolverTest is OniblockTestBase {
    string constant BASE = "live.oniblock.eth";
    string constant PARENT = "oniblock.eth";
    string constant POOL_LABEL = "weth-usdc";
    bytes4 constant SEL_TEXT = 0x59d1d43c; // text(bytes32,string)
    bytes4 constant SEL_ADDR = 0x3b3b57de; // addr(bytes32)
    bytes4 constant SEL_ADDR_COIN = 0xf1cb7e06; // addr(bytes32,uint256)
    bytes4 constant SEL_EXTENDED = 0x9061b923; // resolve(bytes,bytes)
    bytes4 constant SEL_ERC165 = 0x01ffc9a7;
    bytes4 constant SEL_ERC7996 = 0x582de3e7; // supportsFeature(bytes4)
    bytes4 constant SEL_CONTENTHASH = 0xbc1c58d1; // contenthash(bytes32)
    bytes4 constant FEATURE_MULTICALL = 0x96b62db8;

    OniblockLiveResolver live;
    DnsNameLibHarness dns;
    bytes32 modelsNode;
    bytes32 poolsNode;
    bytes32 jev;
    bytes32 kev;
    bytes32 heur;
    uint256 calibratedAt;

    function setUp() public override {
        super.setUp();
        dns = new DnsNameLibHarness();
        modelsNode = EnsV2Lib.namehash("models.oniblock.eth");
        poolsNode = EnsV2Lib.namehash("pools.oniblock.eth");
        live = new OniblockLiveResolver(
            owner, hook, PoolId.unwrap(pid), pkey, modelsNode, poolsNode, BASE, POOL_LABEL
        );
        live.setKnownLabels(_labels());
        jev = live.modelNodeOf("jev-v1");
        kev = live.modelNodeOf("kev-v1");
        heur = live.modelNodeOf("heuristic-v1");
        assertEq(jev, EnsV2Lib.namehash("jev-v1.models.oniblock.eth"));
        hook.setModelAllowed(pid, jev, true);
        hook.setModelAllowed(pid, kev, true);
        vm.prank(settler);
        hook.setCalibration(jev, 1830, 6120, 12); // brier <= brierDemoteBps => active
        calibratedAt = block.number;
    }

    // ------------------------------------------------------------------ helpers
    function _labels() internal pure returns (string[] memory l) {
        l = new string[](4);
        l[0] = "jev-v1";
        l[1] = "heuristic-v1";
        l[2] = "kev-v1";
        l[3] = "rule-v1";
    }

    function _textCall(string memory name, string memory key) internal pure returns (bytes memory) {
        return abi.encodeCall(IEnsProfiles.text, (EnsV2Lib.namehash(name), key));
    }

    /// ENSIP-10 read as the UniversalResolver does it: resolve(dnsName, text(node, key)).
    function _text(string memory name, string memory key) internal view returns (string memory) {
        return abi.decode(live.resolve(EnsV2Lib.dnsEncode(name), _textCall(name, key)), (string));
    }

    function _addrOf(string memory name) internal view returns (address) {
        return abi.decode(
            live.resolve(EnsV2Lib.dnsEncode(name), abi.encodeCall(IEnsProfiles.addr, (EnsV2Lib.namehash(name)))),
            (address)
        );
    }

    function _hex(bytes32 v) internal pure returns (string memory) {
        return Strings.toHexString(uint256(v), 32);
    }

    function _hexAddr(address a) internal pure returns (string memory) {
        return Strings.toChecksumHexString(a);
    }

    /// Posts a signed attestation for `model` at the current block from the quoter.
    function _attest(bytes32 model, uint256 mid, uint32 p, uint32 c, uint32 pJit) internal {
        OniblockHook.Attestation memory a =
            _attestation(pid, uint64(block.number), mid, p, c, pJit, model, attestorPk);
        vm.prank(quoter);
        hook.setAttestation(pkey, a);
    }

    // ------------------------------------------------------------------ constructor
    function test_constructor_state() public view {
        assertEq(address(live.hook()), address(hook));
        assertEq(live.poolId(), PoolId.unwrap(pid));
        assertEq(live.modelsNode(), modelsNode);
        assertEq(live.poolsNode(), poolsNode);
        assertEq(live.baseNode(), EnsV2Lib.namehash(BASE));
        assertEq(live.poolLiveNode(), EnsV2Lib.namehash("weth-usdc.live.oniblock.eth"));
        assertEq(live.currentNode(), EnsV2Lib.namehash("current.live.oniblock.eth"));
        assertEq(live.poolRegistryNode(), EnsV2Lib.namehash("weth-usdc.pools.oniblock.eth"));
        assertEq(live.baseName(), BASE);
        assertEq(live.parentName(), PARENT);
        assertEq(live.poolLabel(), POOL_LABEL);
        assertEq(live.owner(), owner);
        PoolKey memory k = live.poolKey();
        assertEq(address(k.hooks), address(hook));
        assertEq(k.fee, pkey.fee);
        assertEq(keccak256(abi.encode(live.knownLabels())), keccak256(abi.encode(_labels())));
        assertEq(live.labelOf(kev), "kev-v1");
        assertEq(live.labelOf(keccak256("nope")), "");
    }

    function test_constructor_rejectsMismatches() public {
        vm.expectRevert(OniblockLiveResolver.BadPool.selector);
        new OniblockLiveResolver(owner, hook, keccak256("wrong pool id"), pkey, modelsNode, poolsNode, BASE, POOL_LABEL);

        PoolKey memory bad = pkey;
        bad.hooks = IHooks(address(0));
        vm.expectRevert(OniblockLiveResolver.BadPool.selector);
        new OniblockLiveResolver(owner, hook, PoolId.unwrap(bad.toId()), bad, modelsNode, poolsNode, BASE, POOL_LABEL);

        vm.expectRevert(
            abi.encodeWithSelector(
                OniblockLiveResolver.NodeMismatch.selector, "models.oniblock.eth", modelsNode, poolsNode
            )
        );
        new OniblockLiveResolver(owner, hook, PoolId.unwrap(pid), pkey, poolsNode, poolsNode, BASE, POOL_LABEL);

        vm.expectRevert(abi.encodeWithSelector(OniblockLiveResolver.BadName.selector, "live"));
        new OniblockLiveResolver(owner, hook, PoolId.unwrap(pid), pkey, modelsNode, poolsNode, "live", POOL_LABEL);

        vm.expectRevert(abi.encodeWithSelector(OniblockLiveResolver.BadName.selector, ""));
        new OniblockLiveResolver(owner, hook, PoolId.unwrap(pid), pkey, modelsNode, poolsNode, BASE, "");
    }

    // ------------------------------------------------------------------ <label>.live: calibration round-trip
    function test_modelRecords_roundTrip() public view {
        string memory n = "jev-v1.live.oniblock.eth";
        assertEq(_text(n, "calibration.brier"), "1830");
        assertEq(_text(n, "calibration.hitRate"), "6120");
        assertEq(_text(n, "calibration.n"), "12");
        assertEq(_text(n, "calibration.epoch"), Strings.toString(calibratedAt));
        assertEq(_text(n, "allowed"), "true");
        assertEq(_text(n, "demoted"), "false");
        assertEq(_text(n, "status"), "active");
        assertEq(_text(n, "model-node"), _hex(jev));
        assertEq(_text(n, "models-name"), "jev-v1.models.oniblock.eth");
        assertEq(_text(n, "live-name"), n);
        assertGt(bytes(_text(n, "description")).length, 0);
        // JIT head: no record yet => active
        assertEq(_text(n, "calibration.jit.brier"), "0");
        assertEq(_text(n, "calibration.jit.n"), "0");
        assertEq(_text(n, "jit.demoted"), "false");
        assertEq(_text(n, "jit.status"), "active");
        // unset key => "" (ENS convention)
        assertEq(_text(n, "url"), "");
        assertEq(_text(n, "calibration.skill"), "");
        // node in `data` is ignored: the name is authoritative
        string memory viaWrongNode = abi.decode(
            live.resolve(EnsV2Lib.dnsEncode(n), abi.encodeCall(IEnsProfiles.text, (bytes32(0), "calibration.brier"))),
            (string)
        );
        assertEq(viaWrongNode, "1830");
    }

    function test_jitRecords_roundTrip() public {
        string memory n = "jev-v1.live.oniblock.eth";
        vm.roll(block.number + 3);
        bytes32 jitKey = hook.jitCalibrationKey(jev);
        vm.prank(settler);
        hook.setCalibration(jitKey, 900, 7000, 11);
        assertEq(_text(n, "calibration.jit.brier"), "900");
        assertEq(_text(n, "calibration.jit.hitRate"), "7000");
        assertEq(_text(n, "calibration.jit.n"), "11");
        assertEq(_text(n, "calibration.jit.epoch"), Strings.toString(block.number));
        assertEq(_text(n, "jit.demoted"), "false");
        assertEq(_text(n, "jit.status"), "active");
        // the arb head is untouched
        assertEq(_text(n, "calibration.brier"), "1830");
        assertEq(_text(n, "status"), "active");
        // JIT Brier over the gate => demoted, arb head still active
        vm.prank(settler);
        hook.setCalibration(jitKey, 2600, 7000, 11);
        assertEq(_text(n, "jit.status"), "demoted");
        assertEq(_text(n, "jit.demoted"), "true");
        assertEq(_text(n, "status"), "active");
    }

    function test_status_unknown_demoted_active() public {
        string memory n = "kev-v1.live.oniblock.eth";
        // allowlisted, no calibration => active (isDemoted false)
        assertEq(_text(n, "allowed"), "true");
        assertEq(_text(n, "status"), "active");
        assertEq(_text(n, "demoted"), "false");
        assertEq(_text(n, "calibration.n"), "0");
        // a single graded sample with a good Brier => still active
        vm.prank(settler);
        hook.setCalibration(kev, 1000, 5000, 1);
        assertEq(_text(n, "status"), "active");
        // Brier over brierDemoteBps (2500) => demoted
        vm.prank(settler);
        hook.setCalibration(kev, 2600, 5000, CAL_N);
        assertEq(_text(n, "status"), "demoted");
        assertEq(_text(n, "demoted"), "true");
        assertEq(_text(n, "calibration.brier"), "2600");
        // good Brier => active
        vm.prank(settler);
        hook.setCalibration(kev, 1200, 5500, CAL_N);
        assertEq(_text(n, "status"), "active");
        assertEq(_text(n, "demoted"), "false");
        // de-allowlisted => unknown, whatever the record says
        hook.setModelAllowed(pid, kev, false);
        assertEq(_text(n, "status"), "unknown");
        assertEq(_text(n, "allowed"), "false");
        assertEq(_text(n, "calibration.brier"), "1200");
    }

    function test_unknownLabel_isUnknown() public view {
        string memory n = "nobody-v9.live.oniblock.eth";
        bytes32 node = keccak256(abi.encodePacked(modelsNode, keccak256("nobody-v9")));
        assertEq(_text(n, "status"), "unknown");
        assertEq(_text(n, "jit.status"), "unknown");
        assertEq(_text(n, "allowed"), "false");
        assertEq(_text(n, "demoted"), "true");
        assertEq(_text(n, "calibration.n"), "0");
        assertEq(_text(n, "calibration.brier"), "0");
        assertEq(_text(n, "model-node"), _hex(node));
        assertEq(_text(n, "models-name"), "nobody-v9.models.oniblock.eth");
        // heuristic-v1: known label, registered in ENS, but not allowlisted on this pool
        assertEq(_text("heuristic-v1.live.oniblock.eth", "status"), "unknown");
    }

    // ------------------------------------------------------------------ <poolLabel>.live: pool state
    function test_poolRecords_staleThenAttested() public {
        string memory n = "weth-usdc.live.oniblock.eth";
        // static
        assertEq(_text(n, "hook"), _hexAddr(address(hook)));
        assertEq(_text(n, "pool-id"), _hex(PoolId.unwrap(pid)));
        assertEq(_text(n, "pool-node"), _hex(EnsV2Lib.namehash("weth-usdc.pools.oniblock.eth")));
        assertEq(_text(n, "pools-name"), "weth-usdc.pools.oniblock.eth");
        assertEq(_text(n, "base-fee"), "3000");
        assertEq(_text(n, "fee-max"), "10000");
        assertEq(_text(n, "conservative-fee"), "5000");
        assertEq(_text(n, "k-min"), "2000");
        assertEq(_text(n, "k-max"), "8000");
        assertEq(_text(n, "k-default"), "5000");
        assertEq(_text(n, "max-k-step"), "1000");
        assertEq(_text(n, "stale-blocks"), "5");
        assertEq(_text(n, "min-samples"), ""); // removed: no sample minimum on-chain
        assertEq(_text(n, "brier-demote"), "2500");
        assertEq(_text(n, "arb-threshold"), Strings.toString(ARB_THRESHOLD));
        assertEq(_text(n, "jit-window-min"), "10");
        assertEq(_text(n, "jit-window-max"), "100");
        assertEq(_text(n, "jit-window-default"), "10");
        assertGt(bytes(_text(n, "description")).length, 0);
        assertEq(_text(n, "nonsense"), "");
        // no attestation yet: stale, k = kDefault, conservative fee both ways, default JIT window
        assertEq(_text(n, "stale"), "true");
        assertEq(_text(n, "k"), "5000");
        assertEq(_text(n, "fee-zero-for-one"), "5000");
        assertEq(_text(n, "fee-one-for-zero"), "5000");
        assertEq(_text(n, "jit-window"), "10");
        assertEq(_text(n, "model"), _hex(bytes32(0)));
        assertEq(_text(n, "last-model"), _hex(bytes32(0)));
        assertEq(_text(n, "last-attest-block"), "0");
        assertEq(_text(n, "oracle-mid-x96"), "0");

        // attest with jev (active): target k = 2000 + 6000 * 1 * 1 = 8000, step-limited from 5000 => 6000
        uint256 px = _poolX96(pid);
        uint256 mid = px * 10100 / 10000; // pool 1% below the mid => oneForZero is the arb direction
        _attest(jev, mid, 10000, 10000, 3000);
        assertEq(_text(n, "stale"), "false");
        assertEq(_text(n, "k"), "6000");
        assertEq(_text(n, "p-toxic"), "10000");
        assertEq(_text(n, "confidence"), "10000");
        assertEq(_text(n, "p-jit"), "3000");
        assertEq(_text(n, "jit-window"), "37"); // JIT head active (no record): 10 + 90 * 0.3 * 1
        assertEq(_text(n, "model"), _hex(jev));
        assertEq(_text(n, "last-model"), _hex(jev));
        assertEq(_text(n, "oracle-mid-x96"), Strings.toString(mid));
        assertEq(_text(n, "last-attest-block"), Strings.toString(block.number));
        assertEq(_text(n, "last-post-block"), Strings.toString(block.number));
        assertEq(_text(n, "attest-block"), Strings.toString(block.number));
        (uint24 f01,,,) = hook.quoteFee(pkey, true);
        (uint24 f10,, uint32 gap,) = hook.quoteFee(pkey, false);
        assertEq(f01, 3000, "not the arb direction => base");
        assertGt(f10, 3000, "arb direction pays the premium");
        assertEq(_text(n, "fee-zero-for-one"), Strings.toString(f01));
        assertEq(_text(n, "fee-one-for-zero"), Strings.toString(f10));
        assertEq(_text(n, "gap-one-for-zero"), Strings.toString(gap));
        assertEq(_text(n, "gap-zero-for-one"), "0");

        // past staleBlocks the pool is stale again: anchor model 0, last-model still jev
        vm.roll(block.number + 6);
        assertEq(_text(n, "stale"), "true");
        assertEq(_text(n, "k"), "5000");
        assertEq(_text(n, "model"), _hex(bytes32(0)));
        assertEq(_text(n, "last-model"), _hex(jev));
        assertEq(_text(n, "fee-one-for-zero"), "5000");
    }

    function test_poolRecords_quoteRevert_isEmpty() public {
        // quoteFee never reverts for a registered pool (stale => conservative fee), so force a revert: the fee
        // records answer "" instead of failing the whole resolve; everything else is unaffected
        string memory n = "weth-usdc.live.oniblock.eth";
        assertEq(_text(n, "fee-zero-for-one"), "5000");
        vm.mockCallRevert(address(hook), abi.encodeWithSelector(OniblockHook.quoteFee.selector), "boom");
        assertEq(_text(n, "fee-zero-for-one"), "");
        assertEq(_text(n, "fee-one-for-zero"), "");
        assertEq(_text(n, "base-fee"), "3000");
        assertEq(_text(n, "k"), "5000");
        vm.clearMockedCalls();
        assertEq(_text(n, "fee-one-for-zero"), "5000");
        // an unregistered pool id still answers (zero config, stale): no revert anywhere
        PoolKey memory other = pkey;
        other.tickSpacing = 120;
        OniblockLiveResolver r = new OniblockLiveResolver(
            owner, hook, PoolId.unwrap(other.toId()), other, modelsNode, poolsNode, BASE, POOL_LABEL
        );
        assertEq(abi.decode(r.resolve(EnsV2Lib.dnsEncode(n), _textCall(n, "stale")), (string)), "true");
        assertEq(abi.decode(r.resolve(EnsV2Lib.dnsEncode(n), _textCall(n, "fee-zero-for-one")), (string)), "0");
    }

    // ------------------------------------------------------------------ current.live: model alias
    function test_currentRecords() public {
        string memory n = "current.live.oniblock.eth";
        assertEq(_text(n, "model-node"), _hex(bytes32(0)));
        assertEq(_text(n, "label"), "");
        assertEq(_text(n, "models-name"), "");
        assertEq(_text(n, "live-name"), "");
        assertEq(_text(n, "status"), "unknown");
        assertEq(_text(n, "stale"), "true");
        assertEq(_text(n, "k"), "5000");
        assertGt(bytes(_text(n, "description")).length, 0);

        _attest(jev, _poolX96(pid), 10000, 10000, 0);
        assertEq(_text(n, "model-node"), _hex(jev));
        assertEq(_text(n, "label"), "jev-v1");
        assertEq(_text(n, "models-name"), "jev-v1.models.oniblock.eth");
        assertEq(_text(n, "live-name"), "jev-v1.live.oniblock.eth");
        assertEq(_text(n, "status"), "active");
        assertEq(_text(n, "jit.status"), "active");
        assertEq(_text(n, "stale"), "false");
        assertEq(_text(n, "k"), "6000");
        (bytes32 node, string memory label, bool stale) = live.currentModel();
        assertEq(node, jev);
        assertEq(label, "jev-v1");
        assertFalse(stale);

        // stale again: the alias keeps pointing at the last accepted model, flagged stale
        vm.roll(block.number + 6);
        assertEq(_text(n, "model-node"), _hex(jev));
        assertEq(_text(n, "label"), "jev-v1");
        assertEq(_text(n, "stale"), "true");

        // a model the owner never listed resolves to an empty label but a real node
        bytes32 mystery = live.modelNodeOf("mystery-v1");
        hook.setModelAllowed(pid, mystery, true);
        vm.prank(settler);
        hook.setCalibration(mystery, 500, 8000, CAL_N);
        vm.roll(block.number + 1);
        _attest(mystery, _poolX96(pid), 10000, 10000, 0);
        assertEq(_text(n, "model-node"), _hex(mystery));
        assertEq(_text(n, "label"), "");
        assertEq(_text(n, "models-name"), "");
        assertEq(_text(n, "status"), "active");
        // ... until the owner adds the label
        string[] memory l = new string[](1);
        l[0] = "mystery-v1";
        live.setKnownLabels(l);
        assertEq(_text(n, "label"), "mystery-v1");
        assertEq(_text(n, "models-name"), "mystery-v1.models.oniblock.eth");
    }

    // ------------------------------------------------------------------ live.oniblock.eth itself
    function test_baseRecords() public view {
        string memory n = BASE;
        assertGt(bytes(_text(n, "description")).length, 0);
        assertEq(_text(n, "hook"), _hexAddr(address(hook)));
        assertEq(_text(n, "pool-id"), _hex(PoolId.unwrap(pid)));
        assertEq(_text(n, "pool"), POOL_LABEL);
        assertEq(_text(n, "pool-name"), "weth-usdc.live.oniblock.eth");
        assertEq(_text(n, "models-name"), "models.oniblock.eth");
        assertEq(_text(n, "resolver"), _hexAddr(address(live)));
        assertEq(_text(n, "known-labels"), "jev-v1,heuristic-v1,kev-v1,rule-v1");
        assertEq(_text(n, "nonsense"), "");
    }

    // ------------------------------------------------------------------ addr profiles
    function test_addr() public {
        assertEq(_addrOf("weth-usdc.live.oniblock.eth"), address(hook));
        assertEq(_addrOf(BASE), address(hook));
        // addr(node, 60) = packed hook; other coin types empty
        bytes memory out = live.resolve(
            EnsV2Lib.dnsEncode(BASE), abi.encodeCall(IEnsAddressProfile.addr, (EnsV2Lib.namehash(BASE), 60))
        );
        assertEq(abi.decode(out, (bytes)), abi.encodePacked(address(hook)));
        out = live.resolve(
            EnsV2Lib.dnsEncode(BASE), abi.encodeCall(IEnsAddressProfile.addr, (EnsV2Lib.namehash(BASE), 0))
        );
        assertEq(abi.decode(out, (bytes)).length, 0);
        // model and current names have no address: revert with the UR's error so it propagates unchanged
        bytes memory jevName = EnsV2Lib.dnsEncode("jev-v1.live.oniblock.eth");
        vm.expectRevert(abi.encodeWithSelector(OniblockLiveResolver.UnsupportedResolverProfile.selector, SEL_ADDR));
        live.resolve(jevName, abi.encodeCall(IEnsProfiles.addr, (jev)));
        vm.expectRevert(
            abi.encodeWithSelector(OniblockLiveResolver.UnsupportedResolverProfile.selector, SEL_ADDR_COIN)
        );
        live.resolve(jevName, abi.encodeCall(IEnsAddressProfile.addr, (jev, 60)));
        vm.expectRevert(abi.encodeWithSelector(OniblockLiveResolver.UnsupportedResolverProfile.selector, SEL_ADDR));
        live.resolve(EnsV2Lib.dnsEncode("current.live.oniblock.eth"), abi.encodeCall(IEnsProfiles.addr, (bytes32(0))));
    }

    function test_unsupportedSelector_reverts() public {
        bytes memory name = EnsV2Lib.dnsEncode("weth-usdc.live.oniblock.eth");
        bytes32 node = live.poolLiveNode();
        vm.expectRevert(
            abi.encodeWithSelector(OniblockLiveResolver.UnsupportedResolverProfile.selector, SEL_CONTENTHASH)
        );
        live.resolve(name, abi.encodeWithSelector(SEL_CONTENTHASH, node));
        // name(bytes32)
        vm.expectRevert(
            abi.encodeWithSelector(OniblockLiveResolver.UnsupportedResolverProfile.selector, bytes4(0x691f3431))
        );
        live.resolve(name, abi.encodeWithSelector(bytes4(0x691f3431), node));
    }

    function test_multicall_insideResolve() public view {
        string memory n = "weth-usdc.live.oniblock.eth";
        bytes[] memory calls = new bytes[](4);
        calls[0] = _textCall(n, "k");
        calls[1] = _textCall(n, "stale");
        calls[2] = abi.encodeCall(IEnsProfiles.addr, (EnsV2Lib.namehash(n)));
        calls[3] = abi.encodeWithSelector(SEL_CONTENTHASH, EnsV2Lib.namehash(n));
        bytes memory out = live.resolve(EnsV2Lib.dnsEncode(n), abi.encodeCall(IEnsMulticallable.multicall, (calls)));
        bytes[] memory res = abi.decode(out, (bytes[]));
        assertEq(res.length, 4);
        assertEq(abi.decode(res[0], (string)), "5000");
        assertEq(abi.decode(res[1], (string)), "true");
        assertEq(abi.decode(res[2], (address)), address(hook));
        assertEq(bytes4(res[3]), OniblockLiveResolver.UnsupportedResolverProfile.selector, "revert data is passed through");
        assertTrue(live.supportsFeature(FEATURE_MULTICALL));
    }

    // ------------------------------------------------------------------ DNS name parsing
    function test_dns_wrongParent_reverts() public {
        bytes memory n1 = EnsV2Lib.dnsEncode("jev-v1.models.oniblock.eth");
        vm.expectRevert(abi.encodeWithSelector(OniblockLiveResolver.WrongParent.selector, n1));
        live.resolve(n1, _textCall("jev-v1.models.oniblock.eth", "status"));

        bytes memory n2 = EnsV2Lib.dnsEncode("oniblock.eth"); // shorter than the base
        vm.expectRevert(abi.encodeWithSelector(OniblockLiveResolver.WrongParent.selector, n2));
        live.resolve(n2, _textCall("oniblock.eth", "status"));

        bytes memory n3 = EnsV2Lib.dnsEncode("xlive.oniblock.eth"); // same length as a 1-char label, not our parent
        vm.expectRevert(abi.encodeWithSelector(OniblockLiveResolver.WrongParent.selector, n3));
        live.resolve(n3, _textCall("xlive.oniblock.eth", "status"));

        bytes memory n4 = EnsV2Lib.dnsEncode("live.oniblock.xyz");
        vm.expectRevert(abi.encodeWithSelector(OniblockLiveResolver.WrongParent.selector, n4));
        live.resolve(n4, _textCall("live.oniblock.xyz", "status"));

        bytes memory n5 = EnsV2Lib.dnsEncode("eth");
        vm.expectRevert(abi.encodeWithSelector(OniblockLiveResolver.WrongParent.selector, n5));
        live.resolve(n5, _textCall("eth", "status"));
    }

    function test_dns_deeperName_reverts() public {
        bytes memory n = EnsV2Lib.dnsEncode("a.jev-v1.live.oniblock.eth");
        vm.expectRevert(abi.encodeWithSelector(OniblockLiveResolver.NameNotServed.selector, n));
        live.resolve(n, _textCall("a.jev-v1.live.oniblock.eth", "status"));
        // tail bytes equal the base but the boundary is inside a label ("ab\x04live" . oniblock . eth)
        bytes memory tricky = abi.encodePacked(hex"07", "ab", hex"04", "live", hex"08", "oniblock", hex"03", "eth", hex"00");
        assertTrue(dns.isValid(tricky));
        vm.expectRevert(abi.encodeWithSelector(OniblockLiveResolver.NameNotServed.selector, tricky));
        live.resolve(tricky, _textCall("x", "status"));
    }

    function test_dns_malformed_reverts() public {
        bytes memory noTerminator = abi.encodePacked(hex"06", "jev-v1", hex"04", "live", hex"08", "oniblock", hex"03", "eth");
        vm.expectRevert(abi.encodeWithSelector(DnsNameLib.DnsDecodingFailed.selector, noTerminator));
        live.resolve(noTerminator, _textCall("x", "status"));

        bytes memory junkAfter = abi.encodePacked(EnsV2Lib.dnsEncode("jev-v1.live.oniblock.eth"), hex"00");
        vm.expectRevert(abi.encodeWithSelector(DnsNameLib.DnsDecodingFailed.selector, junkAfter));
        live.resolve(junkAfter, _textCall("x", "status"));

        bytes memory overflow = hex"09616200"; // length 9, only 2 bytes follow
        vm.expectRevert(abi.encodeWithSelector(DnsNameLib.DnsDecodingFailed.selector, overflow));
        live.resolve(overflow, _textCall("x", "status"));

        bytes memory empty;
        vm.expectRevert(abi.encodeWithSelector(DnsNameLib.DnsDecodingFailed.selector, empty));
        live.resolve(empty, _textCall("x", "status"));

        bytes memory root = hex"00"; // valid, but not our parent
        vm.expectRevert(abi.encodeWithSelector(OniblockLiveResolver.WrongParent.selector, root));
        live.resolve(root, _textCall("x", "status"));
    }

    function test_dns_baseAndLabelKinds() public view {
        // exactly the base name
        assertEq(_text(BASE, "pool"), POOL_LABEL);
        // 1-byte and 255-byte labels are model labels
        assertEq(_text("a.live.oniblock.eth", "status"), "unknown");
        bytes memory longLabel = new bytes(255);
        for (uint256 i; i < 255; ++i) {
            longLabel[i] = "z";
        }
        string memory longName = string.concat(string(longLabel), ".", BASE);
        assertEq(_text(longName, "status"), "unknown");
        assertEq(_text(longName, "models-name"), string.concat(string(longLabel), ".models.oniblock.eth"));
        // labels are byte-exact: "JEV-V1" is not "jev-v1"
        assertEq(_text("JEV-V1.live.oniblock.eth", "status"), "unknown");
        assertEq(_text("jev-v1.live.oniblock.eth", "status"), "active");
    }

    function test_dnsNameLib() public {
        bytes memory n = EnsV2Lib.dnsEncode("jev-v1.models.oniblock.eth");
        (string memory l, uint256 next) = dns.readLabel(n, 0);
        assertEq(l, "jev-v1");
        assertEq(next, 7);
        (l, next) = dns.readLabel(n, 7);
        assertEq(l, "models");
        assertEq(next, 14);
        (l, next) = dns.readLabel(n, n.length - 1);
        assertEq(l, "");
        assertEq(next, n.length);
        (bytes32 h,) = dns.labelhash(n, 0);
        assertEq(h, keccak256("jev-v1"));
        (h,) = dns.labelhash(n, n.length - 1);
        assertEq(h, bytes32(0));
        assertEq(dns.namehash(n, 0), EnsV2Lib.namehash("jev-v1.models.oniblock.eth"));
        assertEq(dns.namehash(n, 7), EnsV2Lib.namehash("models.oniblock.eth"));
        assertEq(dns.namehash(n, n.length - 1), bytes32(0));
        assertEq(dns.namehash(hex"00", 0), bytes32(0));
        assertEq(dns.countLabels(n, 0), 4);
        assertEq(dns.countLabels(n, 7), 3);
        assertEq(dns.countLabels(hex"00", 0), 0);
        assertTrue(dns.isValid(n));
        assertTrue(dns.isValid(hex"00"));
        assertFalse(dns.isValid(""));
        assertFalse(dns.isValid(hex"0161")); // no terminator
        assertFalse(dns.isValid(hex"016100ff")); // junk after terminator
        assertFalse(dns.isValid(hex"0561")); // length runs past the end
        assertTrue(dns.suffixEquals(n, 7, EnsV2Lib.dnsEncode("models.oniblock.eth")));
        assertTrue(dns.suffixEquals(n, 0, n));
        assertFalse(dns.suffixEquals(n, 8, EnsV2Lib.dnsEncode("models.oniblock.eth")));
        assertFalse(dns.suffixEquals(n, 7, EnsV2Lib.dnsEncode("pools.oniblock.eth")));
        assertFalse(dns.suffixEquals(n, n.length + 1, hex"00"));
        vm.expectRevert(abi.encodeWithSelector(DnsNameLib.DnsDecodingFailed.selector, hex"0161"));
        dns.nextLabel(hex"0161", 0);
        vm.expectRevert(abi.encodeWithSelector(DnsNameLib.DnsDecodingFailed.selector, n));
        dns.nextLabel(n, n.length);
    }

    // ------------------------------------------------------------------ ERC-165 / ERC-7996
    function test_erc165() public view {
        assertTrue(live.supportsInterface(SEL_ERC165));
        assertTrue(live.supportsInterface(SEL_EXTENDED), "IExtendedResolver: what the UR requires for wildcards");
        assertTrue(live.supportsInterface(SEL_ERC7996), "IERC7996: lets the UR call resolve() directly");
        assertTrue(live.supportsInterface(SEL_TEXT));
        assertTrue(live.supportsInterface(SEL_ADDR));
        assertTrue(live.supportsInterface(SEL_ADDR_COIN));
        assertFalse(live.supportsInterface(0xffffffff));
        assertFalse(live.supportsInterface(SEL_CONTENTHASH));
        assertFalse(live.supportsInterface(0xac9650d8)); // not an IMulticallable writer
        assertTrue(live.supportsFeature(FEATURE_MULTICALL));
        assertEq(live.FEATURE_RESOLVE_MULTICALL(), FEATURE_MULTICALL);
        assertFalse(live.supportsFeature(0x86fb8da8)); // SINGULAR: records depend on the name
        assertFalse(live.supportsFeature(0x00000000));
    }

    // ------------------------------------------------------------------ direct getters (known nodes only)
    function test_directGetters() public {
        assertEq(live.text(live.liveNodeOf("jev-v1"), "status"), "active");
        assertEq(live.text(live.liveNodeOf("kev-v1"), "status"), "active");
        assertEq(live.text(live.baseNode(), "pool"), POOL_LABEL);
        assertEq(live.text(live.poolLiveNode(), "k"), "5000");
        assertEq(live.text(live.currentNode(), "label"), "");
        assertEq(live.addr(live.poolLiveNode()), address(hook));
        assertEq(live.addr(live.baseNode()), address(hook));
        assertEq(live.addr(live.poolLiveNode(), 60), abi.encodePacked(address(hook)));
        assertEq(live.addr(live.poolLiveNode(), 1).length, 0);
        bytes32 unknown = live.liveNodeOf("nobody-v9");
        vm.expectRevert(abi.encodeWithSelector(OniblockLiveResolver.UnknownNode.selector, unknown));
        live.text(unknown, "status");
        vm.expectRevert(abi.encodeWithSelector(OniblockLiveResolver.UnknownNode.selector, unknown));
        live.addr(unknown);
        bytes32 jevLive = live.liveNodeOf("jev-v1");
        bytes32 cur = live.currentNode();
        vm.expectRevert(abi.encodeWithSelector(OniblockLiveResolver.UnsupportedResolverProfile.selector, SEL_ADDR));
        live.addr(jevLive);
        vm.expectRevert(abi.encodeWithSelector(OniblockLiveResolver.UnsupportedResolverProfile.selector, SEL_ADDR));
        live.addr(cur);
    }

    // ------------------------------------------------------------------ known labels (owner)
    function test_setKnownLabels_onlyOwner_andReplace() public {
        string[] memory l = new string[](1);
        l[0] = "only-v1";
        vm.prank(quoter);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, quoter));
        live.setKnownLabels(l);

        bytes32 oldNode = live.liveNodeOf("jev-v1");
        live.setKnownLabels(l);
        assertEq(live.knownLabels().length, 1);
        assertEq(live.knownLabels()[0], "only-v1");
        assertEq(_text(BASE, "known-labels"), "only-v1");
        assertEq(live.labelOf(jev), "", "old reverse mapping cleared");
        assertEq(live.labelOf(live.modelNodeOf("only-v1")), "only-v1");
        vm.expectRevert(abi.encodeWithSelector(OniblockLiveResolver.UnknownNode.selector, oldNode));
        live.text(oldNode, "status");
        assertEq(live.text(live.liveNodeOf("only-v1"), "status"), "unknown");
        // wildcard resolution never depended on the list
        assertEq(_text("jev-v1.live.oniblock.eth", "status"), "active");

        string[] memory bad = new string[](1);
        bad[0] = "";
        vm.expectRevert(abi.encodeWithSelector(OniblockLiveResolver.BadName.selector, ""));
        live.setKnownLabels(bad);

        live.setKnownLabels(new string[](0));
        assertEq(_text(BASE, "known-labels"), "");
    }
}
