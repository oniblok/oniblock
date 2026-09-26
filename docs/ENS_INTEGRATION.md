# ENS integration (ENSv2, Sepolia beta)

Status: `oniblock.eth` is registered on ENSv2 Sepolia (`deployments/11155111.ens.json`, owner `DEPLOYER_ADDR`, redeploy of 2026-09-15 contracts); the whole setup is also exercised end to end on an Anvil fork of Sepolia (`scripts/demo-fork.sh`). The pieces added on 2026-09-27 (wildcard live resolver, `add-model`, `set-endpoints`, primary names) are fork-verified (`REHEARSE=1 scripts/deploy-sepolia.sh` ends with "wildcard OK"). `scripts/deploy-sepolia.sh` now broadcasts `add-live` and `set-endpoints` itself, right after the hook deploy, so the next real run of it puts them on Sepolia; the current `deployments/11155111.ens.json` predates that (no `liveResolver` yet). `add-model` and the ENSIP-19 primary names (`pnpm -C services ens:primary`) remain separate, explicit steps that no script runs on its own.

Files:
- `contracts/script/EnsSetup.s.sol`: full setup script (phases `commit`, `finish`, `grant-jit`, `add-live`, `add-model`, `set-endpoints`). Writes `deployments/<chainId>.ens.json`.
- `contracts/src/ens/OniblockLiveResolver.sol`: ENSIP-10 wildcard resolver for `live.<name>.eth` (records computed from hook storage).
- `contracts/src/roles/EnsV2RoleOracle.sol`: the `IRoleOracle` used by the hook.
- `contracts/src/roles/EnsV2Lib.sol`: role constants, `dnsEncode`, `namehash`, `labelId`.
- `contracts/src/interfaces/ens/IEnsV2.sol`: minimal interfaces, copied from the verified deployed source.
- `contracts/test/fork/EnsSetup.t.sol`: fork tests.
- `services/src/ens.ts`: settler-side `calibration.*` writer (PermissionedResolver multicall); `services/src/ens-primary.ts`: ENSIP-19 primary names of the quoter and settler keys.
- `app/src/lib/server/chain.ts` (`ensTexts`, `ensAddr`, `ensReverse`), `app/src/lib/server/ens.ts` + `/api/ens` (the namespace card on `/classic` and `/models`).
- `deployments/11155111.anvil-fork.ens.json`: example output from a broadcast run against the local fork. The addresses in it exist **only on that fork**.

## 0. ENSv2 feature coverage

"used" = exercised by shipped code on the fork and (where the status line above says so) on Sepolia; "partly" = only a subset of the feature, or designed around rather than exercised; "not used" = nothing in this repo touches it. File references are functions and phases, since line numbers move.

