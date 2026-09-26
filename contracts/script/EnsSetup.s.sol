// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";

import {
    EnsGrant,
    IEnsPermissionedRegistry,
    IEnsUserRegistryInit,
    IEnsETHRegistrar,
    IEnsVerifiableFactory,
    IEnsPermissionedResolver,
    IEnsProfiles,
    IEnsMockERC20
} from "../src/interfaces/ens/IEnsV2.sol";
import {EnsV2Lib} from "../src/roles/EnsV2Lib.sol";
import {EnsV2RoleOracle} from "../src/roles/EnsV2RoleOracle.sol";
import {OniblockHook} from "../src/OniblockHook.sol";
import {OniblockLiveResolver} from "../src/ens/OniblockLiveResolver.sol";

/// @title EnsSetup
/// @notice ENSv2 (Sepolia beta) setup for Oniblock:
///   1. commit  : ETHRegistrar.commit(makeCommitment(label, owner, secret, 0, 0, duration, 0))
///   2. finish  : (after MIN_COMMITMENT_AGE = 60s)
///      - mint + approve MockUSDC, ETHRegistrar.register(...)             -> <label>.eth owned by `owner`
///      - VerifiableFactory proxies: PermissionedResolver, UserRegistry for <label>.eth, models.<label>.eth,
///        pools.<label>.eth (all owned by `owner` via root grants)
///      - ETH registry: setSubregistry / setResolver on <label>.eth
///      - subnames: quoter, settler, models -> {jev-v1, heuristic-v1, oniblock1,
///        rule-v1 (v3 gate only)}, pools -> {weth-usdc},
///        live (ENSIP-10 wildcard namespace, see add-live)
///      - v4 pool config (DeployBase): arbThresholdPips 0, kMin 0, kDefault 0, kMax 8000, maxKStep 8000 — Jev decides
///      - EAC roles: ROLE_QUOTER on quoter.<label>.eth -> quoter; ROLE_SETTLER on settler.<label>.eth -> settler
///      - resolver records (addr + text, incl. ENSIP-26 agent-context and agent-endpoint[web]) and settler-only
///        per-key text roles for calibration.* and calibration.jit.* (v5 JIT head)
///      - deploys EnsV2RoleOracle pointing at the subregistry
///      - `live.<label>.eth`: registered with the OniblockLiveResolver when ENS_HOOK is set and matches the
///        deployment json (ENS_DEPLOYMENT_JSON / ../deployments/<chainId>.json); otherwise with the shared
///        PermissionedResolver as a placeholder that `add-live` repoints once the hook exists
///      - writes ../deployments/<chainId>.ens.json
///   3. grant-jit (alias grant-cal) : (upgrade of an EXISTING setup, no re-registration) grants the settler the
///      per-key setter roles for every settler key, calibration.* (incl. the newer calibration.chargeThreshold) and
///      calibration.jit.* (v5), on the resolver recorded in ENS_OUT / ../deployments/<chainId>.ens.json.
///      Idempotent: keys the settler already holds are skipped. ENS_SETTLER defaults to the json's settler.
///   4. add-live  : deploys OniblockLiveResolver (constructor from the deployment json: hook, Oniblock pool id/key;
///      models/pools nodes from ENS_NAME) unless the json's `liveResolver` already serves that hook + pool with the
///      same base name, pool label and owner, registers `live` in the <label>.eth registry with it (or repoints the
///      resolver of an existing `live`), sets the known labels (ENS_LIVE_LABELS, default
///      jev-v1,heuristic-v1,oniblock1,rule-v1) and records hook / liveResolver / liveName / liveNode + the live
///      namehashes in the ens json. Idempotent.
///   5. add-model : registers ENS_MODEL_LABEL in the models registry (owner ENS_MODEL_OWNER, default ENS_OWNER) with
///      the shared PermissionedResolver, writes model-hash / agent-context / agent-endpoint[web] / description
///      (ENS_MODEL_HASH / ENS_MODEL_CONTEXT / ENS_MODEL_ENDPOINT / ENS_MODEL_DESCRIPTION; empty = leave as is) and
///      grants the settler the calibration.* + calibration.jit.* keys. A name registered to an owner other than
///      ENS_OWNER gets no ROLE_SET_RESOLVER, so its author cannot repoint it. Idempotent: registration is skipped
///      when the name exists (with a warning, and no transfer, if its owner is not ENS_MODEL_OWNER), records are
///      rewritten only when they differ, grants only when missing.
///   6. set-endpoints : ENSIP-26 `agent-endpoint[web]` on jev-v1 (ENS_ENDPOINT_JEV, default the Vercel AI Gateway
///      evaluate URL), heuristic-v1 (ENS_ENDPOINT_HEURISTIC, default "in-process") and
///      oniblock1 (ENS_ENDPOINT_ONIBLOCK1: its System One URL, Kev's own server `python -m kev.serve`
///      (ml/serve/start-kev.sh) `POST /v1/systemone`; default empty = skip) for setups from before the key existed. Idempotent.
///   The ens json is written (finish / add-live / add-model) only under `forge script --broadcast` (or --resume);
///   a dry run leaves it untouched.
///
/// Env (all optional except where noted):
///   ENS_PHASE      commit | finish | all | grant-jit (= grant-cal) | add-live | add-model | set-endpoints  (default all; `all`
///                  only works in simulation / on a chain where the script's vm.warp is honoured, i.e. forge test.
///                  For anvil use commit, then `cast rpc evm_increaseTime 61 && cast rpc anvil_mine`, then finish.)
///   ENS_NAME       default "oniblock.eth"
///   ENS_OWNER      default: the broadcasting sender (msg.sender of the script)
///   ENS_QUOTER     default: owner         ENS_SETTLER default: owner
///   ENS_HOOK       optional hook address  ENS_POOL_ID optional bytes32
///   ENS_SECRET     commit-reveal secret (default keccak256("oniblock-ens", owner, label))
///   ENS_DURATION   seconds (default 365 days)   ENS_SALT  factory salt nonce (default 0)
///   ENS_OUT        output json path (default ../deployments/<chainId>.ens.json; use a different path for fork runs)
///   ENS_DEPLOYMENT_JSON  hook deployment json (default ../deployments/<chainId>.json; add-live / finish-with-hook)
///   ENS_POOL_LABEL default "weth-usdc"   ENS_LIVE_LABELS comma list (default jev-v1,heuristic-v1,oniblock1,rule-v1)
///   ENS_ENDPOINT_JEV / ENS_ENDPOINT_HEURISTIC / ENS_ENDPOINT_ONIBLOCK1   ENSIP-26
///                  agent-endpoint[web] values
///   ENS_MODEL_LABEL (required by add-model) / ENS_MODEL_OWNER / ENS_MODEL_HASH / ENS_MODEL_CONTEXT /
///   ENS_MODEL_ENDPOINT / ENS_MODEL_DESCRIPTION
///   ENS_FEE_MIN / ENS_FEE_MAX / ENS_POLICY_URI / ENS_MODEL_HASH_JEV / ENS_MODEL_HASH_HEURISTIC /
///   ENS_MODEL_HASH_ONIBLOCK1 (default: the Kev adapter hash = sha256 of ml/models/kev08b-v1/SHA256, its sorted per-file digests)
///   ENS_ETH_REGISTRAR, ENS_VERIFIABLE_FACTORY, ENS_USER_REGISTRY_IMPL, ENS_PERMISSIONED_RESOLVER_IMPL,
///   ENS_MOCK_USDC, ENS_UNIVERSAL_RESOLVER   (required; from .env)
contract EnsSetup is Script {
    // ------------------------------------------------------------------ text keys
    string internal constant K_MODEL_HASH = "model-hash";
    string internal constant K_AGENT_CONTEXT = "agent-context"; // ENSIP-26
    /// ENSIP-26 `agent-endpoint[<protocol>]`, protocol in {mcp, a2a, web}; value: the endpoint URL.
    string internal constant K_AGENT_ENDPOINT = "agent-endpoint[web]";
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
    // Settler's rolling charge threshold (bps): the model is charged iff pToxicBps >= this value. Settler-only.
    string internal constant K_CAL_CHARGE_THRESHOLD = "calibration.chargeThreshold";
    // v5: the model's JIT head (pJitBps -> JIT penalty window) has its own calibration record, mirrored on the same
    // model name under calibration.jit.* (hook key: OniblockHook.jitCalibrationKey(modelNode)). Settler-only too.
    string internal constant K_JIT_BRIER = "calibration.jit.brier";
    string internal constant K_JIT_HIT = "calibration.jit.hitRate";
    string internal constant K_JIT_N = "calibration.jit.n";
    string internal constant K_JIT_EPOCH = "calibration.jit.epoch";
    string internal constant K_JIT_BRIER_RAW = "calibration.jit.brierRaw";
    string internal constant K_JIT_SKILL = "calibration.jit.skill";
    string internal constant K_JIT_BASE_RATE = "calibration.jit.baseRate";
    string internal constant K_HOOK = "hook";
    string internal constant K_POOL_ID = "pool-id";
    string internal constant K_FEE_MIN = "fee-min";
    string internal constant K_FEE_MAX = "fee-max";
    string internal constant K_POLICY_URI = "policy-uri";

    string internal constant LIVE_LABEL = "live";
    string internal constant DEFAULT_ENDPOINT_JEV = "https://ai-gateway.vercel.sh/v1/evaluate";
    string internal constant DEFAULT_ENDPOINT_HEURISTIC = "in-process";

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
        string modelHashOniblock1; // sha256 of ml/models/kev08b-v1/SHA256 (the Kev adapter's per-file digests)
        string poolLabel; // "weth-usdc": the pool served by <poolLabel>.live.<label>.eth
        string endpointJev; // ENSIP-26 agent-endpoint[web] of jev-v1
        string endpointHeuristic; // ... of heuristic-v1
        string endpointOniblock1; // ... of oniblock1 (its System One URL; "" = leave unset / unchanged)
    }

    struct Result {
        address ethRegistry;
        address resolver;
        address registry; // <label>.eth subregistry
        address modelsRegistry;
        address poolsRegistry;
        address roleOracle;
        address liveResolver; // OniblockLiveResolver serving live.<label>.eth (0 = placeholder shared resolver)
        uint256 tokenId; // <label>.eth token id in ETH registry (at registration time)
        uint256 quoterResource;
        uint256 settlerResource;
    }

    /// A model name to register / update under models.<label>.eth (add-model phase).
    struct ModelSpec {
        string label;
        address owner;
        string modelHash; // "" = leave unchanged
        string context; // ENSIP-26 agent-context; "" = leave unchanged
        string endpoint; // ENSIP-26 agent-endpoint[web]; "" = leave unchanged
        string description; // "" = leave unchanged
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
            if (_broadcasting()) writeJson(cfg, r);
            else console2.log("finish: not broadcasting (no --broadcast), ens json not written");
        } else if (p == keccak256("grant-jit") || p == keccak256("grant-cal")) {
            grantJitPhase(cfg, phase);
        } else if (p == keccak256("add-live")) {
            addLivePhase(cfg);
        } else if (p == keccak256("add-model")) {
            addModelPhase(cfg);
        } else if (p == keccak256("set-endpoints")) {
            setEndpointsPhase(cfg);
        } else {
            require(p == keccak256("all"), "EnsSetup: unknown ENS_PHASE");
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
        // oniblock1's open weights (the Kev-0.8B LoRA adapter ml/models/kev08b-v1/adapter): sha256 of
        // ml/models/kev08b-v1/SHA256, the sorted per-file digest list (ml/train_kev4b/README.md Step 6).
        cfg.modelHashOniblock1 = vm.envOr(
            "ENS_MODEL_HASH_ONIBLOCK1", string("0x24f0793d55e0fde516ebe4da1d187e0468a5f7c830ba9a9f4d48e43f007c88be")
        );
        cfg.poolLabel = vm.envOr("ENS_POOL_LABEL", string("weth-usdc"));
        cfg.endpointJev = vm.envOr("ENS_ENDPOINT_JEV", DEFAULT_ENDPOINT_JEV);
        cfg.endpointHeuristic = vm.envOr("ENS_ENDPOINT_HEURISTIC", DEFAULT_ENDPOINT_HEURISTIC);
        cfg.endpointOniblock1 = vm.envOr("ENS_ENDPOINT_ONIBLOCK1", string(""));
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
        uint256 std = _stdRoles();
        uint64 forever = type(uint64).max; // subnames in our own registry never expire (expiry wipes roles)
        reg.register("quoter", cfg.owner, address(0), r.resolver, std | EnsV2Lib.ROLE_QUOTER_ADMIN, forever);
        reg.register("settler", cfg.owner, address(0), r.resolver, std | EnsV2Lib.ROLE_SETTLER_ADMIN, forever);
        reg.register("models", cfg.owner, r.modelsRegistry, r.resolver, std, forever);
        reg.register("pools", cfg.owner, r.poolsRegistry, r.resolver, std, forever);

        IEnsPermissionedRegistry models = IEnsPermissionedRegistry(r.modelsRegistry);
        models.setParent(r.registry, "models");
        models.register("jev-v1", cfg.owner, address(0), r.resolver, std, forever);
        models.register("heuristic-v1", cfg.owner, address(0), r.resolver, std, forever);
        models.register("oniblock1", cfg.owner, address(0), r.resolver, std, forever); // production model: the Kev-0.8B System One fine-tune
        models.register("rule-v1", cfg.owner, address(0), r.resolver, std, forever); // v3 below-threshold rule

        IEnsPermissionedRegistry pools = IEnsPermissionedRegistry(r.poolsRegistry);
        pools.setParent(r.registry, "pools");
        pools.register(cfg.poolLabel, cfg.owner, address(0), r.resolver, std, forever);

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

        // ---- 2h. live.<label>.eth: the ENSIP-10 wildcard namespace. With the hook known (ENS_HOOK matching the
        // deployment json) the OniblockLiveResolver is deployed and set right away; otherwise the label is
        // registered with the shared resolver so the name exists, and `add-live` repoints it after the hook deploy.
        if (cfg.hook != address(0) && _deploymentMatches(cfg)) {
            (address hook, bytes32 poolId, PoolKey memory key) = _deployment(cfg);
            r.liveResolver = addLive(cfg, r.registry, address(0), hook, poolId, key);
        } else {
            reg.register(LIVE_LABEL, cfg.owner, address(0), r.resolver, std, forever);
            console2.log("live.<name> registered with the shared resolver; run ENS_PHASE=add-live after the hook deploy");
        }

        vm.stopBroadcast();
    }

    // ================================================================== phase 3: settler key grants (upgrade)
    /// Grants the settler the calibration.* (incl. calibration.chargeThreshold) and calibration.jit.* setter roles on
    /// an already-deployed setup. Reads the resolver (and, unless ENS_SETTLER is set, the settler) from ENS_OUT /
    /// ../deployments/<chainId>.ens.json. Idempotent: keys the settler already holds are skipped.
    /// `phase` ("grant-jit" or its alias "grant-cal") only labels the log lines.
    function grantJitPhase(Config memory cfg, string memory phase) public {
        string memory j = _readEnsJson();
        address resolver = vm.parseJsonAddress(j, ".resolver");
        require(resolver != address(0), "EnsSetup: resolver missing in ens json");
        address settler = _settlerOf(cfg, j);

        uint256 granted = grantSettlerKeysBroadcast(cfg, resolver, settler);
        console2.log(string.concat(phase, ": resolver"), resolver);
        console2.log(string.concat(phase, ": settler "), settler);
        console2.log(string.concat(phase, ": new grants"), granted);
    }

    /// Core of grant-jit, broadcast as `cfg.owner`: every settler-only key (calibration.* + calibration.jit.*) the
    /// settler does not hold yet. Returns the number of new grants.
    function grantSettlerKeysBroadcast(Config memory cfg, address resolver, address settler)
        public
        returns (uint256 granted)
    {
        IEnsPermissionedResolver res = IEnsPermissionedResolver(resolver);
        bytes memory nRoot = EnsV2Lib.dnsEncode(string.concat(cfg.label, ".eth"));
        vm.startBroadcast(cfg.owner);
        granted = _grantKeys(res, nRoot, _calKeys(), settler);
        granted += _grantKeys(res, nRoot, _jitCalKeys(), settler);
        vm.stopBroadcast();
    }

    // ================================================================== phase 4: add-live (wildcard resolver)
    /// Deploys / reuses the OniblockLiveResolver for the hook + pool in the deployment json, registers or repoints
    /// `live.<label>.eth` to it, sets the known labels and records it in the ens json. Idempotent.
    function addLivePhase(Config memory cfg) public {
        string memory j = _readEnsJson();
        address registry = vm.parseJsonAddress(j, ".registry");
        require(registry != address(0), "EnsSetup: registry missing in ens json");
        address existing = vm.keyExistsJson(j, ".liveResolver") ? vm.parseJsonAddress(j, ".liveResolver") : address(0);
        (address hook, bytes32 poolId, PoolKey memory key) = _deployment(cfg);

        address live = addLiveBroadcast(cfg, registry, existing, hook, poolId, key);

        if (_broadcasting()) _writeLiveJson(cfg, j, live, hook);
        else console2.log("add-live: not broadcasting (no --broadcast), ens json not written");
        console2.log("add-live: liveResolver", live);
        console2.log("add-live: hook", hook);
        console2.logBytes32(poolId);
    }

    /// `addLive` broadcast as `cfg.owner` (the phase entry point and the fork tests).
    function addLiveBroadcast(
        Config memory cfg,
        address registry,
        address existing,
        address hook,
        bytes32 poolId,
        PoolKey memory key
    ) public returns (address live) {
        vm.startBroadcast(cfg.owner);
        live = addLive(cfg, registry, existing, hook, poolId, key);
        vm.stopBroadcast();
    }

    /// Core of add-live (also used by finish when the hook is known). `existing` (may be 0) is reused when it already
    /// serves this hook + pool. Registers `live` if missing, else repoints its resolver if it differs; sets the known
    /// labels if they differ. Caller broadcasts as `cfg.owner`.
    function addLive(
        Config memory cfg,
        address registry,
        address existing,
        address hook,
        bytes32 poolId,
        PoolKey memory key
    ) public returns (address live) {
        string memory root = string.concat(cfg.label, ".eth");
        string memory baseName = string.concat(LIVE_LABEL, ".", root);
        if (existing != address(0) && _liveMatches(cfg, existing, hook, poolId, baseName)) {
            live = existing;
        } else {
            live = address(
                new OniblockLiveResolver(
                    cfg.owner,
                    OniblockHook(hook),
                    poolId,
                    key,
                    EnsV2Lib.namehash(string.concat("models.", root)),
                    EnsV2Lib.namehash(string.concat("pools.", root)),
                    baseName,
                    cfg.poolLabel
                )
            );
            console2.log("add-live: deployed OniblockLiveResolver", live);
        }

        IEnsPermissionedRegistry reg = IEnsPermissionedRegistry(registry);
        uint256 id = EnsV2Lib.labelId(LIVE_LABEL);
        if (reg.getState(id).status != IEnsPermissionedRegistry.Status.REGISTERED) {
            reg.register(LIVE_LABEL, cfg.owner, address(0), live, _stdRoles(), type(uint64).max);
            console2.log("add-live: registered", baseName);
        } else if (reg.getResolver(LIVE_LABEL) != live) {
            reg.setResolver(id, live);
            console2.log("add-live: resolver of live repointed");
        }

        string[] memory labels = _liveLabels();
        if (keccak256(abi.encode(OniblockLiveResolver(live).knownLabels())) != keccak256(abi.encode(labels))) {
            OniblockLiveResolver(live).setKnownLabels(labels);
        }
    }

    /// True iff `live` is an OniblockLiveResolver for exactly this setup: same hook, pool id, base name
    /// (`live.<root>`), pool label and owner. Anything else (another root / pool label / owner) gets a fresh deploy.
    function _liveMatches(Config memory cfg, address live, address hook, bytes32 poolId, string memory baseName)
        internal
        view
        returns (bool)
    {
        if (live.code.length == 0) return false;
        OniblockLiveResolver r = OniblockLiveResolver(live);
        try r.hook() returns (OniblockHook h) {
            if (address(h) != hook || r.poolId() != poolId || r.owner() != cfg.owner) return false;
            return keccak256(bytes(r.baseName())) == keccak256(bytes(baseName))
                && keccak256(bytes(r.poolLabel())) == keccak256(bytes(cfg.poolLabel));
        } catch {
            return false;
        }
    }

    function _liveLabels() internal view returns (string[] memory labels) {
        labels = new string[](4);
        labels[0] = "jev-v1";
        labels[1] = "heuristic-v1";
        labels[2] = "oniblock1";
        labels[3] = "rule-v1";
        labels = vm.envOr("ENS_LIVE_LABELS", ",", labels);
    }

    // ================================================================== phase 5: add-model
    /// Registers / updates one model name under models.<label>.eth from ENS_MODEL_* and grants the settler its
    /// calibration keys. Idempotent.
    function addModelPhase(Config memory cfg) public {
        string memory j = _readEnsJson();
        address modelsRegistry = vm.parseJsonAddress(j, ".modelsRegistry");
        address resolver = vm.parseJsonAddress(j, ".resolver");
        require(modelsRegistry != address(0) && resolver != address(0), "EnsSetup: ens json incomplete");
        address settler = _settlerOf(cfg, j);

        ModelSpec memory m;
        m.label = vm.envString("ENS_MODEL_LABEL");
        m.owner = vm.envOr("ENS_MODEL_OWNER", cfg.owner);
        m.modelHash = vm.envOr("ENS_MODEL_HASH", string(""));
        m.context = vm.envOr("ENS_MODEL_CONTEXT", string(""));
        m.endpoint = vm.envOr("ENS_MODEL_ENDPOINT", string(""));
        m.description = vm.envOr("ENS_MODEL_DESCRIPTION", string(""));

        (bool registered, uint256 writes, uint256 grants) = addModelBroadcast(cfg, modelsRegistry, resolver, settler, m);

        // keep the ens json's namehashes complete (services reverse-map model nodes through it)
        if (_broadcasting()) {
            string memory o = "ens-model";
            vm.serializeJson(o, j);
            string[] memory extra = new string[](1);
            extra[0] = string.concat(m.label, ".models.", cfg.label, ".eth");
            string memory json = vm.serializeString(o, "namehashes", _namehashesJson(cfg, j, extra));
            vm.writeJson(json, _jsonPath());
        } else {
            console2.log("add-model: not broadcasting (no --broadcast), ens json not written");
        }

        console2.log("add-model:", m.label, registered ? "registered" : "already registered");
        console2.log("add-model: records written", writes);
        console2.log("add-model: new key grants", grants);
    }

    /// `addModel` broadcast as `cfg.owner`.
    function addModelBroadcast(
        Config memory cfg,
        address modelsRegistry,
        address resolver,
        address settler,
        ModelSpec memory m
    ) public returns (bool registered, uint256 writes, uint256 grants) {
        vm.startBroadcast(cfg.owner);
        (registered, writes, grants) = addModel(cfg, modelsRegistry, resolver, settler, m);
        vm.stopBroadcast();
    }

    /// Core of add-model. Caller broadcasts as `cfg.owner` (holds the registry root roles and the owner text keys).
    function addModel(
        Config memory cfg,
        address modelsRegistry,
        address resolver,
        address settler,
        ModelSpec memory m
    ) public returns (bool registered, uint256 writes, uint256 grants) {
        require(bytes(m.label).length > 0 && bytes(m.label).length < 256, "EnsSetup: bad model label");
        IEnsPermissionedRegistry models = IEnsPermissionedRegistry(modelsRegistry);
        IEnsPermissionedResolver res = IEnsPermissionedResolver(resolver);
        uint256 id = EnsV2Lib.labelId(m.label);

        if (models.getState(id).status != IEnsPermissionedRegistry.Status.REGISTERED) {
            // A name owned by someone other than the team owner gets no ROLE_SET_RESOLVER (nor its admin bit): the
            // author holds the token but cannot repoint the name away from the shared resolver where the settler's
            // scorecard lives. The team owner keeps ROLE_SET_RESOLVER through its registry root roles.
            uint256 roles = m.owner == cfg.owner ? _stdRoles() : _authorRoles();
            models.register(m.label, m.owner, address(0), resolver, roles, type(uint64).max);
            registered = true;
        } else {
            address current = models.getOwner(id);
            if (current != m.owner) {
                // never auto-transfer: the token is the current owner's; ENS_MODEL_OWNER only applies at registration
                console2.log(
                    string.concat(
                        "add-model: WARNING ",
                        m.label,
                        " is already registered to ",
                        vm.toString(current),
                        "; ENS_MODEL_OWNER ",
                        vm.toString(m.owner),
                        " ignored - transfer the token manually"
                    )
                );
            }
            if (models.getResolver(m.label) != resolver) models.setResolver(id, resolver);
        }

        string memory root = string.concat(cfg.label, ".eth");
        bytes memory nRoot = EnsV2Lib.dnsEncode(root);
        bytes memory name = EnsV2Lib.dnsEncode(string.concat(m.label, ".models.", root));

        // the static keys are owner-writable (granted at finish); agent-endpoint[web] is newer, grant if missing
        string[] memory ownerKeys = new string[](4);
        ownerKeys[0] = K_MODEL_HASH;
        ownerKeys[1] = K_AGENT_CONTEXT;
        ownerKeys[2] = K_AGENT_ENDPOINT;
        ownerKeys[3] = K_DESCRIPTION;
        grants += _grantKeys(res, nRoot, ownerKeys, cfg.owner);

        string[] memory values = new string[](4);
        values[0] = m.modelHash;
        values[1] = m.context;
        values[2] = m.endpoint;
        values[3] = m.description;
        bytes[] memory c = new bytes[](4);
        uint256 n;
        for (uint256 i; i < 4; ++i) {
            if (_differs(res, name, ownerKeys[i], values[i])) c[n++] = _text(name, ownerKeys[i], values[i]);
        }
        if (n > 0) {
            assembly ("memory-safe") {
                mstore(c, n)
            }
            res.multicall(c);
            writes = n;
        }

        grants += _grantKeys(res, nRoot, _calKeys(), settler);
        grants += _grantKeys(res, nRoot, _jitCalKeys(), settler);
    }

    // ================================================================== phase 6: set-endpoints (ENSIP-26)
    function setEndpointsPhase(Config memory cfg) public {
        string memory j = _readEnsJson();
        address resolver = vm.parseJsonAddress(j, ".resolver");
        require(resolver != address(0), "EnsSetup: resolver missing in ens json");
        (uint256 writes, uint256 grants) = setEndpointsBroadcast(cfg, resolver);
        console2.log("set-endpoints: records written", writes);
        console2.log("set-endpoints: new key grants", grants);
    }

    /// `setEndpoints` broadcast as `cfg.owner`.
    function setEndpointsBroadcast(Config memory cfg, address resolver) public returns (uint256 writes, uint256 grants) {
        vm.startBroadcast(cfg.owner);
        (writes, grants) = setEndpoints(cfg, resolver);
        vm.stopBroadcast();
    }

    /// Writes agent-endpoint[web] on jev-v1, heuristic-v1 and (when ENS_ENDPOINT_ONIBLOCK1 is set) oniblock1 when
    /// they differ (grants the key to the owner first if missing). Caller broadcasts as `cfg.owner`.
    function setEndpoints(Config memory cfg, address resolver) public returns (uint256 writes, uint256 grants) {
        IEnsPermissionedResolver res = IEnsPermissionedResolver(resolver);
        string memory root = string.concat(cfg.label, ".eth");
        string[] memory key = new string[](1);
        key[0] = K_AGENT_ENDPOINT;
        grants = _grantKeys(res, EnsV2Lib.dnsEncode(root), key, cfg.owner);

        bytes memory nJev = EnsV2Lib.dnsEncode(string.concat("jev-v1.models.", root));
        bytes memory nHeur = EnsV2Lib.dnsEncode(string.concat("heuristic-v1.models.", root));
        bytes memory nOni = EnsV2Lib.dnsEncode(string.concat("oniblock1.models.", root));
        bytes[] memory c = new bytes[](3);
        uint256 n;
        if (_differs(res, nJev, K_AGENT_ENDPOINT, cfg.endpointJev)) c[n++] = _text(nJev, K_AGENT_ENDPOINT, cfg.endpointJev);
        if (_differs(res, nHeur, K_AGENT_ENDPOINT, cfg.endpointHeuristic)) {
            c[n++] = _text(nHeur, K_AGENT_ENDPOINT, cfg.endpointHeuristic);
        }
        // oniblock1: its System One URL (Kev's own server, ml/serve/start-kev.sh); ENS_ENDPOINT_ONIBLOCK1 empty (default) = skip
        if (_differs(res, nOni, K_AGENT_ENDPOINT, cfg.endpointOniblock1)) {
            c[n++] = _text(nOni, K_AGENT_ENDPOINT, cfg.endpointOniblock1);
        }
        if (n > 0) {
            assembly ("memory-safe") {
                mstore(c, n)
            }
            res.multicall(c);
            writes = n;
        }
    }

    // ================================================================== json inputs
    function _jsonPath() internal view returns (string memory) {
        return vm.envOr(
            "ENS_OUT",
            string.concat(vm.projectRoot(), "/../deployments/", vm.toString(block.chainid), ".ens.json")
        );
    }

    function _readEnsJson() internal view returns (string memory) {
        string memory path = _jsonPath();
        require(vm.exists(path), "EnsSetup: ens json not found (set ENS_OUT)");
        return vm.readFile(path);
    }

    function _settlerOf(Config memory, string memory j) internal view returns (address settler) {
        settler = vm.envOr("ENS_SETTLER", vm.parseJsonAddress(j, ".settler"));
        require(settler != address(0), "EnsSetup: settler missing");
    }

    function _deploymentPath() internal view returns (string memory) {
        return vm.envOr(
            "ENS_DEPLOYMENT_JSON",
            string.concat(vm.projectRoot(), "/../deployments/", vm.toString(block.chainid), ".json")
        );
    }

    /// Hook + Oniblock pool (id and key) from the hook deployment json (DeployBase output).
    function _deployment(Config memory cfg) internal view returns (address hook, bytes32 poolId, PoolKey memory key) {
        string memory path = _deploymentPath();
        require(vm.exists(path), "EnsSetup: deployment json not found (set ENS_DEPLOYMENT_JSON)");
        string memory d = vm.readFile(path);
        hook = vm.parseJsonAddress(d, ".hook");
        poolId = vm.parseJsonBytes32(d, ".pools.oniblock.poolId");
        key.currency0 = Currency.wrap(vm.parseJsonAddress(d, ".pools.oniblock.key.currency0"));
        key.currency1 = Currency.wrap(vm.parseJsonAddress(d, ".pools.oniblock.key.currency1"));
        key.fee = uint24(vm.parseJsonUint(d, ".pools.oniblock.key.fee"));
        key.tickSpacing = int24(vm.parseJsonInt(d, ".pools.oniblock.key.tickSpacing"));
        key.hooks = IHooks(vm.parseJsonAddress(d, ".pools.oniblock.key.hooks"));
        require(hook != address(0) && address(key.hooks) == hook, "EnsSetup: deployment json hook mismatch");
        if (cfg.hook != address(0)) require(cfg.hook == hook, "EnsSetup: ENS_HOOK != deployment json hook");
        if (cfg.poolId != bytes32(0)) require(cfg.poolId == poolId, "EnsSetup: ENS_POOL_ID != deployment json");
    }

    /// True iff a deployment json exists and its hook is ENS_HOOK.
    function _deploymentMatches(Config memory cfg) internal view returns (bool) {
        string memory path = _deploymentPath();
        if (!vm.exists(path)) return false;
        string memory d = vm.readFile(path);
        if (!vm.keyExistsJson(d, ".hook")) return false;
        return vm.parseJsonAddress(d, ".hook") == cfg.hook;
    }

    // ================================================================== helpers
    function _stdRoles() internal pure returns (uint256) {
        return EnsV2Lib.withAdmin(EnsV2Lib.ROLE_SET_RESOLVER | EnsV2Lib.ROLE_SET_SUBREGISTRY)
            | EnsV2Lib.ROLE_CAN_TRANSFER_ADMIN;
    }

    /// Token roles for a model name registered to an author (ENS_MODEL_OWNER != ENS_OWNER): `_stdRoles` minus
    /// ROLE_SET_RESOLVER and its admin bit, so the author cannot repoint the name's resolver.
    function _authorRoles() internal pure returns (uint256) {
        return EnsV2Lib.withAdmin(EnsV2Lib.ROLE_SET_SUBREGISTRY) | EnsV2Lib.ROLE_CAN_TRANSFER_ADMIN;
    }

    /// True under `forge script --broadcast` / `--resume`: the only runs whose results exist on chain, so the only
    /// ones that may write the ens json (a dry run would record addresses that were never deployed).
    function _broadcasting() internal view returns (bool) {
        return vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
    }

    function _calKeys() internal pure returns (string[] memory k) {
        k = new string[](8);
        k[0] = K_CAL_BRIER;
        k[1] = K_CAL_HIT;
        k[2] = K_CAL_N;
        k[3] = K_CAL_EPOCH;
        k[4] = K_CAL_BRIER_RAW;
        k[5] = K_CAL_SKILL;
        k[6] = K_CAL_BASE_RATE;
        k[7] = K_CAL_CHARGE_THRESHOLD;
    }

    function _jitCalKeys() internal pure returns (string[] memory k) {
        k = new string[](7);
        k[0] = K_JIT_BRIER;
        k[1] = K_JIT_HIT;
        k[2] = K_JIT_N;
        k[3] = K_JIT_EPOCH;
        k[4] = K_JIT_BRIER_RAW;
        k[5] = K_JIT_SKILL;
        k[6] = K_JIT_BASE_RATE;
    }

    /// Per-key setText grants for `account`, skipping keys it already holds (resource = keccak256(key), so a grant
    /// covers that key on every name served by the resolver). Returns the number of new grants.
    function _grantKeys(IEnsPermissionedResolver res, bytes memory name, string[] memory keys, address account)
        internal
        returns (uint256 granted)
    {
        for (uint256 i; i < keys.length; ++i) {
            if (res.hasRoles(EnsV2Lib.keyResource(keys[i]), EnsV2Lib.RES_ROLE_SET_TEXT, account)) continue;
            res.grantSetterRoles(abi.encodeCall(IEnsPermissionedResolver.setText, (name, keys[i], "")), account);
            ++granted;
        }
    }

    /// True iff `value` is non-empty and differs from the text record currently stored for `name`/`key`.
    function _differs(IEnsPermissionedResolver res, bytes memory name, string memory key, string memory value)
        internal
        view
        returns (bool)
    {
        if (bytes(value).length == 0) return false;
        string memory cur = abi.decode(res.resolve(name, abi.encodeCall(IEnsProfiles.text, (bytes32(0), key))), (string));
        return keccak256(bytes(cur)) != keccak256(bytes(value));
    }

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
        bytes memory nOni = EnsV2Lib.dnsEncode(string.concat("oniblock1.models.", root));
        bytes memory nPool = EnsV2Lib.dnsEncode(string.concat(cfg.poolLabel, ".pools.", root));
        bytes memory nRule = EnsV2Lib.dnsEncode(string.concat("rule-v1.models.", root));

        // Per-key text grants. Resource = keccak256(key) (name-independent), so a key grant covers that key
        // on every name served by this resolver.
        string[] memory ownerKeys = new string[](11);
        ownerKeys[0] = K_DESCRIPTION;
        ownerKeys[1] = K_MODEL_HASH;
        ownerKeys[2] = K_AGENT_CONTEXT;
        ownerKeys[3] = K_AGENT_ENDPOINT;
        ownerKeys[4] = K_HOOK;
        ownerKeys[5] = K_POOL_ID;
        ownerKeys[6] = K_FEE_MIN;
        ownerKeys[7] = K_FEE_MAX;
        ownerKeys[8] = K_POLICY_URI;
        ownerKeys[9] = "url";
        ownerKeys[10] = "avatar";
        _grantKeys(res, nRoot, ownerKeys, cfg.owner);
        _grantKeys(res, nRoot, _calKeys(), cfg.settler);
        _grantKeys(res, nRoot, _jitCalKeys(), cfg.settler); // v5 JIT head records

        bytes[] memory c = new bytes[](23); // = number of c[n++] entries below
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
            "Jev decision model (typesafe-ai/jev via Vercel AI Gateway), asked every block: is there profitable arbitrage at the base fee? -> {pToxicBps, confidenceBps}; public fee law k = kMax * p * c (kMin 0, no gap threshold), so p near 0 = base fee. JIT head (v5): will liquidity added next block be short-lived fee capture? -> pJitBps; JIT penalty window = min + (max - min) * pJit * c blocks. Calibration written by settler (calibration.* for k, calibration.jit.* for the JIT head)."
        );
        c[n++] = _text(nJev, K_AGENT_ENDPOINT, cfg.endpointJev);
        c[n++] = _text(nHeur, K_MODEL_HASH, cfg.modelHashHeuristic);
        c[n++] = _text(
            nHeur,
            K_AGENT_CONTEXT,
            "Deterministic heuristic baseline (gap, imbalance, size/depth, realized vol) -> {pToxicBps, confidenceBps}; JIT head (v5) from recent liquidity churn -> pJitBps. Fallback when Jev is slow or demoted."
        );
        c[n++] = _text(nHeur, K_AGENT_ENDPOINT, cfg.endpointHeuristic);
        c[n++] = _text(nOni, K_MODEL_HASH, cfg.modelHashOniblock1);
        c[n++] = _text(
            nOni,
            K_DESCRIPTION,
            "oniblock1: Kev-0.8B (jaredpalmer/kev-0.8b) LoRA fine-tune, a TypeSafe System One decision model; weights ml/models/kev08b-v1/adapter; model-hash = sha256 over its sorted per-file digests"
        );
        c[n++] = _text(
            nOni,
            K_AGENT_CONTEXT,
            "oniblock1 production model (Kev-0.8B LoRA fine-tune, served by Kev's own TypeSafe System One server, POST /v1/systemone), asked every block: is this block's arbitrage flow informed? -> {pToxicBps, confidenceBps}; same public fee law k = kMax * p * c. Charge gate 0.8175 (keeper CHARGE_THRESHOLD; validation-chosen, ml/models/kev08b-v1/charge_threshold.json): c = 10000 when p >= threshold, else 0 (base fee). No JIT head (pJitBps 0 -> jitWindowMin, 10 blocks with the defaults). Active from its first attestation once allowlisted; Brier-demoted to kDefault (0 = base fee) if its calibration (written by the settler) exceeds brierDemoteBps."
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
        require(n == c.length, "EnsSetup: record count");
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
        if (r.liveResolver != address(0)) vm.serializeAddress(o, "liveResolver", r.liveResolver); // 0 = placeholder
        vm.serializeString(o, "liveName", string.concat(LIVE_LABEL, ".", root));
        vm.serializeBytes32(o, "liveNode", EnsV2Lib.namehash(string.concat(LIVE_LABEL, ".", root)));
        vm.serializeUint(o, "nameTokenId", r.tokenId);
        vm.serializeString(o, "roleQuoter", vm.toString(bytes32(EnsV2Lib.ROLE_QUOTER)));
        vm.serializeString(o, "roleSettler", vm.toString(bytes32(EnsV2Lib.ROLE_SETTLER)));
        vm.serializeString(o, "quoterLabelId", vm.toString(bytes32(EnsV2Lib.labelId("quoter"))));
        vm.serializeString(o, "settlerLabelId", vm.toString(bytes32(EnsV2Lib.labelId("settler"))));
        vm.serializeString(o, "quoterResource", vm.toString(bytes32(r.quoterResource)));
        vm.serializeString(o, "settlerResource", vm.toString(bytes32(r.settlerResource)));
        string memory json = vm.serializeString(o, "namehashes", _namehashesJson(cfg, "", new string[](0)));

        string memory path = _jsonPath();
        vm.writeJson(json, path);
        console2.log("wrote", path);
    }

    /// add-live: seeds the existing ens json and sets hook / liveResolver / liveName / liveNode + the live namehashes.
    function _writeLiveJson(Config memory cfg, string memory j, address live, address hook) internal {
        string memory root = string.concat(cfg.label, ".eth");
        string memory o = "ens-live";
        vm.serializeJson(o, j);
        vm.serializeAddress(o, "hook", hook); // the hook the live resolver reads (deployment json)
        vm.serializeAddress(o, "liveResolver", live);
        vm.serializeString(o, "liveName", string.concat(LIVE_LABEL, ".", root));
        vm.serializeBytes32(o, "liveNode", EnsV2Lib.namehash(string.concat(LIVE_LABEL, ".", root)));
        string memory json = vm.serializeString(o, "namehashes", _namehashesJson(cfg, j, new string[](0)));
        string memory path = _jsonPath();
        vm.writeJson(json, path);
        console2.log("wrote", path);
    }

    /// name -> namehash object: the default tree, the live names, every name already present in `existingJson`
    /// (recomputed from the key, so custom add-model labels survive) and `extra`.
    function _namehashesJson(Config memory cfg, string memory existingJson, string[] memory extra)
        internal
        returns (string memory out)
    {
        string memory root = string.concat(cfg.label, ".eth");
        string memory live = string.concat(LIVE_LABEL, ".", root);
        string memory nh = string.concat("namehash-", vm.toString(uint256(keccak256(bytes(existingJson)))));
        string[] memory names = new string[](17);
        names[0] = root;
        names[1] = string.concat("quoter.", root);
        names[2] = string.concat("settler.", root);
        names[3] = string.concat("models.", root);
        names[4] = string.concat("jev-v1.models.", root);
        names[5] = string.concat("heuristic-v1.models.", root);
        names[6] = string.concat("oniblock1.models.", root);
        names[7] = string.concat("rule-v1.models.", root);
        names[8] = string.concat("pools.", root);
        names[9] = string.concat(cfg.poolLabel, ".pools.", root);
        names[10] = live;
        names[11] = string.concat(cfg.poolLabel, ".", live);
        names[12] = string.concat("current.", live);
        names[13] = string.concat("jev-v1.", live);
        names[14] = string.concat("heuristic-v1.", live);
        names[15] = string.concat("oniblock1.", live);
        names[16] = string.concat("rule-v1.", live);
        for (uint256 i; i < names.length; ++i) {
            out = vm.serializeBytes32(nh, names[i], EnsV2Lib.namehash(names[i]));
        }
        if (bytes(existingJson).length > 0 && vm.keyExistsJson(existingJson, ".namehashes")) {
            string[] memory keys = vm.parseJsonKeys(existingJson, ".namehashes");
            for (uint256 i; i < keys.length; ++i) {
                out = vm.serializeBytes32(nh, keys[i], EnsV2Lib.namehash(keys[i]));
            }
        }
        for (uint256 i; i < extra.length; ++i) {
            out = vm.serializeBytes32(nh, extra[i], EnsV2Lib.namehash(extra[i]));
        }
    }
}
