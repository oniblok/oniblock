#!/usr/bin/env bash
# Start the local Kev System One server used by the keeper (MODEL_MODE=kev, services/src/model/kev.ts).
#   KEV_MODEL=0.8b|4b      which fine-tuned model (default 0.8b); keeper model node kev-v1 / kev4b-v1
#   KEV_ADAPTER=<dir>      fine-tuned checkpoint dir (default ml/models/kev-<size>-oniblock); a Hub id also works
#   KEV_TEMPERATURE=<T>    optional served temperature override (see ml/RESULTS.md; default = the checkpoint's own)
#   KEV_PORT=8008          keeper default KEV_URL=http://127.0.0.1:8008/v1/systemone
# Requires the vendored Kev env: (cd ml/vendor/kev && uv sync --extra serve)
set -euo pipefail
ML="$(cd "$(dirname "$0")/.." && pwd)"
SIZE="${KEV_MODEL:-0.8b}"
ADAPTER="${KEV_ADAPTER:-$ML/models/kev-${SIZE}-oniblock}"
PORT="${KEV_PORT:-8008}"
cd "$ML/vendor/kev"
echo "kev serve: model=$SIZE adapter=$ADAPTER port=$PORT" >&2
exec .venv/bin/python -m kev.serve --run "$ADAPTER" --port "$PORT"
