# Shared ENS helpers for scripts/deploy-sepolia.sh and scripts/sepolia-enable-oniblock1.sh (source, don't run).
# Expects: ROOT, RPC, LOGS, ENS_OUT, DEP_OUT, ENS_NAME, ENS_UNIVERSAL_RESOLVER and the .env role addresses
# (DEPLOYER_ADDR, QUOTER_ADDR, SETTLER_ADDR; DEPLOYER_PK only for ens_phase). SECRET_FILE is optional (commit / finish).
# Key values are never printed.

# forge EnsSetup phase, broadcast from the deployer: ens_phase PHASE [VAR=value ...] (extra env, e.g. add-model's ENS_MODEL_*)
ens_phase() {
  local phase=$1; shift
  local secret=()
  [ -n "${SECRET_FILE:-}" ] && [ -s "$SECRET_FILE" ] && secret=(ENS_SECRET="$(cat "$SECRET_FILE")")
  ( cd "$ROOT/contracts" && env ENS_PHASE="$phase" ENS_OWNER="$DEPLOYER_ADDR" ENS_QUOTER="$QUOTER_ADDR" ENS_SETTLER="$SETTLER_ADDR" \
      ${secret[@]+"${secret[@]}"} ENS_OUT="$ENS_OUT" ENS_DEPLOYMENT_JSON="$DEP_OUT" "$@" \
      forge script script/EnsSetup.s.sol --rpc-url "$RPC" --private-key "$DEPLOYER_PK" --broadcast --slow --non-interactive ) >>"$LOGS/ens.log" 2>&1
}
# The same command as text (dry runs): keys and the RPC URL stay as unexpanded variable references.
ens_phase_text() {
  local phase=$1; shift
  local extra="" kv
  for kv in "$@"; do extra+=" ${kv%%=*}=$(printf '%q' "${kv#*=}")"; done
  printf '(cd %q && ENS_PHASE=%s ENS_OWNER=%s ENS_QUOTER=%s ENS_SETTLER=%s ENS_OUT=%q ENS_DEPLOYMENT_JSON=%q%s \\\n    forge script script/EnsSetup.s.sol --rpc-url "$SEPOLIA_RPC_HTTPS" --private-key "$DEPLOYER_PK" --broadcast --slow --non-interactive)\n' \
    "$ROOT/contracts" "$phase" "$DEPLOYER_ADDR" "$QUOTER_ADDR" "$SETTLER_ADDR" "$ENS_OUT" "$DEP_OUT" "$extra"
}
dns_encode() { (cd "$ROOT/services" && pnpm -s exec tsx -e "import {dnsEncode} from './src/ens.ts'; console.log(dnsEncode('$1'))"); }
ur_text() { # name key -> "<value>\t<resolver>" through the UniversalResolverV2, non-zero if the UR call fails
  local out
  out=$(cast call --rpc-url "$RPC" "$ENS_UNIVERSAL_RESOLVER" "resolve(bytes,bytes)(bytes,address)" \
        "$(dns_encode "$1")" "$(cast calldata 'text(bytes32,string)' "$(cast namehash "$1")" "$2")" 2>&1) || { printf '%s\n' "$out"; return 1; }
  local data resolver
  data=$(printf '%s\n' "$out" | sed -n 1p); resolver=$(printf '%s\n' "$out" | sed -n 2p)
  printf '%s\t%s\n' "$(cast abi-decode 'r()(string)' "$data" | sed -e 's/^"//' -e 's/"$//')" "$resolver"
}
lower() { tr 'A-F' 'a-f' <<<"$1"; }

# Default model names an older setup predates (EnsSetup._writeRecords writes the same records in `finish`; keep in sync).
KEV_HASH="0x24f0793d55e0fde516ebe4da1d187e0468a5f7c830ba9a9f4d48e43f007c88be" # ml/models/kev08b-v1/NOTE.md
ONI_HASH="0x$(shasum -a 256 "$ROOT/ml/models/oniblock1.json" | cut -d' ' -f1)"
KEV_DESC="Kev-0.8B (jaredpalmer/kev-0.8b) fine-tuned on Oniblock's mainnet informed-flow dataset; open weights at ml/models/kev08b-v1/adapter; model-hash = sha256 over the sorted per-file digests (ml/models/kev08b-v1/SHA256)"
KEV_CTX="Kev-0.8B open-weights decision model (LoRA fine-tune of jaredpalmer/kev-0.8b, served locally by the keeper), asked every block: is there profitable arbitrage at the base fee? -> {pToxicBps, confidenceBps}; same public fee law k = kMax * p * c. Active from its first attestation; Brier-demoted to kDefault (0 = base fee) if its calibration (written by the settler) exceeds brierDemoteBps."
ONI_DESC="oniblock1: gradient-boosted trees (LightGBM, 216 trees, 17 features) on the per-block features, trained on Binance reads ~2 s before the block; open weights ml/models/oniblock1.json; model-hash = sha256 of that file"
ONI_CTX="oniblock1 production model (LightGBM trees over the pool and Binance features, evaluated in-process by the keeper or over TypeSafe's System One API), asked every block: is there profitable arbitrage at the base fee? -> {pToxicBps, confidenceBps}; same public fee law k = kMax * p * c. Charge gate (keeper CHARGE_THRESHOLD; the model's chargeThreshold is 0.8224): c = 10000 when p >= threshold, else 0 (base fee). No JIT head (pJitBps 0 -> jitWindowMin, 10 blocks with the defaults). Active from its first attestation once allowlisted; Brier-demoted to kDefault (0 = base fee) if its calibration (written by the settler) exceeds brierDemoteBps."

# add-model arguments of a default model label: model_spec LABEL -> sets MODEL_HASH / MODEL_DESC / MODEL_CTX
model_spec() {
  case "$1" in
    kev-v1) MODEL_HASH=$KEV_HASH; MODEL_DESC=$KEV_DESC; MODEL_CTX=$KEV_CTX ;;
    oniblock1) MODEL_HASH=$ONI_HASH; MODEL_DESC=$ONI_DESC; MODEL_CTX=$ONI_CTX ;;
    *) echo "model_spec: unknown label $1" >&2; return 1 ;;
  esac
}
# 0 iff the UR resolves LABEL.models.$ENS_NAME's model-hash to HASH
model_hash_ok() { # label hash
  local res
  res=$(ur_text "$1.models.$ENS_NAME" model-hash) && [ "$(lower "${res%%$'\t'*}")" = "$(lower "$2")" ]
}
