#!/usr/bin/env bash
# Oniblock on an Anvil fork of Sepolia: real ENSv2 + real v4 PoolManager + real Chainlink ETH/USD.
# Nothing is broadcast to Sepolia; every tx goes to the local fork.
#
#   1. anvil --fork-url $SEPOLIA_RPC_HTTPS --fork-block-number <pinned> (automine during setup)
#   2. clear EIP-7702 delegation code on the anvil dev accounts (docs/ENS_INTEGRATION.md, Gotcha 1)
#   3. EnsSetup: commit -> evm_increaseTime 61 + mine -> finish   (oniblock.eth, roles, resolver, EnsV2RoleOracle)
#   4. DeploySepolia on the fork: hook on the REAL v4 PoolManager 0xE03A…3543, role oracle = EnsV2RoleOracle,
#      Chainlink sanity band on; owner writes hook / pool-id text records on weth-usdc.pools.<name>
#   5. interval mining (BLOCK_TIME), keeper + settler (+ arb + retail) + app (CHAIN=fork)
#   6. headless (DEMO_DURATION>0): wait for ENS calibration.* records, check /api/models and /api/receipt via
#      UniversalResolverV2, press "Revoke quoter" (ENS revokeRoles) -> stale -> conservative fee, press
#      "Grant backup" -> attestations resume from the backup key; then the narrative check.
#
# Env knobs:
#   FORK_PORT=8546 APP_PORT=3001 BLOCK_TIME=3 FORK_BLOCK=<default: Sepolia head - 3, pinned for the run>
#   DEMO_DURATION=0 (0 = interactive until Ctrl-C)   FORK_WARMUP_BLOCKS=30 (blocks before the kill-switch test)
#   DEMO_PRICE_SOURCE=live   live Binance mid (default: the hook's Chainlink sanity band is ON, and a replayed
#                            historical price would fall outside it) | replay (sets CHAINLINK_ETH_USD=0 -> band off)
#   SETTLE_EVERY=5 CALIB_WINDOW=8 CALIB_MIN_N=3 RETAIL_LAMBDA=1 MODEL_MODE=auto APP_CMD=<start if built, else dev>
#   SKIP_APP=1 (headless kill switch then uses the same ENS calls with cast)
#   APP_HOST=127.0.0.1 (app bind address; loopback keeps LAN peers off /api/dev/*, 0.0.0.0 exposes them)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="$ROOT/.runtime"
LOGS="$RUNTIME/logs/fork"
FORK_PORT="${FORK_PORT:-8546}"
APP_PORT="${APP_PORT:-3001}"
BLOCK_TIME="${BLOCK_TIME:-3}"
RPC="http://127.0.0.1:${FORK_PORT}"
DEMO_DURATION="${DEMO_DURATION:-0}"
PRICE_SOURCE="${DEMO_PRICE_SOURCE:-live}"
DEP_OUT="$ROOT/deployments/11155111.anvil-fork.json"
ENS_OUT="$ROOT/deployments/11155111.anvil-fork.ens.json"
# anvil default dev keys (PUBLIC; valid only on the fork). 0 owner/deployer, 1 quoter, 2 settler, 3 attestor,
# 4 arb, 5 retail, 6 backup quoter, 7 demo swapper, 8 jit bot (v5, `pnpm -C services jit --chain fork`).
ANVIL0_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
ANVIL_ADDRS=(0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
  0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC 0x90F79bf6EB2c4f870365E785982E1f101E93b906
  0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc
  0x976EA74026E726554dB657fA54763abd0C3a0aa9 0x14dC79964da2C08b23698B3D3cc7Ca32193d9955
  0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f)
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"
# foundry reads $CHAIN as --chain; services/app need CHAIN=fork, so keep it away from cast.
cast() { env -u CHAIN command cast "$@"; }

# Read one key from the root .env without exporting the rest (never echoes values).
env_get() {
  [ -n "${!1:-}" ] && { printf '%s' "${!1}"; return; }
  python3 - "$ROOT/.env" "$1" <<'PY'
import re, sys
for line in open(sys.argv[1]):
    m = re.match(r'\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$', line)
    if m and m.group(1) == sys.argv[2]:
        print(m.group(2).strip('\'"'), end=''); break
PY
}

mkdir -p "$LOGS"
set -m
PIDS=()
trap cleanup INT TERM EXIT
for bin in anvil forge cast pnpm curl python3; do command -v "$bin" >/dev/null || { echo "missing $bin"; exit 1; }; done
check_disk 500
if rpc_up; then echo "[fork] something already serves $RPC — stop it first (or set FORK_PORT)."; exit 1; fi

