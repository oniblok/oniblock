#!/usr/bin/env bash
# Oniblock local demo: anvil (2 s blocks) -> DeployLocal -> keeper + settler + arb + retail + jit -> Next.js app.
# Ctrl-C stops everything. Logs: .runtime/logs/*.log
#
# Story in ~2-3 minutes (demo profile: MIN_SAMPLES=3, settle every 5 blocks, 8-label calibration window).
# v4 "the AI decides the fee" (docs/review/V4_AI_DECIDES.md): the keeper asks Jev EVERY block (no gate), the pool has
# no gap threshold and kMin = kDefault = 0, so k = kMax * p * c: Jev's "no profitable arbitrage" = base fee.
#   unseasoned (k = kDefault = 0: base fee, the model has no power yet) -> seasoned (settler writes n >= 3 from blocks
#   with arb-direction flow; k follows Jev block by block) -> "Degrade model" -> Brier crosses brierDemoteBps
#   -> demoted (k = kDefault = 0 again). The arb bot acts on its own because the price source replays a volatile
#   window of REAL Binance klines on block time (keeper and arb share it).
# v5 "the model decides the JIT window" (docs/review/V5_JIT_HEAD_SPEC.md): the jit bot mints a narrow position, swaps,
#   and pulls it after JIT_HOLD=12 blocks (escapes the old fixed 10-block wall). The settler grades the JIT head once each
#   add's SETTLER_JIT_LABEL_BLOCKS window has closed; after CALIB_MIN_N graded cycles the JIT head is seasoned, the model's
#   pJit moves the window above 12 and the next cycle is caught (JitPenalty with held >= 10). Timing at 2 s blocks:
#   one cycle = JIT_HOLD + JIT_EVERY blocks (~54 s); the first add is a cold-start miss, so the head is seasoned AND active
#   after ~5 cycles + label lag (JIT_CALIB_WINDOW=4 drops the miss) => allow DEMO_DURATION >= 540
#   for the full jit-caught,jit-seasoned story (DEMO_JIT=0 disables the bot and those expectations).
#
# Env knobs (all optional):
#   RPC_PORT=8545  APP_PORT=3000  BLOCK_TIME=2
#   DEMO_DURATION=0        seconds to run before stopping by itself (0 = until Ctrl-C; used for headless checks)
#   DEMO_PRICE_SOURCE=replay   replay (cached Binance klines, one REPLAY_STEP per block) | live (bookTicker)
#   REPLAY_INTERVAL=1m REPLAY_STEP=4 REPLAY_BLOCKS=150 REPLAY_START_MS=<auto: most volatile window, last 7 days>
#   DEMO_DEGRADE_AT        seconds after services start to press "Degrade model" automatically
#                          (default: 40% of DEMO_DURATION when headless, never when interactive)
#   INIT_PRICE_USD_E8      pool init price; default = first replay price (replay) or live Binance mid (live)
#   MIN_SAMPLES=3          calibration records before a model is "seasoned" (hook caps k at kDefault until then)
#   SETTLE_EVERY=5 CALIB_WINDOW=8 CALIB_MIN_N=$MIN_SAMPLES   settler cadence (blocks) / window (labelled blocks)
#   RETAIL_LAMBDA=1        retail swaps per block (Poisson mean); retail arb-direction swaps are labelled too
#   MODEL_MODE=auto        keeper scorer: auto (Jev -> heuristic fallback) | jev | heuristic
#   ARB_SPLIT=1            arb bot sub-swaps per tx (>1 exercises the per-block anchor)
#   APP_CMD=dev            dev | start (start requires `pnpm -C app build` first)
#   APP_HOST=127.0.0.1     app bind address (loopback keeps LAN peers off /api/dev/*; 0.0.0.0 exposes them)
#   SKIP_APP=1             don't start the app
#   DEMO_RUNTIME_DIR=.runtime        flags file + logs (use another dir to run next to a live demo)
#   DEMO_DEPLOYMENTS_FILE=deployments/31337.json   deployment JSON written by DeployLocal / read by the services
#   KEEPER_GATE=0          v4 default: Jev every block (1 = the v3 rule-v1 gate, for comparison only)
#   DEMO_JIT=1             start the jit bot (anvil key #8) and expect jit-caught,jit-seasoned in the headless check
#   JIT_HOLD=12 JIT_EVERY=15 JIT_TICKS=3 JIT_SIZE_USD=2000 JIT_SWAP_USD=5000   jit bot cycle (see services/src/bots/jit.ts)
#   JIT_CALIB_WINDOW=4     demo rolling window (labelled adds) for the JIT head (default: CALIB_WINDOW)
#   JIT_CHURN_WEIGHT=0.7   demo weight of observed liquidity churn in the posted p_jit (keeper default 0.5)
#   SETTLER_JIT_LABEL_BLOCKS=14  demo JIT label window (default 100 in production): a remove within N blocks of the add is JIT;
#                          JIT_LABEL_BLOCKS (keeper churn feature) follows it unless set
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="${DEMO_RUNTIME_DIR:-$ROOT/.runtime}"
case "$RUNTIME" in /*) ;; *) RUNTIME="$ROOT/$RUNTIME" ;; esac # relative dirs are used from subshells that cd elsewhere
DEPLOY_JSON="${DEMO_DEPLOYMENTS_FILE:-$ROOT/deployments/31337.json}"
case "$DEPLOY_JSON" in /*) ;; *) DEPLOY_JSON="$ROOT/$DEPLOY_JSON" ;; esac # forge's fs_permissions need the real ../deployments path
LOGS="$RUNTIME/logs"
RPC_PORT="${RPC_PORT:-8545}"
APP_PORT="${APP_PORT:-3000}"
BLOCK_TIME="${BLOCK_TIME:-2}"
RPC="http://127.0.0.1:${RPC_PORT}"
DEMO_DURATION="${DEMO_DURATION:-0}"
PRICE_SOURCE="${DEMO_PRICE_SOURCE:-replay}"
MIN_SAMPLES="${MIN_SAMPLES:-3}"
# anvil default account #0 (public dev key; local chain only)
ANVIL0_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
# shellcheck source=lib.sh
source "$ROOT/scripts/lib.sh"

mkdir -p "$LOGS"
set -m # each background job gets its own process group, so cleanup can kill whole trees (pnpm -> tsx/node)
PIDS=()
trap cleanup INT TERM EXIT

for bin in anvil forge pnpm curl python3; do
  command -v "$bin" >/dev/null || { echo "missing $bin"; exit 1; }
done
check_disk 500
if rpc_up; then
  echo "[demo] something already serves $RPC — stop it first (or set RPC_PORT)."; exit 1
fi
[ -d "$ROOT/services/node_modules" ] || pnpm -C "$ROOT/services" install
[ -d "$ROOT/app/node_modules" ] || pnpm -C "$ROOT/app" install

# 0. price source ------------------------------------------------------------------------------
# Resolve the replay window ONCE and export it, so keeper / arb / retail / settler share one path.
if [ "$PRICE_SOURCE" = "replay" ]; then
  eval "$(cd "$ROOT/services" && PRICE_SOURCE=replay pnpm -s exec tsx src/pricesource.ts --resolve 2>"$LOGS/pricesource.log")" ||
    { echo "[demo] could not resolve the replay window — see .runtime/logs/pricesource.log"; exit 1; }
  export REPLAY_START_MS
  echo "[demo] price source: replay $(cat "$LOGS/pricesource.log")"
  INIT_PRICE_USD_E8="${INIT_PRICE_USD_E8:-$REPLAY_FIRST_MID_E8}"
elif [ "$PRICE_SOURCE" = "live" ]; then
  echo "[demo] price source: live Binance bookTicker"
  if [ -z "${INIT_PRICE_USD_E8:-}" ]; then
    for host in https://api.binance.com https://api.binance.us https://data-api.binance.vision; do
      json="$(curl -s -m 4 "$host/api/v3/ticker/bookTicker?symbol=ETHUSDT" || true)"
      mid="$(printf '%s' "$json" | python3 -c 'import sys,json
try:
  j=json.load(sys.stdin); print(int(round((float(j["bidPrice"])+float(j["askPrice"]))/2*1e8)))
except Exception: pass' 2>/dev/null || true)"
      if [ -n "$mid" ]; then INIT_PRICE_USD_E8="$mid"; break; fi
    done
  fi
else
  echo "[demo] DEMO_PRICE_SOURCE must be replay|live"; exit 1
fi
export PRICE_SOURCE

# 1. anvil -----------------------------------------------------------------------------------
# --prune-history: no historical state files under ~/.foundry/anvil/tmp (they are never cleaned up).
start anvil anvil --port "$RPC_PORT" --block-time "$BLOCK_TIME" --chain-id 31337 --prune-history 64
for _ in $(seq 1 50); do rpc_up && break; sleep 0.2; done
rpc_up || { echo "[demo] anvil did not start"; exit 1; }

# 2. deploy ----------------------------------------------------------------------------------
echo "[demo] deploying (INIT_PRICE_USD_E8=${INIT_PRICE_USD_E8:-DeployLocal default}, MIN_SAMPLES=$MIN_SAMPLES)..."
PRE_DEPLOY_BLOCK="$(block_number)"
(
  cd "$ROOT/contracts"
  env ${INIT_PRICE_USD_E8:+INIT_PRICE_USD_E8=$INIT_PRICE_USD_E8} MIN_SAMPLES="$MIN_SAMPLES" LOCAL_PK="$ANVIL0_PK" DEPLOYMENTS_OUT="$DEPLOY_JSON" \
    forge script script/DeployLocal.s.sol --rpc-url "$RPC" --broadcast --private-key "$ANVIL0_PK" --slow --non-interactive
) >"$LOGS/deploy.log" 2>&1 || { echo "[demo] deploy failed — see .runtime/logs/deploy.log"; tail -20 "$LOGS/deploy.log"; exit 1; }
echo "[demo] deployed -> ${DEPLOY_JSON#"$ROOT"/} ($(patch_deploy_block "$DEPLOY_JSON" \
  "$ROOT/contracts/broadcast/DeployLocal.s.sol/31337/run-latest.json" "$((PRE_DEPLOY_BLOCK + 1))"))"
# Replay index 0 = the first block after deploy, so the pool starts at the replay's first price.
export REPLAY_ORIGIN_BLOCK="$(block_number)"

# 3. keeper flags (the app's dev panel toggles these; the keeper re-reads them every block) -----
printf '{\n  "degraded": false,\n  "useBackupQuoter": false\n}\n' >"$RUNTIME/keeper-flags.json"

# 4. services --------------------------------------------------------------------------------
export CHAIN=local LOCAL_RPC="$RPC" KEEPER_FLAGS_FILE="$RUNTIME/keeper-flags.json" DEPLOYMENTS_FILE="$DEPLOY_JSON"
export KEEPER_GATE="${KEEPER_GATE:-0}"
export MODEL_MODE="${MODEL_MODE:-auto}"
export SETTLE_EVERY="${SETTLE_EVERY:-5}" CALIB_WINDOW="${CALIB_WINDOW:-8}" CALIB_MIN_N="${CALIB_MIN_N:-$MIN_SAMPLES}"
export RETAIL_LAMBDA="${RETAIL_LAMBDA:-1}" # more labelled blocks per minute for the settler
# v5 JIT head: short label window so the settler grades the jit bot's cycles within the demo.
export SETTLER_JIT_LABEL_BLOCKS="${SETTLER_JIT_LABEL_BLOCKS:-14}" JIT_LABEL_BLOCKS="${JIT_LABEL_BLOCKS:-${SETTLER_JIT_LABEL_BLOCKS:-14}}"
# The JIT head gets one sample per liquidity add; a short rolling window lets the cold-start miss (no churn observed
# yet => p_jit ~ 0 while the first add IS JIT) fall out after a few cycles instead of holding the head demoted.
export JIT_CALIB_WINDOW="${JIT_CALIB_WINDOW:-4}"
# Demo: only the jit bot adds liquidity, so the observed churn IS the base rate; weight it above the keeper default (0.5)
# so the JIT head seasons within a few cycles (services/src/keeper.ts "online calibration of the JIT head").
export JIT_CHURN_WEIGHT="${JIT_CHURN_WEIGHT:-0.7}"
export DEMO_RUNTIME_DIR="$RUNTIME" # keeper verdicts.<chainId>.jsonl and the app's /api/verdicts follow the runtime dir
DEMO_JIT="${DEMO_JIT:-1}"
start keeper  pnpm -C services keeper
start settler pnpm -C services settler
start arb     pnpm -C services arb --all --split "${ARB_SPLIT:-1}"
start retail  pnpm -C services retail --all
if [ "$DEMO_JIT" = "1" ]; then
  start jit   pnpm -C services jit --hold "${JIT_HOLD:-12}" --every "${JIT_EVERY:-15}"
fi
SERVICES_T0=$SECONDS

# 5. app -------------------------------------------------------------------------------------
if [ "${SKIP_APP:-0}" != "1" ]; then
  export APP_PORT; start app pnpm -C app "${APP_CMD:-dev}"
  echo "[demo] app: http://localhost:${APP_PORT}  (receipts: /receipt/<tx>, models: /models)"
fi
echo "[demo] running (replay origin block ${REPLAY_ORIGIN_BLOCK}). Ctrl-C to stop."

if [ "$DEMO_DURATION" = "0" ]; then
  wait
  exit 0
fi

# Headless: optionally press "Degrade model" part-way, then print the narrative check.
DEGRADE_AT="${DEMO_DEGRADE_AT:-$((DEMO_DURATION * 40 / 100))}"
degraded=0
while [ $((SECONDS - SERVICES_T0)) -lt "$DEMO_DURATION" ]; do
  if [ "$degraded" = "0" ] && [ "$DEGRADE_AT" != "0" ] && [ $((SECONDS - SERVICES_T0)) -ge "$DEGRADE_AT" ]; then
    if [ "${SKIP_APP:-0}" != "1" ] && wait_app 30; then
      echo "[demo] t+$((SECONDS - SERVICES_T0))s block $(block_number): Degrade model (POST /api/dev/degrade) -> $(app_post /api/dev/degrade '{"degraded":true}')"
    else
      printf '{\n  "degraded": true,\n  "useBackupQuoter": false\n}\n' >"$RUNTIME/keeper-flags.json"
      echo "[demo] t+$((SECONDS - SERVICES_T0))s block $(block_number): Degrade model (flags file)"
    fi
    degraded=1; DEGRADED_BLOCK="$(block_number)"
  fi
  check_disk 500 || break
  sleep 2
done
EXPECT=seasoned; STORY_ARGS=()
[ "$degraded" = "1" ] && EXPECT=seasoned,honest-active,demoted && STORY_ARGS=(--degraded-at "$((DEGRADED_BLOCK + 1))")
[ "$DEMO_JIT" = "1" ] && EXPECT="$EXPECT,jit-caught,jit-seasoned"
echo "[demo] narrative check (expect $EXPECT):"
set +e
(cd "$ROOT/services" && pnpm -s story --expect "$EXPECT" ${STORY_ARGS[@]+"${STORY_ARGS[@]}"}) | tee "$LOGS/story.log"
rc=${PIPESTATUS[0]}
exit "$rc"
