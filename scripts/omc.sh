#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

cmd="${1:-help}"
slug="${2:-}"
model_arg="${3:-}"
workspace_arg="${4:-}"

case "$cmd" in
  mode)
    target="${2:-show}"
    node dist/cli/omx.js mode "$target"
    ;;
  doctor)
    echo "[omc] mode: $(node dist/cli/omx.js mode show | sed 's/\[mode\] //')"
    npm run doctor
    npm run cursor:doctor
    ;;
  new)
    if [[ -z "$slug" ]]; then
      echo "usage: scripts/omc.sh new <change-slug>"
      exit 2
    fi
    ./scripts/bootstrap-change.sh "$slug"
    ;;
  plan)
    if [[ -z "$slug" ]]; then
      echo "usage: scripts/omc.sh plan <change-slug>"
      exit 2
    fi
    node dist/cli/omx.js cursor plan "$slug"
    ;;
  apply)
    if [[ -z "$slug" ]]; then
      echo "usage: scripts/omc.sh apply <change-slug>"
      exit 2
    fi
    # Default to Cursor CLI execution path.
    # Optional:
    #   scripts/omc.sh apply <slug> <model> <workspace>
    trust_flag="--trust"
    if [[ "${OMC_CURSOR_TRUST:-1}" = "0" ]]; then
      trust_flag=""
    fi

    if [[ -n "$model_arg" ]]; then
      if [[ -n "$workspace_arg" ]]; then
        node dist/cli/omx.js cursor apply "$slug" --run ${trust_flag} --model "$model_arg" --workspace "$workspace_arg"
      else
        node dist/cli/omx.js cursor apply "$slug" --run ${trust_flag} --model "$model_arg"
      fi
    else
      if [[ -n "$workspace_arg" ]]; then
        node dist/cli/omx.js cursor apply "$slug" --run ${trust_flag} --workspace "$workspace_arg"
      else
        node dist/cli/omx.js cursor apply "$slug" --run ${trust_flag}
      fi
    fi
    echo "[omc] After implementation run: scripts/omc.sh review ${slug}"
    ;;
  review)
    if [[ -z "$slug" ]]; then
      echo "usage: scripts/omc.sh review <change-slug>"
      exit 2
    fi
    ./scripts/check-drift.sh "$slug"
    ;;
  archive)
    if [[ -z "$slug" ]]; then
      echo "usage: scripts/omc.sh archive <change-slug>"
      exit 2
    fi
    node dist/cli/omx.js cursor archive "$slug"
    ;;
  help|--help|-h|*)
    cat <<'EOF'
OMC cursor-first helper

Usage:
  scripts/omc.sh mode <show|cursor|codex>
  scripts/omc.sh doctor
  scripts/omc.sh new <change-slug>
  scripts/omc.sh plan <change-slug>
  scripts/omc.sh apply <change-slug> [model] [workspace]
  scripts/omc.sh review <change-slug>
  scripts/omc.sh archive <change-slug>
EOF
    ;;
esac

