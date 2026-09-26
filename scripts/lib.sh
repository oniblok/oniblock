# Shared helpers for scripts/demo-local.sh and scripts/demo-fork.sh (source, don't run).
# Expects: ROOT, RPC, LOGS set by the caller.

# JSON-RPC liveness check.
rpc_up() {
  curl -s -m 2 -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC" 2>/dev/null | grep -q result
}

# Current block number of $RPC (decimal).
block_number() {
  curl -s -m 5 -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' "$RPC" |
    python3 -c 'import sys,json; print(int(json.load(sys.stdin)["result"],16))'
}

# Raw JSON-RPC call: rpc_call METHOD 'PARAMS_JSON'
rpc_call() {
  curl -s -m 20 -X POST -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" "$RPC"
}

# Background process in its own process group (set -m in the caller); PID appended to PIDS.
start() { # name, command...
  local name="$1"; shift
  ( cd "$ROOT" && exec "$@" ) >"$LOGS/$name.log" 2>&1 &
  PIDS+=("$!")
  echo "[demo] $name started (pid $!, log ${LOGS#"$ROOT"/}/$name.log)"
}

cleanup() {
  trap - INT TERM EXIT
  echo
  echo "[demo] stopping..."
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill -TERM -- "-$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill -KILL -- "-$pid" 2>/dev/null || true
  done
  echo "[demo] stopped."
}

# Stop early if the data volume is nearly full (anvil / next can fill a tight disk).
check_disk() { # min free MB (default 500)
  local min="${1:-500}" free
  free="$(df -m "$ROOT" | awk 'NR==2 {print $4}')"
  if [ -n "$free" ] && [ "$free" -lt "$min" ]; then
    echo "[demo] only ${free} MB free on the data volume (< ${min} MB) — refusing to continue."; return 1
  fi
}

# deployBlock fix: forge scripts serialize `block.number` of the *simulation*, which is the pre-deploy head
# (0 on a fresh anvil). Record the first block that actually contains a deploy tx, from the broadcast
# receipts, falling back to the given pre-deploy head + 1. Services/app start history reads there.
patch_deploy_block() { # deployments_json broadcast_run_json fallback_block
  python3 - "$1" "$2" "$3" <<'PY'
import json, sys
out, bc, fb = sys.argv[1], sys.argv[2], int(sys.argv[3])
blk = None
try:
    rs = json.load(open(bc)).get("receipts", [])
    bs = [int(r["blockNumber"], 16) if isinstance(r["blockNumber"], str) else int(r["blockNumber"]) for r in rs]
    blk = min(bs) if bs else None
except Exception:
    pass
if blk is None:
    blk = fb
j = json.load(open(out))
old = j.get("deployBlock")
j["deployBlock"] = blk
json.dump(j, open(out, "w"), indent=2)
print(f"deployBlock {old} -> {blk}")
PY
}

# POST JSON to the app: app_post PATH 'JSON'
app_post() {
  curl -s -m 60 -X POST -H 'content-type: application/json' --data "$2" "http://127.0.0.1:${APP_PORT}$1"
}
app_get() {
  curl -s -m 60 "http://127.0.0.1:${APP_PORT}$1"
}
wait_app() { # seconds
  for _ in $(seq 1 "${1:-90}"); do
    curl -s -m 2 -o /dev/null "http://127.0.0.1:${APP_PORT}/api/state" && return 0
    sleep 1
  done
  return 1
}