| ENSv2 feature | Status | Where in the code | Notes |
|---|---|---|---|
| Hierarchical registries (a name mounts its own registry for subnames) | used | `EnsSetup.finishPhase` 2b–2d: three `UserRegistry` proxies, R0 for `oniblock.eth` (`ethRegistry.setSubregistry`), R1 mounted at `models`, R2 at `pools` (`register(label, owner, subregistry, …)`, `setParent`) | UniversalResolverV2 walks `eth → oniblock → models → jev-v1`; every leaf is a real token in its own registry |
| Enhanced Access Control (EAC) roles | used | `EnsV2Lib` (`ROLE_QUOTER = 1<<64`, `ROLE_SETTLER = 1<<68`, admin bits `<<128`), `EnsSetup.finishPhase` 2d (`register(…, roleBitmap)`) and 2e (`grantRoles`), `EnsV2RoleOracle.isQuoter/isSettler` = `registry.hasRoles(labelId, role, a)`, app `/api/dev/quoter` (revoke / grant backup) | The hook's kill switch (§3). Custom nybbles the stock registry does not use |
| Permissioned Resolver: per-record permissions | used | `EnsSetup._deployResolver` (owner gets every root role except `ROLE_SET_TEXT`; only its admin bit), `_writeRecords` / `_grantKeys` (`grantSetterRoles` per key: owner → static keys, settler → `calibration.*` and `calibration.jit.*`), `ENS_PHASE=grant-jit`; `services/src/ens.ts` `EnsV2CalibrationWriter` (settler `multicall(setText…)`) | Resource = `keccak256(key)`, name-independent (§4). The owner cannot write a scorecard without a visible self-grant |
| Record linking / aliasing (resolver-level) | partly | `RES_ROLE_LINK` is granted to the owner in `_deployResolver` but never called. The alias we ship is `current.live.<root>`: `OniblockLiveResolver._currentText` answers it from `hook.poolState` (anchor model, else the last accepted one) and reverse-maps the node to a label set with `setKnownLabels` | Computed alias, not a PermissionedResolver link: it follows the hook, no record update needed when the model in force changes |
| Shared registries (one registry mounted under several names) | not used | – | Each of our three registries is mounted under exactly one name |
| Subname tokenization + token-id regeneration | used | `EnsSetup.finishPhase` 2d: every subname is an ERC-1155 token in our `UserRegistry` (`expiry = uint64.max`); `ENS_PHASE=add-model` (`addModelPhase`) registers `ENS_MODEL_LABEL` to `ENS_MODEL_OWNER`, which may be a key other than the team owner; `EnsV2RoleOracle` and the app address names by **labelhash** because the token id changes on every `grantRoles` / `revokeRoles` (§3, Gotcha 3) | Holding a model name's token and scoring it are separate: the author holds the token (without `ROLE_SET_RESOLVER`, see the `add-model` notes below), the settler holds the per-key text roles |
| Custom registry logic | not used | – | We deploy the stock `UserRegistry` implementation through the factory; our custom logic sits in a resolver (`OniblockLiveResolver`), not in a registry |
| VerifiableFactory (deterministic, verifiable proxies) | used | `EnsSetup._deployResolver` / `_deployRegistry`: `factory.deployProxy(impl, salt, initCalldata)` with `salt = keccak256(label, "resolver" \| "registry", idx, ENS_SALT)` | The factory mixes in `msg.sender`; rerunning with the same salt reverts (Gotcha 9) |
| UniversalResolverV2 | used | `app/src/lib/server/chain.ts` `ensTexts` / `ensAddr` (`resolve(bytes,bytes)` with a `multicall` payload), `ensReverse` (`reverse(bytes,uint256)`); `services/src/ens-primary.ts` `chainReader`; the receipt page's quoter check; `scripts/demo-fork.sh` headless checks | The only read path the app and services use; no resolver address is hard-coded in the UI |
| Wildcard resolution (ENSIP-10) | used (new) | `contracts/src/ens/OniblockLiveResolver.sol` `resolve(bytes,bytes)` (IExtendedResolver, ERC-165 `0x9061b923`, ERC-7996 `resolve-multicall` feature) set as the resolver of `live.<root>` by `ENS_PHASE=add-live` (`addLivePhase` / `addLive`; `finishPhase` registers `live` with the shared resolver as a placeholder, or with the live resolver when `ENS_HOOK` matches the deployment json); read by `app/src/lib/server/ens.ts` (`/api/ens`, the "ENS namespace" card) | Nothing under `live` is registered; see the mechanism notes below |
| ETH Registrar: commit-reveal, stablecoin fee, 28-day grace | used | `EnsSetup.commitPhase` (`commit(makeCommitment(label, owner, secret, 0, 0, duration, 0))`) then `finishPhase` 2a (`register(…, MockUSDC, …)` after `mint` + `approve`); `scripts/deploy-sepolia.sh` runs commit → wait ≥ 60 s → finish | Grace and renewal are documented (§1, Gotcha 4) but `ETHRegistrar.renew` is not scripted |
| Immediate expiry (an expired name vanishes at once) | partly | Designed around, not exercised: all subnames are registered with `expiry = type(uint64).max` because expiry drops the EAC roles instantly (§2, Gotcha 4) | No name is ever let expire on purpose |
| Primary names / multichain reverse (ENSIP-19) | used (new) | `services/src/ens-primary.ts` (`setName(string)` on the Sepolia `DefaultReverseRegistrar` from each role's own key; idempotent via `nameForAddr`); `app/src/lib/server/chain.ts` `ensReverse` (`UR.reverse(addr, 60)`), shown on `/classic` (status line, dev panel), `/models` (header) and the namespace card | Fork-verified; §8 has the verified addresses and ABI |
| Migration (ENSv1 → v2) | not used | – | `oniblock.eth` was registered directly on the v2 `ETHRegistrar`; no wrapped or v1 name was migrated |
| DNS names | not used | – | |
| ENSIP-25 `agent-registration[<registry>][<agentId>]` | not used | – | No ERC-8004 registry entry exists for the models; a future owner grant for that key is described in §4 |
| ENSIP-26 `agent-context` / `agent-endpoint[<protocol>]` | used | `agent-context` on every model name: `EnsSetup._writeRecords` (owner key). `agent-endpoint[web]` (`K_AGENT_ENDPOINT`): written by `finishPhase` on new setups, by `ENS_PHASE=set-endpoints` (`setEndpointsPhase`: jev-v1 ← `ENS_ENDPOINT_JEV`, heuristic-v1 ← `ENS_ENDPOINT_HEURISTIC`) on older ones, and by `add-model` for the model it registers; the owner grants itself the key first if missing | Values are free text / URLs as ENSIP-26 defines them; only the `web` protocol is used (no `mcp` / `a2a` endpoint exists) |

### Mechanisms of the pieces added on 2026-09-27

- **Wildcard live resolver (`live.<root>`).** `add-live` deploys `OniblockLiveResolver(owner, hook, poolId, poolKey, modelsNode, poolsNode, "live.<root>", "<pool>")` (reusing the json's `liveResolver` only when it already serves that hook and pool with the same base name `live.<root>`, pool label and owner; anything else gets a fresh deploy), registers the `live` label in R0 with it (or repoints an existing `live`), calls `setKnownLabels(ENS_LIVE_LABELS)` and writes `hook`, `liveResolver`, `liveName`, `liveNode` plus the `live` namehashes to the json (under `--broadcast` only). `finish` omits `liveResolver` while `live` is still on the placeholder resolver, and the app treats a missing or zero `liveResolver` as not deployed. The UR finds no resolver for `jev-v1.live.<root>`, walks up to `live`, and calls `resolve(fullName, data)`: the resolver hashes the label into `namehash(<label>.models.<root>)` and answers `calibration.*`, `allowed`, `demoted`, `jit.demoted`, `status`, `model-node` from `hook.calibration / modelAllowed / isDemoted / isJitDemoted`; `<pool>.live.<root>` answers `k`, `jit-window`, `p-toxic`, `p-jit`, `model`, `stale`, `fee-zero-for-one`, `fee-one-for-zero`, `hook`, `pool-id` from `poolState` / `quoteFee`.
- **`current.live.<root>` alias.** The same resolver maps `current` to the model in force (`poolState` anchor model, or the last accepted one while stale) and serves `model-node`, `label`, `models-name`, `k`, `status`, `jit.status`, `stale`; the label comes from `setKnownLabels` (owner). It is an alias by computation, so it never needs a record write when the keeper switches models.
- **Author-owned model names via `add-model`.** `kev-v1` (like `jev-v1`, `heuristic-v1`, `rule-v1`) is registered by `finish` and is **team-owned** (`ENS_OWNER`); `add-model` does not change that. For a new model, e.g. `ENS_MODEL_LABEL=kev-oniblock ENS_MODEL_OWNER=<author key>`, it registers `kev-oniblock.models.<root>` in R1 as an ERC-1155 token owned by the author, with the shared PermissionedResolver, then writes `model-hash` / `agent-context` / `agent-endpoint[web]` / `description` from `ENS_MODEL_*` and grants the settler the `calibration.*` + `calibration.jit.*` keys. When the name already exists, registration is skipped; if its token belongs to someone other than `ENS_MODEL_OWNER`, the phase logs `add-model: WARNING <label> is already registered to <X>; ENS_MODEL_OWNER <Y> ignored - transfer the token manually` and never transfers it.
  - Who controls what. A holder of `ROLE_SET_RESOLVER` on a name can repoint that name's resolver. The team-owned names are registered with it (`_stdRoles`). A name `add-model` registers to an owner different from `ENS_OWNER` is registered **without** `ROLE_SET_RESOLVER` or its admin bit (`_authorRoles` = `ROLE_SET_SUBREGISTRY` + admin, `ROLE_CAN_TRANSFER_ADMIN`), so the author cannot repoint it away from the shared resolver; the team owner still can through its registry root roles, and re-running `add-model` puts the shared resolver back (fork test `test_addModel_phase`).
  - The scorecard. Resolver text roles are per key, so the settler writes `calibration.*` on the name and the author cannot. The settler's scorecard is authoritative in three places regardless of who holds the token: on the hook (`hook.calibration`, which gates the fee), on the shared resolver (`calibration.*` records) and on `<label>.live.<root>` (computed from hook state).
- **`agent-endpoint[web]` via `set-endpoints`.** The owner grants itself the key once (`grantSetterRoles(setText(any, "agent-endpoint[web]", ""), owner)`, resource = `keccak256(key)`), then `setText` on `jev-v1.models.<root>` (`ENS_ENDPOINT_JEV`, default the Vercel AI Gateway evaluate URL), `heuristic-v1.models.<root>` (`ENS_ENDPOINT_HEURISTIC`, default `in-process`) and `kev-v1.models.<root>` (`ENS_ENDPOINT_KEV`, default empty = skipped, since Kev is served locally by the keeper), rewriting only when the value differs (ENSIP-26). Clients discover the endpoint by name; nothing is hard-coded.
- **Primary names (ENSIP-19).** Each role key calls `DefaultReverseRegistrar.setName("<role>.<root>")` itself (`pnpm -C services ens:primary`), which stores `nameForAddr(key)`. `UniversalResolverV2.reverse(key, 60)` resolves `<key>.addr.reverse` through the v2 root's reverse resolver (an ENSv1 mirror that falls back to the default registrar), then forward-verifies `addr(<role>.<root>, 60) == key` (that record is what `EnsSetup` wrote), so the app shows `quoter.oniblock.eth` next to the key only when both directions agree.

### Commands

```bash
# contracts (owner key; --broadcast only when you mean it — the fork commands in §5 apply)
ENS_PHASE=add-live      forge script script/EnsSetup.s.sol --rpc-url $RPC --private-key $OWNER_PK --broadcast   # OniblockLiveResolver + live.<root>
ENS_MODEL_LABEL=kev-oniblock ENS_MODEL_OWNER=0x… ENS_PHASE=add-model forge script script/EnsSetup.s.sol --rpc-url $RPC --private-key $OWNER_PK --broadcast   # kev-oniblock.models.<root> owned by its author (no ROLE_SET_RESOLVER)
ENS_PHASE=set-endpoints forge script script/EnsSetup.s.sol --rpc-url $RPC --private-key $OWNER_PK --broadcast   # agent-endpoint[web] on jev-v1 / heuristic-v1 (+ kev-v1 if ENS_ENDPOINT_KEV is set)
# the ens json is only written under --broadcast (vm.isContext(ScriptBroadcast | ScriptResume)); a dry run leaves it alone
# services (quoter + settler keys; nothing else is signed)
CHAIN=fork    pnpm -C services ens:primary --dry-run     # prints the two setName calls, sends nothing
CHAIN=fork    pnpm -C services ens:primary               # anvil fork: anvil keys, or USE_ENV_KEYS_ON_DEV=1 for the .env keys
CHAIN=sepolia pnpm -C services ens:primary               # real Sepolia (needs QUOTER_PK / SETTLER_PK funded)
```

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
   │   ├─ jev-v1        model-hash, agent-context, agent-endpoint[web], calibration.* (settler only)
   │   ├─ heuristic-v1  model-hash, agent-context, agent-endpoint[web], calibration.* (settler only)
   │   ├─ kev-v1        team-owned; model-hash (SHA-256 of the Kev-0.8B adapter), description, agent-context,
   │   │                calibration.* (settler only); agent-endpoint[web] only if set-endpoints ran with ENS_ENDPOINT_KEV
   │   └─ rule-v1       model-hash, agent-context (v3 keeper rule; never graded => no calibration.*)
   ├─ pools         subregistry = R2 (UserRegistry proxy)
   │   └─ weth-usdc     hook, pool-id, fee-min, fee-max, policy-uri (addr = hook when set)
   └─ live          no subregistry; resolver = OniblockLiveResolver (ENSIP-10 wildcard; add-live, or finish when ENS_HOOK is set)
       ├─ <any label>   = <label>.models.oniblock.eth as the hook sees it: calibration.*, calibration.jit.*, allowed,
       │                 demoted, jit.demoted, status, jit.status, model-node, models-name (nothing registered)
       ├─ weth-usdc     k, stale, jit-window, p-toxic, p-jit, model, oracle-mid-x96, fee-zero-for-one, ..., config (addr = hook)
       └─ current       alias of the model in force: model-node, label, models-name, k, status, stale
```

- `kev-v1.models.oniblock.eth`: the Kev-0.8B fine-tune (open weights, `ml/models/kev08b-v1/`). Its `model-hash` is the SHA-256 of the adapter, `0x24f0793d55e0fde516ebe4da1d187e0468a5f7c830ba9a9f4d48e43f007c88be`, so anyone can check the weights that set a fee. It has the same records and settler-only `calibration.*` keys as heuristic-v1. DeployBase allowlists it by default; like any allowlisted node it is active from its first attestation, and is demoted to `kDefault` (the base fee) if the settler's Brier for it exceeds `brierDemoteBps`.
- `rule-v1.models.oniblock.eth` (v3 gate only, `KEEPER_GATE=1`; docs/review/V3_THRESHOLD_BUILD.md; the v4 default keeper asks Jev every block and never posts it, and DeployBase allowlists it only when `KEEPER_GATE=1`): when the pool-vs-CEX gap is below the pool's `arbThresholdPips` the hook charges exactly baseFee, so the gated keeper skips Jev and posts the mid with a fixed rule score under this node. The settler skips rule-v1 receipts, so the name never carries `calibration.*` records; its `agent-context` says so. It is registered by `EnsSetup.s.sol` (already-deployed setups can add it with one `models.register` + two `setText` calls; not re-broadcast).
- All registered names use a single resolver: RES, a PermissionedResolver proxy we deployed through VerifiableFactory. `live` is the exception: its resolver is `OniblockLiveResolver` (section 9), and the names under it are never registered.
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

Real Sepolia (done: `oniblock.eth` is registered, see the status line; `scripts/deploy-sepolia.sh` wraps these steps and skips them when `deployments/11155111.ens.json` exists). The same two phases with `--rpc-url $SEPOLIA_RPC_HTTPS --private-key $DEPLOYER_PK`, waiting at least 60 s and less than 24 h between them. Keep `ENS_SECRET`, `ENS_OWNER` and `ENS_DURATION` identical across both phases, because they are part of the commitment.
- Output goes to `deployments/11155111.ens.json`.
- The finish phase sends about 40 transactions.
- `DEPLOYER_ADDR` has no code, so it is fine as owner.
- Env knobs: `ENS_NAME` (use `oni-block.eth` as the fallback), `ENS_OWNER`, `ENS_QUOTER`, `ENS_SETTLER`, `ENS_HOOK`, `ENS_POOL_ID`, `ENS_SALT` (bump it if proxies with the same salt already exist), `ENS_FEE_MIN`, `ENS_FEE_MAX`, `ENS_POLICY_URI`, `ENS_MODEL_HASH_JEV`, `ENS_MODEL_HASH_HEURISTIC`.
- Wire the hook with `hook.setRoleOracle(<roleOracle from json>)`.

Tests:
```bash
cd contracts && FORK=1 SEPOLIA_RPC_HTTPS=$SEPOLIA_RPC_HTTPS forge test --match-path test/fork/EnsSetup.t.sol -vv
# or FORK_URL=http://127.0.0.1:8546, with FORK_BLOCK optional. Without FORK=1 the suite is skipped.
# The suite registers oniblock.eth itself, so now that the real name exists it needs a pre-registration block on an
# archive RPC (the default RPC has no historical state):
#   FORK=1 FORK_BLOCK=11781880 FORK_URL=$SEPOLIA_RPC_ALCHEMY forge test --match-path test/fork/EnsSetup.t.sol -vv   # 8 tests
# The wildcard resolver's unit tests run against a real hook without any fork:
#   forge test --match-path test/ens/OniblockLiveResolver.t.sol   # 21 tests
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

To rotate the settler, revoke and grant both the registry role and the 14 key roles (the 7 `calibration.*` keys and the 7 `calibration.jit.*` keys).

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

## 8. Primary names (ENSIP-19), verified facts

What `pnpm -C services ens:primary` relies on, checked on 2026-09-27 against the Etherscan-verified Sepolia sources and on an Anvil fork (nothing broadcast):

| | value | verified where |
|---|---|---|
| Sepolia `DefaultReverseRegistrar` (ensjs `ensDefaultReverseRegistrar`) | `0x4F382928805ba0e23B30cFB75fC9E848e82DFD47` | docs.ens.domains/learn/deployments ("Default Reverse Registrar", Sepolia) and docs.ens.domains/registry/reverse (Sepolia · Default); ensjs PR #387 `packages/ensjs/src/clients/l1.ts`; Etherscan v2 API `getsourcecode`: contract `DefaultReverseRegistrar`, solc 0.8.26 |
| Its HCA adapter (`ensDefaultReverseRegistrarAdapter`, for contracts naming themselves) | `0x4F32A1c62E202922d4d6307126F43218DB9dA6f5` | same PR / deployments page; verified `DefaultReverseRegistrarAdapter` (`setName(address,string)`, `setNameWithHCA`); **not** used by us (our keys are EOAs) |
| ENSv1 L1 `ReverseRegistrar` (`addr.reverse`, legacy) | `0xA0a1AbcDAe1a2a4A2EF8e9113Ff0e02DD81DC0C6` | deployments page; not used |
| ABI we call | `setName(string)` (`0xc47f0027`, writes `nameForAddr(msg.sender)`, emits `NameForAddrChanged(address indexed addr, string name)`), `nameForAddr(address) view returns (string)` (`0x4ec3bd23`); also present: `setNameForAddrWithSignature(address addr, uint256 signatureExpiry, string name, bytes signature)` (ERC-191 message `keccak256(this, selector, addr, expiry, name)`, expiry ≤ 1 h) and controller-only `setNameForAddr(address,string)` | verified source `contracts/reverseRegistrar/DefaultReverseRegistrar.sol` + `StandaloneReverseRegistrar.sol` |
| Read path | `UniversalResolverV2.reverse(bytes lookupAddress, uint256 coinType) view returns (string name, address resolver, address reverseResolver)` with `coinType = 60`; `reverseResolver` on Sepolia is `0xb2BF4a9A86d29661EA93223582b9945943931e42` (verified `ENSV1Resolver`, a mirror of the v1 registry for `*.reverse`) | UR ABI from Etherscan; fork call |
| Forward check | the UR reverts `ReverseAddressMismatch(string,bytes)` (`0xef9c03ce`) unless `addr(name, 60)` equals the address. With `coinType = 0x80000000` (`default.reverse`) the same call reverts for us, because our PermissionedResolver only holds the coin-type-60 address; so both the script and the app read with 60 | fork call |
| Idempotence | the script reads `nameForAddr(key)` first (the registrar is the source of truth for what `setName` wrote) and skips a matching name; the UR view is reported as a check | `services/src/ens-primary.ts` `planPrimaryNames`, unit-tested with a fake reader |

Fork evidence (2026-09-27, anvil `--fork-url $SEPOLIA_RPC_HTTPS --prune-history 64`, `CHAIN=fork USE_ENV_KEYS_ON_DEV=1`): `setName("quoter.oniblock.eth")` from the quoter key, 46 894 gas; `setName("settler.oniblock.eth")` from the settler key, 46 906 gas; afterwards `nameForAddr` and `UR.reverse(key, 60)` both return the names, with our resolver `0x9093…551b` as the forward resolver; a second run skips both. With the anvil keys (default on a fork) the script warns `forward_mismatch`, because `quoter.oniblock.eth` points at the Sepolia quoter, and sends anyway (the reverse record is the key's own; the UR hides it until the forward record agrees).

## 9. `live.<root>` as the app reads it

`/api/ens` (`app/src/lib/server/ens.ts`) resolves, through the UR exactly like `ensTexts` does for the model names, `jev-v1.live.<root>`, `kev-v1.live.<root>`, `heuristic-v1.live.<root>`, `current.live.<root>` and `<pool>.live.<root>`, and shows the raw records on the "ENS namespace" card (`/classic`, `/models`). A name the UR cannot resolve (no `live` label yet, or `live` still on the placeholder resolver, or local anvil) is shown as "—", never as an error. The card also lists the ENSIP-19 primary names of the quoter and settler next to their addresses (raw address when none is set). `deployments/<chainId>.ens.json` fields it reads: `universalResolver`, `name`, `liveResolver`, `liveNode` (or `namehashes["live.<root>"]`).
