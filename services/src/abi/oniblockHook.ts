/**
 * Hand-written minimal ABIs matching docs/BUILD_SPEC.md exactly.
 * INTEGRATION: once `abis/OniblockHook.json` exists (contracts/export-abis.sh), switch
 * to the generated ABI. Verified identical (signatures) to abis/OniblockHook.json on 2026-09-26
 * (re-checked after docs/review/CONTRACT_FIXES_1.md: every entry here is unchanged; modelAllowed + errors added).
 * v3: `poolConfig` added (PoolConfig incl. arbThresholdPips). `poolState` is omitted (nested tuple return; read via generated ABI if needed).
 * v5 (docs/review/V5_JIT_HEAD_SPEC.md): Attestation gains `uint32 pJitBps` BEFORE modelNode; PoolConfig appends
 * `uint16 jitWindowMin, jitWindowMax, jitWindowDefault`; AttestationPosted appends `uint32 pJitBps, uint16 jitWindow`;
 * new `JitPenalty` event and the views `jitCalibrationKey`, `isJitDemoted`, `jitWindowFromScore`. Written from the spec —
 * re-verify against the regenerated abis/OniblockHook.json (field order of the Attestation tuple and of AttestationPosted).
 * Errors: the COMPLETE `"type":"error"` list of abis/OniblockHook.json (hook + inherited Ownable/SafeERC20/ShortString),
 * so viem decodes every revert into its name in the `tx_error` log lines. `roleOracle` view + `roleOracleAbi`
 * (IRoleOracle.isQuoter/isSettler) for the keeper/settler preflight; `poolStateAbi` (nested tuple return) lives here too.
 */
import { parseAbi } from 'viem';

const poolKeyComponents = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const;

/** OniblockHook.PoolConfig (field order = struct order; arbThresholdPips appended in v3). */
export const poolConfigComponents = [
  { name: 'baseFee', type: 'uint24' },
  { name: 'feeMax', type: 'uint24' },
  { name: 'conservativeFee', type: 'uint24' },
  { name: 'kMinBps', type: 'uint32' },
  { name: 'kMaxBps', type: 'uint32' },
  { name: 'kDefaultBps', type: 'uint32' },
  { name: 'maxKStepBps', type: 'uint32' },
  { name: 'staleBlocks', type: 'uint16' },
  { name: 'sanityBandBps', type: 'uint32' },
  { name: 'chainlinkFeed', type: 'address' },
  { name: 'chainlinkInverted', type: 'bool' },
  { name: 'brierDemoteBps', type: 'uint32' },
  { name: 'chainlinkMaxAge', type: 'uint32' },
  { name: 'arbThresholdPips', type: 'uint24' },
  // v5: JIT penalty window bounds (blocks); window = min + (max - min) * pJit * c / 1e8, default when the JIT head is demoted.
  { name: 'jitWindowMin', type: 'uint16' },
  { name: 'jitWindowMax', type: 'uint16' },
  { name: 'jitWindowDefault', type: 'uint16' },
] as const;

/** OniblockHook.Attestation (field order = struct order; v5 inserted pJitBps before modelNode). */
export const attestationComponents = [
  { name: 'blockNumber', type: 'uint64' },
  { name: 'oracleMidX96', type: 'uint256' },
  { name: 'pToxicBps', type: 'uint32' },
  { name: 'confidenceBps', type: 'uint32' },
  { name: 'pJitBps', type: 'uint32' },
  { name: 'modelNode', type: 'bytes32' },
  { name: 'signature', type: 'bytes' },
] as const;

export const poolKeyTuple = { name: 'key', type: 'tuple', components: poolKeyComponents } as const;

