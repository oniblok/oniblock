#!/usr/bin/env bash
# One-time owner steps that enable oniblock1 on the EXISTING live Sepolia deployment (a hook / ENS setup made before
# oniblock1 existed; a fresh scripts/deploy-sepolia.sh does all of this itself):
#   1. ENS add-model oniblock1   registers oniblock1.models.$ENS_NAME with model-hash = 0x + sha256(ml/models/kev08b-v1/SHA256)
#                                and the description / agent-context EnsSetup writes (scripts/sepolia-ens.sh)
#   2. ENS add-live              the live wildcard resolver knows the oniblock1 label (oniblock1.live.$ENS_NAME)
#   3. ENS grant-cal             the settler may write every calibration.* key, incl. calibration.chargeThreshold
#                                (the rolling charge threshold) and calibration.jit.*
#   4. hook.setModelAllowed(poolId, namehash(oniblock1.models.$ENS_NAME), true)   from the hook owner
#
#   scripts/sepolia-enable-oniblock1.sh              DRY RUN (default): read-only checks against Sepolia (eth_call only),
#                                                    then prints what is done and every command still needed
#   scripts/sepolia-enable-oniblock1.sh --broadcast  sends the missing steps from DEPLOYER_PK (ENS owner + hook owner)
#
# Reads the root .env (SEPOLIA_RPC_HTTPS, ENS_NAME, ENS_UNIVERSAL_RESOLVER, DEPLOYER_ADDR/_PK, QUOTER_ADDR, SETTLER_ADDR),
# deployments/11155111.json and deployments/11155111.ens.json. Key values and the RPC URL are never printed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BROADCAST=0
case "${1:-}" in
  "") ;;
  --broadcast) BROADCAST=1 ;;
  -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
  *) echo "usage: $0 [--broadcast]" >&2; exit 2 ;;
