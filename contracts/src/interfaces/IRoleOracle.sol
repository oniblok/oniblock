// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IRoleOracle
/// @notice Answers "may this account post attestations / calibrations?" for OniblockHook.
/// Production: EnsV2RoleOracle (ENSv2 EAC roles on quoter.oniblock.eth / settler.oniblock.eth).
/// Tests/local: MockRoleOracle.
interface IRoleOracle {
    function isQuoter(address account) external view returns (bool);
    function isSettler(address account) external view returns (bool);
}
