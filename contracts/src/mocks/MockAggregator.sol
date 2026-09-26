// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/// @notice Settable Chainlink-style feed. Unit tests only (never used in the demo/benchmark).
contract MockAggregator is AggregatorV3Interface {
    uint8 public immutable decimals;
    int256 public answer;
    uint256 public updatedAt;
    bool public broken;

    constructor(uint8 decimals_, int256 answer_) {
        decimals = decimals_;
        set(answer_);
    }

    function set(int256 answer_) public {
        answer = answer_;
        updatedAt = block.timestamp;
    }

    function setUpdatedAt(uint256 t) external {
        updatedAt = t;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!broken, "broken");
        return (1, answer, updatedAt, updatedAt, 1);
    }
}
