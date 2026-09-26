// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {StateView} from "@uniswap/v4-periphery/src/lens/StateView.sol";

import {DeployBase} from "./DeployBase.s.sol";
import {MockRoleOracle} from "../src/mocks/MockRoleOracle.sol";
import {IRoleOracle} from "../src/interfaces/IRoleOracle.sol";

/// @notice Fresh anvil (31337): PoolManager + mWETH/mUSDC + MockRoleOracle + hook + Oniblock pool + vanilla 0.30%
/// pool + liquidity + SplitSwapRouter. Writes ../deployments/31337.json.
///
///   anvil &
///   forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
///
/// Env (all optional): LOCAL_PK (default anvil #0), QUOTER/SETTLER/ATTESTOR (default anvil #1/#2/#3),
/// INIT_PRICE_USD (default 2500), INIT_PRICE_USD_E8 (overrides), LIQUIDITY (default 5e16 ~ 1000 ETH full range),
/// JIT_OFFSET (default 10), CHAINLINK_FEED (default disabled — no mocked price data locally),
/// DEPLOYMENTS_OUT (default ../deployments/<chainId>.json), CONFIG_DELAY (default 0), MODEL_NODES (comma-separated
/// bytes32; default namehash of jev-v1 / heuristic-v1 / kev-v1 .models.oniblock.eth, + rule-v1 if KEEPER_GATE=1),
/// ARB_THRESHOLD_PIPS (v4 default 0), K_MIN_BPS / K_DEFAULT_BPS (v4 default 0), K_MAX_BPS (8000),
/// MAX_K_STEP_BPS (v4 default 8000), JIT_WINDOW_MIN / JIT_WINDOW_MAX / JIT_WINDOW_DEFAULT (v5, default 10/100/10),
/// plus pool config overrides (see DeployBase).
contract DeployLocal is DeployBase {
    uint256 internal constant ANVIL0_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external returns (Deployed memory d) {
        uint256 pk = vm.envOr("LOCAL_PK", ANVIL0_PK);
        d.deployer = vm.addr(pk);
        d.quoter = vm.envOr("QUOTER", address(0x70997970C51812dc3A010C7d01b50e0d17dc79C8));
        d.settler = vm.envOr("SETTLER", address(0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC));
        d.attestor = vm.envOr("ATTESTOR", address(0x90F79bf6EB2c4f870365E785982E1f101E93b906));
        d.jitOffset = uint48(vm.envOr("JIT_OFFSET", uint256(10)));
        d.initUsdE8 = vm.envOr("INIT_PRICE_USD_E8", vm.envOr("INIT_PRICE_USD", uint256(2500)) * 1e8);
        d.liquidity = int256(vm.envOr("LIQUIDITY", uint256(5e16)));
        d.roleOracleType = "mock";
        d.configDelay = vm.envOr("CONFIG_DELAY", uint256(0)); // no timelock locally
        d.modelNodes = _defaultModelNodes();

        vm.startBroadcast(pk);
        d.manager = _deployPoolManager(d.deployer); // default-profile hook bytecode (R-11)
        d.stateView = address(new StateView(d.manager));
        _deployTokens(d);

        MockRoleOracle roles = new MockRoleOracle(d.deployer);
        roles.setQuoter(d.quoter, true);
        roles.setSettler(d.settler, true);
        d.roles = IRoleOracle(address(roles));

        address feed = vm.envOr("CHAINLINK_FEED", address(0));
        d.cfg = _configFromEnv(feed, !d.wethIs0, 200);

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
}
