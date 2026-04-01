#!/usr/bin/env sh
set -eu

if [ "$#" -eq 0 ]; then
  echo "Usage: scripts/ask-qwen.sh <question or task>" >&2
  exit 1
fi

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
echo "[omx] wrapper deprecation: prefer 'omx ask qwen \"...\"'." >&2
if [ -x "$SCRIPT_DIR/../bin/omx.js" ]; then
  exec node "$SCRIPT_DIR/../bin/omx.js" ask qwen "$@"
fi
exec node "$SCRIPT_DIR/run-provider-advisor.js" qwen "$@"
