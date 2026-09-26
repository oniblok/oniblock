# ENS integration (ENSv2, Sepolia beta)

Status: validated end to end on an Anvil fork of Sepolia (block 11781880 and latest as of 2026-09-26). Nothing has been broadcast to real Sepolia yet. `oniblock.eth` and `oni-block.eth` were both still available on Sepolia on 2026-09-26 (`ETHRegistrar.isAvailable`).

Files:
- `contracts/script/EnsSetup.s.sol`: full setup script. Writes `deployments/<chainId>.ens.json`.
- `contracts/src/roles/EnsV2RoleOracle.sol`: the `IRoleOracle` used by the hook.
- `contracts/src/roles/EnsV2Lib.sol`: role constants, `dnsEncode`, `namehash`, `labelId`.
- `contracts/src/interfaces/ens/IEnsV2.sol`: minimal interfaces, copied from the verified deployed source.
- `contracts/test/fork/EnsSetup.t.sol`: fork tests.
- `deployments/11155111.anvil-fork.ens.json`: example output from a broadcast run against the local fork. The addresses in it exist **only on that fork**.

## 1. Deployed ENSv2 contracts (Sepolia, redeploy of 2026-09-15)

All of these are Etherscan-verified (solc 0.8.25) and match ensjs PR #380 ("target the 2026-09-15 Sepolia v2 redeploy").

| Contract | Address |
|---|---|
| ETH registry (PermissionedRegistry for `.eth`) | `0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E` |
| Root registry (`UR.ROOT_REGISTRY`) | `0x9703DBD26dAB89504490994138cF2c575251a9cE` |
| ETHRegistrar | `0xAbe76F6C8DFcEd81AA5A2bB8034202A7136b94ca` |
| Rent price oracle | `0x9B0b9C65BDAf9794Ff7697E4dCFb1f50581072BB` |
| UniversalResolverV2 | `0x5d25C1D6aCBb71B7a28AA7899618a3412a8303e3` |
| UniversalHelper (registry-walking views; ensjs `getAvailable` uses it) | `0x33f571aa8A160a21b877cF6E0Fb8806692b97DF5` |
| VerifiableFactory | `0x9e726Eb570beb6BCEb495AB8cdA7df517d4e841C` |
| UserRegistry implementation | `0xA80338aAA8D23831cEa25E858D1774534aBb0263` |
| PermissionedResolver implementation | `0x14F09Fd05d4585759e54844DC9B00147131Cf243` |
| MockUSDC (6 decimals, anyone can `mint`) | `0x16f95D91DBa7dA3Aca778Ec053dF0FF6C6A8aA8e` |

Registrar parameters: `MIN_COMMITMENT_AGE` = 60 s, `MAX_COMMITMENT_AGE` = 86400 s, `MIN_REGISTER_DURATION` = 28 days, `GRACE_PERIOD` = 28 days. Price for `oniblock` (8 letters) over 1 year is 8.000021 MockUSDC.

## 2. What the setup creates

```
oniblock.eth                    ETH registry token, owner = ENS_OWNER; subregistry = R0; resolver = RES
└─ R0 = UserRegistry proxy (VerifiableFactory), root roles held by owner; setParent(ETH registry, "oniblock")
   ├─ quoter        owner holds ROLE_QUOTER_ADMIN; the keeper holds ROLE_QUOTER; addr = keeper
   ├─ settler       owner holds ROLE_SETTLER_ADMIN; the settler holds ROLE_SETTLER; addr = settler
   ├─ models        subregistry = R1 (UserRegistry proxy)
   │   ├─ jev-v1        model-hash, agent-context, calibration.* (settler only)
   │   └─ heuristic-v1  model-hash, agent-context, calibration.* (settler only)
   └─ pools         subregistry = R2 (UserRegistry proxy)
       └─ weth-usdc     hook, pool-id, fee-min, fee-max, policy-uri (addr = hook when set)
```

