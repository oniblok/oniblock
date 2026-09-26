#!/usr/bin/env bash
# One-shot Sepolia deploy: ENSv2 (commit -> wait 61 s -> finish), hook + pools, pool records, the live wildcard
# resolver (add-live) + ENSIP-26 endpoints (set-endpoints), wiring checks, and an ENSIP-10 wildcard check through the
# UniversalResolverV2. On an existing ENS setup it also registers the default model name the setup predates (add-model
# for oniblock1) and prints (never sends) the setModelAllowed txs a hook would still need. Writes
# deployments/11155111.ens.json and deployments/11155111.json (what CHAIN=sepolia services/app read).
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
  # python3 compare: bash integers overflow above ~9.22 ETH (2^63 wei)
  python3 -c 'import sys; sys.exit(0 if int(sys.argv[1]) >= 25000000000000000 else 1)' "$BAL" || { echo "deployer $DEPLOYER_ADDR has $(cast from-wei "$BAL") ETH; fund >= 0.05 (0.15 recommended)"; exit 1; }
fi
echo "[sepolia] rpc $([ "$REHEARSE" = 1 ] && echo "fork $RPC" || echo sepolia), deployer $DEPLOYER_ADDR, quoter $QUOTER_ADDR, settler $SETTLER_ADDR"

# 1-3. ENSv2 ---------------------------------------------------------------------------------------
SECRET_FILE="$ROOT/.runtime/ens-secret"; [ "$REHEARSE" = 1 ] && SECRET_FILE="$SECRET_FILE.rehearsal"
[ -s "$SECRET_FILE" ] || cast keccak "$(openssl rand -hex 32)" >"$SECRET_FILE" # reuse on retry: commit must match finish
# ens_phase / dns_encode / ur_text / lower and the default model records (ONI_*): scripts/sepolia-ens.sh
source "$ROOT/scripts/sepolia-ens.sh"
if [ -s "$ENS_OUT" ] && [ "${FORCE_ENS:-0}" != 1 ]; then
  echo "[sepolia] ENS already set up ($(basename "$ENS_OUT")), skipping (FORCE_ENS=1 to redo)"
else
  echo "[sepolia] ENS commit..."; ens_phase commit || { tail -20 "$LOGS/ens.log"; exit 1; }
  wait61
  echo "[sepolia] ENS finish (register $ENS_NAME, subregistries, roles, resolver, EnsV2RoleOracle)..."
  ens_phase finish || { tail -20 "$LOGS/ens.log"; exit 1; }
fi
# the settler also writes calibration.jit.* (v5) and calibration.chargeThreshold records; grant every settler key on an
# existing setup (no-op for keys already held).
echo "[sepolia] ENS grant-jit (calibration.* + calibration.jit.* setter roles for the settler)..."
ens_phase grant-jit || { tail -20 "$LOGS/ens.log"; exit 1; }

# 3b. default model names an existing setup predates (idempotent) -----------------------------------
# A setup registered before oniblock1 existed skips `finish` above, so it is added here with add-model and
# the same records `finish` writes (EnsSetup._writeRecords; keep these strings in sync). The ens json cannot tell
# whether a name exists (its namehashes list always includes the default names), so the check is on chain: a name is
# up to date when the UR resolves its model-hash to the expected value. add-model is idempotent itself (registration
# skipped when the name exists, records rewritten only when they differ, grants only when missing).
add_model() { # label hash description context
  local name="$1.models.$ENS_NAME"
  if model_hash_ok "$1" "$2"; then
    echo "[sepolia] ENS $name up to date (model-hash $2)"; return 0
  fi
  echo "[sepolia] ENS add-model $1 (model-hash $2)..."
  ens_phase add-model ENS_MODEL_LABEL="$1" ENS_MODEL_OWNER="$DEPLOYER_ADDR" ENS_MODEL_HASH="$2" \
    ENS_MODEL_DESCRIPTION="$3" ENS_MODEL_CONTEXT="$4" || { tail -20 "$LOGS/ens.log"; exit 1; }
}
add_model oniblock1 "$ONI_HASH" "$ONI_DESC" "$ONI_CTX"

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

# 4b. model allowlist on the hook -------------------------------------------------------------------
# DeployBase allowlists jev-v1 / heuristic-v1 / oniblock1 on a new hook (unless MODEL_NODES overrides it); an
# allowlisted node has fee power from its first attestation.
# Anything still missing is an owner tx on a live hook: printed for the owner to run, never sent from here.
MISSING_ALLOW=0
for m in jev-v1 heuristic-v1 oniblock1; do
  node=$(cast namehash "$m.models.$ENS_NAME")
  if [ "$(cast call --rpc-url "$RPC" "$HOOK" 'modelAllowed(bytes32,bytes32)(bool)' "$POOL_ID" "$node")" != true ]; then
    [ "$MISSING_ALLOW" = 1 ] || echo "[sepolia] hook $HOOK does not allowlist every default model; as the hook owner run:"
    MISSING_ALLOW=1
    echo "  cast send --rpc-url \"\$SEPOLIA_RPC_HTTPS\" --private-key \"\$DEPLOYER_PK\" $HOOK \"setModelAllowed(bytes32,bytes32,bool)\" $POOL_ID $node true  # $m"
  fi
done
[ "$MISSING_ALLOW" = 1 ] || echo "[sepolia] hook allowlists jev-v1, heuristic-v1, oniblock1"

