/**
 * Hand-written minimal ABIs matching docs/BUILD_SPEC.md exactly.
 * INTEGRATION: once `abis/OniblockHook.json` exists (contracts/export-abis.sh), switch
 * to the generated ABI. Verified identical (signatures) to abis/OniblockHook.json on 2026-09-26
 * (re-checked after docs/review/CONTRACT_FIXES_1.md: every entry here is unchanged; modelAllowed + errors added).
 * v3: `poolConfig` added (PoolConfig incl. arbThresholdPips). `poolState` is omitted (nested tuple return; read via generated ABI if needed).
 */

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
  { name: 'minSamples', type: 'uint32' },
  { name: 'chainlinkMaxAge', type: 'uint32' },
  { name: 'arbThresholdPips', type: 'uint24' },
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
        components: [
          { name: 'blockNumber', type: 'uint64' },
          { name: 'oracleMidX96', type: 'uint256' },
          { name: 'pToxicBps', type: 'uint32' },
          { name: 'confidenceBps', type: 'uint32' },
          { name: 'modelNode', type: 'bytes32' },
          { name: 'signature', type: 'bytes' },
        ],
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
    name: 'attestationDigest',
    stateMutability: 'view',
    inputs: [
      { name: 'id', type: 'bytes32' },
      {
        name: 'a',
        type: 'tuple',
        components: [
          { name: 'blockNumber', type: 'uint64' },
          { name: 'oracleMidX96', type: 'uint256' },
          { name: 'pToxicBps', type: 'uint32' },
          { name: 'confidenceBps', type: 'uint32' },
          { name: 'modelNode', type: 'bytes32' },
          { name: 'signature', type: 'bytes' },
        ],
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
  // CONTRACT_FIXES_1 (R-01): per-pool model allowlist; unseasoned/non-allowlisted nodes run at kDefault.
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
  { type: 'error', name: 'ModelNotAllowed', inputs: [] },
  { type: 'error', name: 'AlreadyAttested', inputs: [] },
  { type: 'error', name: 'AttestationBlockMismatch', inputs: [] },
  { type: 'error', name: 'BadSignature', inputs: [] },
  { type: 'error', name: 'NotQuoter', inputs: [] },
  { type: 'error', name: 'NotSettler', inputs: [] },
] as const;

/** v4 PoolManager: only `extsload` is needed to read slot0 / liquidity (StateLibrary). */
export const poolManagerAbi = [
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
