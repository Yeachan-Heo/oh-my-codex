#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"

cd "$REPO_ROOT"

: "${OMX_COMPAT_TARGET:=$REPO_ROOT/bin/omx}"
export OMX_COMPAT_TARGET

npm run test:compat:node
