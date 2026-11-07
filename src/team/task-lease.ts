/** Bash wrapper for a single long-running tool; only its direct child processes are owned. */
export const TASK_LEASE_SHELL_FUNCTION = `with_task_lease() (
  set +e
  set -o pipefail
  renewal_input=$1; shift
  renew() {
    omx team api renew-task-claim --input "$renewal_input" --json |
      node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const r=JSON.parse(s);process.exit(r.ok===true&&r.data?.ok===true?0:1)}catch{process.exit(1)}})'
  }
  work_pid=
  lease_pid=
  cleanup() {
    trap '' USR1 INT TERM
    for pid in "$lease_pid" "$work_pid"; do
      [ -z "$pid" ] || kill -TERM "$pid" 2>/dev/null || :
    done
    for attempt in 1 2 3 4 5 6 7 8 9 10; do
      alive=
      for pid in "$lease_pid" "$work_pid"; do
        [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null || alive=1
      done
      [ -n "$alive" ] || break
      /bin/sleep 0.1
    done
    for pid in "$lease_pid" "$work_pid"; do
      [ -z "$pid" ] || { kill -KILL "$pid" 2>/dev/null || :; wait "$pid" 2>/dev/null || :; }
    done
  }
  lease_owner_pid=$BASHPID
  trap cleanup EXIT
  trap 'exit 1' USR1
  trap 'exit 130' INT
  trap 'exit 143' TERM
  renew || exit 1
  "$@" & work_pid=$!
  (
    trap - EXIT
    sleep_pid=
    trap '[ -z "$sleep_pid" ] || { kill "$sleep_pid" 2>/dev/null || :; wait "$sleep_pid" 2>/dev/null || :; }; exit 0' TERM INT
    while kill -0 "$work_pid" 2>/dev/null; do
      sleep 300 & sleep_pid=$!
      wait "$sleep_pid" || exit 1
      sleep_pid=
      kill -0 "$work_pid" 2>/dev/null || exit 0
      renew || { kill -USR1 "$lease_owner_pid" 2>/dev/null || :; exit 1; }
    done
  ) & lease_pid=$!
  wait "$work_pid"; work_status=$?; work_pid=
  kill "$lease_pid" 2>/dev/null || :
  wait "$lease_pid"; lease_status=$?; lease_pid=
  [ "$lease_status" -ne 143 ] || lease_status=0
  [ "$work_status" -eq 0 ] || exit "$work_status"
  exit "$lease_status"
)`;

export const TASK_LEASE_INSTRUCTIONS = `After claiming, write {"state":"working","current_task_id":"<id>","current_claim_token":"<returned claimToken>","updated_at":"<ISO timestamp>"} to your worker status.json. Notify/PostToolUse heartbeats renew only that unexpired token. For work or tool waits over 5 minutes, define and use this Bash wrapper (replace the JSON placeholders with your current claim):
\`\`\`bash
${TASK_LEASE_SHELL_FUNCTION}
with_task_lease '{"team_name":"<team>","task_id":"<id>","worker":"<worker>","claim_token":"<returned claimToken>"}' <command> <args...>
\`\`\`
It renews before starting and every 5 minutes, fails closed on renewal failure, and cleans up its own direct children. Commands that spawn grandchildren must handle/terminate their own children. If renewal fails, stop editing and contact the leader; expired claims cannot be revived.`;
