#!/usr/bin/env sh
set -eu

if [ "$#" -eq 0 ]; then
  echo "Usage: scripts/ask-gemini.sh <question or task>" >&2
  exit 1
fi

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
echo "[omx] wrapper deprecation: prefer 'omx ask gemini \"...\"'." >&2
if [ -x "$SCRIPT_DIR/../bin/omx" ]; then
  exec "$SCRIPT_DIR/../bin/omx" ask gemini "$@"
fi
exec node "$SCRIPT_DIR/run-provider-advisor.js" gemini "$@"