SEPOLIA_RPC="$(env_get SEPOLIA_RPC_HTTPS)"
[ -n "$SEPOLIA_RPC" ] || { echo "[fork] SEPOLIA_RPC_HTTPS missing in .env"; exit 1; }
ENS_KEYS=(ENS_NAME ENS_ETH_REGISTRAR ENS_VERIFIABLE_FACTORY ENS_USER_REGISTRY_IMPL ENS_PERMISSIONED_RESOLVER_IMPL ENS_MOCK_USDC ENS_UNIVERSAL_RESOLVER)
for k in "${ENS_KEYS[@]}" V4_POOL_MANAGER CHAINLINK_ETH_USD; do export "$k=$(env_get "$k")"; done
ENS_NAME="${ENS_NAME:-oniblock.eth}"
STATE_VIEW="${STATE_VIEW:-0xE1Dd9c3fA50EDB962E442f60DfBc432e24537E4C}" # v4 StateView on Sepolia (poolManager() == 0xE03A…3543)

# Public RPCs rate-limit: retry with backoff.
retry() { # tries, cmd...
  local n="$1" i=1; shift
  until "$@"; do
    [ "$i" -ge "$n" ] && return 1
    echo "[fork] retry $i/$n: $*" | cut -c1-160 >&2; sleep $((i * 3)); i=$((i + 1))
  done
}
sepolia_head() { cast block-number --rpc-url "$SEPOLIA_RPC" 2>/dev/null; }

# 1. anvil fork ------------------------------------------------------------------------------
if [ -z "${FORK_BLOCK:-}" ]; then
  FORK_BLOCK="$(retry 5 sepolia_head)"; FORK_BLOCK=$((FORK_BLOCK - 3))
fi
echo "[fork] forking Sepolia at block $FORK_BLOCK (pinned for this run)"
# --no-storage-caching: don't write the RPC cache to disk; --prune-history: no state files under
# ~/.foundry/anvil/tmp (never cleaned up otherwise); automine until setup is done.
start anvil anvil --fork-url "$SEPOLIA_RPC" --fork-block-number "$FORK_BLOCK" --port "$FORK_PORT" --chain-id 11155111 \
  --retries 10 --timeout 60000 --fork-retry-backoff 1000 --no-storage-caching --prune-history 64
for _ in $(seq 1 150); do rpc_up && break; sleep 0.2; done
rpc_up || { echo "[fork] anvil did not start"; tail -5 "$LOGS/anvil.log"; exit 1; }

# 2. EIP-7702 gotcha: anvil dev accounts carry sweeper delegation code on Sepolia. Clear it on the fork.
for a in "${ANVIL_ADDRS[@]}"; do rpc_call anvil_setCode "[\"$a\",\"0x\"]" >/dev/null; done
echo "[fork] cleared delegation code on ${#ANVIL_ADDRS[@]} dev accounts"

# 3. ENS setup ---------------------------------------------------------------------------------
ens_phase() { # phase
  ( cd "$ROOT/contracts" && env ENS_PHASE="$1" ENS_OWNER="${ANVIL_ADDRS[0]}" ENS_QUOTER="${ANVIL_ADDRS[1]}" ENS_SETTLER="${ANVIL_ADDRS[2]}" \
      ENS_OUT="$ENS_OUT" forge script script/EnsSetup.s.sol --rpc-url "$RPC" --private-key "$ANVIL0_PK" --broadcast --slow --non-interactive ) \
    >>"$LOGS/ens-setup.log" 2>&1
}
: >"$LOGS/ens-setup.log"
echo "[fork] EnsSetup commit..."
retry 3 ens_phase commit || { echo "[fork] ENS commit failed — see $LOGS/ens-setup.log"; tail -20 "$LOGS/ens-setup.log"; exit 1; }
rpc_call evm_increaseTime '[61]' >/dev/null; rpc_call anvil_mine '["0x1"]' >/dev/null
echo "[fork] EnsSetup finish (register, subregistries, roles, resolver records, EnsV2RoleOracle)..."
retry 3 ens_phase finish || { echo "[fork] ENS finish failed — see $LOGS/ens-setup.log"; tail -20 "$LOGS/ens-setup.log"; exit 1; }
ROLE_ORACLE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["roleOracle"])' "$ENS_OUT")"
echo "[fork] ENS ready: $ENS_NAME, roleOracle $ROLE_ORACLE -> $(basename "$ENS_OUT")"

