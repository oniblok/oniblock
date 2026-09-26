#!/usr/bin/env bash
# Local smoke test: fresh anvil -> DeployLocal -> signed attestation -> arb-direction swap -> check Receipt
# (fee == v3 threshold law: min(base + max(0, gap - arbThresholdPips) * k / 1e4, feeMax)).
# Usage: ./smoke-local.sh [port]   (default 8555; uses anvil's public test mnemonic keys only)
set -euo pipefail
cd "$(dirname "$0")"
PORT=${1:-8555}; RPC=http://127.0.0.1:$PORT
TMP=$(mktemp -d)
anvil --port "$PORT" --silent --prune-history 64 & ANVIL=$! # no state files in ~/.foundry/anvil/tmp
trap 'kill $ANVIL 2>/dev/null; rm -rf "$TMP"' EXIT
sleep 2
mkdir -p cache/smoke; OUTJ="$(pwd)/cache/smoke/31337.json"
DEPLOYMENTS_OUT="$OUTJ" forge script script/DeployLocal.s.sol --rpc-url "$RPC" --broadcast >/dev/null
M="test test test test test test test test test test test junk"
pk() { cast wallet private-key --mnemonic "$M" --mnemonic-index "$1"; }
PKQ=$(pk 1); PKA=$(pk 3); PKT=$(pk 5); T=$(cast wallet address --private-key "$PKT")
j() { jq -r "$1" "$OUTJ"; }
HOOK=$(j .hook); ROUTER=$(j .splitSwapRouter); C0=$(j .currency0); C1=$(j .currency1); PID=$(j .pools.oniblock.poolId); SV=$(j .stateView)
KEY="($C0,$C1,8388608,60,$HOOK)"
TOKEN_IN=$C0
cast send -q --rpc-url "$RPC" --private-key "$PKT" "$TOKEN_IN" "mint(address,uint256)" "$T" 1000000000000000000000000
cast send -q --rpc-url "$RPC" --private-key "$PKT" "$TOKEN_IN" "approve(address,uint256)" "$ROUTER" 1000000000000000000000000
SQ=$(cast call --rpc-url "$RPC" "$SV" "getSlot0(bytes32)(uint160,int24,uint24,uint24)" "$PID" | head -1 | awk '{print $1}')
MID=$(python3 -c "s=$SQ; print((s*s>>96)*99//100)")   # oracle 1% below pool => zeroForOne is arb direction
BN=$(( $(cast block-number --rpc-url "$RPC") + 1 ))
MODEL=$(cast namehash "jev-v1.models.oniblock.eth")   # allowlisted by DeployLocal (R-01)
cat > "$TMP/typed.json" <<JSON
{"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],
"Attestation":[{"name":"poolId","type":"bytes32"},{"name":"blockNumber","type":"uint64"},{"name":"oracleMidX96","type":"uint256"},{"name":"pToxicBps","type":"uint32"},{"name":"confidenceBps","type":"uint32"},{"name":"pJitBps","type":"uint32"},{"name":"modelNode","type":"bytes32"}]},
"primaryType":"Attestation","domain":{"name":"Oniblock","version":"1","chainId":31337,"verifyingContract":"$HOOK"},
"message":{"poolId":"$PID","blockNumber":$BN,"oracleMidX96":"$MID","pToxicBps":10000,"confidenceBps":5000,"pJitBps":0,"modelNode":"$MODEL"}}
JSON
SIG=$(cast wallet sign --private-key "$PKA" --data --from-file "$TMP/typed.json")
cast send -q --rpc-url "$RPC" --private-key "$PKQ" "$HOOK" \
  "setAttestation((address,address,uint24,int24,address),(uint64,uint256,uint32,uint32,uint32,bytes32,bytes))" \
  "$KEY" "($BN,$MID,10000,5000,$MODEL,$SIG)"
echo "quoteFee(zeroForOne): $(cast call --rpc-url "$RPC" "$HOOK" "quoteFee((address,address,uint24,int24,address),bool)(uint24,bool,uint32,bool)" "$KEY" true | tr '\n' ' ')"
cast send --rpc-url "$RPC" --private-key "$PKT" --json "$ROUTER" \
  "swap((address,address,uint24,int24,address),bool,int256,uint160,address)" -- "$KEY" true -1000000000000000000 0 "$T" > "$TMP/swap.json"
THR=$(j .pools.oniblock.config.arbThresholdPips); BASE=$(j .pools.oniblock.config.baseFee); FMAX=$(j .pools.oniblock.config.feeMax)
python3 - "$TMP/swap.json" "$HOOK" "$THR" "$BASE" "$FMAX" <<'PY'
import json, sys
r = json.load(open(sys.argv[1])); hook = sys.argv[2].lower()
RECEIPT = "0x6d7eccb3d49808c4b73c5ecf44bd2416bce762d8bdeb5285ac58e7a09c2a21ef"
logs = [l for l in r["logs"] if l["address"].lower() == hook and l["topics"][0] == RECEIPT]
assert int(r["status"], 16) == 1 and logs, "no Receipt"
d = logs[0]["data"][2:]; w = [int(d[i:i+64], 16) for i in range(0, len(d), 64)]
s = lambda v: v - (1 << 256) if v >= 1 << 255 else v
names = ["zeroForOne", "arbDir", "gapPips", "kBps", "feePips", "amount0", "amount1", "modelNode", "stale"]
rec = {n: (hex(v) if n == "modelNode" else s(v)) for n, v in zip(names, w)}
print("swap gasUsed", int(r["gasUsed"], 16)); print("Receipt", rec)
thr, base, fmax = int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
law = min(base + max(0, rec["gapPips"] - thr) * rec["kBps"] // 10000, fmax)  # v3 threshold law
print("arbThresholdPips", thr, "law fee", law)
assert rec["arbDir"] == 1 and rec["stale"] == 0 and rec["feePips"] > base and rec["feePips"] == law
print("SMOKE OK")
PY