# 5. pool records ------------------------------------------------------------------------------------
POOL_DNS=$(cd "$ROOT/services" && pnpm -s exec tsx -e "import {dnsEncode} from './src/ens.ts'; console.log(dnsEncode('weth-usdc.pools.$ENS_NAME'))")
cast send --rpc-url "$RPC" --private-key "$DEPLOYER_PK" "$RESOLVER" "multicall(bytes[])" \
  "[$(cast calldata 'setText(bytes,string,string)' "$POOL_DNS" hook "$HOOK"),$(cast calldata 'setText(bytes,string,string)' "$POOL_DNS" pool-id "$POOL_ID")]" \
  >"$LOGS/pool-records.log" 2>&1 || { tail -5 "$LOGS/pool-records.log"; exit 1; }

# 5b. live wildcard resolver + ENSIP-26 endpoints (both idempotent) ---------------------------------
# add-live deploys OniblockLiveResolver for this hook/pool (reused on re-runs), registers `live.$ENS_NAME` with it (or
# repoints an existing `live`), sets the known model labels. set-endpoints writes agent-endpoint[web] on jev-v1 and
# heuristic-v1 (and oniblock1 when ENS_ENDPOINT_ONIBLOCK1 is set) if they differ.
echo "[sepolia] ENS add-live (OniblockLiveResolver: *.live.$ENS_NAME wildcard-resolved from the hook)..."
ens_phase add-live || { tail -20 "$LOGS/ens.log"; exit 1; }
echo "[sepolia] ENS set-endpoints (ENSIP-26 agent-endpoint[web] on jev-v1 / heuristic-v1)..."
ens_phase set-endpoints || { tail -20 "$LOGS/ens.log"; exit 1; }
LIVE_RESOLVER=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["liveResolver"])' "$ENS_OUT")
echo "[sepolia] liveResolver $LIVE_RESOLVER"

# 6. wiring checks -----------------------------------------------------------------------------------
Q=$(cast call --rpc-url "$RPC" "$ROLE_ORACLE" 'isQuoter(address)(bool)' "$QUOTER_ADDR")
S=$(cast call --rpc-url "$RPC" "$ROLE_ORACLE" 'isSettler(address)(bool)' "$SETTLER_ADDR")
HR=$(cast call --rpc-url "$RPC" "$HOOK" 'roleOracle()(address)')
echo "[sepolia] hook $HOOK  poolId $POOL_ID"
echo "[sepolia] isQuoter=$Q isSettler=$S hook.roleOracle==roleOracle: $([ "$(echo "$HR" | tr A-F a-f)" = "$(echo "$ROLE_ORACLE" | tr A-F a-f)" ] && echo yes || echo NO)"
[ "$Q" = true ] && [ "$S" = true ] || { echo "[sepolia] WIRING CHECK FAILED"; exit 1; }

# 7. ENSIP-10 wildcard check THROUGH the UniversalResolverV2 -----------------------------------------
# `<label>.live.$ENS_NAME` has no resolver of its own: the UR must walk up to `live`, see IExtendedResolver on
# OniblockLiveResolver and call resolve(fullName, data) there. Plain eth_calls (the resolver is ERC-7996, so the UR
# calls it directly, no CCIP batch gateway); decoded values are printed. Fails loudly if the UR does not wildcard.
# (dns_encode / ur_text / lower: scripts/sepolia-ens.sh)
WILDCARD_OK=1
for spec in "jev-v1.live.$ENS_NAME status" "weth-usdc.live.$ENS_NAME k" "weth-usdc.live.$ENS_NAME fee-zero-for-one" \
            "current.live.$ENS_NAME model-node" "live.$ENS_NAME pool"; do
  set -- $spec
  if res=$(ur_text "$1" "$2"); then
    val=${res%%$'\t'*}; via=${res##*$'\t'}
    echo "[sepolia] UR  $1  text(\"$2\") = \"$val\"  via $via"
    [ "$(lower "$via")" = "$(lower "$LIVE_RESOLVER")" ] || { echo "[sepolia]   ^ answered by $via, not the live resolver $LIVE_RESOLVER"; WILDCARD_OK=0; }
  else
    echo "[sepolia] UR FAILED to wildcard-resolve $1 text(\"$2\"): $(printf '%s' "$res" | head -3 | tr '\n' ' ')"
    WILDCARD_OK=0
    # direct call on the live resolver, to tell "the UR does not wildcard" from "the resolver is broken"
    # `|| true` inside the group: under set -euo pipefail a failing cast would otherwise end the script right here,
    # before the WILDCARD CHECK FAILED diagnostic below
    direct=$( { cast call --rpc-url "$RPC" "$LIVE_RESOLVER" "resolve(bytes,bytes)(bytes)" "$(dns_encode "$1")" \
               "$(cast calldata 'text(bytes32,string)' "$(cast namehash "$1")" "$2")" 2>&1 || true; } | head -1)
    echo "[sepolia]   direct OniblockLiveResolver.resolve -> $(cast abi-decode 'r()(string)' "$direct" 2>/dev/null || printf '%s' "$direct")"
  fi
done
[ "$WILDCARD_OK" = 1 ] || { echo "[sepolia] WILDCARD CHECK FAILED: UniversalResolverV2 $ENS_UNIVERSAL_RESOLVER did not resolve *.live.$ENS_NAME through $LIVE_RESOLVER"; exit 1; }
echo "[sepolia] wildcard OK: *.live.$ENS_NAME resolves through the UniversalResolverV2 via OniblockLiveResolver"
echo "[sepolia] done -> $(basename "$ENS_OUT"), $(basename "$DEP_OUT")"