- All names use a single resolver: RES, a PermissionedResolver proxy we deployed through VerifiableFactory.
- Subnames are registered with `expiry = type(uint64).max`. An expired name gets a new EAC resource, which silently drops its roles, so subnames must not expire.
- Every name is a real registered token in its own registry (`models` and `pools` have their own registries), so UniversalResolverV2 finds RES exactly at the leaf.

## 3. Role mechanism (the hook's kill switch)

**Mechanism:** each role is a custom EAC role bit set on the subname's resource in **our own UserRegistry**.

| | value | meaning |
|---|---|---|
| `ROLE_QUOTER` | `1 << 64` = `0x0000000000000000000000000000000000000000000000010000000000000000` | nybble 16. Unused by `RegistryRolesLib`. |
| `ROLE_QUOTER_ADMIN` | `ROLE_QUOTER << 128` | Held by the name owner. Lets it grant and revoke `ROLE_QUOTER`. |
| `ROLE_SETTLER` | `1 << 68` = `0x0000000000000000000000000000000000000000000000100000000000000000` | nybble 17 |
| `ROLE_SETTLER_ADMIN` | `ROLE_SETTLER << 128` | Held by the name owner. |

Why custom bits work: `EnhancedAccessControl` only checks that bits fall inside `ALL_ROLES` (bit 0 of each nybble). `PermissionedRegistry` uses nybbles 0–9, 30 and 31. Token admin roles can **only** be assigned when the name is registered (`register(label, owner, sub, resolver, roleBitmap, expiry)`), so the setup registers `quoter` with `ROLE_QUOTER_ADMIN` in `roleBitmap`. After that the owner can `grantRoles` and `revokeRoles` the regular bit.

**Resource ids.** `PermissionedRegistry` functions take `anyId`, which can be the labelhash, the tokenId or the resource. Internally `LibLabel.withVersion(anyId, v) = anyId ^ uint32(anyId) ^ v`, which replaces the low 32 bits.
- labelId(`quoter`) = `uint256(keccak256("quoter"))` = `0xb5799fb611a9686d06c14bb2f57d08ffc2aa4db75ffdd3f24710315d78a008a1`
- resource(`quoter`), fresh registration (eacVersionId 0) = `0xb5799fb611a9686d06c14bb2f57d08ffc2aa4db75ffdd3f24710315d00000000`
- labelId(`settler`) = `0xc305bbd2fc906a028d812a684014bdfe9688f5bf2f3fab401cc449ba6707f04a`
- resource(`settler`) = `0xc305bbd2fc906a028d812a684014bdfe9688f5bf2f3fab401cc449ba00000000`
- The tokenId changes on every grant or revoke, because the registry burns and re-mints the token with `tokenVersionId++`. The resource changes on unregister or expiry. **Always pass the labelhash.** The registry maps it to the current resource.

**Oracle.** `EnsV2RoleOracle(owner, quoterRef, settlerRef)` with `RoleRef{registry: R0, resource: labelId("quoter"), roleBitmap: ROLE_QUOTER}`. The settler ref is built the same way.
- `isQuoter(a)` = `R0.hasRoles(labelId("quoter"), ROLE_QUOTER, a)`
- `isSettler(a)` = `R0.hasRoles(labelId("settler"), ROLE_SETTLER, a)`
- The oracle fails closed: a revert or an unset registry returns false.
- `hasRoles` ORs in ROOT roles, so never grant `ROLE_QUOTER` on ROOT of R0. The owner holds only admin bits for these roles.

**Revoke = loss of power.**
- `R0.revokeRoles(labelId("quoter"), ROLE_QUOTER, keeper)` makes `isQuoter(keeper)` false immediately (fork-tested).
- `R0.grantRoles(labelId("quoter"), ROLE_QUOTER, backup)` makes `isQuoter(backup)` true.
- `R0.unregister(labelId("quoter"))` wipes every role on that name.

## 4. Resolver permissions (calibration is settler-only)

