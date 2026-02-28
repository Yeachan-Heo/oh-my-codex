#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash ./scripts/team-post-shutdown-cleanup.sh <team-name> [options]

Options:
  --force-shutdown   Force shutdown even when tasks are not terminal
  --delete-branches  Delete worker branches after removing worktrees
  --skip-cancel      Skip `omx cancel` at the end
  --dry-run          Print planned actions without executing
  -h, --help         Show help
EOF
}

log() {
  printf "[team-cleanup] %s\n" "$*"
}

run_cmd() {
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    printf "[team-cleanup][dry-run] "
    printf "%q " "$@"
    printf "\n"
    return 0
  fi
  "$@"
}

team_status_value() {
  local line="$1"
  local key="$2"
  sed -n "s/.*${key}=\\([0-9][0-9]*\\).*/\\1/p" <<<"${line}" | head -n 1
}

array_contains() {
  local needle="$1"
  shift || true
  local item
  for item in "$@"; do
    [[ "${item}" == "${needle}" ]] && return 0
  done
  return 1
}

TEAM_NAME=""
FORCE_SHUTDOWN=0
DELETE_BRANCHES=0
SKIP_CANCEL=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force-shutdown)
      FORCE_SHUTDOWN=1
      shift
      ;;
    --delete-branches)
      DELETE_BRANCHES=1
      shift
      ;;
    --skip-cancel)
      SKIP_CANCEL=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
    *)
      if [[ -z "${TEAM_NAME}" ]]; then
        TEAM_NAME="$1"
        shift
      else
        echo "Unexpected extra argument: $1" >&2
        usage
        exit 2
      fi
      ;;
  esac
done

if [[ -z "${TEAM_NAME}" ]]; then
  usage
  exit 2
fi

if ! command -v omx >/dev/null 2>&1; then
  echo "omx command not found in PATH" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git command not found in PATH" >&2
  exit 1
fi

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "${ROOT_DIR}"

TEAM_STATE_DIR="${ROOT_DIR}/.omx/state/team/${TEAM_NAME}"
WORKTREE_PREFIX="${ROOT_DIR}.omx-worktrees/team-${TEAM_NAME}-worker-"

log "repo: ${ROOT_DIR}"
log "team: ${TEAM_NAME}"

if [[ -d "${TEAM_STATE_DIR}" ]]; then
  log "team state exists: ${TEAM_STATE_DIR}"
  STATUS_OUTPUT="$(omx team status "${TEAM_NAME}" 2>&1 || true)"
  log "status:"
  while IFS= read -r line; do
    [[ -n "${line}" ]] && log "  ${line}"
  done <<<"${STATUS_OUTPUT}"

  TASK_LINE="$(grep '^tasks:' <<<"${STATUS_OUTPUT}" || true)"
  if [[ -n "${TASK_LINE}" ]]; then
    PENDING="$(team_status_value "${TASK_LINE}" "pending")"
    BLOCKED="$(team_status_value "${TASK_LINE}" "blocked")"
    IN_PROGRESS="$(team_status_value "${TASK_LINE}" "in_progress")"
    FAILED="$(team_status_value "${TASK_LINE}" "failed")"
    PENDING="${PENDING:-0}"
    BLOCKED="${BLOCKED:-0}"
    IN_PROGRESS="${IN_PROGRESS:-0}"
    FAILED="${FAILED:-0}"
    if [[ "${FORCE_SHUTDOWN}" -ne 1 ]] && { [[ "${PENDING}" -gt 0 ]] || [[ "${BLOCKED}" -gt 0 ]] || [[ "${IN_PROGRESS}" -gt 0 ]] || [[ "${FAILED}" -gt 0 ]]; }; then
      echo "Team is not terminal (pending=${PENDING}, blocked=${BLOCKED}, in_progress=${IN_PROGRESS}, failed=${FAILED})." >&2
      echo "Re-run with --force-shutdown if you want to bypass the gate." >&2
      exit 1
    fi
  fi

  SHUTDOWN_CMD=(omx team shutdown "${TEAM_NAME}")
  [[ "${FORCE_SHUTDOWN}" -eq 1 ]] && SHUTDOWN_CMD+=(--force)
  run_cmd "${SHUTDOWN_CMD[@]}"
else
  log "team state dir not found (skip shutdown step): ${TEAM_STATE_DIR}"
fi

declare -a WORKTREE_ENTRIES=()
while IFS=$'\t' read -r wt_path branch_ref; do
  [[ -z "${wt_path}" ]] && continue
  WORKTREE_ENTRIES+=("${wt_path}"$'\t'"${branch_ref}")
done < <(
  git worktree list --porcelain | awk -v prefix="${WORKTREE_PREFIX}" '
    /^worktree / { wt = substr($0, 10); br = ""; next }
    /^branch /   { br = substr($0, 8); next }
    /^$/ {
      if (wt != "" && index(wt, prefix) == 1) print wt "\t" br
      wt = ""
      br = ""
    }
    END {
      if (wt != "" && index(wt, prefix) == 1) print wt "\t" br
    }
  '
)

if [[ "${#WORKTREE_ENTRIES[@]}" -eq 0 ]]; then
  log "no matching team worktrees found for prefix: ${WORKTREE_PREFIX}"
else
  log "found ${#WORKTREE_ENTRIES[@]} matching worktree(s)"
fi

declare -a BRANCH_CANDIDATES=()
if [[ "${#WORKTREE_ENTRIES[@]}" -gt 0 ]]; then
  for entry in "${WORKTREE_ENTRIES[@]}"; do
    IFS=$'\t' read -r wt_path branch_ref <<<"${entry}"
    run_cmd git worktree remove --force "${wt_path}"
    if [[ "${DELETE_BRANCHES}" -eq 1 && "${branch_ref}" == refs/heads/* ]]; then
      branch_name="${branch_ref#refs/heads/}"
      if ! array_contains "${branch_name}" "${BRANCH_CANDIDATES[@]-}"; then
        BRANCH_CANDIDATES+=("${branch_name}")
      fi
    fi
  done
fi

if [[ "${DELETE_BRANCHES}" -eq 1 && "${#BRANCH_CANDIDATES[@]}" -gt 0 ]]; then
  for branch_name in "${BRANCH_CANDIDATES[@]}"; do
    if git worktree list --porcelain | grep -Fq "branch refs/heads/${branch_name}"; then
      log "skip branch delete (still checked out): ${branch_name}"
      continue
    fi
    if git show-ref --verify --quiet "refs/heads/${branch_name}"; then
      run_cmd git branch -D "${branch_name}"
    else
      log "branch already absent: ${branch_name}"
    fi
  done
fi

if [[ "${SKIP_CANCEL}" -eq 1 ]]; then
  log "skip omx cancel"
else
  run_cmd omx cancel
fi

if [[ -d "${TEAM_STATE_DIR}" ]]; then
  log "warning: team state directory still exists: ${TEAM_STATE_DIR}"
else
  log "team state cleaned: ${TEAM_STATE_DIR}"
fi

LEFTOVER_COUNT="$(
  git worktree list --porcelain | awk -v prefix="${WORKTREE_PREFIX}" '
    /^worktree / { wt = substr($0, 10) }
    /^$/ {
      if (wt != "" && index(wt, prefix) == 1) count += 1
      wt = ""
    }
    END { print count + 0 }
  '
)"

if [[ "${LEFTOVER_COUNT}" -gt 0 ]]; then
  log "warning: ${LEFTOVER_COUNT} matching worktree(s) still remain"
else
  log "no leftover worktrees for team prefix"
fi

log "done"
