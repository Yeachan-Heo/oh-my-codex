#!/usr/bin/env bash
#
# OMX Tmux Claude Workers Demo Script
#
# This script demonstrates the tmux-based multi-agent orchestration system
# with Claude Code CLI workers. It showcases:
# - Multi-worker coordination in tmux panes
# - Task lifecycle management (create, claim, complete)
# - Mailbox-based communication between workers
# - Mixed workload distribution across Claude workers
#
# Usage:
#   ./scripts/demo-claude-workers.sh
#
# Environment Variables:
#   WORKER_COUNT                    Number of workers (default: 3, minimum: 2)
#   TEAM_TASK                       Task description (default: "tmux claude workers demo")
#   TEAM_NAME                       Team identifier (default: slugified TEAM_TASK)
#   OMX_TEAM_WORKER_LAUNCH_MODE     Worker launch mode (default: interactive)
#   OMX_TEAM_WORKER_LAUNCH_ARGS     Arguments passed to Claude CLI
#
# Example:
#   WORKER_COUNT=5 ./scripts/demo-claude-workers.sh
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

require_bin omx
require_bin jq
require_bin tmux

WORKER_COUNT="${WORKER_COUNT:-3}"
if ! [[ "$WORKER_COUNT" =~ ^[0-9]+$ ]]; then
  echo "error: WORKER_COUNT must be a positive integer (got: $WORKER_COUNT)" >&2
  exit 1
fi
if ((WORKER_COUNT < 2)); then
  echo "error: WORKER_COUNT must be >= 2 for this demo (got: $WORKER_COUNT)" >&2
  exit 1
fi

TEAM_TASK="${TEAM_TASK:-tmux claude workers demo}"
TEAM_NAME="${TEAM_NAME:-$(slugify "$TEAM_TASK")}"
OMX_TEAM_WORKER_LAUNCH_MODE="${OMX_TEAM_WORKER_LAUNCH_MODE:-interactive}"

# All workers use Claude CLI for this demo
build_claude_cli_map() {
  local count="$1"
  local entries=()
  local i
  for ((i = 1; i <= count; i++)); do
    entries+=("claude")
  done
  (IFS=,; echo "${entries[*]}")
}

OMX_TEAM_WORKER_CLI="${OMX_TEAM_WORKER_CLI:-auto}"
OMX_TEAM_WORKER_CLI_MAP="${OMX_TEAM_WORKER_CLI_MAP:-$(build_claude_cli_map "$WORKER_COUNT")}"

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

echo "== OMX Tmux Claude Workers Demo v${SCRIPT_VERSION} =="
echo "TEAM_TASK=$TEAM_TASK"
echo "TEAM_NAME=$TEAM_NAME"
echo "WORKER_COUNT=$WORKER_COUNT"
echo "OMX_TEAM_WORKER_CLI=$OMX_TEAM_WORKER_CLI"
echo "OMX_TEAM_WORKER_CLI_MAP=$OMX_TEAM_WORKER_CLI_MAP"
echo ""
echo "This demo showcases Claude Code CLI workers in tmux panes"
echo "coordinated through the OMX team orchestration system."
echo ""

echo "[1/10] Starting team with ${WORKER_COUNT} Claude workers..."
omx team "${WORKER_COUNT}:executor" "$TEAM_TASK"
TEAM_STARTED=1
echo ""

echo "[2/10] Checking team status..."
omx team status "$TEAM_NAME"
echo ""

echo "[3/10] Creating distributed tasks for workers..."
for i in $(seq 1 "$WORKER_COUNT"); do
  TASK_SUBJECT="Demo task $i"
  TASK_DESC="Demonstration task for Claude worker-$i showcasing tmux-based multi-agent orchestration"
  CREATE_INPUT="$(jq -nc \
    --arg team "$TEAM_NAME" \
    --arg subject "$TASK_SUBJECT" \
    --arg description "$TASK_DESC" \
    --arg owner "worker-$i" \
    '{team_name:$team,subject:$subject,description:$description,owner:$owner}')"
  CREATE_JSON="$(omx team api create-task --input "$CREATE_INPUT" --json)"
  TASK_ID="$(echo "$CREATE_JSON" | jq -r '.data.task.id // empty')"
  if [[ -n "$TASK_ID" ]]; then
    echo "  Created task $TASK_ID for worker-$i"
  fi
done
echo ""

echo "[4/10] Listing all tasks..."
LIST_INPUT="$(jq -nc --arg team "$TEAM_NAME" '{team_name:$team}')"
omx team api list-tasks --input "$LIST_INPUT" --json | jq -r '.data.tasks[] | "  Task \(.id): \(.subject) [\(.status)]"'
echo ""

echo "[5/10] Workers claiming their assigned tasks..."
for i in $(seq 1 "$WORKER_COUNT"); do
  WORKER_NAME="worker-$i"
  # Find task assigned to this worker
  TASK_ID="$(omx team api list-tasks --input "$(jq -nc --arg team "$TEAM_NAME" '{team_name:$team}')" --json | \
    jq -r --arg owner "$WORKER_NAME" '.data.tasks[] | select(.owner == $owner) | .id' | head -1)"

  if [[ -n "$TASK_ID" ]]; then
    CLAIM_INPUT="$(jq -nc \
      --arg team "$TEAM_NAME" \
      --arg task "$TASK_ID" \
      --arg worker "$WORKER_NAME" \
      '{team_name:$team,task_id:$task,worker:$worker,expected_version:1}')"
    CLAIM_JSON="$(omx team api claim-task --input "$CLAIM_INPUT" --json)"
    if echo "$CLAIM_JSON" | jq -e '.ok' >/dev/null; then
      echo "  $WORKER_NAME claimed task $TASK_ID"
    fi
  fi