The PermissionedResolver checks `setText(name, key, value)` against `ROLE_SET_TEXT` (`1<<4`) on either the resource `uint256(keccak256(bytes(key)))` or ROOT.

- **The resource is per key and ignores the name.** A grant for `calibration.brier` covers that key on every name served by RES.
- `grantRoles` is **disabled** on the resolver. Use `grantSetterRoles(bytes setterCalldata, address account)`: the resolver decodes the calldata (`setText(name,key,*)` gives resource keccak(key) and `ROLE_SET_TEXT`), and the name argument inside the calldata is ignored. `revokeRoles(keccak(key), ROLE_SET_TEXT, account)` works normally.
- The setup gives the owner every ROOT resolver role **except** `ROLE_SET_TEXT`. For text it gets only `ROLE_SET_TEXT_ADMIN` (`1<<132`).
  - The owner then grants itself per-key roles for the static keys: `description`, `model-hash`, `agent-context`, `hook`, `pool-id`, `fee-min`, `fee-max`, `policy-uri`, `url`, `avatar`.
  - It grants the settler `calibration.brier`, `calibration.hitRate`, `calibration.n`, `calibration.epoch`, and the detail keys `calibration.brierRaw`, `calibration.skill` and `calibration.baseRate` (added 2026-09-26; the settler falls back to the four base keys if a resolver from an older setup rejects them).
  - Result: the owner cannot write `calibration.*` (it reverts with `EACUnauthorizedAccountRoles`, `0x4b27a133`) unless it visibly grants itself the key first. That grant is auditable through the `ResourceArgument` and `EACRolesChanged` events.
  - The settler cannot write any key other than those seven.
- A new key, for example ENSIP-25 `agent-registration[<registry>][<agentId>]`, needs the owner to grant it first with `grantSetterRoles(setText(anyName, "<key>", ""), owner)`.

Record value formats. All text values are decimal ASCII unless noted.

| key | example | meaning |
|---|---|---|
| `calibration.brier` | `1830` | The value the settler posted to `hook.setCalibration` in bps (0–10000), in the same unit as the hook's `brierDemoteBps`. It is the raw Brier by default (`CALIB_GATE=raw`), or `2500·Brier/Brier(base rate)` with `CALIB_GATE=skill`. |
| `calibration.brierRaw` | `1830` | Absolute Brier score in bps. |
| `calibration.skill` | `2400` | Brier skill vs the in-window (Laplace-smoothed) base-rate predictor, signed bps: 10000 is perfect, 0 is no better than the base rate, negative is worse. |
| `calibration.baseRate` | `3750` | Share of informed labels in the window, in bps. |
| `calibration.hitRate` | `6120` | Hit rate in bps. |
| `calibration.n` | `412` | Number of scored attestations. |
| `calibration.epoch` | `7` | Settler epoch counter or block. The settler chooses; it must increase monotonically. |
| `model-hash` | `0x5a36…` | 0x-hex bytes32. Default is `keccak256("typesafe-ai/jev")`. Services should overwrite it with the hash of the real model and prompt config (the owner can do this). |
| `agent-context` | free text | ENSIP-26 agent context. |
| `hook`, `pool-id` | 0x-hex | Empty until known. Rerun the setup with `ENS_HOOK` and `ENS_POOL_ID` set, or have the owner `setText` them. |
| `fee-min`, `fee-max` | `3000`, `10000` | pips |
| `policy-uri` | `urn:oniblock:fee-law:v1` | Placeholder. Set `ENS_POLICY_URI` to the published policy or README URL. |

## 5. Running the setup