export const oniblockHookAbi = [
  {
    type: 'function',
    name: 'setAttestation',
    stateMutability: 'nonpayable',
    inputs: [
      poolKeyTuple,
      {
        name: 'a',
        type: 'tuple',
        components: attestationComponents,
      },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setCalibration',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'modelNode', type: 'bytes32' },
      { name: 'brierBps', type: 'uint32' },
      { name: 'hitRateBps', type: 'uint32' },
      { name: 'n', type: 'uint32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'kFromScore',
    stateMutability: 'view',
    inputs: [
      { name: 'id', type: 'bytes32' },
      { name: 'pToxicBps', type: 'uint32' },
      { name: 'confidenceBps', type: 'uint32' },
      { name: 'modelNode', type: 'bytes32' },
    ],
    outputs: [{ name: 'kBps', type: 'uint32' }],
  },
  {
    type: 'function',
    name: 'quoteFee',
    stateMutability: 'view',
    inputs: [poolKeyTuple, { name: 'zeroForOne', type: 'bool' }],
    outputs: [
      { name: 'feePips', type: 'uint24' },
      { name: 'arbDir', type: 'bool' },
      { name: 'gapPips', type: 'uint32' },
      { name: 'stale', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'attestor',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'roleOracle',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'attestationDigest',
    stateMutability: 'view',
    inputs: [
      { name: 'id', type: 'bytes32' },
      {
        name: 'a',
        type: 'tuple',
        components: attestationComponents,
      },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'isDemoted',
    stateMutability: 'view',
    inputs: [
      { name: 'id', type: 'bytes32' },
      { name: 'modelNode', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'calibration',
    stateMutability: 'view',
    inputs: [{ name: 'modelNode', type: 'bytes32' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'brierBps', type: 'uint32' },
          { name: 'hitRateBps', type: 'uint32' },
          { name: 'n', type: 'uint32' },
          { name: 'updatedBlock', type: 'uint64' },
        ],
      },
    ],
  },
  {
    type: 'event',
    name: 'AttestationPosted',
    anonymous: false,
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'blockNumber', type: 'uint64', indexed: true },
      { name: 'oracleMidX96', type: 'uint256', indexed: false },
      { name: 'pToxicBps', type: 'uint32', indexed: false },
      { name: 'confidenceBps', type: 'uint32', indexed: false },
      { name: 'kBps', type: 'uint32', indexed: false },
      { name: 'modelNode', type: 'bytes32', indexed: true },
      { name: 'quoter', type: 'address', indexed: false },
      // v5: appended at the END (non-indexed)
      { name: 'pJitBps', type: 'uint32', indexed: false },
      { name: 'jitWindow', type: 'uint16', indexed: false },
    ],
  },
  // v5: emitted whenever a JIT penalty is applied (donated to in-range LPs or parked). window = the window in force
  // when the position was (last) added; a penalty with block - addedBlock >= 10 would have escaped the old 10-block wall.
  {
    type: 'event',
    name: 'JitPenalty',
    anonymous: false,
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'sender', type: 'address', indexed: true },
      { name: 'positionKey', type: 'bytes32', indexed: false },
      { name: 'addedBlock', type: 'uint48', indexed: false },
      { name: 'window', type: 'uint16', indexed: false },
      { name: 'penalty0', type: 'uint256', indexed: false },
      { name: 'penalty1', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Receipt',
    anonymous: false,
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'blockNumber', type: 'uint64', indexed: true },
      { name: 'sender', type: 'address', indexed: true },
      { name: 'zeroForOne', type: 'bool', indexed: false },
      { name: 'arbDir', type: 'bool', indexed: false },
      { name: 'gapPips', type: 'uint32', indexed: false },
      { name: 'kBps', type: 'uint32', indexed: false },
      { name: 'feePips', type: 'uint24', indexed: false },
      { name: 'amount0', type: 'int128', indexed: false },
      { name: 'amount1', type: 'int128', indexed: false },
      { name: 'modelNode', type: 'bytes32', indexed: false },
      { name: 'stale', type: 'bool', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'CalibrationUpdated',
    anonymous: false,
    inputs: [
      { name: 'modelNode', type: 'bytes32', indexed: true },
      { name: 'brierBps', type: 'uint32', indexed: false },
      { name: 'hitRateBps', type: 'uint32', indexed: false },
      { name: 'n', type: 'uint32', indexed: false },
    ],
  },
  // CONTRACT_FIXES_1 (R-01): per-pool model allowlist; non-allowlisted (and Brier-demoted) nodes run at kDefault.
  {
    type: 'function',
    name: 'modelAllowed',
    stateMutability: 'view',
    inputs: [
      { name: 'id', type: 'bytes32' },
      { name: 'modelNode', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  // v3 (docs/review/V3_THRESHOLD_BUILD.md): PoolConfig gained a trailing `uint24 arbThresholdPips`.
  {
    type: 'function',
    name: 'poolConfig',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [{ name: '', type: 'tuple', components: poolConfigComponents }],
  },
  // v4 (docs/review/V4_AI_DECIDES.md): config events, used by the keeper to drop its poolConfig cache on a change.
  {
    type: 'event',
    name: 'PoolConfigUpdated',
    anonymous: false,
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'config', type: 'tuple', indexed: false, components: poolConfigComponents },
    ],
  },
  // v5 (docs/review/V5_JIT_HEAD_SPEC.md §2.2): the JIT head's calibration key and window law.
  {
    type: 'function',
    name: 'jitCalibrationKey',
    stateMutability: 'pure',
    inputs: [{ name: 'modelNode', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'isJitDemoted',
    stateMutability: 'view',
    inputs: [
      { name: 'id', type: 'bytes32' },
      { name: 'modelNode', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'jitWindowFromScore',
    stateMutability: 'view',
    inputs: [
      { name: 'id', type: 'bytes32' },
      { name: 'pJitBps', type: 'uint32' },
      { name: 'confidenceBps', type: 'uint32' },
      { name: 'modelNode', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'uint16' }],
  },
  // Every `"type":"error"` entry of abis/OniblockHook.json (alphabetical), so tx_error shows the revert name.
  { type: 'error', name: 'AlreadyAttested', inputs: [] },
  { type: 'error', name: 'AttestationBlockMismatch', inputs: [] },
  { type: 'error', name: 'BadSignature', inputs: [] },
  { type: 'error', name: 'BlockNumberOffsetTooLow', inputs: [] },
  { type: 'error', name: 'ChainlinkInvalid', inputs: [] },
  { type: 'error', name: 'HookNotImplemented', inputs: [] },
  { type: 'error', name: 'InvalidAttestation', inputs: [] },
  { type: 'error', name: 'InvalidConfig', inputs: [] },
  { type: 'error', name: 'InvalidNativePayer', inputs: [{ name: 'payer', type: 'address' }] },
  { type: 'error', name: 'InvalidPool', inputs: [] },
  { type: 'error', name: 'InvalidShortString', inputs: [] },
  { type: 'error', name: 'ModelNotAllowed', inputs: [] },
  { type: 'error', name: 'NoLiquidityToReceiveDonation', inputs: [] },
  { type: 'error', name: 'NotDynamicFee', inputs: [] },
  { type: 'error', name: 'NotPoolManager', inputs: [] },
  { type: 'error', name: 'NotQuoter', inputs: [] },
  { type: 'error', name: 'NotSettler', inputs: [] },
  { type: 'error', name: 'OutOfSanityBand', inputs: [] },
  { type: 'error', name: 'OwnableInvalidOwner', inputs: [{ name: 'owner', type: 'address' }] },
  { type: 'error', name: 'OwnableUnauthorizedAccount', inputs: [{ name: 'account', type: 'address' }] },
  { type: 'error', name: 'PoolAlreadyInitialized', inputs: [] },
  { type: 'error', name: 'PoolNotInitialized', inputs: [] },
  { type: 'error', name: 'PoolNotRegistered', inputs: [] },
  { type: 'error', name: 'SafeERC20FailedOperation', inputs: [{ name: 'token', type: 'address' }] },
  { type: 'error', name: 'StringTooLong', inputs: [{ name: 'str', type: 'string' }] },
  { type: 'error', name: 'TimelockNotReady', inputs: [{ name: 'eta', type: 'uint256' }] },
  { type: 'error', name: 'WrongHook', inputs: [] },
] as const;

/** IRoleOracle (MockRoleOracle locally, EnsV2RoleOracle on a fork/sepolia): who may post attestations / calibration. */
export const roleOracleAbi = [
  { type: 'function', name: 'isQuoter', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'isSettler', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'bool' }] },
] as const;

/** `poolState` view (nested tuples, not in the hand-written list above). v5 PoolState appends `uint16 jitWindow, uint32 pJitBps`. */
export const poolStateAbi = parseAbi([
  'function poolState(bytes32 id) view returns ((bool registered,bool initialized,uint8 decimals0,uint8 decimals1,uint32 kBps,uint64 lastAttestBlock,uint64 lastPostBlock,uint32 pToxicBps,uint32 confidenceBps,uint256 oracleMidX96,bytes32 modelNode,uint16 jitWindow,uint32 pJitBps) state, (uint64 blockNumber,bool stale,uint32 kBps,uint32 gapZeroForOne,uint32 gapOneForZero,uint64 attestBlock,bytes32 modelNode) anchor, bool staleNow)',
]);

/** v4 PoolManager: `extsload` to read slot0 / liquidity (StateLibrary) and, for the v5 JIT head, the ModifyLiquidity event. */
export const poolManagerAbi = [
  {
    type: 'event',
    name: 'ModifyLiquidity',
    anonymous: false,
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'sender', type: 'address', indexed: true },
      { name: 'tickLower', type: 'int24', indexed: false },
      { name: 'tickUpper', type: 'int24', indexed: false },
      { name: 'liquidityDelta', type: 'int256', indexed: false },
      { name: 'salt', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'function',
    name: 'extsload',
    stateMutability: 'view',
    inputs: [{ name: 'slot', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'extsload',
    stateMutability: 'view',
    inputs: [
      { name: 'startSlot', type: 'bytes32' },
      { name: 'nSlots', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bytes32[]' }],
  },
] as const;

/** v4-core `PoolSwapTest.swap` (test router used for local demos/bots). */
export const poolSwapTestAbi = [
  {
    type: 'function',
    name: 'swap',
    stateMutability: 'payable',
    inputs: [
      poolKeyTuple,
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'zeroForOne', type: 'bool' },
          { name: 'amountSpecified', type: 'int256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
      {
        name: 'testSettings',
        type: 'tuple',
        components: [
          { name: 'takeClaims', type: 'bool' },
          { name: 'settleUsingBurn', type: 'bool' },
        ],
      },
      { name: 'hookData', type: 'bytes' },
    ],
    outputs: [{ name: 'delta', type: 'int256' }],
  },
] as const;

/** v4-core `PoolModifyLiquidityTest.modifyLiquidity` (deployments.liquidityRouter; used by the JIT bot). liquidityDelta < 0 = remove. */
export const poolModifyLiquidityTestAbi = [
  {
    type: 'function',
    name: 'modifyLiquidity',
    stateMutability: 'payable',
    inputs: [
      poolKeyTuple,
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tickLower', type: 'int24' },
          { name: 'tickUpper', type: 'int24' },
          { name: 'liquidityDelta', type: 'int256' },
          { name: 'salt', type: 'bytes32' },
        ],
      },
      { name: 'hookData', type: 'bytes' },
    ],
    outputs: [{ name: 'delta', type: 'int256' }],
  },
] as const;

/**
 * SplitSwapRouter (contracts/src/periphery/SplitSwapRouter.sol) — ERC20 router used by bots/demo.
 * `swapSplit` runs `parts` equal sub-swaps inside ONE PoolManager unlock (one tx): the split-swap
 * attack the per-block fee anchor defeats. Returns the swapper's net BalanceDelta (packed int256).
 * Payer must approve the router for the input token. amountSpecified < 0 = exact input.
 */
export const splitRouterAbi = [
  {
    type: 'function',
    name: 'swap',
    stateMutability: 'nonpayable',
    inputs: [
      poolKeyTuple,
      { name: 'zeroForOne', type: 'bool' },
      { name: 'amountSpecified', type: 'int256' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [{ name: '', type: 'int256' }],
  },
  {
    type: 'function',
    name: 'swapSplit',
    stateMutability: 'nonpayable',
    inputs: [
      poolKeyTuple,
      { name: 'zeroForOne', type: 'bool' },
      { name: 'amountSpecified', type: 'int256' },
      { name: 'parts', type: 'uint256' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [{ name: '', type: 'int256' }],
  },
] as const;

export const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'o', type: 'address' },
      { name: 's', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 's', type: 'address' },
      { name: 'v', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  /** MockERC20 only (local). */
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;