# 4. hook on the real v4 PoolManager -------------------------------------------------------------
if [ "$PRICE_SOURCE" = "replay" ]; then
  eval "$(cd "$ROOT/services" && PRICE_SOURCE=replay pnpm -s exec tsx src/pricesource.ts --resolve 2>"$LOGS/pricesource.log")"
  export REPLAY_START_MS; INIT_PRICE_USD_E8="${INIT_PRICE_USD_E8:-$REPLAY_FIRST_MID_E8}"
  CHAINLINK_ETH_USD=0x0000000000000000000000000000000000000000 # historical prices vs today's Chainlink: band off
else
  INIT_PRICE_USD_E8="${INIT_PRICE_USD_E8:-$(curl -s -m 5 'https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=ETHUSDT' |
    python3 -c 'import sys,json; j=json.load(sys.stdin); print(int(round((float(j["bidPrice"])+float(j["askPrice"]))/2*1e8)))')}"
fi
export PRICE_SOURCE
echo "[fork] DeploySepolia on the fork (PoolManager $V4_POOL_MANAGER, INIT_PRICE_USD_E8=$INIT_PRICE_USD_E8, price source $PRICE_SOURCE)..."
PRE_DEPLOY_BLOCK="$(block_number)"
deploy_hook() {
  ( cd "$ROOT/contracts" && env DEPLOYER_PK="$ANVIL0_PK" ROLE_ORACLE="$ROLE_ORACLE" V4_POOL_MANAGER="$V4_POOL_MANAGER" \
      CHAINLINK_ETH_USD="$CHAINLINK_ETH_USD" STATE_VIEW="$STATE_VIEW" QUOTER="${ANVIL_ADDRS[1]}" SETTLER="${ANVIL_ADDRS[2]}" \
      ATTESTOR="${ANVIL_ADDRS[3]}" LIQUIDITY="${LIQUIDITY:-50000000000000000}" \
      INIT_PRICE_USD_E8="$INIT_PRICE_USD_E8" DEPLOYMENTS_OUT="$DEP_OUT" \
      forge script script/DeploySepolia.s.sol --rpc-url "$RPC" --broadcast --slow --non-interactive ) >"$LOGS/deploy.log" 2>&1
}
retry 2 deploy_hook || { echo "[fork] deploy failed — see $LOGS/deploy.log"; tail -20 "$LOGS/deploy.log"; exit 1; }
echo "[fork] deployed -> $(basename "$DEP_OUT") ($(patch_deploy_block "$DEP_OUT" \
  "$ROOT/contracts/broadcast/DeploySepolia.s.sol/11155111/run-latest.json" "$((PRE_DEPLOY_BLOCK + 1))"))"
HOOK="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["hook"])' "$DEP_OUT")"
POOL_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pools"]["oniblock"]["poolId"])' "$DEP_OUT")"
RESOLVER="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["resolver"])' "$ENS_OUT")"
POOL_NAME="weth-usdc.pools.${ENS_NAME}"
POOL_DNS="$(cd "$ROOT/services" && pnpm -s exec tsx -e "import {dnsEncode} from './src/ens.ts'; console.log(dnsEncode('$POOL_NAME'))")"
cast send --rpc-url "$RPC" --private-key "$ANVIL0_PK" "$RESOLVER" "multicall(bytes[])" \
  "[$(cast calldata 'setText(bytes,string,string)' "$POOL_DNS" hook "$HOOK"),$(cast calldata 'setText(bytes,string,string)' "$POOL_DNS" pool-id "$POOL_ID")]" \
  >"$LOGS/ens-pool-records.log" 2>&1 && echo "[fork] ENS $POOL_NAME: hook=$HOOK pool-id=$POOL_ID"
# Wire-level check of the hook's view of ENS roles.
echo "[fork] roleOracle.isQuoter(quoter)=$(cast call --rpc-url "$RPC" "$ROLE_ORACLE" 'isQuoter(address)(bool)' "${ANVIL_ADDRS[1]}")" \
  "isSettler(settler)=$(cast call --rpc-url "$RPC" "$ROLE_ORACLE" 'isSettler(address)(bool)' "${ANVIL_ADDRS[2]}")" \
  "hook.roleOracle=$(cast call --rpc-url "$RPC" "$HOOK" 'roleOracle()(address)')"

