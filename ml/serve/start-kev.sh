#!/usr/bin/env bash
# Start the local Kev System One server that serves oniblock1 to the keeper (MODEL_MODE=oniblock1, services/src/model/kev.ts).
# oniblock1 = the Kev-0.8B (jaredpalmer/kev-0.8b) LoRA fine-tune in ml/models/kev08b-v1/adapter (v1 data: the keeper must send
# KEV_STATE_FORMAT=auto, the base-fee state wording); Kev's own server answers `POST /v1/systemone`.
#   KEV_ADAPTER=<dir>      checkpoint dir to serve (default ml/models/kev08b-v1/adapter; a Hub id also works)
#   KEV_HOME=<dir>         Kev checkout with a venv (default ml/vendor/kev if present, else ~/kev);
#                          set up once with (cd "$KEV_HOME" && uv sync --extra serve)
#   KEV_PORT=8008          keeper default KEV_URL=http://127.0.0.1:8008/v1/systemone
#   KEV_HOST=127.0.0.1     interface to bind
# The served temperature is the checkpoint's own (fitted on val_1k, stored with the head).
set -euo pipefail
ML="$(cd "$(dirname "$0")/.." && pwd)"
ADAPTER="${KEV_ADAPTER:-$ML/models/kev08b-v1/adapter}"
if [[ -z "${KEV_HOME:-}" ]]; then
  if [[ -d "$ML/vendor/kev" ]]; then KEV_HOME="$ML/vendor/kev"; else KEV_HOME="$HOME/kev"; fi
fi
PORT="${KEV_PORT:-8008}"
HOST="${KEV_HOST:-127.0.0.1}"
PY="$KEV_HOME/.venv/bin/python"
if [[ ! -x "$PY" ]]; then
  echo "start-kev: no Kev venv at $PY (git clone https://github.com/jaredpalmer/kev \"$KEV_HOME\" && cd \"$KEV_HOME\" && uv sync --extra serve)" >&2
  exit 1
fi
if [[ "$ADAPTER" == /* || "$ADAPTER" == .* ]] && [[ ! -d "$ADAPTER" ]]; then
  echo "start-kev: adapter dir $ADAPTER not found" >&2
  exit 1
fi
cd "$KEV_HOME"
echo "kev serve: oniblock1 adapter=$ADAPTER kev=$KEV_HOME host=$HOST port=$PORT" >&2
exec "$PY" -m kev.serve --run "$ADAPTER" --host "$HOST" --port "$PORT"
