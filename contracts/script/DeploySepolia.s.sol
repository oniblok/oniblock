// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

import {DeployBase} from "./DeployBase.s.sol";
import {EnsV2RoleOracle} from "../src/roles/EnsV2RoleOracle.sol";
import {EnsV2Lib} from "../src/roles/EnsV2Lib.sol";
import {IRoleOracle} from "../src/interfaces/IRoleOracle.sol";

/// @notice Sepolia deployment against the real v4 PoolManager, ENSv2 roles and Chainlink ETH/USD.
/// DO NOT broadcast without explicit go-ahead (spends Sepolia ETH). Dry-run / fork only:
///
///   anvil --fork-url $SEPOLIA_RPC_HTTPS &
///   forge script script/DeploySepolia.s.sol --rpc-url http://127.0.0.1:8545 --broadcast   # fork
///
/// Env (required): DEPLOYER_PK, V4_POOL_MANAGER, CHAINLINK_ETH_USD
/// Role oracle (R-09), in order of preference:
///   1. ROLE_ORACLE env, or `roleOracle` from deployments/11155111.ens.json (ENS_JSON overrides the path) — the
///      EnsV2RoleOracle deployed by EnsSetup.s.sol (resource = labelId, bits = EnsV2Lib roles).
///   2. Otherwise a new EnsV2RoleOracle over ENS_ROLE_REGISTRY (required, nonzero) with
///      ENS_QUOTER_LABEL_ID  default EnsV2Lib.labelId("quoter")  = uint256(keccak256("quoter"))  (never 0 = ROOT)
///      ENS_SETTLER_LABEL_ID default EnsV2Lib.labelId("settler") = uint256(keccak256("settler"))
///      ENS_QUOTER_ROLE      default 1<<64 (EnsV2Lib.ROLE_QUOTER), ENS_SETTLER_ROLE default 1<<68 (ROLE_SETTLER)
/// Env (optional): QUOTER, SETTLER, ATTESTOR (recorded in the JSON; roles are granted via ENS, attestor is set on
/// the hook), INIT_PRICE_USD, LIQUIDITY, JIT_OFFSET, SANITY_BAND_BPS (default 200), CHAINLINK_MAX_AGE (default 7200 s),
/// CONFIG_DELAY (hook timelock, default 3600 s), MIN_SAMPLES (default 10), MODEL_NODES, STATE_VIEW, DEPLOYMENTS_OUT.
/// R-04: after deployment, transfer hook ownership (Ownable2Step) to a Safe.
contract DeploySepolia is DeployBase {
    function run() external returns (Deployed memory d) {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        d.deployer = vm.addr(pk);
        d.manager = IPoolManager(vm.envAddress("V4_POOL_MANAGER"));
        d.stateView = vm.envOr("STATE_VIEW", address(0));
        d.quoter = vm.envOr("QUOTER", d.deployer);
        d.settler = vm.envOr("SETTLER", d.deployer);
        d.attestor = vm.envOr("ATTESTOR", d.deployer);
        d.jitOffset = uint48(vm.envOr("JIT_OFFSET", uint256(10)));
        d.initUsdE8 = vm.envOr("INIT_PRICE_USD_E8", vm.envOr("INIT_PRICE_USD", uint256(2500)) * 1e8);
        d.liquidity = int256(vm.envOr("LIQUIDITY", uint256(5e14)));
        d.roleOracleType = "ensv2";

        d.configDelay = vm.envOr("CONFIG_DELAY", uint256(1 hours));
        d.modelNodes = _defaultModelNodes();
        address existingOracle = vm.envOr("ROLE_ORACLE", _ensJsonRoleOracle());
        vm.startBroadcast(pk);
        _deployTokens(d);
        d.roles = existingOracle != address(0) ? IRoleOracle(existingOracle) : IRoleOracle(address(_newOracle(d.deployer)));
        // Chainlink ETH/USD: non-inverted iff mWETH is currency0.
        d.cfg = _configFromEnv(vm.envAddress("CHAINLINK_ETH_USD"), !d.wethIs0, 200);
        _deployHook(d);
        _pools(d);
        _liquidity(d);
        vm.stopBroadcast();

        string memory out = vm.envOr(
            "DEPLOYMENTS_OUT", string.concat(vm.projectRoot(), "/../deployments/", vm.toString(block.chainid), ".json")
        );
        vm.writeJson(_json(d), out);
        _log(d);
    }

    /// `roleOracle` from the EnsSetup output, if present.
    function _ensJsonRoleOracle() internal view returns (address) {
        string memory path =
            vm.envOr("ENS_JSON", string.concat(vm.projectRoot(), "/../deployments/", vm.toString(block.chainid), ".ens.json"));
        if (!vm.exists(path)) return address(0);
        string memory j = vm.readFile(path);
        if (!vm.keyExistsJson(j, ".roleOracle")) return address(0);
        return vm.parseJsonAddress(j, ".roleOracle");
    }

    function _newOracle(address owner) internal returns (EnsV2RoleOracle) {
        address registry = vm.envAddress("ENS_ROLE_REGISTRY");
        require(registry != address(0), "ENS_ROLE_REGISTRY required");
        EnsV2RoleOracle.RoleRef memory q = EnsV2RoleOracle.RoleRef(
            registry,
            vm.envOr("ENS_QUOTER_LABEL_ID", EnsV2Lib.labelId("quoter")),
            vm.envOr("ENS_QUOTER_ROLE", EnsV2Lib.ROLE_QUOTER)
        );
        EnsV2RoleOracle.RoleRef memory s = EnsV2RoleOracle.RoleRef(
            registry,
            vm.envOr("ENS_SETTLER_LABEL_ID", EnsV2Lib.labelId("settler")),
            vm.envOr("ENS_SETTLER_ROLE", EnsV2Lib.ROLE_SETTLER)
        );
        require(q.resource != 0 && s.resource != 0, "ROOT resource not allowed");
        return new EnsV2RoleOracle(owner, q, s);
    }
}
