#!/usr/bin/env bash
# Live Oniblock on Ethereum Sepolia: the Kev System One server (oniblock1), keeper, settler, retail bot, and the app on :3001.
# RPC: SEPOLIA_RPC_ALCHEMY carries everything except eth_getLogs (SEPOLIA_RPC_HTTPS), see services/src/config.ts.
# Needs the v5 hook (deployments/11155111.json from scripts/deploy-sepolia.sh); keeper/settler preflight the ENS roles.
# A hook deployed before oniblock1 needs the one-time owner steps first: scripts/sepolia-enable-oniblock1.sh (dry run).
#
# Keeper defaults = the production setup (each overridable by env):
#   MODEL_MODE=oniblock1        the production model: the Kev-0.8B System One fine-tune (ml/models/kev08b-v1/adapter),
#                               served locally by ml/serve/start-kev.sh (python -m kev.serve, POST /v1/systemone on
#                               KEV_PORT 8008) and posted under oniblock1.models.oniblock.eth
#                               (MODEL_MODE=auto = Jev, for comparison; CHARGE_THRESHOLD then applies to Jev's p)
#   KEV_STATE_FORMAT=auto       the v1 adapter's state text (base-fee wording); kev2 only for a Kev v2 adapter
#   CHARGE_THRESHOLD=auto       settler's rolling threshold (.runtime/charge-threshold.json) -> CHARGE_THRESHOLD_FALLBACK
#                               -> the adapter's 0.8175 (ml/models/kev08b-v1/charge_threshold.json) -> none (charge nothing)
#   KEEPER_POST=change          post only when the hook would price swaps differently (+ heartbeat)
#   KEEPER_FIRST_IN_BLOCK=1     oniblock1's training setup: Binance read + send KEEPER_READ_LEAD_MS (2000) before the
#   KEEPER_READ_LEAD_MS=2000    next block, tx at the TOP of block N+1 so it prices N+1 itself; ATTEST_BLOCK_OFFSET=1 signs for N+1, so a post
#                               that slips to N+2 is still accepted (block.number - 1) instead of reverting
#   KEEPER_PRIORITY_GWEI=2      tip of setAttestation: above the retail bot / app swaps (viem default, the node's
#                               eth_maxPriorityFeePerGas, ~0.001 gwei on Sepolia) and the network's usual p90 (~1-1.5)
#   KEEPER_BLOCK_TIME_MS        unset = 12000 on sepolia
# Set KEEPER_FIRST_IN_BLOCK=0 / KEEPER_READ_LEAD_MS= / KEEPER_PRIORITY_GWEI= (empty) to get the on-arrival keeper back.
# Kev server: KEV_ADAPTER / KEV_HOME / KEV_PORT (ml/serve/start-kev.sh); SEPOLIA_KEV=0 skips it (a server already running,
# or MODEL_MODE other than oniblock1/kev). The keeper waits up to KEV_WAIT_S (default 120) for it to answer; if Kev is
# down the keeper falls back to heuristic-v1 per tick.
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
  ATTEST_BLOCK_OFFSET="${ATTEST_BLOCK_OFFSET:-1}"
  MODEL_MODE="${MODEL_MODE:-oniblock1}"
  KEV_STATE_FORMAT="${KEV_STATE_FORMAT:-auto}"
  KEV_URL="${KEV_URL:-http://127.0.0.1:${KEV_PORT:-8008}/v1/systemone}"
  CHARGE_THRESHOLD="${CHARGE_THRESHOLD-auto}"
  KEEPER_POST="${KEEPER_POST:-change}"
  KEEPER_FIRST_IN_BLOCK="${KEEPER_FIRST_IN_BLOCK-1}"
  KEEPER_READ_LEAD_MS="${KEEPER_READ_LEAD_MS-2000}"
  KEEPER_PRIORITY_GWEI="${KEEPER_PRIORITY_GWEI-2}"
)
MODE="${MODEL_MODE:-oniblock1}"
if [ "${SEPOLIA_KEV:-1}" = 1 ] && { [ "$MODE" = oniblock1 ] || [ "$MODE" = kev ]; }; then
  start kev ml bash serve/start-kev.sh
  KEV_MODELS="http://127.0.0.1:${KEV_PORT:-8008}/v1/models"
  for _ in $(seq 1 "${KEV_WAIT_S:-120}"); do curl -fsS -o /dev/null "$KEV_MODELS" 2>/dev/null && break; sleep 1; done
  curl -fsS -o /dev/null "$KEV_MODELS" 2>/dev/null && echo "[sepolia] kev: up ($KEV_MODELS)" \
    || echo "[sepolia] kev: NOT answering after ${KEV_WAIT_S:-120} s (see $L/kev.log); the keeper falls back to heuristic-v1 until it does"
fi
echo "[sepolia] keeper: ${KEEPER_ENV[*]}"
start keeper  services env "${KEEPER_ENV[@]}" pnpm keeper
start settler services pnpm settler
start retail  services pnpm retail --all --lambda "${RETAIL_LAMBDA:-0.15}"
[ "${SEPOLIA_JIT:-0}" = 1 ] && start jit services pnpm jit --hold "${JIT_HOLD:-12}" --every "${JIT_EVERY:-30}"
[ -f "$ROOT/app/.next/BUILD_ID" ] || (cd "$ROOT/app" && pnpm build >"$L/app-build.log" 2>&1)
start app     app env APP_PORT="${APP_PORT:-3001}" pnpm start
echo "[sepolia] app: http://localhost:${APP_PORT:-3001}"
wait
