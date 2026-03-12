#!/usr/bin/env bash
#
# OMX Team E2E Demo Script
#
# This script demonstrates the tmux-based multi-agent orchestration system
# with mixed Codex/Claude workers. It performs a complete end-to-end test
# of team lifecycle, task management, and mailbox communication.
#
# Usage:
#   ./scripts/demo-team-e2e.sh
#
# Environment Variables:
#   WORKER_COUNT                    Number of workers (default: 6, minimum: 5)
#   TEAM_TASK                       Task description (default: "e2e team demo <timestamp>")
#   TEAM_NAME                       Team identifier (default: slugified TEAM_TASK)
#   OMX_TEAM_WORKER_CLI             Worker CLI mode (default: auto)
#   OMX_TEAM_WORKER_CLI_MAP         Comma-separated CLI assignments per worker
#   OMX_TEAM_WORKER_LAUNCH_ARGS     Arguments passed to worker CLIs
#
# Example:
#   WORKER_COUNT=8 ./scripts/demo-team-e2e.sh
#
# shellcheck disable=SC2317  # Functions are called via trap

set -euo pipefail

readonly SCRIPT_VERSION="1.0.0"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

require_bin() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required command not found: $1" >&2
    exit 1
  fi
}

slugify() {
  echo "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g' \
    | cut -c1-30
}

build_default_cli_map() {
  local count="$1"
  # More claude than codex for mixed demos (emphasizes claude workers)
  # For 6 workers: 2 codex, 4 claude
  local pivot=$(((count - 1) / 2))
  local entries=()
  local i
  for ((i = 1; i <= count; i++)); do
    if ((i <= pivot)); then
      entries+=("codex")
    else
      entries+=("claude")
    fi
  done
  (IFS=,; echo "${entries[*]}")
}

require_bin omx
require_bin jq

WORKER_COUNT="${WORKER_COUNT:-6}"
if ! [[ "$WORKER_COUNT" =~ ^[0-9]+$ ]]; then
  echo "error: WORKER_COUNT must be a positive integer (got: $WORKER_COUNT)" >&2
  exit 1
fi
if ((WORKER_COUNT < 5)); then
  echo "error: WORKER_COUNT must be >= 5 for this demo (got: $WORKER_COUNT)" >&2
  exit 1
fi

# Validate CLI map length matches worker count when explicitly provided
if [[ -n "${OMX_TEAM_WORKER_CLI_MAP:-}" ]]; then
  IFS=',' read -ra CLI_MAP_ENTRIES <<< "$OMX_TEAM_WORKER_CLI_MAP"
  if (("${#CLI_MAP_ENTRIES[@]}" != WORKER_COUNT)); then
    echo "error: OMX_TEAM_WORKER_CLI_MAP has ${#CLI_MAP_ENTRIES[@]} entries but WORKER_COUNT is $WORKER_COUNT" >&2
    exit 1
  fi
fi

TEAM_TASK="${TEAM_TASK:-e2e team demo $(date -u +%Y%m%d%H%M%S)}"
TEAM_NAME="${TEAM_NAME:-$(slugify "$TEAM_TASK")}"
OMX_TEAM_WORKER_CLI="${OMX_TEAM_WORKER_CLI:-auto}"
OMX_TEAM_WORKER_CLI_MAP="${OMX_TEAM_WORKER_CLI_MAP:-$(build_default_cli_map "$WORKER_COUNT")}"
OMX_TEAM_WORKER_LAUNCH_ARGS="${OMX_TEAM_WORKER_LAUNCH_ARGS:--c model_reasoning_effort=\"low\"}"

