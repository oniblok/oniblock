#!/usr/bin/env bash
# One-shot Sepolia deploy: ENSv2 (commit -> wait 61 s -> finish), hook + pools, pool records, wiring checks.
# Writes deployments/11155111.ens.json and deployments/11155111.json (what CHAIN=sepolia services/app read).
#
#   scripts/deploy-sepolia.sh                 real broadcast to Sepolia (needs funded DEPLOYER)
#   REHEARSE=1 scripts/deploy-sepolia.sh      same steps on a local anvil fork of Sepolia with the real keys
#                                             (balances faked; outputs go to deployments/11155111.rehearsal*.json)
#
# Keys come from the root .env: DEPLOYER_PK, QUOTER_PK/ADDR, SETTLER_PK/ADDR, ATTESTOR_ADDR, BACKUP_QUOTER_ADDR.
# Values are never printed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a; source "$ROOT/.env"; set +a
unset CHAIN # foundry reads $CHAIN as --chain
REHEARSE="${REHEARSE:-0}"
STATE_VIEW="${STATE_VIEW:-0xE1Dd9c3fA50EDB962E442f60DfBc432e24537E4C}"
LOGS="$ROOT/.runtime/logs/sepolia"; mkdir -p "$LOGS"
: "${QUOTER_ADDR:?} ${SETTLER_ADDR:?} ${ATTESTOR_ADDR:?} ${DEPLOYER_ADDR:?}"

if [ "$REHEARSE" = "1" ]; then
  PORT="${FORK_PORT:-8547}"; RPC="http://127.0.0.1:$PORT"
  ENS_OUT="$ROOT/deployments/11155111.rehearsal.ens.json"; DEP_OUT="$ROOT/deployments/11155111.rehearsal.json"
  anvil --fork-url "$SEPOLIA_RPC_HTTPS" --port "$PORT" --chain-id 11155111 --no-storage-caching --prune-history 64 \
    --retries 10 --timeout 60000 >"$LOGS/anvil-rehearsal.log" 2>&1 &
  ANVIL_PID=$!; trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT
  for _ in $(seq 60); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 1; done
  for a in "$DEPLOYER_ADDR" "$QUOTER_ADDR" "$SETTLER_ADDR"; do
    cast rpc --rpc-url "$RPC" anvil_setBalance "$a" 0x8AC7230489E80000 >/dev/null # 10 ETH
  done
  wait61() { cast rpc --rpc-url "$RPC" evm_increaseTime 61 >/dev/null; cast rpc --rpc-url "$RPC" anvil_mine 1 >/dev/null; }
  # A fresh fork knows nothing from an earlier rehearsal (a stale file would point the hook at a role oracle that only
  # existed on the previous fork). If the REAL Sepolia ENS setup exists, the fork has it too: rehearse the upgrade path
  # on it (grant-jit + hook deploy); otherwise redo ENS from scratch on the fork.
  rm -f "$ENS_OUT" "$ROOT/.runtime/ens-secret.rehearsal"
  [ -s "$ROOT/deployments/11155111.ens.json" ] && cp "$ROOT/deployments/11155111.ens.json" "$ENS_OUT"
  VERIFY=()
else
  RPC="$SEPOLIA_RPC_HTTPS"
  ENS_OUT="$ROOT/deployments/11155111.ens.json"; DEP_OUT="$ROOT/deployments/11155111.json"
  wait61() { echo "[sepolia] waiting 75 s for the ENS commitment to mature..."; sleep 75; }
  VERIFY=(); [ "${VERIFY_CONTRACTS:-0}" = 1 ] && VERIFY=(--verify)
  BAL=$(cast balance "$DEPLOYER_ADDR" --rpc-url "$RPC")
  [ "$BAL" -ge 25000000000000000 ] || { echo "deployer $DEPLOYER_ADDR has $(cast from-wei "$BAL") ETH; fund >= 0.05 (0.15 recommended)"; exit 1; }
fi
echo "[sepolia] rpc $([ "$REHEARSE" = 1 ] && echo "fork $RPC" || echo sepolia), deployer $DEPLOYER_ADDR, quoter $QUOTER_ADDR, settler $SETTLER_ADDR"

# 1-3. ENSv2 ---------------------------------------------------------------------------------------
SECRET_FILE="$ROOT/.runtime/ens-secret"; [ "$REHEARSE" = 1 ] && SECRET_FILE="$SECRET_FILE.rehearsal"
[ -s "$SECRET_FILE" ] || cast keccak "$(openssl rand -hex 32)" >"$SECRET_FILE" # reuse on retry: commit must match finish
ens_phase() {
  ( cd "$ROOT/contracts" && env ENS_PHASE="$1" ENS_OWNER="$DEPLOYER_ADDR" ENS_QUOTER="$QUOTER_ADDR" ENS_SETTLER="$SETTLER_ADDR" \
      ENS_SECRET="$(cat "$SECRET_FILE")" ENS_OUT="$ENS_OUT" \
      forge script script/EnsSetup.s.sol --rpc-url "$RPC" --private-key "$DEPLOYER_PK" --broadcast --slow --non-interactive ) >>"$LOGS/ens.log" 2>&1
}
if [ -s "$ENS_OUT" ] && [ "${FORCE_ENS:-0}" != 1 ]; then
  echo "[sepolia] ENS already set up ($(basename "$ENS_OUT")), skipping (FORCE_ENS=1 to redo)"
