#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash ./scripts/team-auto-run.sh [omx team args...]

Examples:
  bash ./scripts/team-auto-run.sh 3:executor "research X"
  bash ./scripts/team-auto-run.sh --worktree=feature-x ralph 3:executor "ship with verification"

Environment:
  TEAM_AUTO_POLL_SECONDS=10      # status polling interval
  TEAM_AUTO_DELETE_BRANCHES=1    # cleanup branch deletion (default: ralph=0, non-ralph=1)
  TEAM_AUTO_FORCE_ON_FAILURE=1   # force shutdown when failed>0 (default: ralph=0, non-ralph=1)
  TEAM_AUTO_SKIP_CANCEL=0        # pass --skip-cancel to cleanup
  TEAM_AUTO_CLEANUP_DRY_RUN=0    # pass --dry-run to cleanup
EOF
}

log() {
  printf "[team-auto] %s\n" "$*"
}

extract_int() {
  local line="$1"
  local key="$2"
  sed -n "s/.*${key}=\\([0-9][0-9]*\\).*/\\1/p" <<<"${line}" | head -n 1
}

is_ralph_args() {
  local arg
  for arg in "$@"; do
    if [[ "${arg,,}" == "ralph" ]]; then
      return 0
    fi
  done
  return 1
}

if [[ $# -eq 0 ]]; then
  usage
  exit 2
fi

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CLEANUP_SCRIPT="${SCRIPT_DIR}/team-post-shutdown-cleanup.sh"

if [[ ! -x "${CLEANUP_SCRIPT}" ]]; then
  echo "cleanup script not found or not executable: ${CLEANUP_SCRIPT}" >&2
  exit 1
fi
if ! command -v omx >/dev/null 2>&1; then
  echo "omx command not found in PATH" >&2
  exit 1
fi

POLL_SECONDS="${TEAM_AUTO_POLL_SECONDS:-10}"
IS_RALPH=0
if is_ralph_args "$@"; then
  IS_RALPH=1
fi

# Dedicated default policy for `omx team ralph ...` unless explicitly overridden.
if [[ -z "${TEAM_AUTO_DELETE_BRANCHES+x}" ]]; then
  DELETE_BRANCHES=$([[ "${IS_RALPH}" -eq 1 ]] && echo 0 || echo 1)
else
  DELETE_BRANCHES="${TEAM_AUTO_DELETE_BRANCHES}"
fi
if [[ -z "${TEAM_AUTO_FORCE_ON_FAILURE+x}" ]]; then
  FORCE_ON_FAILURE=$([[ "${IS_RALPH}" -eq 1 ]] && echo 0 || echo 1)
else
  FORCE_ON_FAILURE="${TEAM_AUTO_FORCE_ON_FAILURE}"
fi
SKIP_CANCEL="${TEAM_AUTO_SKIP_CANCEL:-0}"
CLEANUP_DRY_RUN="${TEAM_AUTO_CLEANUP_DRY_RUN:-0}"

TEAM_NAME=""

run_cleanup() {
  local force_shutdown="${1:-0}"
  if [[ -z "${TEAM_NAME}" ]]; then
    return 0
  fi
  local cmd=(bash "${CLEANUP_SCRIPT}" "${TEAM_NAME}")
  [[ "${DELETE_BRANCHES}" == "1" ]] && cmd+=(--delete-branches)
  [[ "${SKIP_CANCEL}" == "1" ]] && cmd+=(--skip-cancel)
  [[ "${force_shutdown}" == "1" ]] && cmd+=(--force-shutdown)
  [[ "${CLEANUP_DRY_RUN}" == "1" ]] && cmd+=(--dry-run)
  log "running cleanup: ${cmd[*]}"
  "${cmd[@]}"
}

on_interrupt() {
  log "interrupt received; attempting forced cleanup..."
  run_cleanup 1 || true
  exit 130
}
trap on_interrupt INT TERM

cd "${ROOT_DIR}"

if [[ "${IS_RALPH}" -eq 1 ]]; then
  log "ralph mode detected: default policy delete_branches=${DELETE_BRANCHES} force_on_failure=${FORCE_ON_FAILURE}"
else
  log "standard mode: default policy delete_branches=${DELETE_BRANCHES} force_on_failure=${FORCE_ON_FAILURE}"
fi

log "starting team: omx team $*"
START_OUTPUT="$(omx team "$@" 2>&1)"
printf '%s\n' "${START_OUTPUT}"

TEAM_NAME="$(sed -n 's/^Team started: //p' <<<"${START_OUTPUT}" | tail -n 1 | xargs)"
if [[ -z "${TEAM_NAME}" ]]; then
  echo "failed to parse team name from startup output" >&2
  exit 1
fi

log "team detected: ${TEAM_NAME}"
log "monitoring until terminal tasks, then auto-cleanup"

while true; do
  STATUS_OUTPUT="$(omx team status "${TEAM_NAME}" 2>&1 || true)"
  if grep -q '^No team state found' <<<"${STATUS_OUTPUT}"; then
    log "team state already missing (assume cleaned)"
    break
  fi

  TASK_LINE="$(grep '^tasks:' <<<"${STATUS_OUTPUT}" || true)"
  if [[ -z "${TASK_LINE}" ]]; then
    log "status parse pending; retrying in ${POLL_SECONDS}s"
    sleep "${POLL_SECONDS}"
    continue
  fi

  PENDING="$(extract_int "${TASK_LINE}" "pending")"
  BLOCKED="$(extract_int "${TASK_LINE}" "blocked")"
  IN_PROGRESS="$(extract_int "${TASK_LINE}" "in_progress")"
  COMPLETED="$(extract_int "${TASK_LINE}" "completed")"
  FAILED="$(extract_int "${TASK_LINE}" "failed")"
  PENDING="${PENDING:-0}"
  BLOCKED="${BLOCKED:-0}"
  IN_PROGRESS="${IN_PROGRESS:-0}"
  COMPLETED="${COMPLETED:-0}"
  FAILED="${FAILED:-0}"

  log "status pending=${PENDING} blocked=${BLOCKED} in_progress=${IN_PROGRESS} completed=${COMPLETED} failed=${FAILED}"

  if [[ "${PENDING}" -eq 0 && "${BLOCKED}" -eq 0 && "${IN_PROGRESS}" -eq 0 ]]; then
    if [[ "${FAILED}" -gt 0 && "${FORCE_ON_FAILURE}" != "1" ]]; then
      if [[ "${IS_RALPH}" -eq 1 ]]; then
        log "ralph policy guard: failed tasks present, skipping force-shutdown/cleanup to preserve triage context."
        log "set TEAM_AUTO_FORCE_ON_FAILURE=1 if you intentionally want forced teardown."
        exit 3
      fi
      run_cleanup 0
      break
    fi

    FORCE_SHUTDOWN=0
    if [[ "${FAILED}" -gt 0 && "${FORCE_ON_FAILURE}" == "1" ]]; then
      FORCE_SHUTDOWN=1
      log "failed tasks detected; using forced shutdown cleanup"
    fi
    run_cleanup "${FORCE_SHUTDOWN}"
    break
  fi

  sleep "${POLL_SECONDS}"
done

log "auto-run complete"
