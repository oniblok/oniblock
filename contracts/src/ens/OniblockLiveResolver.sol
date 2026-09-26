// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";

import {OniblockHook} from "../OniblockHook.sol";
import {EnsV2Lib} from "../roles/EnsV2Lib.sol";
import {
    IEnsProfiles,
    IEnsAddressProfile,
    IEnsExtendedResolver,
    IEnsFeatures,
    IEnsMulticallable
} from "../interfaces/ens/IEnsV2.sol";
import {DnsNameLib} from "./DnsNameLib.sol";

/// @title OniblockLiveResolver
/// @notice ENSIP-10 wildcard resolver for `live.<name>.eth`: every subname is answered from the hook's storage, so
/// nothing under `live` is ever registered and no gateway is involved. Set as the resolver of the `live` label in the
/// `<name>.eth` registry; UniversalResolverV2 finds no resolver for `<label>.live.<name>.eth`, walks up to `live`,
/// sees IExtendedResolver (ERC-165 0x9061b923) and calls `resolve(fullName, data)` here.
///
/// Names served (base = `live.<name>.eth`, e.g. `live.oniblock.eth`):
///   - `<label>.live.<name>.eth`  any label is a model label: node = namehash(`<label>.models.<name>.eth`), i.e.
///                                keccak256(modelsNode ‖ keccak256(label)); text records read the hook's
///                                `calibration(node)`, `calibration(jitCalibrationKey(node))`, `modelAllowed`,
///                                `isDemoted` and `isJitDemoted`:
///       calibration.brier | calibration.hitRate | calibration.n | calibration.epoch          (arb head, bps / count / block)
///       calibration.jit.brier | calibration.jit.hitRate | calibration.jit.n | calibration.jit.epoch   (JIT head)
///       allowed | demoted | jit.demoted                              "true" / "false"
///       status | jit.status      "unknown" (not allowlisted) | "demoted" (Brier gate) | "active"
///       model-node (0x-hex bytes32) | models-name (`<label>.models.<name>.eth`) | live-name | description
///   - `<poolLabel>.live.<name>.eth` (the pool label given at construction, e.g. `weth-usdc`): the pool's live state
///       k | stale | jit-window | p-toxic | confidence | p-jit | model (node of the attestation in force, 0x0 while
///       stale) | last-model | oracle-mid-x96 | last-attest-block | last-post-block | attest-block |
///       gap-zero-for-one | gap-one-for-zero | fee-zero-for-one | fee-one-for-zero (quoteFee, pips)
///       hook | pool-id | pool-node | pools-name | description
///       base-fee | fee-max | conservative-fee | k-min | k-max | k-default | max-k-step | stale-blocks |
///       brier-demote | arb-threshold | jit-window-min | jit-window-max | jit-window-default
///       addr(node) = the hook
///   - `current.live.<name>.eth`: alias of the model in force (anchor model, or the last accepted one while stale)
///       model-node | label | models-name | live-name | k | status | jit.status | stale | description
///       (label/names are reverse-mapped through the owner-set `knownLabels`; empty when the node is not known)
///   - `live.<name>.eth` itself: description | hook | pool-id | pool | pool-name | models-name | known-labels |
///       resolver; addr(node) = the hook
/// Unset keys resolve to "" (ENS convention). Profiles other than text / addr / addr(coinType) / multicall revert
/// `UnsupportedResolverProfile(selector)` (the UniversalResolverV2 error, which it propagates unchanged), as do
/// addr() calls on model names. Names with the wrong parent revert `WrongParent`; deeper names revert
/// `NameNotServed`. The node inside `data` is ignored (the name is authoritative, as in PermissionedResolver); the
/// direct `text(node,key)` / `addr(node)` getters accept the base, pool, current and known-label nodes only.
contract OniblockLiveResolver is Ownable2Step, IERC165, IEnsExtendedResolver, IEnsFeatures {
    using PoolIdLibrary for PoolKey;

    enum Kind {
        Base,
        Pool,
        Current,
        Model
    }

    /// @notice ERC-7996 feature: `resolve(name, multicall(calls))` is implemented. 0x96b62db8.
    bytes4 public constant FEATURE_RESOLVE_MULTICALL = bytes4(keccak256("eth.ens.resolver.extended.multicall"));

    /// @dev Same signature as UniversalResolverV2's error (0x7b1c461b), which re-raises it verbatim.
    error UnsupportedResolverProfile(bytes4 selector);
    /// @dev `name` does not end with the base name this resolver serves.
    error WrongParent(bytes name);
    /// @dev `name` has more than one label under the base name.
    error NameNotServed(bytes name);
    /// @dev Direct getter for a node that is not the base, pool, current or a known-label node.
    error UnknownNode(bytes32 node);
    error BadPool();
    error BadName(string name);
    error NodeMismatch(string name, bytes32 expected, bytes32 given);

    event KnownLabelsSet(string[] labels);

    OniblockHook public immutable hook;
    bytes32 public immutable poolId;
    /// @notice namehash(`models.<name>.eth`): model nodes are its subnodes.
    bytes32 public immutable modelsNode;
    /// @notice namehash(`pools.<name>.eth`).
    bytes32 public immutable poolsNode;
    /// @notice namehash(`live.<name>.eth`).
    bytes32 public immutable baseNode;
    /// @notice namehash(`<poolLabel>.live.<name>.eth`).
    bytes32 public immutable poolLiveNode;
    /// @notice namehash(`current.live.<name>.eth`).
    bytes32 public immutable currentNode;
    /// @notice namehash(`<poolLabel>.pools.<name>.eth`), the pool's registered name.
    bytes32 public immutable poolRegistryNode;

    PoolKey internal _key;
    /// @notice `live.<name>.eth`
    string public baseName;
    /// @notice `<name>.eth`
    string public parentName;
    /// @notice e.g. `weth-usdc`
    string public poolLabel;
    bytes internal _baseDns;
    string[] internal _knownLabels;
    mapping(bytes32 liveNode => string label) internal _labelOfLiveNode;
    mapping(bytes32 modelNode => string label) internal _labelOfModelNode;

    constructor(
        address owner_,
        OniblockHook hook_,
        bytes32 poolId_,
        PoolKey memory key_,
        bytes32 modelsNode_,
        bytes32 poolsNode_,
        string memory baseName_,
        string memory poolLabel_
    ) Ownable(owner_) {
        if (
            address(hook_) == address(0) || address(key_.hooks) != address(hook_)
                || PoolId.unwrap(key_.toId()) != poolId_
        ) revert BadPool();
        if (bytes(poolLabel_).length == 0 || bytes(poolLabel_).length > 255) revert BadName(poolLabel_);
        string memory parent = _parentOf(baseName_);
        bytes32 expected = EnsV2Lib.namehash(string.concat("models.", parent));
        if (modelsNode_ != expected) revert NodeMismatch(string.concat("models.", parent), expected, modelsNode_);
        expected = EnsV2Lib.namehash(string.concat("pools.", parent));
        if (poolsNode_ != expected) revert NodeMismatch(string.concat("pools.", parent), expected, poolsNode_);

        hook = hook_;
        poolId = poolId_;
        _key = key_;
        modelsNode = modelsNode_;
        poolsNode = poolsNode_;
        baseName = baseName_;
        parentName = parent;
        poolLabel = poolLabel_;
        _baseDns = EnsV2Lib.dnsEncode(baseName_);
        bytes32 base = EnsV2Lib.namehash(baseName_);
        baseNode = base;
        poolLiveNode = _subnode(base, poolLabel_);
        currentNode = _subnode(base, "current");
        poolRegistryNode = _subnode(poolsNode_, poolLabel_);
    }

    // ------------------------------------------------------------------ admin

    /// @notice Labels the `current` alias (and the direct node getters) can reverse-map a model node to. Replaces
    /// the previous list.
    function setKnownLabels(string[] calldata labels) external onlyOwner {
        for (uint256 i; i < _knownLabels.length; ++i) {
            delete _labelOfLiveNode[liveNodeOf(_knownLabels[i])];
            delete _labelOfModelNode[modelNodeOf(_knownLabels[i])];
        }
        delete _knownLabels;
        for (uint256 i; i < labels.length; ++i) {
            if (bytes(labels[i]).length == 0 || bytes(labels[i]).length > 255) revert BadName(labels[i]);
            _knownLabels.push(labels[i]);
            _labelOfLiveNode[liveNodeOf(labels[i])] = labels[i];
            _labelOfModelNode[modelNodeOf(labels[i])] = labels[i];
        }
        emit KnownLabelsSet(labels);
    }

    // ------------------------------------------------------------------ ENSIP-10 / ERC-165 / ERC-7996

    /// @inheritdoc IEnsExtendedResolver
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory) {
        bytes4 selector = bytes4(data);
        if (selector == IEnsMulticallable.multicall.selector) {
            bytes[] memory calls = abi.decode(data[4:], (bytes[]));
            for (uint256 i; i < calls.length; ++i) {
                try this.resolve(name, calls[i]) returns (bytes memory v) {
                    calls[i] = v;
                } catch (bytes memory v) {
                    calls[i] = v; // revert data, as PermissionedResolver does
                }
            }
            return abi.encode(calls);
        }
        (Kind kind, string memory label) = _parse(name);
        return _answer(kind, label, selector, data);
    }

    function supportsInterface(bytes4 interfaceId) public pure returns (bool) {
        return interfaceId == type(IERC165).interfaceId || interfaceId == type(IEnsExtendedResolver).interfaceId
            || interfaceId == type(IEnsFeatures).interfaceId || interfaceId == IEnsProfiles.text.selector
            || interfaceId == IEnsProfiles.addr.selector || interfaceId == IEnsAddressProfile.addr.selector;
    }

    /// @inheritdoc IEnsFeatures
    function supportsFeature(bytes4 featureId) public pure returns (bool) {
        return featureId == FEATURE_RESOLVE_MULTICALL;
    }

    // ------------------------------------------------------------------ direct profile getters (known nodes only)

    function text(bytes32 node, string calldata key) external view returns (string memory) {
        (Kind kind, string memory label) = _kindOfNode(node);
        return _text(kind, label, key);
    }

    function addr(bytes32 node) external view returns (address) {
        (Kind kind,) = _kindOfNode(node);
        return _addr(kind, IEnsProfiles.addr.selector);
    }

    function addr(bytes32 node, uint256 coinType) external view returns (bytes memory) {
        (Kind kind,) = _kindOfNode(node);
        address a = _addr(kind, IEnsAddressProfile.addr.selector);
        return coinType == EnsV2Lib.COIN_TYPE_ETH ? abi.encodePacked(a) : bytes("");
    }

    // ------------------------------------------------------------------ public helpers

    function knownLabels() external view returns (string[] memory) {
        return _knownLabels;
    }

    function poolKey() external view returns (PoolKey memory) {
        return _key;
    }

    /// @notice namehash(`<label>.models.<name>.eth`), the hook's model node for a label.
    function modelNodeOf(string memory label) public view returns (bytes32) {
        return _subnode(modelsNode, label);
    }

    /// @notice namehash(`<label>.live.<name>.eth`).
    function liveNodeOf(string memory label) public view returns (bytes32) {
        return _subnode(baseNode, label);
    }

    /// @notice Known label of a model node ("" if not set with setKnownLabels).
    function labelOf(bytes32 modelNode) external view returns (string memory) {
        return _labelOfModelNode[modelNode];
    }

    /// @notice The model behind `current.live.<name>.eth`: the anchor's model, or the last accepted one while stale.
    function currentModel() public view returns (bytes32 node, string memory label, bool stale) {
        (OniblockHook.PoolState memory st, OniblockHook.Anchor memory anc, bool staleNow) =
            hook.poolState(PoolId.wrap(poolId));
        node = anc.modelNode != bytes32(0) ? anc.modelNode : st.modelNode;
        label = _labelOfModelNode[node];
        stale = staleNow;
    }

    /// @notice Gate status of a model node on the pool: unknown | demoted | active.
    function status(bytes32 modelNode) public view returns (string memory) {
        PoolId pid = PoolId.wrap(poolId);
        return _status(pid, modelNode, hook.isDemoted(pid, modelNode));
    }

    /// @notice Gate status of a model's JIT head on the pool.
    function jitStatus(bytes32 modelNode) public view returns (string memory) {
        PoolId pid = PoolId.wrap(poolId);
        return _status(pid, modelNode, hook.isJitDemoted(pid, modelNode));
    }

    // ------------------------------------------------------------------ name parsing

    /// @dev Classifies a DNS-encoded name: exactly the base name, or one label under it.
    function _parse(bytes memory name) internal view returns (Kind kind, string memory label) {
        if (!DnsNameLib.isValid(name)) revert DnsNameLib.DnsDecodingFailed(name);
        bytes memory base = _baseDns;
        if (name.length < base.length || !DnsNameLib.suffixEquals(name, name.length - base.length, base)) {
            revert WrongParent(name);
        }
        if (name.length == base.length) return (Kind.Base, "");
        uint256 next;
        (label, next) = DnsNameLib.readLabel(name, 0);
        if (next != name.length - base.length) revert NameNotServed(name);
        kind = _kindOfLabel(label);
    }

    function _kindOfLabel(string memory label) internal view returns (Kind) {
        bytes32 h = keccak256(bytes(label));
        if (h == keccak256(bytes(poolLabel))) return Kind.Pool;
        if (h == keccak256("current")) return Kind.Current;
        return Kind.Model;
    }

    function _kindOfNode(bytes32 node) internal view returns (Kind, string memory) {
        if (node == baseNode) return (Kind.Base, "");
        if (node == poolLiveNode) return (Kind.Pool, poolLabel);
        if (node == currentNode) return (Kind.Current, "current");
        string memory label = _labelOfLiveNode[node];
        if (bytes(label).length == 0) revert UnknownNode(node);
        return (Kind.Model, label);
    }

    // ------------------------------------------------------------------ profiles

    function _answer(Kind kind, string memory label, bytes4 selector, bytes calldata data)
        internal
        view
        returns (bytes memory)
    {
        if (selector == IEnsProfiles.text.selector) {
            (, string memory key) = abi.decode(data[4:], (bytes32, string));
            return abi.encode(_text(kind, label, key));
        }
        if (selector == IEnsProfiles.addr.selector) {
            return abi.encode(_addr(kind, selector));
        }
        if (selector == IEnsAddressProfile.addr.selector) {
            (, uint256 coinType) = abi.decode(data[4:], (bytes32, uint256));
            address a = _addr(kind, selector);
            return abi.encode(coinType == EnsV2Lib.COIN_TYPE_ETH ? abi.encodePacked(a) : bytes(""));
        }
        revert UnsupportedResolverProfile(selector);
    }

    function _addr(Kind kind, bytes4 selector) internal view returns (address) {
        if (kind == Kind.Base || kind == Kind.Pool) return address(hook);
        revert UnsupportedResolverProfile(selector);
    }

    function _text(Kind kind, string memory label, string memory key) internal view returns (string memory) {
        if (kind == Kind.Model) return _modelText(label, key);
        if (kind == Kind.Pool) return _poolText(key);
        if (kind == Kind.Current) return _currentText(key);
        return _baseText(key);
    }

    // ------------------------------------------------------------------ records: <label>.live

    function _modelText(string memory label, string memory key) internal view returns (string memory) {
        bytes32 node = modelNodeOf(label);
        PoolId pid = PoolId.wrap(poolId);
        bytes32 k = keccak256(bytes(key));
        if (k == keccak256("status")) return status(node);
        if (k == keccak256("jit.status")) return jitStatus(node);
        if (k == keccak256("allowed")) return _bool(hook.modelAllowed(pid, node));
        if (k == keccak256("demoted")) return _bool(hook.isDemoted(pid, node));
        if (k == keccak256("jit.demoted")) return _bool(hook.isJitDemoted(pid, node));
        if (k == keccak256("model-node")) return _hex(node);
        if (k == keccak256("models-name")) return string.concat(label, ".models.", parentName);
        if (k == keccak256("live-name")) return string.concat(label, ".", baseName);
        if (k == keccak256("description")) {
            return string.concat(
                "Oniblock model ", label, ": calibration and gate status read live from the hook (", _hexAddr(address(hook)), ")"
            );
        }
        if (k == keccak256("calibration.brier")) return _u(hook.calibration(node).brierBps);
        if (k == keccak256("calibration.hitRate")) return _u(hook.calibration(node).hitRateBps);
        if (k == keccak256("calibration.n")) return _u(hook.calibration(node).n);
        if (k == keccak256("calibration.epoch")) return _u(hook.calibration(node).updatedBlock);
        bytes32 jit = hook.jitCalibrationKey(node);
        if (k == keccak256("calibration.jit.brier")) return _u(hook.calibration(jit).brierBps);
        if (k == keccak256("calibration.jit.hitRate")) return _u(hook.calibration(jit).hitRateBps);
        if (k == keccak256("calibration.jit.n")) return _u(hook.calibration(jit).n);
        if (k == keccak256("calibration.jit.epoch")) return _u(hook.calibration(jit).updatedBlock);
        return "";
    }

    /// @dev unknown (not allowlisted) | demoted (Brier gate) | active (incl. no calibration record yet).
    function _status(PoolId pid, bytes32 modelNode, bool demoted) internal view returns (string memory) {
        if (!hook.modelAllowed(pid, modelNode)) return "unknown";
        if (demoted) return "demoted";
        return "active";
    }

    // ------------------------------------------------------------------ records: <poolLabel>.live

    function _poolText(string memory key) internal view returns (string memory) {
        bytes32 k = keccak256(bytes(key));
        PoolId pid = PoolId.wrap(poolId);
        if (k == keccak256("hook")) return _hexAddr(address(hook));
        if (k == keccak256("pool-id")) return _hex(poolId);
        if (k == keccak256("pool-node")) return _hex(poolRegistryNode);
        if (k == keccak256("pools-name")) return string.concat(poolLabel, ".pools.", parentName);
        if (k == keccak256("description")) {
            return string.concat("Oniblock pool ", poolLabel, ": live fee state read from the hook (", _hexAddr(address(hook)), ")");
        }
        if (k == keccak256("fee-zero-for-one")) return _quote(true);
        if (k == keccak256("fee-one-for-zero")) return _quote(false);

        OniblockHook.PoolConfig memory cfg = hook.poolConfig(pid);
        if (k == keccak256("base-fee")) return _u(cfg.baseFee);
        if (k == keccak256("fee-max")) return _u(cfg.feeMax);
        if (k == keccak256("conservative-fee")) return _u(cfg.conservativeFee);
        if (k == keccak256("k-min")) return _u(cfg.kMinBps);
        if (k == keccak256("k-max")) return _u(cfg.kMaxBps);
        if (k == keccak256("k-default")) return _u(cfg.kDefaultBps);
        if (k == keccak256("max-k-step")) return _u(cfg.maxKStepBps);
        if (k == keccak256("stale-blocks")) return _u(cfg.staleBlocks);
        if (k == keccak256("brier-demote")) return _u(cfg.brierDemoteBps);
        if (k == keccak256("arb-threshold")) return _u(cfg.arbThresholdPips);
        if (k == keccak256("jit-window-min")) return _u(cfg.jitWindowMin);
        if (k == keccak256("jit-window-max")) return _u(cfg.jitWindowMax);
        if (k == keccak256("jit-window-default")) return _u(cfg.jitWindowDefault);

        (OniblockHook.PoolState memory st, OniblockHook.Anchor memory anc, bool staleNow) = hook.poolState(pid);
        if (k == keccak256("k")) return _u(anc.kBps);
        if (k == keccak256("stale")) return _bool(staleNow);
        if (k == keccak256("jit-window")) return _u(staleNow ? cfg.jitWindowDefault : st.jitWindow);
        if (k == keccak256("p-toxic")) return _u(st.pToxicBps);
        if (k == keccak256("confidence")) return _u(st.confidenceBps);
        if (k == keccak256("p-jit")) return _u(st.pJitBps);
        if (k == keccak256("model")) return _hex(anc.modelNode);
        if (k == keccak256("last-model")) return _hex(st.modelNode);
        if (k == keccak256("oracle-mid-x96")) return _u(st.oracleMidX96);
        if (k == keccak256("last-attest-block")) return _u(st.lastAttestBlock);
        if (k == keccak256("last-post-block")) return _u(st.lastPostBlock);
        if (k == keccak256("attest-block")) return _u(anc.attestBlock);
        if (k == keccak256("gap-zero-for-one")) return _u(anc.gapZeroForOne);
        if (k == keccak256("gap-one-for-zero")) return _u(anc.gapOneForZero);
        return "";
    }

    /// @dev quoteFee(pips) for a direction; "" if the hook cannot quote (e.g. pool not initialized).
    function _quote(bool zeroForOne) internal view returns (string memory) {
        try hook.quoteFee(_key, zeroForOne) returns (uint24 fee, bool, uint32, bool) {
            return _u(fee);
        } catch {
            return "";
        }
    }

    // ------------------------------------------------------------------ records: current.live

    function _currentText(string memory key) internal view returns (string memory) {
        (bytes32 node, string memory label, bool stale) = currentModel();
        bytes32 k = keccak256(bytes(key));
        if (k == keccak256("model-node")) return _hex(node);
        if (k == keccak256("label")) return label;
        if (k == keccak256("models-name")) {
            return bytes(label).length == 0 ? "" : string.concat(label, ".models.", parentName);
        }
        if (k == keccak256("live-name")) return bytes(label).length == 0 ? "" : string.concat(label, ".", baseName);
        if (k == keccak256("k")) {
            (, OniblockHook.Anchor memory anc,) = hook.poolState(PoolId.wrap(poolId));
            return _u(anc.kBps);
        }
        if (k == keccak256("status")) return status(node);
        if (k == keccak256("jit.status")) return jitStatus(node);
        if (k == keccak256("stale")) return _bool(stale);
        if (k == keccak256("description")) {
            return string.concat(
                "Alias of the model whose attestation is in force for ", poolLabel, " (last accepted model while stale)"
            );
        }
        return "";
    }

    // ------------------------------------------------------------------ records: live (the namespace itself)

    function _baseText(string memory key) internal view returns (string memory) {
        bytes32 k = keccak256(bytes(key));
        if (k == keccak256("description")) {
            return string.concat(
                "Oniblock live namespace: <model>.",
                baseName,
                " = calibration/gate of <model>.models.",
                parentName,
                "; ",
                poolLabel,
                ".",
                baseName,
                " = pool state; current.",
                baseName,
                " = model in force. Wildcard-resolved from the hook, nothing registered."
            );
        }
        if (k == keccak256("hook")) return _hexAddr(address(hook));
        if (k == keccak256("pool-id")) return _hex(poolId);
        if (k == keccak256("pool")) return poolLabel;
        if (k == keccak256("pool-name")) return string.concat(poolLabel, ".", baseName);
        if (k == keccak256("models-name")) return string.concat("models.", parentName);
        if (k == keccak256("resolver")) return _hexAddr(address(this));
        if (k == keccak256("known-labels")) {
            string memory out;
            for (uint256 i; i < _knownLabels.length; ++i) {
                out = i == 0 ? _knownLabels[i] : string.concat(out, ",", _knownLabels[i]);
            }
            return out;
        }
        return "";
    }

    // ------------------------------------------------------------------ small helpers

    function _subnode(bytes32 parent, string memory label) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(parent, keccak256(bytes(label))));
    }

    /// @dev "live.oniblock.eth" -> "oniblock.eth".
    function _parentOf(string memory name) internal pure returns (string memory) {
        bytes memory b = bytes(name);
        for (uint256 i; i < b.length; ++i) {
            if (b[i] == ".") {
                if (i == 0 || i + 1 >= b.length) revert BadName(name);
                bytes memory out = new bytes(b.length - i - 1);
                for (uint256 j; j < out.length; ++j) {
                    out[j] = b[i + 1 + j];
                }
                return string(out);
            }
        }
        revert BadName(name);
    }

    function _u(uint256 v) internal pure returns (string memory) {
        return Strings.toString(v);
    }

    function _hex(bytes32 v) internal pure returns (string memory) {
        return Strings.toHexString(uint256(v), 32);
    }

    function _hexAddr(address a) internal pure returns (string memory) {
        return Strings.toChecksumHexString(a);
    }

    function _bool(bool v) internal pure returns (string memory) {
        return v ? "true" : "false";
    }
}
