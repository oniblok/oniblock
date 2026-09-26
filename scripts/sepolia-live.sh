#!/usr/bin/env bash
# Live Oniblock on Ethereum Sepolia: keeper, settler, retail bot, and the app on :3001.
# RPC: SEPOLIA_RPC_ALCHEMY carries everything except eth_getLogs (SEPOLIA_RPC_HTTPS), see services/src/config.ts.
# Needs the v5 hook (deployments/11155111.json from scripts/deploy-sepolia.sh); keeper/settler preflight the ENS roles.
# A hook deployed before oniblock1 needs the one-time owner steps first: scripts/sepolia-enable-oniblock1.sh (dry run).
#
# Keeper defaults = the production setup (each overridable by env):
#   MODEL_MODE=oniblock1        the LightGBM production model, posted under oniblock1.models.oniblock.eth
#                               (MODEL_MODE=auto = Jev, for comparison; CHARGE_THRESHOLD then applies to Jev's p)
#   CHARGE_THRESHOLD=auto       settler's rolling threshold (.runtime/charge-threshold.json) -> CHARGE_THRESHOLD_FALLBACK
#                               -> the model JSON's 0.8224 -> none (charge nothing)
#   KEEPER_POST=change          post only when the hook would price swaps differently (+ heartbeat)
#   KEEPER_FIRST_IN_BLOCK=1     oniblock1's training setup: Binance read + send KEEPER_READ_LEAD_MS (2000) before the
#   KEEPER_READ_LEAD_MS=2000    next block, tx at the TOP of block N+1 so it prices N+1 itself (ATTEST_BLOCK_OFFSET=0)
#   KEEPER_PRIORITY_GWEI=2      tip of setAttestation: above the retail bot / app swaps (viem default, the node's
#                               eth_maxPriorityFeePerGas, ~0.001 gwei on Sepolia) and the network's usual p90 (~1-1.5)
#   KEEPER_BLOCK_TIME_MS        unset = 12000 on sepolia
# Set KEEPER_FIRST_IN_BLOCK=0 / KEEPER_READ_LEAD_MS= / KEEPER_PRIORITY_GWEI= (empty) to get the on-arrival keeper back.
# Settler: publishes the rolling charge threshold by default (CHARGE_WINDOW_BLOCKS default 50400 = 7 days of 12 s
# blocks, CHARGE_MIN_BENIGN 200 labels before it publishes anything; until then the keeper falls back as above).
# SEPOLIA_JIT=1 also runs the jit bot (JIT_PK, funded) so the JIT head sees churn and seasons; off by default (gas).
# Ctrl-C stops everything. Logs: .runtime/logs/sepolia/*.log
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
L="$ROOT/.runtime/logs/sepolia"; mkdir -p "$L"
export CHAIN=sepolia
PIDS=()
start() { local name=$1; shift; ( cd "$ROOT/$1" && shift && exec "$@" ) >"$L/$name.log" 2>&1 & PIDS+=($!); echo "[sepolia] $name started (log $L/$name.log)"; }
trap 'echo; echo "[sepolia] stopping"; kill "${PIDS[@]}" 2>/dev/null; wait; exit 0' INT TERM

# ${VAR-default}: unset -> default, explicitly empty -> stays empty (= that knob off in the keeper)
KEEPER_ENV=(
  KEEPER_EVERY="${KEEPER_EVERY:-1}"
  ATTEST_BLOCK_OFFSET="${ATTEST_BLOCK_OFFSET:-0}"
  MODEL_MODE="${MODEL_MODE:-oniblock1}"
  CHARGE_THRESHOLD="${CHARGE_THRESHOLD-auto}"
  KEEPER_POST="${KEEPER_POST:-change}"
  KEEPER_FIRST_IN_BLOCK="${KEEPER_FIRST_IN_BLOCK-1}"
  KEEPER_READ_LEAD_MS="${KEEPER_READ_LEAD_MS-2000}"
  KEEPER_PRIORITY_GWEI="${KEEPER_PRIORITY_GWEI-2}"
)
echo "[sepolia] keeper: ${KEEPER_ENV[*]}"
start keeper  services env "${KEEPER_ENV[@]}" pnpm keeper
start settler services pnpm settler
start retail  services pnpm retail --all --lambda "${RETAIL_LAMBDA:-0.15}"
[ "${SEPOLIA_JIT:-0}" = 1 ] && start jit services pnpm jit --hold "${JIT_HOLD:-12}" --every "${JIT_EVERY:-30}"
[ -f "$ROOT/app/.next/BUILD_ID" ] || (cd "$ROOT/app" && pnpm build >"$L/app-build.log" 2>&1)
start app     app env APP_PORT="${APP_PORT:-3001}" pnpm start
echo "[sepolia] app: http://localhost:${APP_PORT:-3001}"
wait