# 5. run -------------------------------------------------------------------------------------
rpc_call evm_setIntervalMining "[$BLOCK_TIME]" >/dev/null
export REPLAY_ORIGIN_BLOCK="$(block_number)"
RUNTIME_FLAGS="$RUNTIME/keeper-flags.fork.json"
printf '{\n  "degraded": false,\n  "useBackupQuoter": false\n}\n' >"$RUNTIME_FLAGS"
export CHAIN=fork FORK_RPC="$RPC" DEPLOYMENTS_FILE="$DEP_OUT" ENS_DEPLOYMENT_FILE="$ENS_OUT" KEEPER_FLAGS_FILE="$RUNTIME_FLAGS"
export MODEL_MODE="${MODEL_MODE:-auto}" SETTLE_EVERY="${SETTLE_EVERY:-5}" CALIB_WINDOW="${CALIB_WINDOW:-8}" CALIB_MIN_N="${CALIB_MIN_N:-3}"
export RETAIL_LAMBDA="${RETAIL_LAMBDA:-1}"
start keeper  pnpm -C services keeper
start settler pnpm -C services settler
start arb     pnpm -C services arb --all
start retail  pnpm -C services retail --all
if [ "${SKIP_APP:-0}" != "1" ]; then
  APP_CMD="${APP_CMD:-$([ -f "$ROOT/app/.next/BUILD_ID" ] && echo start || echo dev)}"
  export APP_PORT; start app pnpm -C app "$APP_CMD"
  echo "[fork] app: http://localhost:${APP_PORT}  (CHAIN=fork, ENS via UniversalResolverV2 $ENS_UNIVERSAL_RESOLVER)"
fi
echo "[fork] running from block $REPLAY_ORIGIN_BLOCK. Ctrl-C to stop."
[ "$DEMO_DURATION" = "0" ] && { wait; exit 0; }

# 6. headless checks -------------------------------------------------------------------------------
T0=$SECONDS
START_BLOCK="$REPLAY_ORIGIN_BLOCK"
UR="$ENS_UNIVERSAL_RESOLVER"
MODEL_NAME="jev-v1.models.${ENS_NAME}"
ens_text() { # name key  (UniversalResolverV2.resolve(dns(name), text(node,key)))
  local dns node out
  dns="$(cd "$ROOT/services" && pnpm -s exec tsx -e "import {dnsEncode} from './src/ens.ts'; console.log(dnsEncode('$1'))")"
  node="$(cast namehash "$1")"
  out="$(cast call --rpc-url "$RPC" "$UR" 'resolve(bytes,bytes)(bytes,address)' "$dns" "$(cast calldata 'text(bytes32,string)' "$node" "$2")" | head -1)"
  cast abi-decode 'text(bytes32,string)(string)' "$out" 2>/dev/null | tr -d '"' || echo "?"
}
quote_fee() { cast call --rpc-url "$RPC" "$HOOK" \
  'quoteFee((address,address,uint24,int24,address),bool)(uint24,bool,uint32,bool)' \
  "$(python3 -c 'import json,sys; k=json.load(open(sys.argv[1]))["pools"]["oniblock"]["key"]; print("(%s,%s,%d,%d,%s)"%(k["currency0"],k["currency1"],k["fee"],k["tickSpacing"],k["hooks"]))' "$DEP_OUT")" true | tr '\n' ' '; }
wait_blocks() { local target=$(( $(block_number) + $1 )); while [ "$(block_number)" -lt "$target" ]; do sleep 1; done; }

WARM="${FORK_WARMUP_BLOCKS:-30}"
echo "[fork] warm-up: $WARM blocks of keeper + settler..."
wait_blocks "$WARM"
for i in $(seq 1 20); do
  n="$(ens_text "$MODEL_NAME" calibration.n)"; [ -n "$n" ] && [ "$n" != "?" ] && break; wait_blocks 3
done
echo "[fork] ENS $MODEL_NAME via UR: calibration.brier=$(ens_text "$MODEL_NAME" calibration.brier) hitRate=$(ens_text "$MODEL_NAME" calibration.hitRate) n=$(ens_text "$MODEL_NAME" calibration.n) epoch=$(ens_text "$MODEL_NAME" calibration.epoch)"
echo "[fork] quoteFee(zeroForOne) before revoke: $(quote_fee)"
if [ "${SKIP_APP:-0}" != "1" ] && wait_app 120; then
  app_get /api/models >"$LOGS/api-models.json"
  RTX="$(python3 - "$LOGS/keeper.log" <<'PY'
