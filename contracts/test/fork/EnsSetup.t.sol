// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {EnsSetup} from "../../script/EnsSetup.s.sol";
import {
    IEnsPermissionedRegistry,
    IEnsETHRegistrar,
    IEnsPermissionedResolver,
    IEnsUniversalResolver,
    IEnsProfiles,
    IEnsVerifiableFactory
} from "../../src/interfaces/ens/IEnsV2.sol";
import {EnsV2Lib} from "../../src/roles/EnsV2Lib.sol";
import {EnsV2RoleOracle} from "../../src/roles/EnsV2RoleOracle.sol";

/// @notice Full ENSv2 setup on a Sepolia fork (no broadcast).
/// Run: FORK=1 SEPOLIA_RPC_HTTPS=<rpc> forge test --match-path test/fork/EnsSetup.t.sol -vv
///   (FORK_URL=http://127.0.0.1:8546 to use a local `anvil --fork-url` instead; FORK_BLOCK to pin.)
contract EnsSetupForkTest is Test {
    // Sepolia ENSv2 (redeploy 2026-09-15), overridable via env.
    address constant REGISTRAR = 0xAbe76F6C8DFcEd81AA5A2bB8034202A7136b94ca;
    address constant FACTORY = 0x9e726Eb570beb6BCEb495AB8cdA7df517d4e841C;
    address constant USER_REGISTRY_IMPL = 0xA80338aAA8D23831cEa25E858D1774534aBb0263;
    address constant RESOLVER_IMPL = 0x14F09Fd05d4585759e54844DC9B00147131Cf243;
    address constant MOCK_USDC = 0x16f95D91DBa7dA3Aca778Ec053dF0FF6C6A8aA8e;
    address constant UNIVERSAL_RESOLVER = 0x5d25C1D6aCBb71B7a28AA7899618a3412a8303e3;

    EnsSetup setup;
    EnsSetup.Config cfg;
    EnsSetup.Result r;

    address owner = makeAddr("oniblock.ens.owner");
    address quoter = makeAddr("oniblock.ens.quoter");
    address backupQuoter = makeAddr("oniblock.ens.backupQuoter");
    address settler = makeAddr("oniblock.ens.settler");
    address rando = makeAddr("oniblock.ens.rando");

    string constant NAME = "oniblock.eth";

    function setUp() public {
        if (!vm.envOr("FORK", false)) {
            vm.skip(true);
            return;
        }
        string memory url = vm.envOr("FORK_URL", vm.envOr("SEPOLIA_RPC_HTTPS", string("")));
        require(bytes(url).length > 0, "set FORK_URL or SEPOLIA_RPC_HTTPS");
        uint256 blk = vm.envOr("FORK_BLOCK", uint256(0));
        if (blk == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, blk);

        setup = new EnsSetup();
        cfg.ens = EnsSetup.Addrs({
            registrar: vm.envOr("ENS_ETH_REGISTRAR", REGISTRAR),
            factory: vm.envOr("ENS_VERIFIABLE_FACTORY", FACTORY),
            userRegistryImpl: vm.envOr("ENS_USER_REGISTRY_IMPL", USER_REGISTRY_IMPL),
            resolverImpl: vm.envOr("ENS_PERMISSIONED_RESOLVER_IMPL", RESOLVER_IMPL),
            usdc: vm.envOr("ENS_MOCK_USDC", MOCK_USDC),
            universalResolver: vm.envOr("ENS_UNIVERSAL_RESOLVER", UNIVERSAL_RESOLVER)
        });
        cfg.label = "oniblock";
        cfg.owner = owner;
        cfg.quoter = quoter;
        cfg.settler = settler;
        cfg.hook = address(0xB00C);
        cfg.poolId = keccak256("weth-usdc-pool");
        cfg.secret = keccak256("test-secret");
        cfg.duration = 365 days;
        cfg.salt = 0;
        cfg.feeMin = "3000";
        cfg.feeMax = "10000";
        cfg.policyUri = "urn:oniblock:fee-law:v1";
        cfg.modelHashJev = vm.toString(keccak256("typesafe-ai/jev"));
        cfg.modelHashHeuristic = vm.toString(keccak256("oniblock/heuristic-v1"));
        cfg.modelHashKev = "0x24f0793d55e0fde516ebe4da1d187e0468a5f7c830ba9a9f4d48e43f007c88be";

        IEnsETHRegistrar registrar = IEnsETHRegistrar(cfg.ens.registrar);
        assertTrue(registrar.isAvailable("oniblock"), "oniblock.eth must be available at fork block");

        setup.commitPhase(cfg);
        // register before MIN_COMMITMENT_AGE must fail
        vm.prank(owner);
        vm.expectRevert();
        registrar.register("oniblock", owner, cfg.secret, address(0), address(0), cfg.duration, cfg.ens.usdc, 0);

        vm.warp(block.timestamp + registrar.MIN_COMMITMENT_AGE() + 1);
        r = setup.finishPhase(cfg);
    }

    // ------------------------------------------------------------------ registration & tree
    function test_registeredAndWired() public view {
        IEnsETHRegistrar registrar = IEnsETHRegistrar(cfg.ens.registrar);
        assertFalse(registrar.isAvailable("oniblock"));
        IEnsPermissionedRegistry eth = IEnsPermissionedRegistry(r.ethRegistry);
        assertEq(eth.getOwner(EnsV2Lib.labelId("oniblock")), owner);
        assertEq(eth.getSubregistry("oniblock"), r.registry);
        assertEq(eth.getResolver("oniblock"), r.resolver);

        // proxies are genuine VerifiableFactory deployments of the ENS implementations
        IEnsVerifiableFactory f = IEnsVerifiableFactory(cfg.ens.factory);
        assertEq(f.verifyContract(r.registry), cfg.ens.userRegistryImpl);
        assertEq(f.verifyContract(r.resolver), cfg.ens.resolverImpl);

        IEnsPermissionedRegistry reg = IEnsPermissionedRegistry(r.registry);
        assertEq(reg.getSubregistry("models"), r.modelsRegistry);
        assertEq(reg.getSubregistry("pools"), r.poolsRegistry);
        assertEq(IEnsPermissionedRegistry(r.modelsRegistry).getOwner(EnsV2Lib.labelId("jev-v1")), owner);
        assertEq(IEnsPermissionedRegistry(r.modelsRegistry).getOwner(EnsV2Lib.labelId("heuristic-v1")), owner);
        assertEq(IEnsPermissionedRegistry(r.modelsRegistry).getOwner(EnsV2Lib.labelId("kev-v1")), owner);
        assertEq(IEnsPermissionedRegistry(r.poolsRegistry).getOwner(EnsV2Lib.labelId("weth-usdc")), owner);

        // resource of a fresh name = labelhash with low 32 bits = eacVersionId (0)
        assertEq(r.quoterResource, EnsV2Lib.resourceAt(EnsV2Lib.labelId("quoter"), 0));
        assertEq(r.settlerResource, EnsV2Lib.resourceAt(EnsV2Lib.labelId("settler"), 0));
    }

    // ------------------------------------------------------------------ quoter kill switch
    function test_quoterRole_revoke_and_backup() public {
        EnsV2RoleOracle oracle = EnsV2RoleOracle(r.roleOracle);
        IEnsPermissionedRegistry reg = IEnsPermissionedRegistry(r.registry);
        uint256 qid = EnsV2Lib.labelId("quoter");

        assertTrue(oracle.isQuoter(quoter), "quoter");
        assertFalse(oracle.isQuoter(owner), "owner is admin only, not quoter");
        assertFalse(oracle.isQuoter(rando));
        assertFalse(oracle.isQuoter(settler));
        assertTrue(oracle.isSettler(settler), "settler");
        assertFalse(oracle.isSettler(quoter), "roles are per-name");
        // direct EAC call the oracle wraps (labelhash, token id and resource are all accepted as anyId)
        assertTrue(reg.hasRoles(qid, EnsV2Lib.ROLE_QUOTER, quoter));
        assertTrue(reg.hasRoles(r.quoterResource, EnsV2Lib.ROLE_QUOTER, quoter));

        // random account cannot revoke / grant
        vm.prank(rando);
        vm.expectRevert();
        reg.revokeRoles(qid, EnsV2Lib.ROLE_QUOTER, quoter);
        vm.prank(quoter);
        vm.expectRevert();
        reg.grantRoles(qid, EnsV2Lib.ROLE_QUOTER, rando); // holding the role != admin

        // kill switch
        vm.prank(owner);
        assertTrue(reg.revokeRoles(qid, EnsV2Lib.ROLE_QUOTER, quoter));
        assertFalse(oracle.isQuoter(quoter), "revoked quoter loses power");

        // backup keeper
        vm.prank(owner);
        assertTrue(reg.grantRoles(qid, EnsV2Lib.ROLE_QUOTER, backupQuoter));
        assertTrue(oracle.isQuoter(backupQuoter), "backup quoter");
        assertFalse(oracle.isQuoter(quoter));

        // unregistering the name wipes every role (new EAC resource version)
        vm.prank(owner);
        reg.unregister(qid);
        assertFalse(oracle.isQuoter(backupQuoter), "unregister = all roles gone");
    }

    // ------------------------------------------------------------------ calibration records
    function test_settlerWritesCalibration_othersCannot() public {
        IEnsPermissionedResolver res = IEnsPermissionedResolver(r.resolver);
        bytes memory jev = EnsV2Lib.dnsEncode("jev-v1.models.oniblock.eth");

        bytes[] memory calls = new bytes[](4);
        calls[0] = abi.encodeCall(IEnsPermissionedResolver.setText, (jev, "calibration.brier", "1830"));
        calls[1] = abi.encodeCall(IEnsPermissionedResolver.setText, (jev, "calibration.hitRate", "6120"));
        calls[2] = abi.encodeCall(IEnsPermissionedResolver.setText, (jev, "calibration.n", "412"));
        calls[3] = abi.encodeCall(IEnsPermissionedResolver.setText, (jev, "calibration.epoch", "7"));
        vm.prank(settler);
        res.multicall(calls);

        assertEq(_text(jev, "calibration.brier"), "1830");
        assertEq(_text(jev, "calibration.hitRate"), "6120");
        assertEq(_text(jev, "calibration.n"), "412");
        assertEq(_text(jev, "calibration.epoch"), "7");

        // non-settlers cannot write calibration (owner holds only ROLE_SET_TEXT_ADMIN on root)
        vm.prank(rando);
        vm.expectRevert();
        res.setText(jev, "calibration.brier", "0");
        vm.prank(quoter);
        vm.expectRevert();
        res.setText(jev, "calibration.brier", "0");
        vm.prank(owner);
        vm.expectRevert();
        res.setText(jev, "calibration.brier", "0");

        // settler scope is exactly the calibration keys
        vm.prank(settler);
        vm.expectRevert();
        res.setText(jev, "model-hash", "0xdead");

        // owner can rotate the model hash (static key granted to owner)
        vm.prank(owner);
        res.setText(jev, "model-hash", "0xbeef");
        assertEq(_text(jev, "model-hash"), "0xbeef");

        // per-key grants are name-independent: the settler can grade kev-v1 too; others still cannot
        bytes memory kev = EnsV2Lib.dnsEncode("kev-v1.models.oniblock.eth");
        vm.prank(settler);
        res.setText(kev, "calibration.n", "12");
        assertEq(_text(kev, "calibration.n"), "12");
        vm.prank(owner);
        vm.expectRevert();
        res.setText(kev, "calibration.n", "0");

        // revoke settler's per-key role -> write fails
        uint256 brierRes = EnsV2Lib.keyResource("calibration.brier");
        assertTrue(res.hasRoles(brierRes, EnsV2Lib.RES_ROLE_SET_TEXT, settler));
        vm.prank(owner);
        res.revokeRoles(brierRes, EnsV2Lib.RES_ROLE_SET_TEXT, settler);
        vm.prank(settler);
        vm.expectRevert();
        res.setText(jev, "calibration.brier", "999");
    }

    // ------------------------------------------------------------------ UniversalResolverV2
    function test_universalResolver() public view {
        IEnsUniversalResolver ur = IEnsUniversalResolver(cfg.ens.universalResolver);

        bytes memory qName = EnsV2Lib.dnsEncode("quoter.oniblock.eth");
        bytes32 qNode = EnsV2Lib.namehash("quoter.oniblock.eth");
        (bytes memory out, address resolver) = ur.resolve(qName, abi.encodeCall(IEnsProfiles.addr, (qNode)));
        assertEq(resolver, r.resolver);
        assertEq(abi.decode(out, (address)), quoter);

        (address found, bytes32 node,) = ur.findResolver(EnsV2Lib.dnsEncode("jev-v1.models.oniblock.eth"));
        assertEq(found, r.resolver);
        assertEq(node, EnsV2Lib.namehash("jev-v1.models.oniblock.eth"));

        assertEq(_urText("jev-v1.models.oniblock.eth", "model-hash"), cfg.modelHashJev);
        assertEq(_urText("heuristic-v1.models.oniblock.eth", "model-hash"), cfg.modelHashHeuristic);
        assertEq(_urText("kev-v1.models.oniblock.eth", "model-hash"), cfg.modelHashKev);
        assertGt(bytes(_urText("kev-v1.models.oniblock.eth", "agent-context")).length, 0);
        assertGt(bytes(_urText("kev-v1.models.oniblock.eth", "description")).length, 0);
        assertGt(bytes(_urText("jev-v1.models.oniblock.eth", "agent-context")).length, 0);
        assertEq(_urText("weth-usdc.pools.oniblock.eth", "fee-max"), "10000");
        assertEq(_urText("weth-usdc.pools.oniblock.eth", "hook"), vm.toString(address(0xB00C)));
        assertEq(_urText("weth-usdc.pools.oniblock.eth", "pool-id"), vm.toString(cfg.poolId));

        (out,) = ur.resolve(
            EnsV2Lib.dnsEncode("settler.oniblock.eth"),
            abi.encodeCall(IEnsProfiles.addr, (EnsV2Lib.namehash("settler.oniblock.eth")))
        );
        assertEq(abi.decode(out, (address)), settler);
    }

    function test_namehashLib() public pure {
        assertEq(EnsV2Lib.namehash("eth"), 0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae);
        assertEq(
            EnsV2Lib.namehash("foo.eth"), 0xde9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f
        );
        assertEq(EnsV2Lib.dnsEncode("ab.eth"), hex"0261620365746800");
    }

    // ------------------------------------------------------------------ helpers
    function _text(bytes memory name, string memory key) internal view returns (string memory) {
        bytes32 node = _namehashDns(name);
        return abi.decode(
            IEnsPermissionedResolver(r.resolver).resolve(name, abi.encodeCall(IEnsProfiles.text, (node, key))), (string)
        );
    }

    function _urText(string memory name, string memory key) internal view returns (string memory) {
        (bytes memory out,) = IEnsUniversalResolver(cfg.ens.universalResolver).resolve(
            EnsV2Lib.dnsEncode(name), abi.encodeCall(IEnsProfiles.text, (EnsV2Lib.namehash(name), key))
        );
        return abi.decode(out, (string));
    }

    function _namehashDns(bytes memory) internal pure returns (bytes32) {
        return bytes32(0); // PermissionedResolver.resolve ignores the node argument in `data`
    }
}