else
  echo "[sepolia] ENS commit..."; ens_phase commit || { tail -20 "$LOGS/ens.log"; exit 1; }
  wait61
  echo "[sepolia] ENS finish (register $ENS_NAME, subregistries, roles, resolver, EnsV2RoleOracle)..."
  ens_phase finish || { tail -20 "$LOGS/ens.log"; exit 1; }
fi
# v5: the settler also writes calibration.jit.* records; grant those setter roles on an existing setup (no-op if held).
echo "[sepolia] ENS grant-jit (calibration.jit.* setter roles for the settler)..."
ens_phase grant-jit || { tail -20 "$LOGS/ens.log"; exit 1; }
ROLE_ORACLE=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["roleOracle"])' "$ENS_OUT")
RESOLVER=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["resolver"])' "$ENS_OUT")
echo "[sepolia] roleOracle $ROLE_ORACLE"

# 4. hook + pools ------------------------------------------------------------------------------------
INIT_PRICE_USD_E8="${INIT_PRICE_USD_E8:-$(curl -s -m 5 'https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=ETHUSDT' |
  python3 -c 'import sys,json;j=json.load(sys.stdin);print(int(round((float(j["bidPrice"])+float(j["askPrice"]))/2*1e8)))')}"
[ -s "$DEP_OUT" ] && cp "$DEP_OUT" "${DEP_OUT%.json}.prev.json" && echo "[sepolia] previous deployment kept at $(basename "${DEP_OUT%.json}.prev.json")"
echo "[sepolia] DeploySepolia (init price $INIT_PRICE_USD_E8 e8)..."
( cd "$ROOT/contracts" && env ROLE_ORACLE="$ROLE_ORACLE" STATE_VIEW="$STATE_VIEW" QUOTER="$QUOTER_ADDR" SETTLER="$SETTLER_ADDR" \
    ATTESTOR="$ATTESTOR_ADDR" INIT_PRICE_USD_E8="$INIT_PRICE_USD_E8" DEPLOYMENTS_OUT="$DEP_OUT" LIQUIDITY="${LIQUIDITY:-50000000000000000}" \
    forge script script/DeploySepolia.s.sol --rpc-url "$RPC" --broadcast --slow --non-interactive ${VERIFY[@]+"${VERIFY[@]}"} ) >"$LOGS/deploy.log" 2>&1 \
  || { tail -25 "$LOGS/deploy.log"; exit 1; }
HOOK=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["hook"])' "$DEP_OUT")
POOL_ID=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["pools"]["oniblock"]["poolId"])' "$DEP_OUT")

# 5. pool records ------------------------------------------------------------------------------------
POOL_DNS=$(cd "$ROOT/services" && pnpm -s exec tsx -e "import {dnsEncode} from './src/ens.ts'; console.log(dnsEncode('weth-usdc.pools.$ENS_NAME'))")
cast send --rpc-url "$RPC" --private-key "$DEPLOYER_PK" "$RESOLVER" "multicall(bytes[])" \
  "[$(cast calldata 'setText(bytes,string,string)' "$POOL_DNS" hook "$HOOK"),$(cast calldata 'setText(bytes,string,string)' "$POOL_DNS" pool-id "$POOL_ID")]" \
  >"$LOGS/pool-records.log" 2>&1 || { tail -5 "$LOGS/pool-records.log"; exit 1; }

# 6. wiring checks -----------------------------------------------------------------------------------
Q=$(cast call --rpc-url "$RPC" "$ROLE_ORACLE" 'isQuoter(address)(bool)' "$QUOTER_ADDR")
S=$(cast call --rpc-url "$RPC" "$ROLE_ORACLE" 'isSettler(address)(bool)' "$SETTLER_ADDR")
HR=$(cast call --rpc-url "$RPC" "$HOOK" 'roleOracle()(address)')
echo "[sepolia] hook $HOOK  poolId $POOL_ID"
echo "[sepolia] isQuoter=$Q isSettler=$S hook.roleOracle==roleOracle: $([ "$(echo "$HR" | tr A-F a-f)" = "$(echo "$ROLE_ORACLE" | tr A-F a-f)" ] && echo yes || echo NO)"
[ "$Q" = true ] && [ "$S" = true ] || { echo "[sepolia] WIRING CHECK FAILED"; exit 1; }
echo "[sepolia] done -> $(basename "$ENS_OUT"), $(basename "$DEP_OUT")"