import json, sys
tx = ''
for l in open(sys.argv[1]):
    try: j = json.loads(l)
    except Exception: continue
    if j.get('e') == 'attested' and j.get('tx'): tx = j['tx']
print(tx)
PY
)"
  RRX="$(python3 - "$LOGS/retail.log" <<'PY'
import json, sys
tx = ''
for l in open(sys.argv[1]):
    try: j = json.loads(l)
    except Exception: continue
    if j.get('e') == 'swap' and j.get('pool') == 'oniblock' and j.get('tx'): tx = j['tx']
print(tx)
PY
)"
  [ -n "$RRX" ] && app_get "/api/receipt/$RRX" >"$LOGS/api-receipt.json"
  [ -n "$RTX" ] && app_get "/api/receipt/$RTX" >"$LOGS/api-receipt-attestation.json"
  python3 - "$LOGS" <<'PY'
import json, os, sys
d = sys.argv[1]
def load(n):
    try: return json.load(open(os.path.join(d, n)))
    except Exception as e: return {'error': str(e)}
m = load('api-models.json'); r = load('api-receipt.json')
print('[fork] /api/models:', json.dumps({'chain': m.get('chain'), 'models': [{k: x.get(k) for k in ('name', 'node', 'brierBps', 'n', 'demoted', 'ens')} for x in (m.get('models') or [])][:2]})[:900])
s = json.dumps(r)
print('[fork] /api/receipt (retail swap): ens names resolved:', {k: (k in s) for k in ('quoter.', 'jev-v1.models.', 'calibration.brier')}, s[:600])
PY
  echo "[fork] Revoke quoter (app POST /api/dev/quoter revoke) -> $(app_post /api/dev/quoter '{"action":"revoke"}' | cut -c1-400)"
else
  REG="$(python3 -c 'import json,sys; j=json.load(open(sys.argv[1])); print(j["registry"], j["quoterLabelId"], j["roleQuoter"])' "$ENS_OUT")"
  set -- $REG
  cast send --rpc-url "$RPC" --private-key "$ANVIL0_PK" "$1" 'revokeRoles(uint256,uint256,address)' "$2" "$3" "${ANVIL_ADDRS[1]}" >/dev/null
  echo "[fork] Revoke quoter (cast ENS revokeRoles)"
fi
echo "[fork] isQuoter(quoter) after revoke: $(cast call --rpc-url "$RPC" "$ROLE_ORACLE" 'isQuoter(address)(bool)' "${ANVIL_ADDRS[1]}")"
STALE_WAIT=$(( $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pools"]["oniblock"]["config"]["staleBlocks"])' "$DEP_OUT") + 3 ))
wait_blocks "$STALE_WAIT"
echo "[fork] quoteFee(zeroForOne) after $STALE_WAIT blocks: $(quote_fee)   (conservativeFee, stale=true expected)"
if [ "${SKIP_APP:-0}" != "1" ]; then
  echo "[fork] Execute swap while stale -> $(app_post /api/dev/swap '{"direction":"arb","size":0.5,"target":"oniblock"}' | cut -c1-300)"
  echo "[fork] Grant backup quoter (app POST /api/dev/quoter grant-backup) -> $(app_post /api/dev/quoter '{"action":"grant-backup"}' | cut -c1-400)"
else
  cast send --rpc-url "$RPC" --private-key "$ANVIL0_PK" "$1" 'grantRoles(uint256,uint256,address)' "$2" "$3" "${ANVIL_ADDRS[6]}" >/dev/null
  printf '{\n  "degraded": false,\n  "useBackupQuoter": true\n}\n' >"$RUNTIME_FLAGS"
  echo "[fork] Grant backup quoter (cast ENS grantRoles + keeper flag)"
fi
wait_blocks 4
echo "[fork] quoteFee(zeroForOne) after grant: $(quote_fee)   (stale=false expected)"
while [ $((SECONDS - T0)) -lt "$DEMO_DURATION" ]; do check_disk 500 || break; sleep 3; done
echo "[fork] narrative check:"
set +e
(cd "$ROOT/services" && pnpm -s story --chain fork --from "$START_BLOCK" --expect stale,resumed) | tee "$LOGS/story.log"
rc=${PIPESTATUS[0]}
echo "[fork] ENS after run: calibration.brier=$(ens_text "$MODEL_NAME" calibration.brier) n=$(ens_text "$MODEL_NAME" calibration.n) epoch=$(ens_text "$MODEL_NAME" calibration.epoch)"
exit "$rc"