Fork (local, no real funds):
```bash
anvil --fork-url $SEPOLIA_RPC_HTTPS --port 8546 --retries 10 --timeout 60000
# anvil default accounts have EIP-7702 delegations on Sepolia (sweeper code). Clear the owner's code, see Gotchas.
cast rpc anvil_setCode 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 0x --rpc-url http://127.0.0.1:8546
cd contracts
set -a; source ../.env; set +a
export ENS_QUOTER=0x7099…79C8 ENS_SETTLER=0x3C44…93BC ENS_OUT=$PWD/../deployments/11155111.anvil-fork.ens.json
ENS_PHASE=commit forge script script/EnsSetup.s.sol --rpc-url http://127.0.0.1:8546 --private-key <anvil pk0> --broadcast
cast rpc evm_increaseTime 61 --rpc-url http://127.0.0.1:8546 && cast rpc anvil_mine --rpc-url http://127.0.0.1:8546
ENS_PHASE=finish forge script script/EnsSetup.s.sol --rpc-url http://127.0.0.1:8546 --private-key <anvil pk0> --broadcast --slow
```

End-to-end on a fork, with the hook, keeper, settler and app included: `DEMO_DURATION=200 ./scripts/demo-fork.sh`. It forks at a pinned block (Sepolia head − 3 unless `FORK_BLOCK` is set) and clears the 7702 code on anvil accounts 0–7. It then runs EnsSetup commit → `evm_increaseTime 61` → finish, and DeploySepolia on the real v4 PoolManager with `ROLE_ORACLE` set to the EnsV2RoleOracle. Services and app run with `CHAIN=fork`. Headless, the script checks the `calibration.*` records through the UR, `/api/models` and `/api/receipt`. It then presses Revoke quoter (ENS `revokeRoles`), which makes the pool stale at `conservativeFee`, and Grant backup (ENS `grantRoles` to anvil #6), after which attestations resume. Evidence: `docs/review/INTEGRATION_1.md`.

Real Sepolia (NOT done yet; needs explicit approval). The same two phases with `--rpc-url $SEPOLIA_RPC_HTTPS --private-key $DEPLOYER_PK`, waiting at least 60 s and less than 24 h between them. Keep `ENS_SECRET`, `ENS_OWNER` and `ENS_DURATION` identical across both phases, because they are part of the commitment.
- Output goes to `deployments/11155111.ens.json`.
- The finish phase sends about 40 transactions.
- `DEPLOYER_ADDR` has no code, so it is fine as owner.
- Env knobs: `ENS_NAME` (use `oni-block.eth` as the fallback), `ENS_OWNER`, `ENS_QUOTER`, `ENS_SETTLER`, `ENS_HOOK`, `ENS_POOL_ID`, `ENS_SALT` (bump it if proxies with the same salt already exist), `ENS_FEE_MIN`, `ENS_FEE_MAX`, `ENS_POLICY_URI`, `ENS_MODEL_HASH_JEV`, `ENS_MODEL_HASH_HEURISTIC`.
- Wire the hook with `hook.setRoleOracle(<roleOracle from json>)`.

Tests:
```bash
cd contracts && FORK=1 SEPOLIA_RPC_HTTPS=$SEPOLIA_RPC_HTTPS forge test --match-path test/fork/EnsSetup.t.sol -vv
# or FORK_URL=http://127.0.0.1:8546, with FORK_BLOCK optional. Without FORK=1 the suite is skipped.
```

## 6. Calls for services (viem)

`deployments/<chainId>.ens.json` provides `registry`, `resolver`, `roleOracle`, `universalResolver`, `roleQuoter`, `roleSettler`, `quoterLabelId`, `settlerLabelId` and `namehashes`.

```ts
import { parseAbi, namehash, toHex, keccak256, stringToBytes, concat, encodeFunctionData, decodeFunctionResult } from 'viem'

// DNS wire-format name (same as EnsV2Lib.dnsEncode): "a.b.eth" -> 0x01 61 01 62 03 657468 00
const dns = (name: string) =>
  concat([...name.split('.').map((l) => { const b = stringToBytes(l); return concat([toHex(b.length, { size: 1 }), toHex(b)]) }), '0x00'])

export const urAbi = parseAbi([
  'function resolve(bytes name, bytes data) view returns (bytes, address)',
  'function findResolver(bytes name) view returns (address resolver, bytes32 node, uint256 offset)',
])
export const profileAbi = parseAbi([
  'function text(bytes32 node, string key) view returns (string)',
  'function addr(bytes32 node) view returns (address)',
])
export const resolverAbi = parseAbi([
  'function setText(bytes name, string key, string value)',
  'function setAddress(bytes name, uint256 coinType, bytes addressBytes)',
  'function multicall(bytes[] calls) returns (bytes[])',
  'function grantSetterRoles(bytes setter, address account) returns (bool)',
  'function revokeRoles(uint256 resource, uint256 roleBitmap, address account) returns (bool)',
  'function hasRoles(uint256 resource, uint256 roleBitmap, address account) view returns (bool)',
  'function resolve(bytes name, bytes data) view returns (bytes)',
  'error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)',
])
export const registryAbi = parseAbi([
  'function grantRoles(uint256 anyId, uint256 roleBitmap, address account) returns (bool)',
  'function revokeRoles(uint256 anyId, uint256 roleBitmap, address account) returns (bool)',
  'function hasRoles(uint256 anyId, uint256 roleBitmap, address account) view returns (bool)',
  'function roles(uint256 anyId, address account) view returns (uint256)',
  'function getResource(uint256 anyId) view returns (uint256)',
])
export const roleOracleAbi = parseAbi([
  'function isQuoter(address) view returns (bool)',
  'function isSettler(address) view returns (bool)',
])
const labelId = (label: string) => BigInt(keccak256(stringToBytes(label)))
```

**Read calibration** (explorer, settler, app). Either:
- viem's built-in `client.getEnsText({ name: 'jev-v1.models.oniblock.eth', key: 'calibration.brier', universalResolverAddress: ens.universalResolver })`, or
- the explicit form:
```ts
const name = 'jev-v1.models.oniblock.eth'
const data = encodeFunctionData({ abi: profileAbi, functionName: 'text', args: [namehash(name), 'calibration.brier'] })
const [out] = await client.readContract({ address: ens.universalResolver, abi: urAbi, functionName: 'resolve', args: [dns(name), data] })
const brier = decodeFunctionResult({ abi: profileAbi, functionName: 'text', data: out }) // "1830"
```
For several keys, wrap the `text` calls in `multicall(bytes[])` and pass that as `data`. The resolver answers with `abi.encode(bytes[])`. A PermissionedResolver has **no** direct `text()` getter; reads always go through `resolve(name, data)`, either on the UR or on the resolver itself.

**Write calibration** (settler key, one transaction):
```ts
const model = dns('jev-v1.models.oniblock.eth')
const calls = [
  ['calibration.brier', String(brierBps)], ['calibration.hitRate', String(hitRateBps)],
  ['calibration.n', String(count)], ['calibration.epoch', String(epoch)],
].map(([k, v]) => encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [model, k, v] }))
await settlerWallet.writeContract({ address: ens.resolver, abi: resolverAbi, functionName: 'multicall', args: [calls] })
```
`multicall` delegatecalls itself, so `msg.sender` is preserved. It reverts with `EACUnauthorizedAccountRoles` (`0x4b27a133`) if the caller lacks the per-key role.

**Revoke or grant the quoter** (owner key; this is the demo kill switch):
```ts
await ownerWallet.writeContract({ address: ens.registry, abi: registryAbi, functionName: 'revokeRoles',
  args: [BigInt(ens.quoterLabelId), BigInt(ens.roleQuoter), keeper] })
await ownerWallet.writeContract({ address: ens.registry, abi: registryAbi, functionName: 'grantRoles',
  args: [BigInt(ens.quoterLabelId), BigInt(ens.roleQuoter), backupKeeper] })
// check (same result the hook sees):
await client.readContract({ address: ens.roleOracle, abi: roleOracleAbi, functionName: 'isQuoter', args: [keeper] })
```
The settler role works the same way with `settlerLabelId` and `roleSettler`. Resolver per-key rights are handled separately:
- revoke: `resolver.revokeRoles(BigInt(keccak256(stringToBytes('calibration.brier'))), 16n /*1<<4*/, settler)`
- grant: `resolver.grantSetterRoles(encodeFunctionData({abi: resolverAbi, functionName: 'setText', args: ['0x00', 'calibration.brier', '']}), newSettler)`

To rotate the settler, revoke and grant both the registry role and the 4 key roles.

**Resolve an address:** `getEnsAddress({ name: 'quoter.oniblock.eth', universalResolverAddress })`, or UR `resolve(dns(name), addr(namehash(name)))`.

Equivalent cast commands (these were run on the fork):
```bash
cast call $ORACLE "isQuoter(address)(bool)" $Q
cast send $REG "revokeRoles(uint256,uint256,address)" $QUOTER_LABEL_ID $ROLE_QUOTER $Q --private-key $OWNER_PK
cast send $RES "multicall(bytes[])" "[$(cast calldata 'setText(bytes,string,string)' $DNS calibration.brier 1830),...]" --private-key $SETTLER_PK
cast call $UR "resolve(bytes,bytes)(bytes,address)" $DNS $(cast calldata "text(bytes32,string)" $(cast namehash jev-v1.models.oniblock.eth) calibration.brier)
```

## 7. Gotchas

1. **EIP-7702 on Sepolia:** every Anvil default account (`0xf39F…`, `0x7099…`, `0x3C44…` and so on) and even `makeAddr("owner")` has sweeper delegation code (`0xef0100…`) on Sepolia.
   - Names are ERC1155 tokens minted with an acceptance check, so a delegated owner makes `register` revert.
   - On a fork, run `anvil_setCode <addr> 0x` first, or use a fresh key.
   - On real Sepolia, the owner must be a plain EOA (for example `DEPLOYER_ADDR`) or an ERC1155Receiver such as a Safe.
   - Keeper and settler senders are unaffected.
2. **Commit-reveal cannot happen inside one broadcast.** `forge script` simulates the whole script first, so the script has an explicit `commit` phase and a `finish` phase. The commitment uses `subregistry = 0` and `resolver = 0`; the finish phase sets both with `ETHRegistry.setSubregistry` and `setResolver`, since the owner token has `ROLE_SET_SUBREGISTRY` and `ROLE_SET_RESOLVER`. This way no proxy address has to be predicted.
3. **Token ids are not stable.** Every grant or revoke re-mints the name token. Use labelhashes (`anyId`) everywhere.
4. **Parent expiry.** `oniblock.eth` expires after `ENS_DURATION` (1 year) plus 28 days of grace. Renew with `ETHRegistrar.renew`.
   - If it lapses, UR resolution stops, because the ETH registry no longer returns our subregistry.
   - The role oracle keeps working, because it queries R0 directly. Repoint or revoke it if that matters.
5. **Max 15 assignees per role per resource** (EAC nybble counters). This is plenty for quoter, backup and settler.
6. **The per-key resolver resource ignores the name.** A settler with `calibration.brier` can write it for every model name on RES. That is intended: one settler scores all models.
7. **ROOT fallback:** `hasRoles(resource, …)` also passes if the account holds the bit on ROOT (resource 0). The owner holds only admin bits for `ROLE_QUOTER` and `ROLE_SETTLER`, and admin bits do not satisfy `hasRoles(…, ROLE_QUOTER, …)`.
8. **The ensjs PR #380 API moved registry-walking views** (`findParentRegistry`, `getNameRegistries`) from the UR to UniversalHelper `0x33f5…`. The UR keeps `resolve` and `findResolver`. `ETHRegistrar.isAvailable(label)` is the simplest availability check.
9. `EnsSetup` uses VerifiableFactory salts `keccak256(abi.encode(label, "resolver"|"registry", idx, ENS_SALT))`, which the factory combines with `msg.sender`. Rerunning with the same sender and salt reverts, so bump `ENS_SALT`.