done
echo ""

echo "[6/10] Simulating work completion - transitioning tasks to completed..."
for i in $(seq 1 "$WORKER_COUNT"); do
  WORKER_NAME="worker-$i"
  # Get the claimed task for this worker
  TASK_INFO="$(omx team api list-tasks --input "$(jq -nc --arg team "$TEAM_NAME" '{team_name:$team}')" --json | \
    jq -r --arg owner "$WORKER_NAME" '.data.tasks[] | select(.owner == $owner and .status == "in_progress") | [.id, .claim.token] | @tsv' | head -1)"

  if [[ -n "$TASK_INFO" ]]; then
    TASK_ID="$(echo "$TASK_INFO" | cut -f1)"
    CLAIM_TOKEN="$(echo "$TASK_INFO" | cut -f2)"

    TRANSITION_INPUT="$(jq -nc \
      --arg team "$TEAM_NAME" \
      --arg task "$TASK_ID" \
      --arg worker "$WORKER_NAME" \
      --arg token "$CLAIM_TOKEN" \
      '{team_name:$team,task_id:$task,worker:$worker,from:"in_progress",to:"completed",claim_token:$token}')"
    omx team api transition-task-status --input "$TRANSITION_INPUT" --json >/dev/null
    echo "  $WORKER_NAME completed task $TASK_ID"
  fi
done
echo ""

echo "[7/10] Testing mailbox communication..."
# Leader sends messages to workers
for i in $(seq 1 "$WORKER_COUNT"); do
  SEND_INPUT="$(jq -nc \
    --arg team "$TEAM_NAME" \
    --arg to "worker-$i" \
    --arg body "Hello from leader! Great work on the demo task." \
    '{team_name:$team,from_worker:"leader-fixed",to_worker:$to,body:$body}')"
  omx team api send-message --input "$SEND_INPUT" --json >/dev/null
  echo "  Sent message to worker-$i"
done

# Workers acknowledge
for i in $(seq 1 "$WORKER_COUNT"); do
  WORKER_NAME="worker-$i"
  MAILBOX_INPUT="$(jq -nc --arg team "$TEAM_NAME" --arg worker "$WORKER_NAME" '{team_name:$team,worker:$worker}')"
  MAILBOX_JSON="$(omx team api mailbox-list --input "$MAILBOX_INPUT" --json)"
  MESSAGE_COUNT="$(echo "$MAILBOX_JSON" | jq -r '.data.messages | length')"
  echo "  $WORKER_NAME has $MESSAGE_COUNT messages in mailbox"
done
echo ""

echo "[8/10] Broadcasting sync message to all workers..."
BROADCAST_INPUT="$(jq -nc \
  --arg team "$TEAM_NAME" \
  --arg body "Sync checkpoint: All workers verify tmux coordination complete" \
  '{team_name:$team,from_worker:"leader-fixed",body:$body}')"
BROADCAST_RESULT="$(omx team api broadcast --input "$BROADCAST_INPUT" --json)"
BROADCAST_COUNT="$(echo "$BROADCAST_RESULT" | jq -r '.data.count')"
echo "  Broadcasted to $BROADCAST_COUNT workers"
echo ""

echo "[9/10] Verifying team summary..."
SUMMARY_INPUT="$(jq -nc --arg team "$TEAM_NAME" '{team_name:$team}')"
SUMMARY_JSON="$(omx team api get-summary --input "$SUMMARY_INPUT" --json)"
echo "$SUMMARY_JSON" | jq -e '.schema_version == "1.0" and .operation == "get-summary" and .ok == true' >/dev/null

# Extract and display summary stats
TOTAL_TASKS="$(echo "$SUMMARY_JSON" | jq -r '.data.summary.taskStatusById | length')"
COMPLETED_TASKS="$(echo "$SUMMARY_JSON" | jq -r '[.data.summary.taskStatusById[] | select(. == "completed")] | length')"
ALIVE_WORKERS="$(echo "$SUMMARY_JSON" | jq -r '[.data.summary.workerAliveByName[] | select(. == true)] | length')"
echo "  Total tasks: $TOTAL_TASKS"
echo "  Completed tasks: $COMPLETED_TASKS"
echo "  Alive workers: $ALIVE_WORKERS"
echo ""

echo "[10/10] Shutting down team and cleaning up..."
omx team shutdown "$TEAM_NAME"
omx team api cleanup --input "{\"team_name\":\"$TEAM_NAME\"}" --json >/dev/null
TEAM_STARTED=0
echo ""

echo "=========================================="
echo "Tmux Claude Workers Demo Complete!"
echo ""
echo "Summary:"
echo "  - Spawned $WORKER_COUNT Claude workers in tmux panes"
echo "  - Created and distributed $WORKER_COUNT tasks"
echo "  - Demonstrated claim-safe task lifecycle"
echo "  - Verified mailbox-based communication"
echo "  - Tested broadcast messaging"
echo "  - Clean shutdown and state cleanup"
echo ""
echo "The Claude workers were coordinated through the OMX"
echo "team orchestration system using tmux for process isolation"
echo "and the CLI interop API for state management."
echo "=========================================="