esac
set -a; source "$ROOT/.env"; set +a
unset CHAIN # foundry reads $CHAIN as --chain
RPC="${SEPOLIA_RPC_HTTPS:?SEPOLIA_RPC_HTTPS missing in .env}"
: "${ENS_NAME:?} ${ENS_UNIVERSAL_RESOLVER:?} ${DEPLOYER_ADDR:?} ${QUOTER_ADDR:?} ${SETTLER_ADDR:?}"
ENS_OUT="$ROOT/deployments/11155111.ens.json"; DEP_OUT="$ROOT/deployments/11155111.json"
LOGS="$ROOT/.runtime/logs/sepolia"; mkdir -p "$LOGS"
source "$ROOT/scripts/sepolia-ens.sh"
say() { echo "[oniblock1] $*"; }
json() { python3 -c 'import json,sys; j=json.load(open(sys.argv[1]));
for k in sys.argv[2].split("."): j=j[k]
print(j)' "$1" "$2"; }

[ -s "$ENS_OUT" ] && [ -s "$DEP_OUT" ] || { say "missing $ENS_OUT or $DEP_OUT (run scripts/deploy-sepolia.sh first)"; exit 1; }
CID=$(cast chain-id --rpc-url "$RPC")
[ "$CID" = 11155111 ] || { say "RPC chain id $CID != 11155111"; exit 1; }
HOOK=$(json "$DEP_OUT" hook); POOL_ID=$(json "$DEP_OUT" pools.oniblock.poolId)
RESOLVER=$(json "$ENS_OUT" resolver); LIVE_RESOLVER=$(json "$ENS_OUT" liveResolver)
SETTLER=$(json "$ENS_OUT" settler); ENS_OWNER_JSON=$(json "$ENS_OUT" owner)
MODEL_NAME="oniblock1.models.$ENS_NAME"; NODE=$(cast namehash "$MODEL_NAME")
model_spec oniblock1
say "mode: $([ "$BROADCAST" = 1 ] && echo BROADCAST || echo 'dry run (read-only; --broadcast to send)')"
say "hook $HOOK  poolId $POOL_ID"
say "model $MODEL_NAME  node $NODE"
say "model-hash $MODEL_HASH (sha256 of ml/models/kev08b-v1/SHA256: the Kev adapter per-file digests)"

# --- read-only checks ------------------------------------------------------------------------------------------------
HOOK_OWNER=$(cast call --rpc-url "$RPC" "$HOOK" 'owner()(address)')
[ "$(lower "$HOOK_OWNER")" = "$(lower "$DEPLOYER_ADDR")" ] && OWNER_OK=1 || OWNER_OK=0
[ "$(lower "$ENS_OWNER_JSON")" = "$(lower "$DEPLOYER_ADDR")" ] && ENS_OWNER_OK=1 || ENS_OWNER_OK=0
[ "$(lower "$SETTLER")" = "$(lower "$SETTLER_ADDR")" ] || say "WARNING: ens json settler $SETTLER != SETTLER_ADDR $SETTLER_ADDR (grants are checked for the json's)"
BAL=$(cast balance --rpc-url "$RPC" "$DEPLOYER_ADDR")
say "hook owner $HOOK_OWNER ($([ $OWNER_OK = 1 ] && echo '= DEPLOYER_ADDR' || echo 'NOT DEPLOYER_ADDR: step 4 must come from that key'))"
say "ENS owner  $ENS_OWNER_JSON ($([ $ENS_OWNER_OK = 1 ] && echo '= DEPLOYER_ADDR' || echo 'NOT DEPLOYER_ADDR: the ENS phases would fail'))"
say "deployer balance $(cast from-wei "$BAL") ETH"

# 1. model name
if model_hash_ok oniblock1 "$MODEL_HASH"; then S1=done; else
  S1=needed
  cur=$(ur_text "$MODEL_NAME" model-hash 2>/dev/null | cut -f1 || true)
  say "  UR model-hash of $MODEL_NAME: ${cur:-<unresolved>}"
fi
# 2. live resolver: serves this hook and knows the oniblock1 label
S2=needed; LIVE_HOOK=""; LABELS=""
if [ "$(cast code --rpc-url "$RPC" "$LIVE_RESOLVER")" != 0x ]; then
  LIVE_HOOK=$(cast call --rpc-url "$RPC" "$LIVE_RESOLVER" 'hook()(address)' 2>/dev/null || true)
  LABELS=$(cast call --rpc-url "$RPC" "$LIVE_RESOLVER" 'knownLabels()(string[])' 2>/dev/null || true)
  if [ "$(lower "$LIVE_HOOK")" = "$(lower "$HOOK")" ] && grep -q '"oniblock1"' <<<"$LABELS"; then S2=done; fi
fi
say "  liveResolver $LIVE_RESOLVER hook=${LIVE_HOOK:-?} knownLabels=${LABELS:-?}"
# 3. settler text-key grants on the shared resolver (resource = uint256(keccak256(key)), RES_ROLE_SET_TEXT = 1 << 4)
CAL_KEYS=(calibration.brier calibration.hitRate calibration.n calibration.epoch calibration.brierRaw calibration.skill
          calibration.baseRate calibration.chargeThreshold calibration.jit.brier calibration.jit.hitRate calibration.jit.n
          calibration.jit.epoch calibration.jit.brierRaw calibration.jit.skill calibration.jit.baseRate)
MISSING_KEYS=(); UNREADABLE=0
for k in "${CAL_KEYS[@]}"; do
  if r=$(cast call --rpc-url "$RPC" "$RESOLVER" 'hasRoles(uint256,uint256,address)(bool)' "$(cast keccak "$k")" 16 "$SETTLER" 2>/dev/null); then
    [ "$r" = true ] || MISSING_KEYS+=("$k")
  else UNREADABLE=1; fi
done
if [ "$UNREADABLE" = 1 ]; then S3=unverified; elif [ "${#MISSING_KEYS[@]}" = 0 ]; then S3=done; else S3=needed; fi
[ "${#MISSING_KEYS[@]}" = 0 ] || say "  settler $SETTLER lacks: ${MISSING_KEYS[*]}"
# 4. hook allowlist
ALLOWED=$(cast call --rpc-url "$RPC" "$HOOK" 'modelAllowed(bytes32,bytes32)(bool)' "$POOL_ID" "$NODE")
[ "$ALLOWED" = true ] && S4=done || S4=needed
# informational: the other allowlisted defaults and oniblock1's calibration record on the hook
for m in jev-v1 heuristic-v1 rule-v1; do
  say "  hook.modelAllowed($m) = $(cast call --rpc-url "$RPC" "$HOOK" 'modelAllowed(bytes32,bytes32)(bool)' "$POOL_ID" "$(cast namehash "$m.models.$ENS_NAME")")"
done
say "  hook.calibration(oniblock1) (brierBps, hitRateBps, n, epoch) = $(cast call --rpc-url "$RPC" "$HOOK" 'calibration(bytes32)((uint32,uint32,uint32,uint64))' "$NODE" 2>/dev/null || echo '?')"

echo
say "status:"
say "  1. ENS add-model oniblock1 (model-hash)          $S1"
say "  2. ENS add-live (live resolver knows oniblock1)  $S2"
say "  3. ENS grant-cal (settler calibration.* keys)    $S3"
say "  4. hook.setModelAllowed(oniblock1)               $S4"

SET_ALLOWED_TEXT="cast send --rpc-url \"\$SEPOLIA_RPC_HTTPS\" --private-key \"\$DEPLOYER_PK\" $HOOK \"setModelAllowed(bytes32,bytes32,bool)\" $POOL_ID $NODE true"
if [ "$S1$S2$S3$S4" = donedonedonedone ]; then say "nothing to do: oniblock1 is enabled on $HOOK"; exit 0; fi
if [ "$BROADCAST" = 0 ]; then
  echo
  say "commands still needed (run from the repo root with the .env loaded: set -a; source .env; set +a), or re-run with --broadcast:"
  [ "$S1" = done ] || { echo "# 1. add-model oniblock1"; ens_phase_text add-model ENS_MODEL_LABEL=oniblock1 ENS_MODEL_OWNER="$DEPLOYER_ADDR" ENS_MODEL_HASH="$MODEL_HASH" ENS_MODEL_DESCRIPTION="$MODEL_DESC" ENS_MODEL_CONTEXT="$MODEL_CTX"; }
  [ "$S2" = done ] || { echo "# 2. add-live"; ens_phase_text add-live; }
  [ "$S3" = done ] || { echo "# 3. grant-cal"; ens_phase_text grant-cal; }
  [ "$S4" = done ] || { echo "# 4. allowlist oniblock1 on the hook (hook owner)"; echo "$SET_ALLOWED_TEXT"; }
  exit 0
fi

# --- broadcast -------------------------------------------------------------------------------------------------------
[ "$ENS_OWNER_OK" = 1 ] || [ "$S1$S2$S3" = donedonedone ] || { say "DEPLOYER_ADDR is not the ENS owner; refusing to run the ENS phases"; exit 1; }
[ "$OWNER_OK" = 1 ] || [ "$S4" = done ] || { say "DEPLOYER_ADDR is not the hook owner; refusing to send setModelAllowed"; exit 1; }
: "${DEPLOYER_PK:?}"
if [ "$S1" != done ]; then
  say "ENS add-model oniblock1..."
  ens_phase add-model ENS_MODEL_LABEL=oniblock1 ENS_MODEL_OWNER="$DEPLOYER_ADDR" ENS_MODEL_HASH="$MODEL_HASH" \
    ENS_MODEL_DESCRIPTION="$MODEL_DESC" ENS_MODEL_CONTEXT="$MODEL_CTX" || { tail -20 "$LOGS/ens.log"; exit 1; }
fi
if [ "$S2" != done ]; then say "ENS add-live..."; ens_phase add-live || { tail -20 "$LOGS/ens.log"; exit 1; }; fi
if [ "$S3" != done ]; then say "ENS grant-cal..."; ens_phase grant-cal || { tail -20 "$LOGS/ens.log"; exit 1; }; fi
if [ "$S4" != done ]; then
  say "hook.setModelAllowed(oniblock1)..."
  cast send --rpc-url "$RPC" --private-key "$DEPLOYER_PK" "$HOOK" "setModelAllowed(bytes32,bytes32,bool)" "$POOL_ID" "$NODE" true \
    >>"$LOGS/enable-oniblock1.log" 2>&1 || { tail -5 "$LOGS/enable-oniblock1.log"; exit 1; }
fi
say "sent; re-run without --broadcast to verify"
