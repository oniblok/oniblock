// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IRoleOracle} from "../interfaces/IRoleOracle.sol";

/// @notice Subset of ENSv2 EnhancedAccessControl (EAC) used for role checks.
/// @dev ENSv2 contracts-v2: `hasRoles(resource, roleBitmap, account)` returns true iff `account` holds ALL roles in
/// `roleBitmap` on `resource` (implementations may also honour roles granted on the ROOT resource).
interface IEnsV2EAC {
    function hasRoles(uint256 resource, uint256 roleBitmap, address account) external view returns (bool);
}

/// @title EnsV2RoleOracle
/// @notice Thin adapter: IRoleOracle answered by ENSv2 EAC roles.
///   quoter  <=> registry.hasRoles(quoterResource,  quoterRoleBitmap,  account)
///   settler <=> registry.hasRoles(settlerResource, settlerRoleBitmap, account)
/// Validated mechanism (Sepolia ENSv2 redeploy 2026-09-15, see test/fork/EnsSetup.t.sol + docs/ENS_INTEGRATION.md):
///   registry   = our UserRegistry proxy for oniblock.eth (VerifiableFactory), i.e. the registry that holds the
///                `quoter` / `settler` labels
///   resource   = labelhash, e.g. uint256(keccak256("quoter")). PermissionedRegistry.hasRoles takes `anyId`
///                (labelhash | tokenId | resource) and maps it to the name's *current* EAC resource, so the value
///                survives token regeneration (every grant/revoke re-mints the token) and re-registration.
///   roleBitmap = EnsV2Lib.ROLE_QUOTER (1<<64, nybble 16) / EnsV2Lib.ROLE_SETTLER (1<<68, nybble 17): custom
///                application roles in our own registry; the name owner holds the *_ADMIN bit and grants/revokes.
/// Revoking the ENS role (registry.revokeRoles(labelhash, ROLE_QUOTER, keeper)) revokes the keeper instantly
/// (demo "kill switch"); unregistering the name wipes all roles. The owner can repoint via setQuoterRole/
/// setSettlerRole, and the hook owner can swap the whole oracle via setRoleOracle.
contract EnsV2RoleOracle is IRoleOracle, Ownable2Step {
    struct RoleRef {
        address registry; // ENSv2 PermissionedRegistry holding the label (our UserRegistry for oniblock.eth)
        uint256 resource; // anyId: labelhash of the subname label (recommended), token id or EAC resource
        uint256 roleBitmap; // role bit(s) that must ALL be held
    }

    RoleRef public quoterRole;
    RoleRef public settlerRole;

    event QuoterRoleSet(address registry, uint256 resource, uint256 roleBitmap);
    event SettlerRoleSet(address registry, uint256 resource, uint256 roleBitmap);

    constructor(address owner_, RoleRef memory quoter_, RoleRef memory settler_) Ownable(owner_) {
        _setQuoter(quoter_);
        _setSettler(settler_);
    }

    function setQuoterRole(RoleRef calldata r) external onlyOwner {
        _setQuoter(r);
    }

    function setSettlerRole(RoleRef calldata r) external onlyOwner {
        _setSettler(r);
    }

    function isQuoter(address account) external view returns (bool) {
        return _hasRoles(quoterRole, account);
    }

    function isSettler(address account) external view returns (bool) {
        return _hasRoles(settlerRole, account);
    }

    /// @dev The ONLY place that talks to ENSv2. Adjust here if the ENSv2 role API differs.
    /// Fails closed: an unset registry, a revert or malformed return data => false.
    function _hasRoles(RoleRef memory r, address account) internal view virtual returns (bool) {
        if (r.registry == address(0) || r.roleBitmap == 0) return false;
        try IEnsV2EAC(r.registry).hasRoles(r.resource, r.roleBitmap, account) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    function _setQuoter(RoleRef memory r) internal {
        quoterRole = r;
        emit QuoterRoleSet(r.registry, r.resource, r.roleBitmap);
    }

    function _setSettler(RoleRef memory r) internal {
        settlerRole = r;
        emit SettlerRoleSet(r.registry, r.resource, r.roleBitmap);
    }
}
