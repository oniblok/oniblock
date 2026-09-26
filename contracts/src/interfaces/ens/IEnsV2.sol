// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Minimal ENSv2 (contracts-v2, Sepolia redeploy of 2026-09-15) interfaces used by Oniblock.
/// Signatures copied from the Etherscan-verified sources of the deployed contracts:
///   PermissionedRegistry / UserRegistry, ETHRegistrar, VerifiableFactory, PermissionedResolver,
///   UniversalResolverV2 (all solc 0.8.25).
/// Only the functions Oniblock calls are declared.

/// @dev Initialization-time grant on the ROOT resource (IEACGrantInitializable.Grant).
struct EnsGrant {
    address account;
    uint256 roleBitmap;
}

/// @notice EnhancedAccessControl (EAC): resource-scoped, nybble-packed role bitmaps.
interface IEnsEAC {
    function grantRoles(uint256 resource, uint256 roleBitmap, address account) external returns (bool);
    function revokeRoles(uint256 resource, uint256 roleBitmap, address account) external returns (bool);
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function revokeRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function roles(uint256 resource, address account) external view returns (uint256);
    function roleCount(uint256 resource) external view returns (uint256);
    function hasRoles(uint256 resource, uint256 roleBitmap, address account) external view returns (bool);
    function hasRootRoles(uint256 roleBitmap, address account) external view returns (bool);
}

/// @notice ENSv2 registry read surface (IRegistry).
interface IEnsRegistry {
    function getSubregistry(string calldata label) external view returns (address);
    function getResolver(string calldata label) external view returns (address);
    function getParent() external view returns (address parent, string memory label);
}

/// @notice PermissionedRegistry (ETH registry, UserRegistry). `anyId` = labelhash, tokenId or resource.
interface IEnsPermissionedRegistry is IEnsEAC, IEnsRegistry {
    enum Status {
        AVAILABLE,
        RESERVED,
        REGISTERED
    }

    struct State {
        Status status;
        uint64 expiry;
        address latestOwner;
        uint256 tokenId;
        uint256 resource;
    }

    function register(
        string calldata label,
        address owner,
        address registry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    ) external returns (uint256 tokenId);
    function unregister(uint256 anyId) external;
    function setSubregistry(uint256 anyId, address registry) external;
    function setResolver(uint256 anyId, address resolver) external;
    function setParent(address parent, string calldata label) external;
    function getState(uint256 anyId) external view returns (State memory);
    function getResource(uint256 anyId) external view returns (uint256);
    function getTokenId(uint256 anyId) external view returns (uint256);
    function getOwner(uint256 anyId) external view returns (address);
    function getExpiry(uint256 anyId) external view returns (uint64);
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @notice UserRegistry proxy initializer (IEACGrantInitializable, selector 0x37cb53a8).
interface IEnsUserRegistryInit {
    function initialize(EnsGrant[] calldata grants) external;
}

/// @notice ENSv2 .eth registrar (commit-reveal, ERC20 payment).
interface IEnsETHRegistrar {
    function MIN_COMMITMENT_AGE() external view returns (uint64);
    function MAX_COMMITMENT_AGE() external view returns (uint64);
    function MIN_REGISTER_DURATION() external view returns (uint64);
    function ETH_REGISTRY() external view returns (address);
    function commit(bytes32 commitment) external;
    function commitmentAt(bytes32 commitment) external view returns (uint64);
    function register(
        string calldata label,
        address owner,
        bytes32 secret,
        address subregistry,
        address resolver,
        uint64 duration,
        address paymentToken,
        bytes32 referrer
    ) external returns (uint256 tokenId);
    function isAvailable(string calldata label) external view returns (bool);
    function getRegisterPrice(string calldata label, uint64 duration, address paymentToken)
        external
        view
        returns (uint256 base, uint256 premium);
    function makeCommitment(
        string calldata label,
        address owner,
        bytes32 secret,
        address subregistry,
        address resolver,
        uint64 duration,
        bytes32 referrer
    ) external pure returns (bytes32);
}

/// @notice ENS VerifiableFactory: CREATE2 salt = keccak256(abi.encode(msg.sender, salt)).
interface IEnsVerifiableFactory {
    function deployProxy(address implementation, uint256 salt, bytes calldata data) external returns (address proxy);
    function verifyContract(address proxy) external view returns (address implementation);
}

/// @notice PermissionedResolver (EAC-gated, multi-name record resolver). Names are DNS-encoded bytes.
/// Per-key permission: setText(name,key,..) passes if caller has ROLE_SET_TEXT on resource keccak256(key)
/// OR on ROOT. Per-key grants are made with grantSetterRoles(<setter calldata>, account); grantRoles is disabled.
interface IEnsPermissionedResolver is IEnsEAC {
    function initialize(EnsGrant[] calldata grants, bytes[] calldata calls) external;
    function setText(bytes calldata name, string calldata key, string calldata value) external;
    function setAddress(bytes calldata name, uint256 coinType, bytes calldata addressBytes) external;
    function setData(bytes calldata name, string calldata key, bytes calldata value) external;
    function grantSetterRoles(bytes calldata setter, address account) external returns (bool);
    function decodeSetter(bytes calldata setter)
        external
        pure
        returns (bytes memory arg, uint256 resource, uint256 roleBitmap);
    function getRecordId(bytes32 node) external view returns (uint256);
    function multicall(bytes[] calldata calls) external returns (bytes[] memory);
    /// @dev ENSIP-10 entry point; the only read path (no direct text()/addr() getters).
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory);
}

/// @notice Profile selectors used inside resolve() calls (ENSIP-1 addr, ENSIP-5 text).
interface IEnsProfiles {
    function addr(bytes32 node) external view returns (address);
    function text(bytes32 node, string calldata key) external view returns (string memory);
}

/// @notice ENSIP-9 multi-coin addr profile.
interface IEnsAddressProfile {
    function addr(bytes32 node, uint256 coinType) external view returns (bytes memory);
}

/// @notice UniversalResolverV2.
interface IEnsUniversalResolver {
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory, address);
    function findResolver(bytes calldata name) external view returns (address resolver, bytes32 node, uint256 offset);
    function ROOT_REGISTRY() external view returns (address);
}

/// @notice ENS Sepolia MockERC20 used as "USDC" by the registrar (mint is permissionless).
interface IEnsMockERC20 {
    function mint(address to, uint256 amount) external;
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}
