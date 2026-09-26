// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {
    EnsGrant,
    IEnsPermissionedRegistry,
    IEnsUserRegistryInit,
    IEnsETHRegistrar,
    IEnsVerifiableFactory,
    IEnsPermissionedResolver,
    IEnsMockERC20
} from "../src/interfaces/ens/IEnsV2.sol";
import {EnsV2Lib} from "../src/roles/EnsV2Lib.sol";
import {EnsV2RoleOracle} from "../src/roles/EnsV2RoleOracle.sol";

/// @title EnsSetup
/// @notice ENSv2 (Sepolia beta) setup for Oniblock:
///   1. commit  : ETHRegistrar.commit(makeCommitment(label, owner, secret, 0, 0, duration, 0))
///   2. finish  : (after MIN_COMMITMENT_AGE = 60s)
///      - mint + approve MockUSDC, ETHRegistrar.register(...)             -> <label>.eth owned by `owner`
///      - VerifiableFactory proxies: PermissionedResolver, UserRegistry for <label>.eth, models.<label>.eth,
///        pools.<label>.eth (all owned by `owner` via root grants)
///      - ETH registry: setSubregistry / setResolver on <label>.eth
///      - subnames: quoter, settler, models -> {jev-v1, heuristic-v1, rule-v1 (v3 gate only)}, pools -> {weth-usdc}
///      - v4 pool config (DeployBase): arbThresholdPips 0, kMin 0, kDefault 0, kMax 8000, maxKStep 8000 — Jev decides
///      - EAC roles: ROLE_QUOTER on quoter.<label>.eth -> quoter; ROLE_SETTLER on settler.<label>.eth -> settler
///      - resolver records (addr + text) and settler-only per-key text roles for calibration.*
///      - deploys EnsV2RoleOracle pointing at the subregistry
///      - writes ../deployments/<chainId>.ens.json
///
/// Env (all optional except where noted):
///   ENS_PHASE      commit | finish | all  (default all; `all` only works in simulation / on a chain where the
///                  script's vm.warp is honoured, i.e. forge test. For anvil use commit, then
///                  `cast rpc evm_increaseTime 61 && cast rpc anvil_mine`, then finish.)
///   ENS_NAME       default "oniblock.eth"
///   ENS_OWNER      default: the broadcasting sender (msg.sender of the script)
///   ENS_QUOTER     default: owner         ENS_SETTLER default: owner
///   ENS_HOOK       optional hook address  ENS_POOL_ID optional bytes32
///   ENS_SECRET     commit-reveal secret (default keccak256("oniblock-ens", owner, label))
///   ENS_DURATION   seconds (default 365 days)   ENS_SALT  factory salt nonce (default 0)
///   ENS_OUT        output json path (default ../deployments/<chainId>.ens.json; use a different path for fork runs)
///   ENS_FEE_MIN / ENS_FEE_MAX / ENS_POLICY_URI / ENS_MODEL_HASH_JEV / ENS_MODEL_HASH_HEURISTIC
///   ENS_ETH_REGISTRAR, ENS_VERIFIABLE_FACTORY, ENS_USER_REGISTRY_IMPL, ENS_PERMISSIONED_RESOLVER_IMPL,
///   ENS_MOCK_USDC, ENS_UNIVERSAL_RESOLVER   (required; from .env)
contract EnsSetup is Script {
    // ------------------------------------------------------------------ text keys
    string internal constant K_MODEL_HASH = "model-hash";
    string internal constant K_AGENT_CONTEXT = "agent-context"; // ENSIP-26
    string internal constant K_DESCRIPTION = "description";
    string internal constant K_CAL_BRIER = "calibration.brier";
    string internal constant K_CAL_HIT = "calibration.hitRate";
    string internal constant K_CAL_N = "calibration.n";
    string internal constant K_CAL_EPOCH = "calibration.epoch";
    // Settler detail records (services/src/settler.ts): absolute Brier, Brier skill vs the base-rate predictor,
    // base rate. calibration.brier holds the value posted to hook.setCalibration (skill-normalised gate value).
    string internal constant K_CAL_BRIER_RAW = "calibration.brierRaw";
    string internal constant K_CAL_SKILL = "calibration.skill";
    string internal constant K_CAL_BASE_RATE = "calibration.baseRate";
    string internal constant K_HOOK = "hook";
    string internal constant K_POOL_ID = "pool-id";
    string internal constant K_FEE_MIN = "fee-min";
    string internal constant K_FEE_MAX = "fee-max";
    string internal constant K_POLICY_URI = "policy-uri";

    struct Addrs {
        address registrar;
        address factory;
        address userRegistryImpl;
        address resolverImpl;
        address usdc;
        address universalResolver;
    }

    struct Config {
        Addrs ens;
        string label; // "oniblock"
        address owner;
        address quoter;
        address settler;
        address hook; // may be 0
        bytes32 poolId; // may be 0
        bytes32 secret;
        uint64 duration;
        uint256 salt;
        string feeMin;
        string feeMax;
        string policyUri;
        string modelHashJev;
        string modelHashHeuristic;
    }

    struct Result {
        address ethRegistry;
        address resolver;
        address registry; // <label>.eth subregistry
        address modelsRegistry;
        address poolsRegistry;
        address roleOracle;
        uint256 tokenId; // <label>.eth token id in ETH registry (at registration time)
        uint256 quoterResource;
        uint256 settlerResource;
    }

    // ================================================================== entry point
    function run() external {
        Config memory cfg = loadConfig(msg.sender);
        string memory phase = vm.envOr("ENS_PHASE", string("all"));
        bytes32 p = keccak256(bytes(phase));
        if (p == keccak256("commit")) {
            commitPhase(cfg);
        } else if (p == keccak256("finish")) {
            Result memory r = finishPhase(cfg);
            writeJson(cfg, r);
        } else {
            commitPhase(cfg);
            vm.warp(block.timestamp + IEnsETHRegistrar(cfg.ens.registrar).MIN_COMMITMENT_AGE() + 1);
            Result memory r = finishPhase(cfg);
            writeJson(cfg, r);
        }
    }

    function loadConfig(address sender) public view returns (Config memory cfg) {
        cfg.ens.registrar = vm.envAddress("ENS_ETH_REGISTRAR");
        cfg.ens.factory = vm.envAddress("ENS_VERIFIABLE_FACTORY");
        cfg.ens.userRegistryImpl = vm.envAddress("ENS_USER_REGISTRY_IMPL");
        cfg.ens.resolverImpl = vm.envAddress("ENS_PERMISSIONED_RESOLVER_IMPL");
        cfg.ens.usdc = vm.envAddress("ENS_MOCK_USDC");
        cfg.ens.universalResolver = vm.envAddress("ENS_UNIVERSAL_RESOLVER");

        cfg.label = _labelOf(vm.envOr("ENS_NAME", string("oniblock.eth")));
        cfg.owner = vm.envOr("ENS_OWNER", sender);
        cfg.quoter = vm.envOr("ENS_QUOTER", cfg.owner);
        cfg.settler = vm.envOr("ENS_SETTLER", cfg.owner);
        cfg.hook = vm.envOr("ENS_HOOK", address(0));
        cfg.poolId = vm.envOr("ENS_POOL_ID", bytes32(0));
        cfg.secret = vm.envOr("ENS_SECRET", keccak256(abi.encode("oniblock-ens", cfg.owner, cfg.label)));
        cfg.duration = uint64(vm.envOr("ENS_DURATION", uint256(365 days)));
        cfg.salt = vm.envOr("ENS_SALT", uint256(0));
        cfg.feeMin = vm.envOr("ENS_FEE_MIN", string("3000"));
        cfg.feeMax = vm.envOr("ENS_FEE_MAX", string("10000"));
        cfg.policyUri = vm.envOr("ENS_POLICY_URI", string("urn:oniblock:fee-law:v1"));
        cfg.modelHashJev = vm.envOr("ENS_MODEL_HASH_JEV", vm.toString(keccak256("typesafe-ai/jev")));
        cfg.modelHashHeuristic =
            vm.envOr("ENS_MODEL_HASH_HEURISTIC", vm.toString(keccak256("oniblock/heuristic-v1")));
    }

    // ================================================================== phase 1: commit
    function commitment(Config memory cfg) public pure returns (bytes32) {
        return IEnsETHRegistrar(cfg.ens.registrar).makeCommitment(
            cfg.label, cfg.owner, cfg.secret, address(0), address(0), cfg.duration, bytes32(0)
        );
    }

    function commitPhase(Config memory cfg) public {
        IEnsETHRegistrar registrar = IEnsETHRegistrar(cfg.ens.registrar);
        require(registrar.isAvailable(cfg.label), "EnsSetup: name not available");
        bytes32 c = commitment(cfg);
        vm.startBroadcast(cfg.owner);
        registrar.commit(c);
        vm.stopBroadcast();
        console2.log("committed", cfg.label);
        console2.logBytes32(c);
    }

    // ================================================================== phase 2: register + configure
    function finishPhase(Config memory cfg) public returns (Result memory r) {
        IEnsETHRegistrar registrar = IEnsETHRegistrar(cfg.ens.registrar);
        IEnsPermissionedRegistry ethRegistry = IEnsPermissionedRegistry(registrar.ETH_REGISTRY());
        r.ethRegistry = address(ethRegistry);

        vm.startBroadcast(cfg.owner);

        // ---- 2a. register <label>.eth, paying in the registrar's mintable MockUSDC
        (uint256 base, uint256 premium) = registrar.getRegisterPrice(cfg.label, cfg.duration, cfg.ens.usdc);
        IEnsMockERC20(cfg.ens.usdc).mint(cfg.owner, base + premium);
        IEnsMockERC20(cfg.ens.usdc).approve(address(registrar), base + premium);
        r.tokenId = registrar.register(
            cfg.label, cfg.owner, cfg.secret, address(0), address(0), cfg.duration, cfg.ens.usdc, bytes32(0)
        );

        // ---- 2b. our own resolver + registries (VerifiableFactory proxies)
        r.resolver = _deployResolver(cfg);
        r.registry = _deployRegistry(cfg, 1);
        r.modelsRegistry = _deployRegistry(cfg, 2);
        r.poolsRegistry = _deployRegistry(cfg, 3);

        // ---- 2c. hook <label>.eth into the ETH registry (owner holds ROLE_SET_SUBREGISTRY/RESOLVER on the token)
        uint256 nameId = EnsV2Lib.labelId(cfg.label);
        ethRegistry.setSubregistry(nameId, r.registry);
        ethRegistry.setResolver(nameId, r.resolver);

        // ---- 2d. subnames
        IEnsPermissionedRegistry reg = IEnsPermissionedRegistry(r.registry);
        reg.setParent(address(ethRegistry), cfg.label); // canonical name for UniversalResolver
        uint256 std = EnsV2Lib.withAdmin(EnsV2Lib.ROLE_SET_RESOLVER | EnsV2Lib.ROLE_SET_SUBREGISTRY)
            | EnsV2Lib.ROLE_CAN_TRANSFER_ADMIN;
        uint64 forever = type(uint64).max; // subnames in our own registry never expire (expiry wipes roles)
        reg.register("quoter", cfg.owner, address(0), r.resolver, std | EnsV2Lib.ROLE_QUOTER_ADMIN, forever);
        reg.register("settler", cfg.owner, address(0), r.resolver, std | EnsV2Lib.ROLE_SETTLER_ADMIN, forever);
        reg.register("models", cfg.owner, r.modelsRegistry, r.resolver, std, forever);
        reg.register("pools", cfg.owner, r.poolsRegistry, r.resolver, std, forever);

        IEnsPermissionedRegistry models = IEnsPermissionedRegistry(r.modelsRegistry);
        models.setParent(r.registry, "models");
        models.register("jev-v1", cfg.owner, address(0), r.resolver, std, forever);
        models.register("heuristic-v1", cfg.owner, address(0), r.resolver, std, forever);
        models.register("rule-v1", cfg.owner, address(0), r.resolver, std, forever); // v3 below-threshold rule

        IEnsPermissionedRegistry pools = IEnsPermissionedRegistry(r.poolsRegistry);
        pools.setParent(r.registry, "pools");
        pools.register("weth-usdc", cfg.owner, address(0), r.resolver, std, forever);

        // ---- 2e. EAC roles: the kill switch. Owner holds *_ADMIN on the token resource; grants the regular role.
        reg.grantRoles(EnsV2Lib.labelId("quoter"), EnsV2Lib.ROLE_QUOTER, cfg.quoter);
        reg.grantRoles(EnsV2Lib.labelId("settler"), EnsV2Lib.ROLE_SETTLER, cfg.settler);
        r.quoterResource = reg.getResource(EnsV2Lib.labelId("quoter"));
        r.settlerResource = reg.getResource(EnsV2Lib.labelId("settler"));

        // ---- 2f. resolver records
        _writeRecords(cfg, IEnsPermissionedResolver(r.resolver));

        // ---- 2g. role oracle for the hook (resource = labelhash: registry maps it to the live EAC resource)
        r.roleOracle = address(
            new EnsV2RoleOracle(
                cfg.owner,
                EnsV2RoleOracle.RoleRef(r.registry, EnsV2Lib.labelId("quoter"), EnsV2Lib.ROLE_QUOTER),
                EnsV2RoleOracle.RoleRef(r.registry, EnsV2Lib.labelId("settler"), EnsV2Lib.ROLE_SETTLER)
            )
        );

        vm.stopBroadcast();
    }

    // ================================================================== helpers
    function _deployResolver(Config memory cfg) internal returns (address) {
        // Owner gets every root role EXCEPT ROLE_SET_TEXT (only its admin bit): text keys are then writable
        // only by accounts holding a per-key grant, so calibration.* is settler-only unless the admin
        // explicitly grants itself that key (auditable via EACRolesChanged / ResourceArgument events).
        EnsGrant[] memory grants = new EnsGrant[](1);
        grants[0] = EnsGrant(
            cfg.owner,
            EnsV2Lib.withAdmin(
                EnsV2Lib.RES_ROLE_SET_ADDRESS | EnsV2Lib.RES_ROLE_SET_CONTENTHASH | EnsV2Lib.RES_ROLE_SET_ABI
                    | EnsV2Lib.RES_ROLE_SET_INTERFACE | EnsV2Lib.RES_ROLE_SET_NAME | EnsV2Lib.RES_ROLE_SET_DATA
                    | EnsV2Lib.RES_ROLE_LINK | EnsV2Lib.RES_ROLE_UPGRADE
            ) | (EnsV2Lib.RES_ROLE_SET_TEXT << 128)
        );
        bytes memory init = abi.encodeCall(IEnsPermissionedResolver.initialize, (grants, new bytes[](0)));
        return IEnsVerifiableFactory(cfg.ens.factory).deployProxy(
            cfg.ens.resolverImpl, uint256(keccak256(abi.encode(cfg.label, "resolver", cfg.salt))), init
        );
    }

    function _deployRegistry(Config memory cfg, uint256 idx) internal returns (address) {
        EnsGrant[] memory grants = new EnsGrant[](1);
        grants[0] = EnsGrant(
            cfg.owner,
            EnsV2Lib.withAdmin(
                EnsV2Lib.ROLE_REGISTRAR | EnsV2Lib.ROLE_REGISTER_RESERVED | EnsV2Lib.ROLE_SET_PARENT
                    | EnsV2Lib.ROLE_UNREGISTER | EnsV2Lib.ROLE_RENEW | EnsV2Lib.ROLE_SET_SUBREGISTRY
                    | EnsV2Lib.ROLE_SET_RESOLVER | EnsV2Lib.ROLE_SET_URI | EnsV2Lib.ROLE_UPGRADE
            )
        );
        bytes memory init = abi.encodeCall(IEnsUserRegistryInit.initialize, (grants));
        return IEnsVerifiableFactory(cfg.ens.factory).deployProxy(
            cfg.ens.userRegistryImpl, uint256(keccak256(abi.encode(cfg.label, "registry", idx, cfg.salt))), init
        );
    }

    function _writeRecords(Config memory cfg, IEnsPermissionedResolver res) internal {
        string memory root = string.concat(cfg.label, ".eth");
        bytes memory nRoot = EnsV2Lib.dnsEncode(root);
        bytes memory nQuoter = EnsV2Lib.dnsEncode(string.concat("quoter.", root));
        bytes memory nSettler = EnsV2Lib.dnsEncode(string.concat("settler.", root));
        bytes memory nJev = EnsV2Lib.dnsEncode(string.concat("jev-v1.models.", root));
        bytes memory nHeur = EnsV2Lib.dnsEncode(string.concat("heuristic-v1.models.", root));
        bytes memory nPool = EnsV2Lib.dnsEncode(string.concat("weth-usdc.pools.", root));
        bytes memory nRule = EnsV2Lib.dnsEncode(string.concat("rule-v1.models.", root));

        // Per-key text grants. Resource = keccak256(key) (name-independent), so a key grant covers that key
        // on every name served by this resolver.
        string[10] memory ownerKeys = [
            K_DESCRIPTION, K_MODEL_HASH, K_AGENT_CONTEXT, K_HOOK, K_POOL_ID, K_FEE_MIN, K_FEE_MAX, K_POLICY_URI,
            "url", "avatar"
        ];
        for (uint256 i; i < ownerKeys.length; ++i) {
            res.grantSetterRoles(abi.encodeCall(IEnsPermissionedResolver.setText, (nRoot, ownerKeys[i], "")), cfg.owner);
        }
        string[7] memory calKeys =
            [K_CAL_BRIER, K_CAL_HIT, K_CAL_N, K_CAL_EPOCH, K_CAL_BRIER_RAW, K_CAL_SKILL, K_CAL_BASE_RATE];
        for (uint256 i; i < calKeys.length; ++i) {
            res.grantSetterRoles(abi.encodeCall(IEnsPermissionedResolver.setText, (nRoot, calKeys[i], "")), cfg.settler);
        }

        bytes[] memory c = new bytes[](18);
        uint256 n;
        c[n++] = _addr(nRoot, cfg.owner);
        c[n++] = _text(nRoot, K_DESCRIPTION, "Oniblock: attested, directional LVR fee law for Uniswap v4");
        c[n++] = _addr(nQuoter, cfg.quoter);
        c[n++] = _text(nQuoter, K_DESCRIPTION, "Keeper that posts per-block attestations; power = ROLE_QUOTER on this name");
        c[n++] = _addr(nSettler, cfg.settler);
        c[n++] = _text(nSettler, K_DESCRIPTION, "Scores models (markouts) and writes calibration.* text records");
        c[n++] = _text(nJev, K_MODEL_HASH, cfg.modelHashJev);
        c[n++] = _text(
            nJev,
            K_AGENT_CONTEXT,
            "Jev decision model (typesafe-ai/jev via Vercel AI Gateway), asked every block: is there profitable arbitrage at the base fee? -> {pToxicBps, confidenceBps}; public fee law k = kMax * p * c (kMin 0, no gap threshold), so p near 0 = base fee. Calibration written by settler."
        );
        c[n++] = _text(nHeur, K_MODEL_HASH, cfg.modelHashHeuristic);
        c[n++] = _text(
            nHeur,
            K_AGENT_CONTEXT,
            "Deterministic heuristic baseline (gap, imbalance, size/depth, realized vol) -> {pToxicBps, confidenceBps}. Fallback when Jev is slow or demoted."
        );
        c[n++] = _text(nRule, K_MODEL_HASH, vm.toString(keccak256("oniblock/rule-v1")));
        c[n++] = _text(
            nRule,
            K_AGENT_CONTEXT,
            "Deterministic keeper rule (v3; only with KEEPER_GATE=1, not used by the v4 default keeper): posted when the pool-vs-CEX gap is below the pool's arbThresholdPips, where the fee law charges exactly baseFee and k is irrelevant. Fixed {pToxicBps 1000, confidenceBps 10000}; never graded by the settler (no calibration.* records)."
        );
        c[n++] = _text(nPool, K_HOOK, cfg.hook == address(0) ? "" : vm.toString(cfg.hook));
        c[n++] = _text(nPool, K_POOL_ID, cfg.poolId == bytes32(0) ? "" : vm.toString(cfg.poolId));
        c[n++] = _text(nPool, K_FEE_MIN, cfg.feeMin);
        c[n++] = _text(nPool, K_FEE_MAX, cfg.feeMax);
        c[n++] = _text(nPool, K_POLICY_URI, cfg.policyUri);
        c[n++] = cfg.hook == address(0) ? _text(nPool, K_DESCRIPTION, "mWETH/mUSDC Oniblock pool") : _addr(nPool, cfg.hook);
        res.multicall(c);
    }

    function _addr(bytes memory name, address a) internal pure returns (bytes memory) {
        return abi.encodeCall(IEnsPermissionedResolver.setAddress, (name, EnsV2Lib.COIN_TYPE_ETH, abi.encodePacked(a)));
    }

    function _text(bytes memory name, string memory k, string memory v) internal pure returns (bytes memory) {
        return abi.encodeCall(IEnsPermissionedResolver.setText, (name, k, v));
    }

    function _labelOf(string memory name) internal pure returns (string memory) {
        bytes memory b = bytes(name);
        require(b.length > 4, "EnsSetup: ENS_NAME must be <label>.eth");
        bytes memory out = new bytes(b.length - 4);
        for (uint256 i; i < out.length; ++i) {
            out[i] = b[i];
        }
        require(keccak256(bytes(string.concat(string(out), ".eth"))) == keccak256(b), "EnsSetup: not .eth");
        return string(out);
    }

    // ================================================================== output
    function writeJson(Config memory cfg, Result memory r) public {
        string memory root = string.concat(cfg.label, ".eth");
        string memory o = "ens";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeString(o, "name", root);
        vm.serializeAddress(o, "owner", cfg.owner);
        vm.serializeAddress(o, "quoter", cfg.quoter);
        vm.serializeAddress(o, "settler", cfg.settler);
        vm.serializeAddress(o, "hook", cfg.hook);
        vm.serializeAddress(o, "ethRegistry", r.ethRegistry);
        vm.serializeAddress(o, "ethRegistrar", cfg.ens.registrar);
        vm.serializeAddress(o, "universalResolver", cfg.ens.universalResolver);
        vm.serializeAddress(o, "resolver", r.resolver);
        vm.serializeAddress(o, "registry", r.registry);
        vm.serializeAddress(o, "modelsRegistry", r.modelsRegistry);
        vm.serializeAddress(o, "poolsRegistry", r.poolsRegistry);
        vm.serializeAddress(o, "roleOracle", r.roleOracle);
        vm.serializeUint(o, "nameTokenId", r.tokenId);
        vm.serializeString(o, "roleQuoter", vm.toString(bytes32(EnsV2Lib.ROLE_QUOTER)));
        vm.serializeString(o, "roleSettler", vm.toString(bytes32(EnsV2Lib.ROLE_SETTLER)));
        vm.serializeString(o, "quoterLabelId", vm.toString(bytes32(EnsV2Lib.labelId("quoter"))));
        vm.serializeString(o, "settlerLabelId", vm.toString(bytes32(EnsV2Lib.labelId("settler"))));
        vm.serializeString(o, "quoterResource", vm.toString(bytes32(r.quoterResource)));
        vm.serializeString(o, "settlerResource", vm.toString(bytes32(r.settlerResource)));

        string memory nh = "namehash";
        vm.serializeBytes32(nh, root, EnsV2Lib.namehash(root));
        vm.serializeBytes32(nh, string.concat("quoter.", root), EnsV2Lib.namehash(string.concat("quoter.", root)));
        vm.serializeBytes32(nh, string.concat("settler.", root), EnsV2Lib.namehash(string.concat("settler.", root)));
        vm.serializeBytes32(nh, string.concat("models.", root), EnsV2Lib.namehash(string.concat("models.", root)));
        vm.serializeBytes32(
            nh, string.concat("jev-v1.models.", root), EnsV2Lib.namehash(string.concat("jev-v1.models.", root))
        );
        vm.serializeBytes32(
            nh,
            string.concat("heuristic-v1.models.", root),
            EnsV2Lib.namehash(string.concat("heuristic-v1.models.", root))
        );
        vm.serializeBytes32(
            nh, string.concat("rule-v1.models.", root), EnsV2Lib.namehash(string.concat("rule-v1.models.", root))
        );
        vm.serializeBytes32(nh, string.concat("pools.", root), EnsV2Lib.namehash(string.concat("pools.", root)));
        string memory nhJson = vm.serializeBytes32(
            nh, string.concat("weth-usdc.pools.", root), EnsV2Lib.namehash(string.concat("weth-usdc.pools.", root))
        );
        string memory json = vm.serializeString(o, "namehashes", nhJson);

        string memory path = vm.envOr(
            "ENS_OUT",
            string.concat(vm.projectRoot(), "/../deployments/", vm.toString(block.chainid), ".ens.json")
        );
        vm.writeJson(json, path);
        console2.log("wrote", path);
    }
}
