// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {EnsV2RoleOracle, IEnsV2EAC} from "../src/roles/EnsV2RoleOracle.sol";

contract MockEAC is IEnsV2EAC {
    mapping(uint256 => mapping(address => uint256)) public roles;
    bool public reverts;

    function grant(uint256 resource, address a, uint256 bits) external {
        roles[resource][a] |= bits;
    }

    function revoke(uint256 resource, address a, uint256 bits) external {
        roles[resource][a] &= ~bits;
    }

    function setReverts(bool r) external {
        reverts = r;
    }

    function hasRoles(uint256 resource, uint256 roleBitmap, address account) external view returns (bool) {
        require(!reverts);
        return roles[resource][account] & roleBitmap == roleBitmap;
    }
}

contract EnsV2RoleOracleTest is Test {
    MockEAC eac;
    EnsV2RoleOracle oracle;
    address q = makeAddr("q");
    address s = makeAddr("s");
    uint256 constant RQ = 1 << 64;
    uint256 constant RS = 1 << 68;

    function setUp() public {
        eac = new MockEAC();
        oracle = new EnsV2RoleOracle(
            address(this),
            EnsV2RoleOracle.RoleRef(address(eac), 111, RQ),
            EnsV2RoleOracle.RoleRef(address(eac), 222, RS)
        );
    }

    function test_rolesFollowEac() public {
        assertFalse(oracle.isQuoter(q));
        eac.grant(111, q, RQ);
        assertTrue(oracle.isQuoter(q));
        assertFalse(oracle.isSettler(q), "quoter role on settler resource not granted");
        eac.grant(222, s, RS);
        assertTrue(oracle.isSettler(s));
        eac.grant(222, q, RQ); // wrong bit on settler resource
        assertFalse(oracle.isSettler(q));
        eac.revoke(111, q, RQ); // kill switch
        assertFalse(oracle.isQuoter(q));
    }

    function test_failsClosed() public {
        eac.grant(111, q, RQ);
        eac.setReverts(true);
        assertFalse(oracle.isQuoter(q));
        oracle.setQuoterRole(EnsV2RoleOracle.RoleRef(address(0), 111, RQ));
        assertFalse(oracle.isQuoter(q));
    }

    function test_onlyOwnerReconfigures() public {
        vm.prank(q);
        vm.expectRevert();
        oracle.setQuoterRole(EnsV2RoleOracle.RoleRef(address(eac), 1, 1));
    }
}
