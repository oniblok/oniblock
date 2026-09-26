// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IRoleOracle} from "../interfaces/IRoleOracle.sol";

/// @notice Owner-managed quoter/settler sets. Tests and local anvil only.
contract MockRoleOracle is IRoleOracle, Ownable {
    mapping(address => bool) public quoters;
    mapping(address => bool) public settlers;

    event QuoterSet(address indexed account, bool allowed);
    event SettlerSet(address indexed account, bool allowed);

    constructor(address owner_) Ownable(owner_) {}

    function setQuoter(address account, bool allowed) external onlyOwner {
        quoters[account] = allowed;
        emit QuoterSet(account, allowed);
    }

    function setSettler(address account, bool allowed) external onlyOwner {
        settlers[account] = allowed;
        emit SettlerSet(account, allowed);
    }

    function isQuoter(address account) external view returns (bool) {
        return quoters[account];
    }

    function isSettler(address account) external view returns (bool) {
        return settlers[account];
    }
}
