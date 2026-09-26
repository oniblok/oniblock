// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Uniswap v4
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {Position} from "@uniswap/v4-core/src/libraries/Position.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary, toBalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
// OpenZeppelin
import {BaseHook} from "@openzeppelin/uniswap-hooks/base/BaseHook.sol";
import {LiquidityPenaltyHook} from "@openzeppelin/uniswap-hooks/general/LiquidityPenaltyHook.sol";
import {CurrencySettler} from "@openzeppelin/uniswap-hooks/utils/CurrencySettler.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
// Oniblock
import {IRoleOracle} from "./interfaces/IRoleOracle.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

/// @title OniblockHook
/// @notice Uniswap v4 hook that charges informed (arbitrage-direction) flow a fee proportional to the part of the
/// gap between the pool price and an attested CEX mid that exceeds an arbitrage threshold (below it the pool is a
/// plain baseFee pool), scaled by an attested sensitivity `k`. Flow that moves the pool away from
/// the oracle pays the base fee. JIT liquidity is penalised (OpenZeppelin LiquidityPenaltyHook pattern) over a
/// per-pool window the model sets every block (v5). Every swap emits a `Receipt` that an off-chain settler scores;
/// a model's calibration (Brier) gates its power.
///
/// Fee law (see docs/BUILD_SPEC.md, docs/review/CONTRACT_FIXES_1.md):
///   stale mid (block.number - lastAttestBlock > staleBlocks at the block's first touch)
///       => fee = conservativeFee (both directions) for the whole block, k = kDefault
///   poolX96 = sqrtP^2 / 2^96 ;  gapPips = |poolX96 - oracleX96| * 1e6 / oracleX96 (clamped to 1e6)
///   toward-oracle direction: zeroForOne iff poolX96 > oracleX96
///   Per-block, per-direction HIGH-WATER gap: before every swap (and every quote) the live gap is measured against
///   the stored mid and folded into `gap[dir]` = max(gap[dir], liveGap) for the toward-oracle direction. The gaps
///   reset at the first touch of each block.
///   live(dir) = the LIVE pool price is on the arbitrage side of the mid for `dir` by >= 1 pip (i.e. a swap in
///   `dir` moves the pool TOWARD the oracle). If the live price is at (within 1 pip of) or past the mid for `dir`,
///   the swap cannot be an arbitrage toward the oracle and pays baseFee, whatever the block's high-water mark:
///   fee(dir) = live(dir) && gap[dir] > 0 ? min(baseFee + max(0, gap[dir] - arbThresholdPips) * kBps / 1e4, feeMax)
///                                         : baseFee
///   i.e. below the arbitrage threshold (a gap no arbitrageur can profitably close at baseFee) the pool charges
///   exactly baseFee in both directions — identical to a vanilla pool with that fee (docs/DESIGN.md §13, v3).
///   (then floored at conservativeFee for the rest of a block whose first touch was stale, see N-07 below).
///   => a split arb (many sub-swaps in one block) pays the first sub-swap's fee on every part (every part starts
///      while the live gap is still > 0); a same-block backrun that re-aligns the pool after a displacement is
///      priced from the live gap; once the pool is back at/past the mid, retail in that direction pays baseFee.
///   Residual (N-02, documented): a dominant LP can still leave the pool at mid+epsilon after a round trip so that
///   the toward direction pays the inflated high-water fee for the rest of the block (bounded by feeMax, one block;
///   only profitable for an LP, which earns the fees back). Integral (average-gap) pricing would remove it.
///
/// Same-block attestations (docs/review/CONTRACT_FIXES_2.md): the anchor carries exactly one attestation's
/// (k, model, mid). A newer attestation with k >= anchored k takes over all three; a lower-k one only updates the
/// stored state for the NEXT block and the anchor keeps measuring gaps against its own mid (N-05). If the block's
/// first touch was stale, a fresh attestation in that block un-stales the anchor: later swaps are priced by the
/// law with the new attestation, never below conservativeFee (the fee already charged in that block) (N-07).
///
/// Calibration gate: attestations must name a model node allowlisted for the pool (owner, `setModelAllowed`).
/// A node whose calibration has fewer than `minSamples` samples ("unseasoned") or whose Brier exceeds
/// `brierDemoteBps` is demoted: k = kDefault. Rotating to a fresh node therefore never escapes demotion.
///
/// v5: JIT window (docs/review/V5_JIT_HEAD_SPEC.md). The same attestation carries a second score, `pJitBps` (the
/// model's probability that liquidity added in the next block is short-lived fee capture), which sets the pool's
/// JIT penalty window instead of the fixed OZ `blockNumberOffset`:
///   window = jitWindowMin + (jitWindowMax - jitWindowMin) * pJit * confidence / 1e8   (blocks, in [min, max])
///   JIT head demoted / unseasoned, parent model not allowlisted, or attestation stale => window = jitWindowDefault
/// The JIT head has its own calibration record under `jitCalibrationKey(modelNode)` = keccak256(modelNode ‖
/// keccak256("jit")) (written by the settler with the existing `setCalibration`; ENS `calibration.jit.*`) and is
/// demoted by the same rule as k (`isJitDemoted`), gated by the parent model's allowlist. Window-at-add rule: a
/// position is judged by the window in force when its liquidity was added (`_windowAtAdd`), so a later change of
/// the window never lengthens the wall for liquidity already in the pool and never shortens it for liquidity added
/// under a wide one (re-adding inside the window keeps the larger of the two). The penalty decays linearly over that
/// window (OZ shape); every applied penalty emits `JitPenalty`. The fee law for swaps is unchanged.
///
/// Price convention: priceX96 = (raw token1 per raw token0) * 2^96, i.e. sqrtPriceX96^2 / 2^96.
/// Range: sqrtPriceX96 <= 2^160 so poolX96 <= 2^224 (FullMath 512-bit intermediate, never overflows). Precision:
/// for very small prices (sqrtP < 2^48) poolX96 truncates towards 0 — the gap then reads as large, the fee is capped
/// at feeMax, and nothing reverts. Attested oracle mids must lie in (0, 2^224).
///
/// Safety: beforeSwap / afterSwap never revert for data reasons (stale/missing attestation, extreme prices).
/// All reverts on bad data happen in `setAttestation` (the keeper's transaction), which leaves the pool on its
/// previous attestation and eventually on the conservative fee.
///
/// Trust model (see docs/DESIGN.md "Known limitations / trust assumptions"): the `attestor` (TEE stand-in) is
/// trusted to report the mid within the Chainlink band AND the true model identity — the allowlist bounds which
/// identities it may claim, not which model produced a score (N-03). Within one block a later attestation can raise
/// (never lower) the other direction's fee by moving the mid (N-06), and two posts in one block (for block-1, then
/// block) apply two k steps (N-10). Calibration is global per model node while the allowlist / minSamples / Brier
/// gates are per pool (N-13). Quoters/settlers are ENS-role gated (instant revocation = kill switch). Owner changes
/// to the pool config, attestor and role oracle go through a `configDelay` timelock (queue = first call, execute =
/// same call again within [eta, eta + TIMELOCK_GRACE]; later it must be re-queued). Executing a config update
/// mid-block clears the anchor, so fees locked earlier in that block can fall (N-12, owner + timelock only).
/// Model allowlisting is instant (a new node starts unseasoned, i.e. at kDefault); disallowing every node pushes the
/// pool to stale/conservativeFee (bounded owner DoS; conservativeFee itself is timelocked).
contract OniblockHook is LiquidityPenaltyHook, Ownable2Step, EIP712 {
    using StateLibrary for IPoolManager;
    using LPFeeLibrary for uint24;
    using CurrencySettler for Currency;

    // ---------------------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Per-pool parameters (owner; timelocked after registration).
    struct PoolConfig {
        uint24 baseFee; // pips (1e6 = 100%), e.g. 3000 = 0.30%
        uint24 feeMax; // pips, e.g. 10000 = 1%  (hard cap: <= FEE_MAX_CAP)
        uint24 conservativeFee; // pips, used when oracle mid is stale
        uint32 kMinBps; // 10000 = 1.0
        uint32 kMaxBps; // must be < 10000 (k >= 1 blocks re-alignment)
        uint32 kDefaultBps; // used when attestation stale or model demoted/unseasoned (~5000)
        uint32 maxKStepBps; // max |dk| per accepted attestation
        uint16 staleBlocks; // attestation older than this => stale
        uint32 sanityBandBps; // max |oracleMid - chainlink| / chainlink; 0 = disabled
        address chainlinkFeed; // address(0) = disabled
        bool chainlinkInverted; // true if feed price must be inverted to match priceX96 convention
        uint32 brierDemoteBps; // if model brier > this => k forced to kDefault (0 = Brier demotion disabled)
        uint32 minSamples; // calibration samples (n) a model needs before it can move k off kDefault (0 = no probation)
        uint32 chainlinkMaxAge; // seconds; Chainlink answers older than this are invalid (required if feed set)
        uint24 arbThresholdPips; // gap (pips) below which no profitable arb exists: the premium only prices the
        // excess gap above it (0 = premium from the first pip, the v2 law). Typically baseFee + ~300. <= feeMax.
        uint16 jitWindowMin; // v5: JIT penalty window (blocks) at pJit * confidence = 0 (>= 1)
        uint16 jitWindowMax; // v5: window at pJit * confidence = 1 (>= jitWindowDefault)
        uint16 jitWindowDefault; // v5: window while the JIT head is demoted/unseasoned or the attestation is stale
    }

    /// @notice Signed by the attestor (EIP-712), posted by a quoter once per block.
    struct Attestation {
        uint64 blockNumber; // must equal block.number (or block.number-1) and be newer than the last accepted one
        uint256 oracleMidX96; // CEX mid in priceX96 convention
        uint32 pToxicBps; // 0..10000
        uint32 confidenceBps; // 0..10000
        uint32 pJitBps; // 0..10000, v5: P(liquidity added next block is short-lived fee capture); sets the JIT window
        bytes32 modelNode; // ENS namehash of the model name; must be allowlisted for the pool
        bytes signature; // EIP-712 signature by `attestor` over (poolId, blockNumber, oracleMidX96, pToxicBps, confidenceBps, pJitBps, modelNode)
    }

    /// @notice A model's calibration record, written by the settler (mirrors the ENS calibration.* text records).
    struct Calibration {
        uint32 brierBps; // Brier score * 1e4 (lower is better)
        uint32 hitRateBps; // informational (not read on-chain)
        uint32 n; // number of scored samples; n < minSamples => unseasoned => kDefault
        uint64 updatedBlock; // informational
    }

    /// @notice Per-pool live state.
    struct PoolState {
        bool registered;
        bool initialized;
        uint8 decimals0; // read at registration (native => 18); used for the Chainlink band
        uint8 decimals1;
        uint32 kBps; // current (step-limited) k, applied from the next block's first touch
        uint64 lastAttestBlock; // Attestation.blockNumber of the last accepted attestation (0 = none)
        uint64 lastPostBlock; // block.number when the last attestation was accepted
        uint32 pToxicBps; // informational (last attestation)
        uint32 confidenceBps; // informational (last attestation)
        uint256 oracleMidX96;
        bytes32 modelNode; // model of the last accepted attestation
        uint16 jitWindow; // v5: JIT window (blocks) for liquidity added from now on while the attestation is fresh
        uint32 pJitBps; // informational (last attestation)
    }

    /// @notice Per-block fee anchor. Created at the block's first touch (swap) from the stored state; the gaps are
    /// per-direction high-water marks of the live toward-oracle gap; k/model/attestBlock identify the attestation
    /// in force (a later attestation in the same block replaces them only if its k is >= the anchored k).
    struct Anchor {
        uint64 blockNumber;
        bool stale; // mid was stale at the first touch => conservativeFee for the whole block, k = kDefault
        uint32 kBps; // k in force for this block
        uint32 gapZeroForOne; // high-water gap (pips) for zeroForOne swaps this block; 0 = not arb direction
        uint32 gapOneForZero; // high-water gap (pips) for oneForZero swaps this block; 0 = not arb direction
        uint64 attestBlock; // Attestation.blockNumber of the attestation in force (0 if stale)
        bytes32 modelNode; // model credited in Receipts of this block (0 if stale)
    }

    /// @dev Storage/memory form of the anchor: `Anchor` (the external view) plus two flags packed into the same
    /// first slot (no extra SLOAD). `conservativeFloor`: the block's first touch was stale and a fresh attestation
    /// un-staled it => fees are floored at conservativeFee for the rest of the block. `pinnedMid`: a lower-k
    /// same-block attestation replaced the stored mid; this block keeps its own attestation's mid in `_pinnedMid`.
    struct BlockAnchor {
        uint64 blockNumber;
        bool stale;
        uint32 kBps;
        uint32 gapZeroForOne;
        uint32 gapOneForZero;
        uint64 attestBlock;
        bool conservativeFloor;
        bool pinnedMid;
        bytes32 modelNode;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------------------------------

    uint24 public constant FEE_MAX_CAP = 100_000; // 10%
    uint32 public constant BPS = 10_000;
    uint32 public constant PIPS = 1_000_000;
    uint256 internal constant Q96 = 1 << 96;
    uint256 internal constant MAX_MID_X96 = 1 << 224;
    /// @notice A queued timelocked call can be executed only within [eta, eta + TIMELOCK_GRACE]; afterwards the same
    /// call re-queues it (fresh notice + full delay).
    uint256 public constant TIMELOCK_GRACE = 1 days;
    /// @dev Transient slot carrying (fee, arbDir, gap) from beforeSwap to afterSwap of the same swap.
    uint256 internal constant FEE_TSLOT = uint256(keccak256("oniblock.fee.transient")) - 1;

    string public constant ATTESTATION_TYPE =
        "Attestation(bytes32 poolId,uint64 blockNumber,uint256 oracleMidX96,uint32 pToxicBps,uint32 confidenceBps,uint32 pJitBps,bytes32 modelNode)";
    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(bytes(ATTESTATION_TYPE));

    // ---------------------------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Timelock (seconds) on updatePoolConfig / setAttestor / setRoleOracle. 0 = changes apply immediately.
    uint256 public immutable configDelay;

    /// @notice EIP-712 signer of attestations (TEE stand-in).
    address public attestor;
    /// @notice Quoter / settler role source (ENSv2 EAC or mock).
    IRoleOracle public roleOracle;

    mapping(PoolId => PoolConfig) internal _config;
    mapping(PoolId => PoolState) internal _state;
    mapping(PoolId => BlockAnchor) internal _anchor;
    mapping(bytes32 modelNode => Calibration) internal _calibration;

    /// @notice Per-pool model allowlist: attestations naming any other node are rejected.
    mapping(PoolId => mapping(bytes32 modelNode => bool)) public modelAllowed;

    /// @notice Timelocked admin calls: keccak256(calldata) => earliest execution timestamp (0 = not queued).
    mapping(bytes32 => uint256) public queuedEta;

    /// @notice JIT penalties parked (as ERC-6909 claims held by this hook) when the last in-range LP exits inside
    /// the penalty window; donated to whatever liquidity is in range on the next swap that finds any (see
    /// docs/review/CONTRACT_FIXES_1.md R-08 for the redirect caveat — use a large jitWindowDefault in thin pools).
    mapping(PoolId => uint256) public pendingPenalty0;
    mapping(PoolId => uint256) public pendingPenalty1;

    /// @dev v5: the JIT window (blocks) in force when a position's liquidity was (last) added; 0 = never added.
    /// Read by `_afterRemoveLiquidity` instead of the immutable `blockNumberOffset`. Never cleared: a fully removed
    /// position's entry is harmless (its `lastAddedLiquidityBlock` decides whether a window is still running) and
    /// is replaced by the effective window on the next add once the old window has expired.
    mapping(PoolId => mapping(bytes32 positionKey => uint16)) internal _windowAtAdd;

    /// @dev Mid of the attestation in force in the current block's anchor when a lower-k same-block attestation
    /// has already replaced `PoolState.oracleMidX96` (only read while `BlockAnchor.pinnedMid`).
    mapping(PoolId => uint256) internal _pinnedMid;

    // ---------------------------------------------------------------------------------------------------------
    // Events & errors
    // ---------------------------------------------------------------------------------------------------------

    event AttestationPosted(
        PoolId indexed id,
        uint64 indexed blockNumber,
        uint256 oracleMidX96,
        uint32 pToxicBps,
        uint32 confidenceBps,
        uint32 kBps,
        bytes32 indexed modelNode,
        address quoter,
        uint32 pJitBps,
        uint16 jitWindow
    );
    /// @notice One per swap. gapPips/kBps/feePips are exactly the inputs/outputs of the fee law for this swap;
    /// gapPips is the RAW (high-water) gap, the threshold comes from poolConfig(id).arbThresholdPips:
    /// arbDir && !stale => feePips == min(base + max(0, gapPips - arbThresholdPips)*kBps/1e4, feeMax), then floored
    /// at conservativeFee in a block un-staled by a same-block attestation; !arbDir && !stale => base.
    /// arbDir only says the swap moved the pool toward the mid (it can pay exactly base below the threshold).
    /// feePips is the LP fee only (protocol fee excluded). sender = the router calling the PoolManager.
    /// amount0/amount1 use the v4 swapper convention (negative = paid by the swapper). modelNode is the model whose
    /// attestation is in force in this block's anchor (0 when stale: a stale receipt belongs to no model).
    event Receipt(
        PoolId indexed id,
        uint64 indexed blockNumber,
        address indexed sender,
        bool zeroForOne,
        bool arbDir,
        uint32 gapPips,
        uint32 kBps,
        uint24 feePips,
        int128 amount0,
        int128 amount1,
        bytes32 modelNode,
        bool stale
    );
    event CalibrationUpdated(bytes32 indexed modelNode, uint32 brierBps, uint32 hitRateBps, uint32 n);
    event PoolRegistered(PoolId indexed id, Currency currency0, Currency currency1, int24 tickSpacing, PoolConfig config);
    event PoolConfigUpdated(PoolId indexed id, PoolConfig config);
    event AttestorSet(address indexed attestor);
    event RoleOracleSet(address indexed roleOracle);
    event ModelAllowed(PoolId indexed id, bytes32 indexed modelNode, bool allowed);
    event ChangeQueued(bytes32 indexed id, uint256 eta, bytes data);
    event ChangeCancelled(bytes32 indexed id);
    event PenaltyParked(PoolId indexed id, uint256 amount0, uint256 amount1);
    event PenaltyDonated(PoolId indexed id, uint256 amount0, uint256 amount1);
    /// @notice v5: a JIT penalty was applied (donated, or parked if no liquidity was in range) to a position removed
    /// within `window` blocks of `addedBlock`. sender = the router calling the PoolManager; positionKey = OZ/v4
    /// Position.calculatePositionKey(sender, tickLower, tickUpper, salt).
    event JitPenalty(
        PoolId indexed id,
        address indexed sender,
        bytes32 positionKey,
        uint48 addedBlock,
        uint16 window,
        uint256 penalty0,
        uint256 penalty1
    );

    error PoolNotRegistered();
    error PoolAlreadyInitialized();
    error PoolNotInitialized();
    error NotDynamicFee();
    error WrongHook();
    error InvalidConfig();
    error NotQuoter();
    error NotSettler();
    error AttestationBlockMismatch();
    error AlreadyAttested();
    error InvalidAttestation();
    error BadSignature();
    error ChainlinkInvalid();
    error OutOfSanityBand();
    error ModelNotAllowed();
    error TimelockNotReady(uint256 eta);

    // ---------------------------------------------------------------------------------------------------------
    // Construction & admin
    // ---------------------------------------------------------------------------------------------------------

    /// @param _poolManager v4 PoolManager
    /// @param _owner admin (Ownable2Step); explicit because the hook is deployed via a CREATE2 factory
    /// @param _attestor EIP-712 signer of attestations (TEE stand-in)
    /// @param _roleOracle quoter/settler role source (ENSv2 or mock)
    /// @param _blockNumberOffset LiquidityPenaltyHook's immutable window; kept for ABI/deploy compatibility only
    ///        (v5 reads the per-pool `PoolConfig.jitWindow*` / attested window instead). Must be >= 1.
    /// @param _configDelay timelock in seconds for updatePoolConfig / setAttestor / setRoleOracle (0 = none)
    constructor(
        IPoolManager _poolManager,
        address _owner,
        address _attestor,
        IRoleOracle _roleOracle,
        uint48 _blockNumberOffset,
        uint256 _configDelay
    ) BaseHook(_poolManager) LiquidityPenaltyHook(_blockNumberOffset) Ownable(_owner) EIP712("Oniblock", "1") {
        attestor = _attestor;
        roleOracle = _roleOracle;
        configDelay = _configDelay;
        emit AttestorSet(_attestor);
        emit RoleOracleSet(address(_roleOracle));
    }

    /// @notice Allowlist a pool (must be called BEFORE PoolManager.initialize). The pool must use this hook and the
    /// dynamic-fee flag. Can be re-called to change the config until the pool is initialized (not timelocked:
    /// nobody can trade an uninitialized pool). Reverts if a Chainlink feed is configured and a token's decimals()
    /// cannot be read.
    function registerPool(PoolKey calldata key, PoolConfig calldata cfg) external onlyOwner {
        if (address(key.hooks) != address(this)) revert WrongHook();
        if (key.fee != LPFeeLibrary.DYNAMIC_FEE_FLAG) revert NotDynamicFee();
        PoolId id = key.toId();
        PoolState storage st = _state[id];
        if (st.initialized) revert PoolAlreadyInitialized();
        _validateConfig(cfg);
        _config[id] = cfg;
        st.registered = true;
        bool strict = cfg.chainlinkFeed != address(0);
        st.decimals0 = _decimalsOf(key.currency0, strict);
        st.decimals1 = _decimalsOf(key.currency1, strict);
        emit PoolRegistered(id, key.currency0, key.currency1, key.tickSpacing, cfg);
    }

    /// @notice Update the config of a registered pool (owner, timelocked: the first call queues, the identical call
    /// after `configDelay` executes). On execution the stored k is clamped into [kMin, kMax], the stored JIT window
    /// into [jitWindowMin, jitWindowMax], and the current block's anchor is cleared (the next swap re-anchors under
    /// the new config). Note: Chainlink decimals are only checked at registration.
    function updatePoolConfig(PoolId id, PoolConfig calldata cfg) external onlyOwner {
        PoolState storage st = _state[id];
        if (!st.registered) revert PoolNotRegistered();
        _validateConfig(cfg);
        if (!_timelocked()) return;
        _config[id] = cfg;
        uint32 k = st.kBps;
        if (k < cfg.kMinBps) st.kBps = cfg.kMinBps;
        else if (k > cfg.kMaxBps) st.kBps = cfg.kMaxBps;
        uint16 w = st.jitWindow;
        if (w < cfg.jitWindowMin) st.jitWindow = cfg.jitWindowMin;
        else if (w > cfg.jitWindowMax) st.jitWindow = cfg.jitWindowMax;
        delete _anchor[id];
        emit PoolConfigUpdated(id, cfg);
    }

    /// @notice Set the attestation signer (owner, timelocked).
    function setAttestor(address _attestor) external onlyOwner {
        if (!_timelocked()) return;
        attestor = _attestor;
        emit AttestorSet(_attestor);
    }

    /// @notice Set the quoter/settler role source (owner, timelocked).
    function setRoleOracle(IRoleOracle _roleOracle) external onlyOwner {
        if (!_timelocked()) return;
        roleOracle = _roleOracle;
        emit RoleOracleSet(address(_roleOracle));
    }

    /// @notice Cancel a queued timelocked call (id = keccak256 of its calldata, as emitted in ChangeQueued).
    /// Note (N-09): the id is the hash of the raw calldata, so the same logical call with extra trailing bytes is a
    /// separate entry — watchers must track every ChangeQueued payload. Queued entries are NOT bound to the owner
    /// that queued them and survive `transferOwnership`; a new owner should cancel entries it does not endorse
    /// (every entry also expires TIMELOCK_GRACE after its eta).
    function cancelQueued(bytes32 id) external onlyOwner {
        delete queuedEta[id];
        emit ChangeCancelled(id);
    }

    /// @notice Allow / disallow a model node for a pool (owner, instant). A newly allowed node is unseasoned
    /// (n < minSamples) and therefore runs at kDefault until the settler has scored enough of its receipts.
    function setModelAllowed(PoolId id, bytes32 modelNode, bool allowed) external onlyOwner {
        if (!_state[id].registered) revert PoolNotRegistered();
        modelAllowed[id][modelNode] = allowed;
        emit ModelAllowed(id, modelNode, allowed);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Keeper / settler entry points
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Post an oracle mid + model score. Only a quoter (role oracle). `a.blockNumber` must be the current
    /// or previous block and strictly newer than the last accepted attestation (so a newer attestation may replace
    /// an older one within the same block, and replays are rejected). `a.modelNode` must be allowlisted.
    /// Reverts on any bad input (bad sig, out-of-band mid, invalid Chainlink) — the pool keeps the previous state.
    /// The new k/mid apply from the next block's anchor. If this block is already anchored (a swap happened):
    ///  - anchor stale (first touch saw a stale mid): the anchor is un-staled with this attestation's k/model/mid,
    ///    fees floored at conservativeFee for the rest of the block (N-07);
    ///  - k >= anchored k: this attestation's k, model AND mid take over the anchor (high-water gaps are kept);
    ///  - k < anchored k: the anchor keeps its own k, model and mid (pinned); this one applies from the next block
    ///    (N-05: every Receipt reflects exactly one attestation).
    function setAttestation(PoolKey calldata key, Attestation calldata a) external {
        PoolId id = key.toId();
        PoolState storage st = _state[id];
        if (!st.initialized) revert PoolNotInitialized();
        if (!roleOracle.isQuoter(msg.sender)) revert NotQuoter();
        if (a.blockNumber != block.number && uint256(a.blockNumber) + 1 != block.number) {
            revert AttestationBlockMismatch();
        }
        if (a.blockNumber <= st.lastAttestBlock) revert AlreadyAttested();
        if (
            a.oracleMidX96 == 0 || a.oracleMidX96 >= MAX_MID_X96 || a.pToxicBps > BPS || a.confidenceBps > BPS
                || a.pJitBps > BPS
        ) revert InvalidAttestation();
        if (!modelAllowed[id][a.modelNode]) revert ModelNotAllowed();

        // EIP-712 signature by the attestor over all fields + poolId.
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(attestationDigest(id, a), a.signature);
        if (err != ECDSA.RecoverError.NoError || signer != attestor) revert BadSignature();

        PoolConfig memory cfg = _config[id];
        _checkSanityBand(cfg, st, a.oracleMidX96);

        // k: demotion (incl. unseasoned) is immediate (safety action); otherwise step-limited toward kFromScore.
        uint32 k;
        if (isDemoted(id, a.modelNode)) {
            k = cfg.kDefaultBps;
        } else {
            uint32 target = kFromScore(id, a.pToxicBps, a.confidenceBps, a.modelNode);
            uint32 cur = st.kBps;
            if (target > cur) {
                k = target - cur > cfg.maxKStepBps ? cur + cfg.maxKStepBps : target;
            } else {
                k = cur - target > cfg.maxKStepBps ? cur - cfg.maxKStepBps : target;
            }
        }

        // v5 JIT window: not step-limited (it only governs liquidity added from now on) and demotion-aware on the
        // JIT head's own calibration key.
        uint16 jitWindow = jitWindowFromScore(id, a.pJitBps, a.confidenceBps, a.modelNode);

        uint256 prevMid = st.oracleMidX96;
        st.kBps = k;
        st.oracleMidX96 = a.oracleMidX96;
        st.pToxicBps = a.pToxicBps;
        st.confidenceBps = a.confidenceBps;
        st.modelNode = a.modelNode;
        st.lastAttestBlock = a.blockNumber;
        st.lastPostBlock = uint64(block.number);
        st.jitWindow = jitWindow;
        st.pJitBps = a.pJitBps;

        // Same-block refresh: the anchored (k, model, mid) move together, and only to a higher-or-equal k.
        BlockAnchor storage anc = _anchor[id];
        if (anc.blockNumber == block.number) {
            if (anc.stale || k >= anc.kBps) {
                if (anc.stale) {
                    anc.stale = false;
                    anc.conservativeFloor = true;
                }
                anc.kBps = k;
                anc.attestBlock = a.blockNumber;
                anc.modelNode = a.modelNode;
                anc.pinnedMid = false; // gaps are now measured against this attestation's mid (st.oracleMidX96)
            } else if (!anc.pinnedMid) {
                _pinnedMid[id] = prevMid; // the anchored attestation's mid
                anc.pinnedMid = true;
            }
        }

        emit AttestationPosted(
            id, a.blockNumber, a.oracleMidX96, a.pToxicBps, a.confidenceBps, k, a.modelNode, msg.sender, a.pJitBps, jitWindow
        );
    }

    /// @notice Settler posts a model's calibration record (mirrors the ENS calibration.* text records).
    /// Writing n below a pool's minSamples puts the model back on probation (kDefault) on that pool.
    function setCalibration(bytes32 modelNode, uint32 brierBps, uint32 hitRateBps, uint32 n) external {
        if (!roleOracle.isSettler(msg.sender)) revert NotSettler();
        if (brierBps > BPS || hitRateBps > BPS) revert InvalidAttestation();
        _calibration[modelNode] = Calibration(brierBps, hitRateBps, n, uint64(block.number));
        emit CalibrationUpdated(modelNode, brierBps, hitRateBps, n);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Public, clamped, demotion-aware (NOT step-limited) map from model score to k:
    ///   k = kMin + (kMax - kMin) * pToxic * confidence / 1e8 ;  demoted / unseasoned / not allowlisted => kDefault.
    function kFromScore(PoolId id, uint32 pToxicBps, uint32 confidenceBps, bytes32 modelNode)
        public
        view
        returns (uint32 kBps)
    {
        PoolConfig storage cfg = _config[id];
        if (isDemoted(id, modelNode)) return cfg.kDefaultBps;
        uint256 p = pToxicBps > BPS ? BPS : pToxicBps;
        uint256 c = confidenceBps > BPS ? BPS : confidenceBps;
        uint256 span = cfg.kMaxBps - cfg.kMinBps; // validated kMax >= kMin
        kBps = uint32(cfg.kMinBps + (span * p * c) / 1e8);
    }

    /// @notice True iff the model has no power over k on this pool (k = kDefault): it is not allowlisted, OR it is
    /// unseasoned (calibration n < minSamples), OR Brier demotion is enabled (brierDemoteBps > 0), it has a record
    /// (n > 0) and its Brier score exceeds the threshold.
    function isDemoted(PoolId id, bytes32 modelNode) public view returns (bool) {
        return _demoted(id, modelNode, modelNode);
    }

    /// @notice v5: derived calibration key of a model's JIT head, keccak256(modelNode ‖ keccak256("jit")). The
    /// settler writes it with `setCalibration`; ENS mirrors it as calibration.jit.* records on the model name.
    function jitCalibrationKey(bytes32 modelNode) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(modelNode, keccak256("jit")));
    }

    /// @notice v5: True iff the model's JIT head has no power over the JIT window on this pool (window =
    /// jitWindowDefault). Same rule as `isDemoted`, read on `jitCalibrationKey(modelNode)`: the parent model is not
    /// allowlisted, OR the JIT record is unseasoned (n < minSamples), OR Brier demotion is enabled, it has a record
    /// and its Brier exceeds brierDemoteBps. No separate allowlist: the parent's allowlist gates both heads.
    function isJitDemoted(PoolId id, bytes32 modelNode) public view returns (bool) {
        return _demoted(id, modelNode, jitCalibrationKey(modelNode));
    }

    /// @notice v5: Public, clamped, demotion-aware map from the JIT score to the penalty window (blocks):
    ///   window = jitWindowMin + (jitWindowMax - jitWindowMin) * pJit * confidence / 1e8 ;
    ///   JIT head demoted / unseasoned / parent not allowlisted => jitWindowDefault.
    function jitWindowFromScore(PoolId id, uint32 pJitBps, uint32 confidenceBps, bytes32 modelNode)
        public
        view
        returns (uint16)
    {
        PoolConfig storage cfg = _config[id];
        if (isJitDemoted(id, modelNode)) return cfg.jitWindowDefault;
        uint256 p = pJitBps > BPS ? BPS : pJitBps;
        uint256 c = confidenceBps > BPS ? BPS : confidenceBps;
        uint256 span = cfg.jitWindowMax - cfg.jitWindowMin; // validated max >= min; p * c <= 1e8 => <= max
        return uint16(cfg.jitWindowMin + (span * p * c) / 1e8);
    }

    /// @notice Fee a swap in `zeroForOne` direction would pay if executed now (in this block, at the current pool
    /// price). Exactly what beforeSwap charges for the next swap in this block.
    function quoteFee(PoolKey calldata key, bool zeroForOne)
        external
        view
        returns (uint24 feePips, bool arbDir, uint32 gapPips, bool stale)
    {
        PoolId id = key.toId();
        (BlockAnchor memory anc,, uint8 toward) = _liveAnchor(id);
        (feePips, arbDir, gapPips) = _fee(_config[id], anc, zeroForOne, toward);
        stale = anc.stale;
    }

    /// @notice Live state: stored pool state, the current block's anchor (as it is, or would be at a swap now),
    /// and staleness now.
    function poolState(PoolId id) external view returns (PoolState memory state, Anchor memory anchor, bool staleNow) {
        state = _state[id];
        BlockAnchor memory b;
        if (state.initialized) (b,,) = _liveAnchor(id);
        else b = _anchor[id];
        anchor = Anchor(b.blockNumber, b.stale, b.kBps, b.gapZeroForOne, b.gapOneForZero, b.attestBlock, b.modelNode);
        staleNow = _isStale(_config[id], state.lastAttestBlock);
    }

    function poolConfig(PoolId id) external view returns (PoolConfig memory) {
        return _config[id];
    }

    function calibration(bytes32 modelNode) external view returns (Calibration memory) {
        return _calibration[modelNode];
    }

    /// @notice EIP-712 digest the attestor signs. Domain: name "Oniblock", version "1", chainId, this contract
    /// (also available via EIP-5267 `eip712Domain()`).
    function attestationDigest(PoolId id, Attestation calldata a) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ATTESTATION_TYPEHASH,
                    PoolId.unwrap(id),
                    a.blockNumber,
                    a.oracleMidX96,
                    a.pToxicBps,
                    a.confidenceBps,
                    a.pJitBps,
                    a.modelNode
                )
            )
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Current Chainlink reference in priceX96 convention (ok=false if disabled/invalid/stale).
    function chainlinkPriceX96(PoolId id) external view returns (bool ok, uint256 priceX96) {
        return _chainlinkX96(_config[id], _state[id]);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Hook permissions & callbacks
    // ---------------------------------------------------------------------------------------------------------

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: true,
            beforeAddLiquidity: false,
            afterAddLiquidity: true,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: true,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: true,
            afterRemoveLiquidityReturnDelta: true
        });
    }

    /// @dev Allowlist + dynamic-fee requirement.
    function _beforeInitialize(address, PoolKey calldata key, uint160) internal view override returns (bytes4) {
        if (key.fee != LPFeeLibrary.DYNAMIC_FEE_FLAG) revert NotDynamicFee();
        if (!_state[key.toId()].registered) revert PoolNotRegistered();
        return this.beforeInitialize.selector;
    }

    /// @dev Marks the pool initialized and starts k at kDefault and the JIT window at jitWindowDefault (dynamic fee
    /// already enforced in beforeInitialize).
    function _afterInitialize(address, PoolKey calldata key, uint160, int24) internal override returns (bytes4) {
        PoolId id = key.toId();
        PoolState storage st = _state[id];
        PoolConfig storage cfg = _config[id];
        st.initialized = true;
        st.kBps = cfg.kDefaultBps;
        st.jitWindow = cfg.jitWindowDefault;
        return this.afterInitialize.selector;
    }

    /// @dev Never reverts for data reasons. Creates the block's anchor on the first swap and folds the live gap into
    /// the per-direction high-water mark; storage is written only when the anchor changes.
    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        (BlockAnchor memory anc, bool dirty, uint8 toward) = _liveAnchor(id);
        if (dirty) _anchor[id] = anc;
        (uint24 fee, bool arbDir, uint32 gap) = _fee(_config[id], anc, params.zeroForOne, toward);
        // Hand the exact fee-law result to afterSwap (the live price has moved by then).
        uint256 packed = uint256(fee) | (arbDir ? 1 << 24 : 0) | (uint256(gap) << 32);
        uint256 slot = FEE_TSLOT;
        assembly ("memory-safe") {
            tstore(slot, packed)
        }
        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    /// @dev Emits the Receipt with the fee/arbDir/gap beforeSwap charged (transient) and the k/model/stale of the
    /// anchor it used; donates parked JIT penalties if liquidity is in
    /// range.
    function _afterSwap(address sender, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        PoolId id = key.toId();
        BlockAnchor storage anc = _anchor[id]; // written/confirmed in beforeSwap of this swap
        uint256 packed;
        uint256 slot = FEE_TSLOT;
        assembly ("memory-safe") {
            packed := tload(slot)
        }
        emit Receipt(
            id,
            uint64(block.number),
            sender,
            params.zeroForOne,
            (packed >> 24) & 1 == 1,
            uint32(packed >> 32),
            anc.kBps,
            uint24(packed),
            delta.amount0(),
            delta.amount1(),
            anc.modelNode,
            anc.stale
        );
        if ((pendingPenalty0[id] | pendingPenalty1[id]) != 0) _flushPenalty(key, id);
        return (this.afterSwap.selector, 0);
    }

    /// @dev LiquidityPenaltyHook._afterAddLiquidity with the v5 per-position window: the "added recently" check
    /// (fees withheld by the hook until removal) runs against the window the position was last added under, and the
    /// window stored for this add is the larger of that running window and the effective window now — re-adding
    /// inside a window never shortens it (OZ: splitting additions does not reduce the penalty). Once the previous
    /// window has expired the position starts afresh under the effective window now (equivalent to a new position).
    function _afterAddLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        BalanceDelta,
        BalanceDelta feeDelta,
        bytes calldata
    ) internal override returns (bytes4, BalanceDelta) {
        PoolId id = key.toId();
        bytes32 positionKey = Position.calculatePositionKey(sender, params.tickLower, params.tickUpper, params.salt);

        uint16 w = _windowAtAdd[id][positionKey];
        bool recent = w != 0 && _getBlockNumber() - getLastAddedLiquidityBlock(id, positionKey) < w;
        uint16 wNow = _effectiveJitWindow(id);
        if (!recent || wNow > w) w = wNow;
        _windowAtAdd[id][positionKey] = w;
        _updateLastAddedLiquidityBlock(id, positionKey);

        if (recent) {
            _takeFeesToHook(key, positionKey, feeDelta);
            return (this.afterAddLiquidity.selector, feeDelta);
        }
        return (this.afterAddLiquidity.selector, BalanceDeltaLibrary.ZERO_DELTA);
    }

    /// @dev LiquidityPenaltyHook._afterRemoveLiquidity with two changes. (1) v5: the window is the one in force
    /// when the position's liquidity was added (`_windowAtAdd`, jitWindowDefault if never recorded), not the
    /// immutable `blockNumberOffset`; the penalty decays linearly over that window and emits `JitPenalty`. (2) The
    /// "last in-range LP exits inside the window" case: instead of reverting (which would brick the withdrawal until
    /// the window passes), the penalty is taken by the hook as ERC-6909 claims (`pendingPenalty*`) and donated to
    /// in-range LPs on the next swap that finds liquidity in range. The exiting JIT LP still forfeits the penalty;
    /// the withdrawal never reverts. Caveat (R-08): the parked penalty goes to whoever is in range at that later
    /// swap, which can be an old position of the same JIT; like OZ's multi-account caveat, use a large
    /// jitWindowDefault in thin pools.
    function _afterRemoveLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        BalanceDelta,
        BalanceDelta feeDelta,
        bytes calldata
    ) internal override returns (bytes4, BalanceDelta) {
        PoolId id = key.toId();
        bytes32 positionKey = Position.calculatePositionKey(sender, params.tickLower, params.tickUpper, params.salt);

        BalanceDelta withheldFees = _settleFeesFromHook(key, positionKey);
        BalanceDelta totalFees = feeDelta + withheldFees;
        uint48 lastAdded = getLastAddedLiquidityBlock(id, positionKey);
        uint16 window = _windowAtAdd[id][positionKey];
        if (window == 0) window = _config[id].jitWindowDefault;

        if (_getBlockNumber() - lastAdded < window && totalFees != BalanceDeltaLibrary.ZERO_DELTA) {
            BalanceDelta penalty = _jitPenalty(totalFees, lastAdded, window);
            uint256 p0 = uint256(int256(penalty.amount0()));
            uint256 p1 = uint256(int256(penalty.amount1()));
            if (poolManager.getLiquidity(id) == 0) {
                if (p0 != 0) key.currency0.take(poolManager, address(this), p0, true);
                if (p1 != 0) key.currency1.take(poolManager, address(this), p1, true);
                pendingPenalty0[id] += p0;
                pendingPenalty1[id] += p1;
                emit PenaltyParked(id, p0, p1);
            } else {
                poolManager.donate(key, p0, p1, "");
            }
            emit JitPenalty(id, sender, positionKey, lastAdded, window, p0, p1);
            return (this.afterRemoveLiquidity.selector, penalty - withheldFees);
        }

        if (withheldFees != BalanceDeltaLibrary.ZERO_DELTA) {
            return (
                this.afterRemoveLiquidity.selector, toBalanceDelta(-withheldFees.amount0(), -withheldFees.amount1())
            );
        }
        return (this.afterRemoveLiquidity.selector, BalanceDeltaLibrary.ZERO_DELTA);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------------------

    /// @dev Timelock gate for owner calls. Returns true if the call may execute now. With configDelay > 0 the first
    /// call queues keccak256(msg.data) and returns false (no state change besides the queue); the identical call
    /// within [eta, eta + TIMELOCK_GRACE] executes and clears the entry. An expired entry is re-queued (fresh
    /// ChangeQueued, full delay) instead of executing (N-08).
    function _timelocked() internal returns (bool) {
        if (configDelay == 0) return true;
        bytes32 h = keccak256(msg.data);
        uint256 eta = queuedEta[h];
        if (eta == 0 || block.timestamp > eta + TIMELOCK_GRACE) {
            eta = block.timestamp + configDelay;
            queuedEta[h] = eta;
            emit ChangeQueued(h, eta, msg.data);
            return false;
        }
        if (block.timestamp < eta) revert TimelockNotReady(eta);
        delete queuedEta[h];
        return true;
    }

    function _isStale(PoolConfig memory cfg, uint64 lastAttestBlock) internal view returns (bool) {
        return lastAttestBlock == 0 || block.number - lastAttestBlock > cfg.staleBlocks;
    }

    /// @dev Demotion rule shared by the arb head (`calKey` = modelNode) and the JIT head (`calKey` =
    /// jitCalibrationKey(modelNode)); the allowlist is always the parent model's.
    function _demoted(PoolId id, bytes32 modelNode, bytes32 calKey) internal view returns (bool) {
        PoolConfig storage cfg = _config[id];
        Calibration storage c = _calibration[calKey];
        uint32 n = c.n;
        if (!modelAllowed[id][modelNode] || n < cfg.minSamples) return true;
        uint32 threshold = cfg.brierDemoteBps;
        return threshold != 0 && n != 0 && c.brierBps > threshold;
    }

    /// @dev v5: the JIT window for liquidity added now: the attested window while the attestation is fresh, else
    /// jitWindowDefault (same staleness rule as the fee law).
    function _effectiveJitWindow(PoolId id) internal view returns (uint16) {
        PoolConfig storage cfg = _config[id];
        uint64 last = _state[id].lastAttestBlock;
        if (last == 0 || block.number - last > cfg.staleBlocks) return cfg.jitWindowDefault;
        return _state[id].jitWindow;
    }

    /// @dev OZ's _calculateLiquidityPenalty with the position's window in place of the immutable offset:
    /// penalty = fees * (window - (now - lastAdded)) / window, i.e. 100% in the add block, 0 once the window has
    /// passed. Caller guarantees now - lastAdded < window (no underflow).
    function _jitPenalty(BalanceDelta fees, uint48 lastAdded, uint16 window) internal view returns (BalanceDelta) {
        uint256 remaining = uint256(window) - (_getBlockNumber() - lastAdded);
        uint256 p0 = FullMath.mulDiv(SafeCast.toUint128(fees.amount0()), remaining, window);
        uint256 p1 = FullMath.mulDiv(SafeCast.toUint128(fees.amount1()), remaining, window);
        return toBalanceDelta(SafeCast.toInt128(p0), SafeCast.toInt128(p1));
    }

    /// @dev The anchor as it is after a swap/quote now: loads the current block's anchor (or creates it from the
    /// stored state), then folds the live toward-oracle gap into the per-direction high-water mark.
    /// `dirty` = the result differs from storage. `toward` = the direction that moves the LIVE price toward the
    /// anchor's mid (1 = zeroForOne, 2 = oneForZero, 0 = none: stale, or the live gap is < 1 pip).
    /// Pure math, no reverts: mid in (0, 2^224) is enforced at post time, so mulDiv results fit (|diff|*1e6 < 2^244).
    function _liveAnchor(PoolId id) internal view returns (BlockAnchor memory anc, bool dirty, uint8 toward) {
        anc = _anchor[id];
        PoolState storage st = _state[id];
        if (anc.blockNumber != block.number) {
            dirty = true;
            anc = BlockAnchor(uint64(block.number), false, 0, 0, 0, 0, false, false, bytes32(0));
            PoolConfig storage cfg = _config[id];
            uint64 last = st.lastAttestBlock;
            if (last == 0 || block.number - last > cfg.staleBlocks) {
                anc.stale = true;
                anc.kBps = cfg.kDefaultBps;
                return (anc, true, 0);
            }
            anc.kBps = st.kBps;
            anc.attestBlock = last;
            anc.modelNode = st.modelNode;
        }
        if (anc.stale) return (anc, dirty, 0);

        uint256 mid = anc.pinnedMid ? _pinnedMid[id] : st.oracleMidX96;
        (uint160 sqrtP,,,) = poolManager.getSlot0(id);
        uint256 poolX96 = FullMath.mulDiv(sqrtP, sqrtP, Q96);
        bool towardIsZeroForOne = poolX96 > mid; // selling token0 lowers the price toward the oracle
        uint256 gap = FullMath.mulDiv(towardIsZeroForOne ? poolX96 - mid : mid - poolX96, PIPS, mid);
        if (gap == 0) return (anc, dirty, 0); // at the mid (within 1 pip): no direction is an arbitrage
        if (gap > PIPS) gap = PIPS;
        toward = towardIsZeroForOne ? 1 : 2;
        if (towardIsZeroForOne) {
            if (gap > anc.gapZeroForOne) {
                anc.gapZeroForOne = uint32(gap);
                dirty = true;
            }
        } else if (gap > anc.gapOneForZero) {
            anc.gapOneForZero = uint32(gap);
            dirty = true;
        }
    }

    /// @dev Fee law for a swap direction given the anchor and the live toward direction: (fee, arbDir, raw gap).
    /// Only the part of the high-water gap above cfg.arbThresholdPips is priced.
    /// The high-water gap applies only while the live price is on the arbitrage side of the mid for this direction
    /// (N-01); otherwise baseFee. A block un-staled by a same-block attestation is floored at conservativeFee.
    function _fee(PoolConfig memory cfg, BlockAnchor memory anc, bool zeroForOne, uint8 toward)
        internal
        pure
        returns (uint24 fee, bool arbDir, uint32 gap)
    {
        if (anc.stale) return (cfg.conservativeFee, false, 0);
        fee = cfg.baseFee;
        if (toward == (zeroForOne ? 1 : 2)) {
            gap = zeroForOne ? anc.gapZeroForOne : anc.gapOneForZero; // >= live gap > 0
            uint256 excess = gap > cfg.arbThresholdPips ? gap - cfg.arbThresholdPips : 0; // below threshold => base
            uint256 f = uint256(cfg.baseFee) + (excess * anc.kBps) / BPS;
            fee = uint24(f > cfg.feeMax ? cfg.feeMax : f);
            arbDir = true;
        }
        if (anc.conservativeFloor && fee < cfg.conservativeFee) fee = cfg.conservativeFee;
    }

    /// @dev Reverts (keeper tx only) if the band is enabled and the feed is invalid/stale or the mid is outside it.
    /// Conservative choice: an unverifiable mid is rejected; the pool then falls back to the conservative fee
    /// once the previous attestation goes stale. Never evaluated in the swap path. Within the band the attestor is
    /// trusted (keep sanityBandBps tight relative to feeMax, e.g. 200 bps).
    function _checkSanityBand(PoolConfig memory cfg, PoolState storage st, uint256 mid) internal view {
        if (cfg.chainlinkFeed == address(0) || cfg.sanityBandBps == 0) return;
        (bool ok, uint256 ref) = _chainlinkX96(cfg, st);
        if (!ok) revert ChainlinkInvalid();
        uint256 diff = mid > ref ? mid - ref : ref - mid;
        if (FullMath.mulDiv(diff, BPS, ref) > cfg.sanityBandBps) revert OutOfSanityBand();
    }

    /// @dev Chainlink USD-per-ETH-style answer -> priceX96 (raw token1 per raw token0 * 2^96), accounting for feed
    /// and token decimals. Non-inverted: token0 is the feed's base (e.g. WETH/USDC with WETH=token0).
    ///   non-inverted: X96 = ans * 10^dec1 * 2^96 / (10^fd * 10^dec0)
    ///   inverted:     X96 = 10^fd * 10^dec1 * 2^96 / (ans * 10^dec0)
    /// Answers older than cfg.chainlinkMaxAge (seconds) are invalid.
    function _chainlinkX96(PoolConfig memory cfg, PoolState storage st) internal view returns (bool, uint256) {
        if (cfg.chainlinkFeed == address(0)) return (false, 0);
        AggregatorV3Interface feed = AggregatorV3Interface(cfg.chainlinkFeed);
        int256 ans;
        uint256 updatedAt;
        try feed.latestRoundData() returns (uint80, int256 a_, uint256, uint256 u_, uint80) {
            ans = a_;
            updatedAt = u_;
        } catch {
            return (false, 0);
        }
        if (ans <= 0 || ans > int256(uint256(type(uint128).max))) return (false, 0);
        if (updatedAt == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > cfg.chainlinkMaxAge) {
            return (false, 0);
        }
        uint8 fd;
        try feed.decimals() returns (uint8 d) {
            fd = d;
        } catch {
            return (false, 0);
        }
        if (fd > 36) return (false, 0);
        uint256 a = uint256(ans);
        uint256 x;
        if (!cfg.chainlinkInverted) {
            x = FullMath.mulDiv(a * (10 ** st.decimals1), Q96, 10 ** (uint256(fd) + st.decimals0));
        } else {
            x = FullMath.mulDiv((10 ** fd) * (10 ** st.decimals1), Q96, a * (10 ** st.decimals0));
        }
        if (x == 0) return (false, 0);
        return (true, x);
    }

    /// @dev Donates parked JIT penalties to in-range liquidity (no-op while none is in range).
    function _flushPenalty(PoolKey calldata key, PoolId id) internal {
        if (poolManager.getLiquidity(id) == 0) return;
        uint256 p0 = pendingPenalty0[id];
        uint256 p1 = pendingPenalty1[id];
        pendingPenalty0[id] = 0;
        pendingPenalty1[id] = 0;
        poolManager.donate(key, p0, p1, "");
        // Pay the donation by burning the parked ERC-6909 claims.
        key.currency0.settle(poolManager, address(this), p0, true);
        key.currency1.settle(poolManager, address(this), p1, true);
        emit PenaltyDonated(id, p0, p1);
    }

    function _validateConfig(PoolConfig calldata c) internal pure {
        if (
            c.feeMax > FEE_MAX_CAP || c.baseFee > c.feeMax || c.conservativeFee > c.feeMax || c.kMaxBps >= BPS
                || c.kMinBps > c.kMaxBps || c.kDefaultBps < c.kMinBps || c.kDefaultBps > c.kMaxBps
                || c.sanityBandBps > BPS || c.brierDemoteBps > BPS || c.staleBlocks == 0
                || (c.chainlinkFeed != address(0) && c.chainlinkMaxAge == 0)
                || c.arbThresholdPips > c.feeMax || c.jitWindowMin == 0 || c.jitWindowMin > c.jitWindowDefault
                || c.jitWindowDefault > c.jitWindowMax
        ) revert InvalidConfig();
    }

    /// @dev Token decimals for the Chainlink conversion. Native currency => 18. A failing call => 18, or a revert if
    /// `strict` (a feed is configured, so a wrong guess would skew the band). More than 30 decimals => revert.
    function _decimalsOf(Currency c, bool strict) internal view returns (uint8) {
        address t = Currency.unwrap(c);
        if (t == address(0)) return 18;
        try IERC20Metadata(t).decimals() returns (uint8 d) {
            if (d > 30) revert InvalidConfig();
            return d;
        } catch {
            if (strict) revert InvalidConfig();
            return 18;
        }
    }
}
