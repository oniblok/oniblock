// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Compiles v4-core's PoolManager (pinned to its own 44,444,444-run profile in foundry.toml) into
// out/PoolManager.sol/PoolManager.json so scripts and tests can deploy it with
// `vm.deployCode("PoolManager.sol:PoolManager", abi.encode(owner))` WITHOUT importing it.
//
// Why (review R-11): solc compiles a whole import graph under one profile. Any script/test that imports both
// PoolManager.sol and OniblockHook.sol gets the 44M-run OniblockHook build (larger than the default 800-run
// build that Sepolia deploys). Do NOT import OniblockHook (or anything that imports it) from this file, and do not
// import PoolManager.sol from files that deploy the hook.
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