TEAM_STARTED=0
cleanup() {
  if ((TEAM_STARTED == 1)); then
    echo "[cleanup] shutting down team: $TEAM_NAME"
    omx team shutdown "$TEAM_NAME" >/dev/null 2>&1 || true
    echo "[cleanup] cleaning state for team: $TEAM_NAME"
    omx team api cleanup --input "{\"team_name\":\"$TEAM_NAME\"}" --json >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "== OMX Team E2E demo =="
echo "TEAM_TASK=$TEAM_TASK"
echo "TEAM_NAME=$TEAM_NAME"
echo "WORKER_COUNT=$WORKER_COUNT"
echo "OMX_TEAM_WORKER_CLI=$OMX_TEAM_WORKER_CLI"
echo "OMX_TEAM_WORKER_CLI_MAP=$OMX_TEAM_WORKER_CLI_MAP"
echo "OMX_TEAM_WORKER_LAUNCH_ARGS=$OMX_TEAM_WORKER_LAUNCH_ARGS"

echo "[1/8] start team (${WORKER_COUNT} mixed workers)"
omx team "${WORKER_COUNT}:executor" "$TEAM_TASK"
TEAM_STARTED=1

echo "[2/8] status"
omx team status "$TEAM_NAME"

echo "[3/8] create task"
CREATE_INPUT="$(jq -nc \
  --arg team "$TEAM_NAME" \
  --arg subject "one-shot lifecycle" \
  --arg description "demo task" \
  --arg owner "worker-1" \
  '{team_name:$team,subject:$subject,description:$description,owner:$owner}')"
CREATE_JSON="$(omx team api create-task --input "$CREATE_INPUT" --json)"
TASK_ID="$(echo "$CREATE_JSON" | jq -r '.data.task.id // empty')"
if [[ -z "$TASK_ID" ]]; then
  echo "error: failed to parse task id from create-task response" >&2
  exit 1
fi
echo "task_id=$TASK_ID"

echo "[4/8] claim task"
CLAIM_INPUT="$(jq -nc \
  --arg team "$TEAM_NAME" \
  --arg task "$TASK_ID" \
  --arg worker "worker-1" \
  '{team_name:$team,task_id:$task,worker:$worker,expected_version:1}')"
CLAIM_JSON="$(omx team api claim-task --input "$CLAIM_INPUT" --json)"
CLAIM_TOKEN="$(echo "$CLAIM_JSON" | jq -r '.data.claimToken // empty')"
if [[ -z "$CLAIM_TOKEN" ]]; then
  echo "error: failed to parse claimToken from claim-task response" >&2
  exit 1
fi

echo "[5/8] transition task -> completed"
TRANSITION_INPUT="$(jq -nc \
  --arg team "$TEAM_NAME" \
  --arg task "$TASK_ID" \
  --arg token "$CLAIM_TOKEN" \
  '{team_name:$team,task_id:$task,from:"in_progress",to:"completed",claim_token:$token}')"
omx team api transition-task-status --input "$TRANSITION_INPUT" --json >/dev/null

echo "[6/8] mailbox flow"
SEND_INPUT="$(jq -nc \
  --arg team "$TEAM_NAME" \
  --arg body "ACK one-shot" \
  '{team_name:$team,from_worker:"leader-fixed",to_worker:"worker-1",body:$body}')"
omx team api send-message --input "$SEND_INPUT" --json >/dev/null
MAILBOX_INPUT="$(jq -nc --arg team "$TEAM_NAME" '{team_name:$team,worker:"worker-1"}')"
MAILBOX_JSON="$(omx team api mailbox-list --input "$MAILBOX_INPUT" --json)"
MESSAGE_ID="$(echo "$MAILBOX_JSON" | jq -r '.data.messages[0].id // empty')"
if [[ -n "$MESSAGE_ID" ]]; then
  MARK_INPUT="$(jq -nc \
    --arg team "$TEAM_NAME" \
    --arg id "$MESSAGE_ID" \
    '{team_name:$team,worker:"worker-1",message_id:$id}')"
  omx team api mailbox-mark-notified --input "$MARK_INPUT" --json >/dev/null
  omx team api mailbox-mark-delivered --input "$MARK_INPUT" --json >/dev/null
fi

echo "[7/8] summary envelope check"
SUMMARY_INPUT="$(jq -nc --arg team "$TEAM_NAME" '{team_name:$team}')"
SUMMARY_JSON="$(omx team api get-summary --input "$SUMMARY_INPUT" --json)"
echo "$SUMMARY_JSON" | jq -e '.schema_version == "1.0" and .operation == "get-summary" and .ok == true' >/dev/null

echo "[8/8] shutdown + cleanup"
omx team shutdown "$TEAM_NAME"
omx team api cleanup --input "{\"team_name\":\"$TEAM_NAME\"}" --json >/dev/null
TEAM_STARTED=0

echo "E2E demo complete."
