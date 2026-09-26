// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title DnsNameLib
/// @notice Pure helpers over DNS wire-format names ("\x06jev-v1\x04live\x08oniblock\x03eth\x00"), the encoding
/// ENSIP-10 resolvers receive in `resolve(bytes name, bytes data)`. Mirrors the checks of ens-contracts'
/// `NameCoder` (a label is 1..255 bytes, `0x00` terminates and must be the last byte, no junk after it).
library DnsNameLib {
    /// @notice The bytes are not a well-formed DNS-encoded name.
    error DnsDecodingFailed(bytes name);

    /// @dev Length byte of the label at `offset` and the offset of the label after it. Reverts on a length byte
    /// that runs past the end, a missing terminator, or bytes after the terminator.
    function nextLabel(bytes memory name, uint256 offset) internal pure returns (uint8 size, uint256 next) {
        if (offset >= name.length) revert DnsDecodingFailed(name);
        size = uint8(name[offset]);
        next = offset + 1 + size;
        if (size > 0 ? next >= name.length : next != name.length) revert DnsDecodingFailed(name);
    }

    /// @dev True iff `name` is a well-formed DNS-encoded name (does not revert).
    function isValid(bytes memory name) internal pure returns (bool) {
        uint256 offset;
        while (true) {
            if (offset >= name.length) return false;
            uint256 size = uint8(name[offset]);
            uint256 next = offset + 1 + size;
            if (size == 0) return next == name.length;
            if (next >= name.length) return false;
            offset = next;
        }
        return false; // unreachable
    }

    /// @dev The label at `offset` as a string ("" for the terminator) and the offset of the next label.
    function readLabel(bytes memory name, uint256 offset) internal pure returns (string memory label, uint256 next) {
        uint8 size;
        (size, next) = nextLabel(name, offset);
        bytes memory out = new bytes(size);
        for (uint256 i; i < size; ++i) {
            out[i] = name[offset + 1 + i];
        }
        label = string(out);
    }

    /// @dev keccak256 of the label bytes at `offset` (bytes32(0) for the terminator) and the next offset.
    function labelhash(bytes memory name, uint256 offset) internal pure returns (bytes32 hash, uint256 next) {
        uint8 size;
        (size, next) = nextLabel(name, offset);
        if (size > 0) {
            assembly ("memory-safe") {
                hash := keccak256(add(add(name, 33), offset), size)
            }
        }
    }

    /// @dev EIP-137 namehash of `name[offset:]` (bytes32(0) for the root).
    function namehash(bytes memory name, uint256 offset) internal pure returns (bytes32 node) {
        (bytes32 hash, uint256 next) = labelhash(name, offset);
        if (hash == bytes32(0)) return bytes32(0);
        node = keccak256(abi.encodePacked(namehash(name, next), hash));
    }

    /// @dev Number of labels in `name[offset:]` ("\x03eth\x00" -> 1, "\x00" -> 0).
    function countLabels(bytes memory name, uint256 offset) internal pure returns (uint256 count) {
        uint8 size;
        while (true) {
            (size, offset) = nextLabel(name, offset);
            if (size == 0) return count;
            ++count;
        }
    }

    /// @dev True iff `name[offset:]` is byte-for-byte `suffix` (both DNS-encoded).
    function suffixEquals(bytes memory name, uint256 offset, bytes memory suffix) internal pure returns (bool) {
        if (offset > name.length || name.length - offset != suffix.length) return false;
        bytes32 a;
        assembly ("memory-safe") {
            a := keccak256(add(add(name, 32), offset), mload(suffix))
        }
        return a == keccak256(suffix);
    }
}
