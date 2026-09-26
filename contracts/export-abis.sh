#!/usr/bin/env bash
# Export contract ABIs to ../abis/*.json (plain ABI arrays). Run from anywhere.
set -euo pipefail
cd "$(dirname "$0")"
OUT=../abis
mkdir -p "$OUT"
forge build >/dev/null

export_abi() { # <path:Contract> <outName>
  forge inspect "$1" abi --json > "$OUT/$2.json"
  echo "wrote $OUT/$2.json"
}

export_abi src/OniblockHook.sol:OniblockHook OniblockHook
export_abi src/interfaces/IRoleOracle.sol:IRoleOracle IRoleOracle
export_abi src/mocks/MockRoleOracle.sol:MockRoleOracle MockRoleOracle
export_abi src/roles/EnsV2RoleOracle.sol:EnsV2RoleOracle EnsV2RoleOracle
export_abi src/mocks/MockERC20.sol:MockERC20 MockERC20
export_abi src/mocks/MockERC20.sol:MockERC20 ERC20
export_abi src/periphery/SplitSwapRouter.sol:SplitSwapRouter SplitSwapRouter

# Library contracts (compiled under multiple profiles, so read the build artifact directly).
from_artifact() { # <out/File.sol/Contract.json> <outName>
  jq '.abi' "$1" > "$OUT/$2.json"
  echo "wrote $OUT/$2.json"
}
from_artifact out/PoolManager.sol/PoolManager.json PoolManager
from_artifact out/StateView.sol/StateView.json StateView
from_artifact out/PoolModifyLiquidityTest.sol/PoolModifyLiquidityTest.json PoolModifyLiquidityTest
