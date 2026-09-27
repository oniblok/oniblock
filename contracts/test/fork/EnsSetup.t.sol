// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";

import {EnsSetup} from "../../script/EnsSetup.s.sol";
import {
    IEnsPermissionedRegistry,
    IEnsETHRegistrar,
    IEnsPermissionedResolver,
    IEnsUniversalResolver,
    IEnsProfiles,
    IEnsAddressProfile,
    IEnsMulticallable,
    IEnsVerifiableFactory
} from "../../src/interfaces/ens/IEnsV2.sol";
import {EnsV2Lib} from "../../src/roles/EnsV2Lib.sol";
import {EnsV2RoleOracle} from "../../src/roles/EnsV2RoleOracle.sol";
import {OniblockHook} from "../../src/OniblockHook.sol";
import {OniblockLiveResolver} from "../../src/ens/OniblockLiveResolver.sol";
import {IRoleOracle} from "../../src/interfaces/IRoleOracle.sol";
import {MockRoleOracle} from "../../src/mocks/MockRoleOracle.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";

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
        // oniblock1 = the Kev-0.8B LoRA adapter: sha256 of ml/models/kev08b-v1/SHA256 (EnsSetup default)
        cfg.modelHashOniblock1 = "0x24f0793d55e0fde516ebe4da1d187e0468a5f7c830ba9a9f4d48e43f007c88be";
        cfg.poolLabel = "weth-usdc";
        cfg.endpointJev = "https://ai-gateway.vercel.sh/v1/evaluate";
        cfg.endpointHeuristic = "in-process";

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
        assertEq(IEnsPermissionedRegistry(r.modelsRegistry).getOwner(EnsV2Lib.labelId("oniblock1")), owner);
        assertEq(IEnsPermissionedRegistry(r.poolsRegistry).getOwner(EnsV2Lib.labelId("weth-usdc")), owner);
        // kev-v1 is retired: new setups no longer register it
        assertEq(IEnsPermissionedRegistry(r.modelsRegistry).getOwner(EnsV2Lib.labelId("kev-v1")), address(0));

        // resource of a fresh name = labelhash with low 32 bits = eacVersionId (0)
        assertEq(r.quoterResource, EnsV2Lib.resourceAt(EnsV2Lib.labelId("quoter"), 0));
        assertEq(r.settlerResource, EnsV2Lib.resourceAt(EnsV2Lib.labelId("settler"), 0));

        // live.<name>: registered by finish with the shared resolver as a placeholder (no hook known here)
        assertEq(reg.getOwner(EnsV2Lib.labelId("live")), owner);
        assertEq(reg.getResolver("live"), r.resolver);
        assertEq(reg.getSubregistry("live"), address(0));
        assertEq(r.liveResolver, address(0));
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

        // per-key grants are name-independent: the settler can grade oniblock1 too (k and JIT head keys); others
        // still cannot
        bytes memory oni = EnsV2Lib.dnsEncode("oniblock1.models.oniblock.eth");
        vm.prank(settler);
        res.setText(oni, "calibration.n", "12");
        assertEq(_text(oni, "calibration.n"), "12");
        vm.prank(owner);
        vm.expectRevert();
        res.setText(oni, "calibration.n", "0");
        vm.prank(settler);
        res.setText(oni, "calibration.brier", "1700");
        vm.prank(settler);
        res.setText(oni, "calibration.jit.n", "5");
        assertEq(_text(oni, "calibration.brier"), "1700");
        assertEq(_text(oni, "calibration.jit.n"), "5");
        vm.prank(owner);
        vm.expectRevert();
        res.setText(oni, "calibration.brier", "0");
        vm.prank(rando);
        vm.expectRevert();
        res.setText(oni, "calibration.jit.n", "0");

        // calibration.chargeThreshold (the settler's rolling charge threshold, bps): settler-only like calibration.*
        uint256 thrRes = EnsV2Lib.keyResource("calibration.chargeThreshold");
        assertTrue(res.hasRoles(thrRes, EnsV2Lib.RES_ROLE_SET_TEXT, settler));
        assertFalse(res.hasRoles(thrRes, EnsV2Lib.RES_ROLE_SET_TEXT, owner), "owner holds no setter role for it");
        vm.prank(settler);
        res.setText(oni, "calibration.chargeThreshold", "8175");
        assertEq(_text(oni, "calibration.chargeThreshold"), "8175");
        vm.prank(owner);
        vm.expectRevert();
        res.setText(oni, "calibration.chargeThreshold", "0");
        vm.prank(quoter);
        vm.expectRevert();
        res.setText(jev, "calibration.chargeThreshold", "0");
        // upgrade path (grant-jit on an existing setup): finish already granted every settler key => no-op; a setup
        // from before the key existed (simulated by revoking it) gets exactly that one grant back
        assertEq(setup.grantSettlerKeysBroadcast(cfg, r.resolver, settler), 0);
        vm.prank(owner);
        res.revokeRoles(thrRes, EnsV2Lib.RES_ROLE_SET_TEXT, settler);
        vm.prank(settler);
        vm.expectRevert();
        res.setText(oni, "calibration.chargeThreshold", "9000");
        assertEq(setup.grantSettlerKeysBroadcast(cfg, r.resolver, settler), 1);
        assertFalse(res.hasRoles(thrRes, EnsV2Lib.RES_ROLE_SET_TEXT, owner));
        vm.prank(settler);
        res.setText(oni, "calibration.chargeThreshold", "9000");
        assertEq(_text(oni, "calibration.chargeThreshold"), "9000");

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
        assertEq(_urText("oniblock1.models.oniblock.eth", "model-hash"), cfg.modelHashOniblock1);
        string memory oniCtx = _urText("oniblock1.models.oniblock.eth", "agent-context");
        assertTrue(vm.contains(oniCtx, "Kev-0.8B"), "oniblock1 agent-context names the Kev model");
        assertTrue(vm.contains(oniCtx, "is this block's arbitrage flow informed?"));
        assertTrue(vm.contains(oniCtx, "Charge gate 0.8175"));
        assertFalse(vm.contains(oniCtx, "LightGBM"), "oniblock1 is not the LightGBM teacher");
        assertEq(
            _urText("oniblock1.models.oniblock.eth", "description"),
            "oniblock1: Kev-0.8B (jaredpalmer/kev-0.8b) LoRA fine-tune, a TypeSafe System One decision model; weights ml/models/kev08b-v1/adapter; model-hash = sha256 over its sorted per-file digests"
        );
        assertGt(bytes(_urText("jev-v1.models.oniblock.eth", "agent-context")).length, 0);
        assertEq(_urText("weth-usdc.pools.oniblock.eth", "fee-max"), "10000");
        // ENSIP-26 agent-endpoint[<protocol>]
        assertEq(_urText("jev-v1.models.oniblock.eth", "agent-endpoint[web]"), cfg.endpointJev);
        assertEq(_urText("heuristic-v1.models.oniblock.eth", "agent-endpoint[web]"), "in-process");
        assertEq(_urText("oniblock1.models.oniblock.eth", "agent-endpoint[web]"), "");
        assertEq(_urText("weth-usdc.pools.oniblock.eth", "hook"), vm.toString(address(0xB00C)));
        assertEq(_urText("weth-usdc.pools.oniblock.eth", "pool-id"), vm.toString(cfg.poolId));

        (out,) = ur.resolve(
            EnsV2Lib.dnsEncode("settler.oniblock.eth"),
            abi.encodeCall(IEnsProfiles.addr, (EnsV2Lib.namehash("settler.oniblock.eth")))
        );
        assertEq(abi.decode(out, (address)), settler);
    }

    // ------------------------------------------------------------------ ENSIP-10 wildcard: *.live.oniblock.eth
    /// The UR finds no resolver for `<label>.live.oniblock.eth` (no subregistry under `live`), walks up to `live`,
    /// checks IExtendedResolver and calls OniblockLiveResolver.resolve(fullName, data): nothing under `live` is
    /// registered, every record comes from the hook.
    function test_liveWildcard_throughUniversalResolver() public {
        (OniblockHook hook, PoolKey memory key) = _deployHookAndPool();
        bytes32 poolId = PoolId.unwrap(key.toId());
        bytes32 jev = EnsV2Lib.namehash("jev-v1.models.oniblock.eth");
        IEnsPermissionedRegistry reg = IEnsPermissionedRegistry(r.registry);
        IEnsUniversalResolver ur = IEnsUniversalResolver(cfg.ens.universalResolver);

        // before add-live the placeholder (shared) resolver answers with empty records
        assertEq(reg.getResolver("live"), r.resolver);
        assertEq(_urText("jev-v1.live.oniblock.eth", "status"), "");

        address live = setup.addLiveBroadcast(cfg, r.registry, address(0), address(hook), poolId, key);
        assertEq(reg.getResolver("live"), live, "resolver of live repointed");
        assertEq(reg.getSubregistry("live"), address(0), "nothing registered under live");
        assertEq(OniblockLiveResolver(live).owner(), owner);
        assertEq(OniblockLiveResolver(live).knownLabels().length, 4);

        // the UR walk stops at `live` (offset 7 = after "\x06jev-v1") and accepts the resolver as ENSIP-10
        (address found, bytes32 node, uint256 offset) = ur.findResolver(EnsV2Lib.dnsEncode("jev-v1.live.oniblock.eth"));
        assertEq(found, live);
        assertEq(node, EnsV2Lib.namehash("jev-v1.live.oniblock.eth"));
        assertEq(offset, 7);

        // model records: allowlisted, no record yet => active; unknown label => unknown
        assertEq(_urText("jev-v1.live.oniblock.eth", "status"), "active");
        assertEq(_urText("jev-v1.live.oniblock.eth", "allowed"), "true");
        assertEq(_urText("jev-v1.live.oniblock.eth", "calibration.n"), "0");
        assertEq(_urText("jev-v1.live.oniblock.eth", "model-node"), Strings.toHexString(uint256(jev), 32));
        assertEq(_urText("jev-v1.live.oniblock.eth", "models-name"), "jev-v1.models.oniblock.eth");
        assertEq(_urText("nobody-v9.live.oniblock.eth", "status"), "unknown");
        assertEq(_urText("oniblock1.live.oniblock.eth", "status"), "unknown"); // known label, not allowlisted here
        assertEq(_urText("oniblock1.live.oniblock.eth", "models-name"), "oniblock1.models.oniblock.eth");
        // pool records
        assertEq(_urText("weth-usdc.live.oniblock.eth", "k"), "5000");
        assertEq(_urText("weth-usdc.live.oniblock.eth", "stale"), "true");
        assertEq(_urText("weth-usdc.live.oniblock.eth", "hook"), Strings.toChecksumHexString(address(hook)));
        assertEq(_urText("weth-usdc.live.oniblock.eth", "pool-id"), Strings.toHexString(uint256(poolId), 32));
        assertEq(_urText("weth-usdc.live.oniblock.eth", "fee-zero-for-one"), "5000"); // stale => conservative
        assertEq(_urText("weth-usdc.live.oniblock.eth", "pools-name"), "weth-usdc.pools.oniblock.eth");
        // current alias + the namespace itself
        assertEq(_urText("current.live.oniblock.eth", "status"), "unknown");
        assertEq(_urText("live.oniblock.eth", "pool"), "weth-usdc");
        assertEq(_urText("live.oniblock.eth", "known-labels"), "jev-v1,heuristic-v1,oniblock1,rule-v1");
        // addr through the UR: the pool name resolves to the hook
        (bytes memory out, address via) = ur.resolve(
            EnsV2Lib.dnsEncode("weth-usdc.live.oniblock.eth"),
            abi.encodeCall(IEnsProfiles.addr, (EnsV2Lib.namehash("weth-usdc.live.oniblock.eth")))
        );
        assertEq(via, live);
        assertEq(abi.decode(out, (address)), address(hook));

        // the settler grades the model on the hook: the same ENS name flips, with no ENS write at all
        vm.prank(settler);
        hook.setCalibration(jev, 1000, 6000, 10);
        assertEq(_urText("jev-v1.live.oniblock.eth", "status"), "active");
        assertEq(_urText("jev-v1.live.oniblock.eth", "calibration.brier"), "1000");
        assertEq(_urText("jev-v1.live.oniblock.eth", "demoted"), "false");

        // multicall through the UR (direct call path: IERC7996 + RESOLVE_MULTICALL)
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(IEnsProfiles.text, (bytes32(0), "k"));
        calls[1] = abi.encodeCall(IEnsProfiles.text, (bytes32(0), "base-fee"));
        (out, via) = ur.resolve(
            EnsV2Lib.dnsEncode("weth-usdc.live.oniblock.eth"), abi.encodeCall(IEnsMulticallable.multicall, (calls))
        );
        bytes[] memory rs = abi.decode(out, (bytes[]));
        assertEq(abi.decode(rs[0], (string)), "5000");
        assertEq(abi.decode(rs[1], (string)), "3000");

        // an unsupported profile is propagated by the UR as its own UnsupportedResolverProfile error
        vm.expectRevert(
            abi.encodeWithSelector(OniblockLiveResolver.UnsupportedResolverProfile.selector, IEnsProfiles.addr.selector)
        );
        ur.resolve(EnsV2Lib.dnsEncode("jev-v1.live.oniblock.eth"), abi.encodeCall(IEnsProfiles.addr, (jev)));

        // idempotent: the recorded resolver is reused, nothing re-registered or repointed
        address again = setup.addLiveBroadcast(cfg, r.registry, live, address(hook), poolId, key);
        assertEq(again, live);
        assertEq(reg.getResolver("live"), live);
        // a recorded resolver bound to another hook/pool is replaced by a fresh one
        address stale_ = setup.addLiveBroadcast(cfg, r.registry, address(0xdead), address(hook), poolId, key);
        assertTrue(stale_ != live);
        assertEq(reg.getResolver("live"), stale_);
        assertEq(_urText("weth-usdc.live.oniblock.eth", "k"), "5000");

        // a recorded resolver for the same hook/pool but another owner or pool label is not reused either
        bytes32 modelsNode = EnsV2Lib.namehash("models.oniblock.eth");
        bytes32 poolsNode = EnsV2Lib.namehash("pools.oniblock.eth");
        address foreign = address(
            new OniblockLiveResolver(rando, hook, poolId, key, modelsNode, poolsNode, "live.oniblock.eth", cfg.poolLabel)
        );
        address fresh = setup.addLiveBroadcast(cfg, r.registry, foreign, address(hook), poolId, key);
        assertTrue(fresh != foreign, "other owner => fresh resolver");
        assertEq(OniblockLiveResolver(fresh).owner(), owner);
        address otherPool = address(
            new OniblockLiveResolver(owner, hook, poolId, key, modelsNode, poolsNode, "live.oniblock.eth", "other-pool")
        );
        fresh = setup.addLiveBroadcast(cfg, r.registry, otherPool, address(hook), poolId, key);
        assertTrue(fresh != otherPool, "other pool label => fresh resolver");
        assertEq(reg.getResolver("live"), fresh);
        assertEq(setup.addLiveBroadcast(cfg, r.registry, fresh, address(hook), poolId, key), fresh, "match => reused");

        // the old names keep resolving through the shared resolver: same UR, two resolver kinds under one parent
        assertEq(_urText("jev-v1.models.oniblock.eth", "model-hash"), cfg.modelHashJev);
    }

    // ------------------------------------------------------------------ add-model / set-endpoints phases
    function test_addModel_phase() public {
        IEnsPermissionedRegistry models = IEnsPermissionedRegistry(r.modelsRegistry);
        IEnsPermissionedResolver res = IEnsPermissionedResolver(r.resolver);
        EnsSetup.ModelSpec memory m = EnsSetup.ModelSpec({
            label: "test-v9",
            owner: owner,
            modelHash: vm.toString(keccak256("test-v9")),
            context: "Test model context",
            endpoint: "https://example.org/evaluate",
            description: "Test model"
        });
        (bool registered, uint256 writes, uint256 grants) =
            setup.addModelBroadcast(cfg, r.modelsRegistry, r.resolver, settler, m);
        assertTrue(registered);
        assertEq(writes, 4);
        assertEq(grants, 0, "finish already granted every key");
        assertEq(models.getOwner(EnsV2Lib.labelId("test-v9")), owner);
        assertEq(models.getResolver("test-v9"), r.resolver);
        assertEq(_urText("test-v9.models.oniblock.eth", "model-hash"), m.modelHash);
        assertEq(_urText("test-v9.models.oniblock.eth", "agent-context"), m.context);
        assertEq(_urText("test-v9.models.oniblock.eth", "agent-endpoint[web]"), m.endpoint);
        assertEq(_urText("test-v9.models.oniblock.eth", "description"), m.description);

        // the settler can grade it (per-key grants are name-independent), nobody else can
        bytes memory name = EnsV2Lib.dnsEncode("test-v9.models.oniblock.eth");
        vm.prank(settler);
        res.setText(name, "calibration.jit.n", "3");
        assertEq(_urText("test-v9.models.oniblock.eth", "calibration.jit.n"), "3");
        vm.prank(owner);
        vm.expectRevert();
        res.setText(name, "calibration.n", "1");

        // idempotent: nothing to do
        (registered, writes, grants) = setup.addModelBroadcast(cfg, r.modelsRegistry, r.resolver, settler, m);
        assertFalse(registered);
        assertEq(writes, 0);
        assertEq(grants, 0);
        // partial update: only the record that differs is rewritten; empty values leave records alone
        m.description = "Test model v2";
        m.modelHash = "";
        (registered, writes,) = setup.addModelBroadcast(cfg, r.modelsRegistry, r.resolver, settler, m);
        assertFalse(registered);
        assertEq(writes, 1);
        assertEq(_urText("test-v9.models.oniblock.eth", "description"), "Test model v2");
        assertEq(_urText("test-v9.models.oniblock.eth", "model-hash"), vm.toString(keccak256("test-v9")));

        // a model owned by another account (its own identity + token permissions; records still written by owner)
        address agent = makeAddr("oniblock.ens.agentOwner");
        vm.etch(agent, ""); // Sepolia EIP-7702 delegations on well-known keys would break the ERC1155 mint
        EnsSetup.ModelSpec memory a = EnsSetup.ModelSpec({
            label: "agent-v1",
            owner: agent,
            modelHash: "",
            context: "",
            endpoint: "https://agent.example/mcp",
            description: ""
        });
        (registered, writes,) = setup.addModelBroadcast(cfg, r.modelsRegistry, r.resolver, settler, a);
        assertTrue(registered);
        assertEq(writes, 1);
        assertEq(models.getOwner(EnsV2Lib.labelId("agent-v1")), agent);
        assertEq(_urText("agent-v1.models.oniblock.eth", "agent-endpoint[web]"), "https://agent.example/mcp");
        // an author-owned name is registered without ROLE_SET_RESOLVER: the author cannot repoint it away from the
        // shared resolver (where the settler's scorecard lives), nor can a stranger
        uint256 agentId = EnsV2Lib.labelId("agent-v1");
        assertFalse(models.hasRoles(agentId, EnsV2Lib.ROLE_SET_RESOLVER, agent));
        vm.prank(agent);
        vm.expectRevert();
        models.setResolver(agentId, address(0xBEEF));
        assertEq(models.getResolver("agent-v1"), r.resolver);
        vm.prank(rando);
        vm.expectRevert();
        models.setResolver(agentId, address(0xBEEF));
        // the team owner still can (registry root roles), and add-model puts the shared resolver back
        vm.prank(owner);
        models.setResolver(agentId, address(0xBEEF));
        assertEq(models.getResolver("agent-v1"), address(0xBEEF));
        setup.addModelBroadcast(cfg, r.modelsRegistry, r.resolver, settler, a);
        assertEq(models.getResolver("agent-v1"), r.resolver);
        // re-running with another ENS_MODEL_OWNER warns and changes nothing (no auto-transfer)
        a.owner = rando;
        (registered, writes,) = setup.addModelBroadcast(cfg, r.modelsRegistry, r.resolver, settler, a);
        assertFalse(registered);
        assertEq(writes, 0);
        assertEq(models.getOwner(agentId), agent);
    }

    function test_setEndpoints_phase() public {
        (uint256 writes, uint256 grants) = setup.setEndpointsBroadcast(cfg, r.resolver);
        assertEq(writes, 0, "finish already wrote them");
        assertEq(grants, 0);
        cfg.endpointJev = "https://other.example/v1/evaluate";
        (writes, grants) = setup.setEndpointsBroadcast(cfg, r.resolver);
        assertEq(writes, 1);
        assertEq(_urText("jev-v1.models.oniblock.eth", "agent-endpoint[web]"), cfg.endpointJev);
        assertEq(_urText("heuristic-v1.models.oniblock.eth", "agent-endpoint[web]"), "in-process");
        // oniblock1: empty ENS_ENDPOINT_ONIBLOCK1 (default) = skipped; set (its System One URL) = written once
        assertEq(_urText("oniblock1.models.oniblock.eth", "agent-endpoint[web]"), "");
        cfg.endpointOniblock1 = "https://systemone.example/v1/systemone";
        (writes,) = setup.setEndpointsBroadcast(cfg, r.resolver);
        assertEq(writes, 1);
        assertEq(_urText("oniblock1.models.oniblock.eth", "agent-endpoint[web]"), cfg.endpointOniblock1);
        (writes,) = setup.setEndpointsBroadcast(cfg, r.resolver);
        assertEq(writes, 0);
    }

    /// A real hook + registered/initialized Oniblock pool on the fork (fresh PoolManager, mock tokens), so the live
    /// resolver has state to serve. Mirrors OniblockTestBase without its block/time rewinds.
    function _deployHookAndPool() internal returns (OniblockHook hook, PoolKey memory key) {
        IPoolManager pm = IPoolManager(deployCode("out/PoolManager.sol/PoolManager.json", abi.encode(address(this))));
        MockERC20 a = new MockERC20("Mock WETH", "mWETH", 18);
        MockERC20 b = new MockERC20("Mock USDC", "mUSDC", 6);
        (Currency c0, Currency c1) = address(a) < address(b)
            ? (Currency.wrap(address(a)), Currency.wrap(address(b)))
            : (Currency.wrap(address(b)), Currency.wrap(address(a)));
        MockRoleOracle roles = new MockRoleOracle(address(this));
        roles.setSettler(settler, true);
        address attestor = makeAddr("oniblock.ens.attestor");
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.AFTER_ADD_LIQUIDITY_FLAG
                | Hooks.AFTER_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG | Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG
        );
        bytes memory args = abi.encode(pm, address(this), attestor, IRoleOracle(address(roles)), uint48(10), uint256(0));
        (address expected, bytes32 salt) = HookMiner.find(address(this), flags, type(OniblockHook).creationCode, args);
        hook = new OniblockHook{salt: salt}(pm, address(this), attestor, IRoleOracle(address(roles)), 10, 0);
        require(address(hook) == expected, "hook addr");

        OniblockHook.PoolConfig memory c;
        c.baseFee = 3000;
        c.feeMax = 10000;
        c.conservativeFee = 5000;
        c.kMinBps = 2000;
        c.kMaxBps = 8000;
        c.kDefaultBps = 5000;
        c.maxKStepBps = 1000;
        c.staleBlocks = 5;
        c.brierDemoteBps = 2500;
        c.chainlinkMaxAge = 2 hours;
        c.arbThresholdPips = 3300;
        c.jitWindowMin = 10;
        c.jitWindowMax = 100;
        c.jitWindowDefault = 10;
        key = PoolKey(c0, c1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(address(hook)));
        hook.registerPool(key, c);
        hook.setModelAllowed(key.toId(), EnsV2Lib.namehash("jev-v1.models.oniblock.eth"), true);
        pm.initialize(key, TickMath.getSqrtPriceAtTick(0));
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
