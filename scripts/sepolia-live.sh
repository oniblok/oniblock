#!/usr/bin/env bash
# Live Oniblock on Ethereum Sepolia: keeper (Jev every block), settler, retail bot, and the app on :3001.
# RPC: SEPOLIA_RPC_ALCHEMY carries everything except eth_getLogs (SEPOLIA_RPC_HTTPS), see services/src/config.ts.
# Needs the v5 hook (deployments/11155111.json from scripts/deploy-sepolia.sh); keeper/settler preflight the ENS roles.
# SEPOLIA_JIT=1 also runs the jit bot (JIT_PK, funded) so the JIT head sees churn and seasons; off by default (gas).
# Ctrl-C stops everything. Logs: .runtime/logs/sepolia/*.log
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
L="$ROOT/.runtime/logs/sepolia"; mkdir -p "$L"
export CHAIN=sepolia
PIDS=()
start() { local name=$1; shift; ( cd "$ROOT/$1" && shift && exec "$@" ) >"$L/$name.log" 2>&1 & PIDS+=($!); echo "[sepolia] $name started (log $L/$name.log)"; }
trap 'echo; echo "[sepolia] stopping"; kill "${PIDS[@]}" 2>/dev/null; wait; exit 0' INT TERM

start keeper  services env KEEPER_EVERY="${KEEPER_EVERY:-1}" ATTEST_BLOCK_OFFSET=0 MODEL_MODE="${MODEL_MODE:-auto}" pnpm keeper
start settler services pnpm settler
start retail  services pnpm retail --all --lambda "${RETAIL_LAMBDA:-0.15}"
[ "${SEPOLIA_JIT:-0}" = 1 ] && start jit services pnpm jit --hold "${JIT_HOLD:-12}" --every "${JIT_EVERY:-30}"
[ -f "$ROOT/app/.next/BUILD_ID" ] || (cd "$ROOT/app" && pnpm build >"$L/app-build.log" 2>&1)
start app     app env APP_PORT="${APP_PORT:-3001}" pnpm start
echo "[sepolia] app: http://localhost:${APP_PORT:-3001}"
wait
