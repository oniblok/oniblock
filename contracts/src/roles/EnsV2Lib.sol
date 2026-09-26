// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title EnsV2Lib
/// @notice Role constants and name helpers for Oniblock's ENSv2 integration.
///
/// EAC bitmap layout (ENSv2 EnhancedAccessControl): 64 nybbles; regular role N = 1 << (4*N) for N in 0..31,
/// admin role = regular << 128. `hasRoles(anyId, bitmap, acct)` is true iff acct holds ALL bits on the name's
/// resource OR on ROOT (resource 0).
///
/// PermissionedRegistry uses nybbles 0-9, 30, 31 (see RegistryRolesLib). EAC validates only that bits sit on
/// nybble boundaries, so unused nybbles are free for application roles in OUR OWN UserRegistry. We use:
///   nybble 16 -> ROLE_QUOTER   (held on the resource of quoter.<name>)
///   nybble 17 -> ROLE_SETTLER  (held on the resource of settler.<name>)
/// Their admin bits are granted to the name owner at subname registration (token admin roles can only be
/// assigned at registration in PermissionedRegistry), so the owner can grant/revoke the regular role later.
library EnsV2Lib {
    // ---------------------------------------------------------------- Oniblock custom registry roles
    uint256 internal constant ROLE_QUOTER = 1 << 64; // nybble 16
    uint256 internal constant ROLE_QUOTER_ADMIN = ROLE_QUOTER << 128;
    uint256 internal constant ROLE_SETTLER = 1 << 68; // nybble 17
    uint256 internal constant ROLE_SETTLER_ADMIN = ROLE_SETTLER << 128;

    // ---------------------------------------------------------------- RegistryRolesLib (contracts-v2)
    uint256 internal constant ROLE_REGISTRAR = 1 << 0;
    uint256 internal constant ROLE_REGISTER_RESERVED = 1 << 4;
    uint256 internal constant ROLE_SET_PARENT = 1 << 8;
    uint256 internal constant ROLE_UNREGISTER = 1 << 12;
    uint256 internal constant ROLE_RENEW = 1 << 16;
    uint256 internal constant ROLE_SET_SUBREGISTRY = 1 << 20;
    uint256 internal constant ROLE_SET_RESOLVER = 1 << 24;
    uint256 internal constant ROLE_CAN_TRANSFER_ADMIN = (1 << 28) << 128;
    uint256 internal constant ROLE_SET_URI = 1 << 36;
    uint256 internal constant ROLE_UPGRADE = 1 << 124;

    // ---------------------------------------------------------------- PermissionedResolverLib (contracts-v2)
    uint256 internal constant RES_ROLE_SET_ADDRESS = 1 << 0;
    uint256 internal constant RES_ROLE_SET_TEXT = 1 << 4;
    uint256 internal constant RES_ROLE_SET_CONTENTHASH = 1 << 8;
    uint256 internal constant RES_ROLE_SET_ABI = 1 << 12;
    uint256 internal constant RES_ROLE_SET_INTERFACE = 1 << 16;
    uint256 internal constant RES_ROLE_SET_NAME = 1 << 20;
    uint256 internal constant RES_ROLE_SET_DATA = 1 << 24;
    uint256 internal constant RES_ROLE_LINK = 1 << 28;
    uint256 internal constant RES_ROLE_UPGRADE = 1 << 124;

    uint256 internal constant COIN_TYPE_ETH = 60;

    /// @dev Regular role(s) plus their admin counterparts.
    function withAdmin(uint256 roles) internal pure returns (uint256) {
        return roles | (roles << 128);
    }

    /// @dev ENSv2 label id (LibLabel.id): uint256(keccak256(label)). Accepted as `anyId` by the registry.
    function labelId(string memory label) internal pure returns (uint256) {
        return uint256(keccak256(bytes(label)));
    }

    /// @dev Resource of a label at EAC version `v` (LibLabel.withVersion): low 32 bits replaced by `v`.
    ///      A freshly registered name has v = 0. Prefer registry.getResource(labelId) at runtime.
    function resourceAt(uint256 anyId, uint32 v) internal pure returns (uint256) {
        return anyId ^ uint32(anyId) ^ v;
    }

    /// @dev PermissionedResolver per-argument resource for a text/data key: uint256(keccak256(key)).
    function keyResource(string memory key) internal pure returns (uint256) {
        return uint256(keccak256(bytes(key)));
    }

    /// @dev DNS wire-format encoding of a dotted name ("a.b.eth" -> 0x01'a'01'b'03'eth'00). Labels must be 1..255 bytes.
    function dnsEncode(string memory name) internal pure returns (bytes memory out) {
        bytes memory s = bytes(name);
        out = new bytes(s.length + 2);
        uint256 lenPos;
        uint256 n;
        for (uint256 i; i < s.length; ++i) {
            if (s[i] == ".") {
                require(n > 0 && n < 256, "EnsV2Lib: bad label");
                out[lenPos] = bytes1(uint8(n));
                lenPos = i + 1;
                n = 0;
            } else {
                out[i + 1] = s[i];
                ++n;
            }
        }
        if (s.length > 0) {
            require(n > 0 && n < 256, "EnsV2Lib: bad label");
            out[lenPos] = bytes1(uint8(n));
            out[s.length + 1] = 0x00;
        } else {
            out = new bytes(1); // root
        }
    }

    /// @dev EIP-137 namehash of a dotted name.
    function namehash(string memory name) internal pure returns (bytes32 node) {
        bytes memory s = bytes(name);
        uint256 end = s.length;
        for (uint256 i = s.length; i > 0; --i) {
            if (s[i - 1] == ".") {
                node = keccak256(abi.encodePacked(node, _hashSlice(s, i, end)));
                end = i - 1;
            }
        }
        if (end > 0) node = keccak256(abi.encodePacked(node, _hashSlice(s, 0, end)));
    }

    function _hashSlice(bytes memory s, uint256 from, uint256 to) private pure returns (bytes32 h) {
        bytes memory part = new bytes(to - from);
        for (uint256 i; i < part.length; ++i) {
            part[i] = s[from + i];
        }
        h = keccak256(part);
    }
}
