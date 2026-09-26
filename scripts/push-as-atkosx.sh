#!/usr/bin/env bash
# Sync this working tree into a staging clone of the team repo and push as the ACTIVE `gh` account.
#
# Why this exists: the local tree has no .git (and vendors contracts/lib as plain files, while the repo
# uses submodules), and the macOS keychain may hold a token for a different GitHub account that hijacks
# HTTPS pushes. This script copies only tracked-worthy files into a clone, commits, and pushes using the
# token of whichever account `gh` has active (check with `gh api user --jq .login`; switch with `gh auth switch`).
#
# Usage:  scripts/push-as-atkosx.sh "commit message"          (from anywhere inside the repo)
#         PUSH_USER=atkosX scripts/push-as-atkosx.sh "msg"    (override the GitHub username)
set -euo pipefail
MSG="${1:?usage: $0 \"commit message\"}"
REPO_URL="${REPO_URL:-https://github.com/oniblok/oniblock}"
SRC="$(cd "$(dirname "$0")/.." && pwd)/"
STAGE="${STAGE:-$HOME/.oniblock-push}"
PUSH_USER="${PUSH_USER:-$(gh api user --jq .login)}"
EMAIL="${PUSH_EMAIL:-$(gh api user --jq .id)+${PUSH_USER}@users.noreply.github.com}"

[ -d "$STAGE/.git" ] || git clone -q "$REPO_URL" "$STAGE"
cd "$STAGE"
git config user.name "$PUSH_USER"; git config user.email "$EMAIL"
git -c credential.helper= -c "credential.helper=!f(){ echo username=$PUSH_USER; echo password=\$(gh auth token); }; f" pull -q --ff-only origin main

rsync -rlpt --checksum --delete-excluded \
  --exclude .git/ --exclude .gitmodules --exclude node_modules/ --exclude .next/ --exclude out/ --exclude cache/ \
  --exclude broadcast/ --exclude .runtime/ --exclude '.env' --exclude '.env.*' --exclude '*.log' --exclude .DS_Store \
  --exclude '*.tsbuildinfo' --exclude .cache/ --exclude __pycache__/ --exclude contracts/lib/ \
  --exclude ml/.venv/ --exclude ml/vendor/ --exclude ml/raw/ --exclude 'ml/data/*.parquet' --exclude ml/data/kev/ \
  --exclude ml/train_kev4b/data/ --exclude benchmark/results/quick/ --exclude 'deployments/*.e2e.json' \
  --exclude 'deployments/*.review*.json' \
  "$SRC" "$STAGE/"

if git status --short | grep -qE '\.env$|keys\.txt'; then echo "refusing: secret file staged"; exit 1; fi
git add -A
if git diff --cached --quiet; then echo "nothing to push"; exit 0; fi
git commit -q -m "$MSG"
git -c credential.helper= -c "credential.helper=!f(){ echo username=$PUSH_USER; echo password=\$(gh auth token); }; f" push origin main
echo "pushed as $PUSH_USER: $(git log -1 --format='%h %s')"
