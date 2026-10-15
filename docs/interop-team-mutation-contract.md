# OMX Team Mutation Contract for Interop Brokers

This document defines the supported **mutation path** for external interoperability brokers.

## Rule of record

External systems must mutate team state through CLI interop:

```bash
omx team api <operation> --input '<json-object>' --json
```

Legacy `team_*` MCP APIs are hard-deprecated and return a deprecation error with a CLI hint.
Direct writes to `.omx/state/team/...` are unsupported and may violate runtime invariants.

## Required task mutation flow

1. Read current task:
   - `omx team api read-task --json`
2. Claim with optimistic version:
   - `omx team api claim-task --json`
3. Transition terminal state with claim token:
   - `omx team api transition-task-status --json` (`in_progress -> completed|failed`)
4. Use `omx team api release-task-claim --json` only for rollback/requeue-to-pending flows.

## Worker completion evidence

Tasks explicitly marked `requires_code_change: true` must supply a JSON evidence
report before transitioning from `in_progress` to `completed`. This validates the
report's format and association with the current claim; it does not authenticate
whether the reported commands actually ran. Existing claim, lease, delegation and
coordination checks still apply.

After claiming, write the report under `.omx/evidence/` in the worker's assigned
`working_dir`. If that directory is not configured, paths resolve from the API
call's working directory. Use a path without whitespace, for example
`.omx/evidence/task-1.json`:

```json
{
  "teamName": "my-team",
  "taskId": "1",
  "claimTokenSha256": "<SHA-256 hex digest of the current claim token>",
  "summary": "Fix addition and verify positive and negative inputs",
  "verification": [
    {
      "command": "node --test add.test.mjs",
      "result": "passed",
      "output": "2 tests passed; 0 failed"
    }
  ],
  "unverified": ["Manual UI validation was not run"]
}
```

Replace the example identity, digest and verification output with the actual task
and observed results. Hash the token returned by the latest successful `claim-task`
using SHA-256 with lowercase hexadecimal encoding; do not put the raw token in the
report.
`verification` must contain at least one check with a non-empty command, the exact
result `"passed"`, and non-empty output. `summary` must be non-empty. Obvious
placeholder values such as `TODO`, `TBD` and `not run` are rejected in these text
fields. `unverified` is a required array of non-empty, non-placeholder descriptions
of validation gaps; use `[]` when there are none.

Complete through the existing API, with both a structured verification summary
and the evidence marker on its own line in the `result` string:

```bash
omx team api transition-task-status --input '{"team_name":"my-team","task_id":"1","from":"in_progress","to":"completed","claim_token":"<current-claim-token>","result":"Verification: PASS\nEVIDENCE_RECORDED: .omx/evidence/task-1.json"}' --json
```

The summary must pass the existing team verification gate: include `Verification:`
or a `## Verification` heading and PASS/FAIL checks or command references. A marker
alone, or a heading without a verification signal, is rejected even with a valid
report. The task stays `in_progress`, so the client can correct the result and retry
with the same live claim instead of leaving a completed task stuck in `team-verify`.

The report must be a regular, non-empty JSON file of at most 1 MiB, located inside
the worker's `.omx/evidence/` directory. Symlinked files or directories beneath
the working directory are rejected. Its
modification time must be at or after the current claim's `claimed_at`, and its
`teamName`, string `taskId` and `claimTokenSha256` must match the task and claim.
After releasing and reclaiming, regenerate the report with the new token's hash;
refreshing only the old report's modification time is insufficient.

A rejected report returns `data.ok: false`, `data.error: "invalid_completion_evidence"`
and a human-readable `data.reason`. The outer envelope may still have `ok: true`:
clients must inspect `data.ok`, not just the process exit status or envelope. A
rejection leaves the task, completion events and completion monitor marker unchanged.

### Compatibility

- Tasks with `requires_code_change: false` or an absent flag retain their existing
  completion behavior. Transitions to `failed` do not require this report. Already
  completed task records are not revalidated.
- Existing clients completing tasks marked `true` must now create and cite the
  report, retain the structured verification summary, and handle
  `invalid_completion_evidence`; neither plain-text verification nor a report
  marker alone is sufficient.
- Once `requires_code_change` is `true`, `update-task` cannot set it to `false`,
  including while pending or after releasing a claim. This returns outer
  `ok: false` with `error.code: "operation_failed"`. Choose the flag when defining
  the task; releasing a claim does not disable the evidence requirement.
- `update-task` can enable the requirement before a task is terminal, but cannot
  change a false or absent flag to `true` on a `completed` or `failed` task. It
  returns `operation_failed` without changing the terminal record. Reapplying
  `true` to an already-enabled task and updating other metadata remain supported.
- New claims include `claimed_at`. It is optional for persisted-state compatibility;
  validation falls back to the task's `created_at` for older claims without it.
- The CLI operation names, envelope schema version and successful transition shape
  are unchanged. Implementation tasks must enter `completed` through the claim-safe
  transition path; the shared `updateTask` helper also rejects direct completion
  of tasks already marked `true`.

## Legacy MCP -> CLI migration table

| Legacy `team_*` tool | CLI operation |
|---|---|
| `team_send_message` | `omx team api send-message --json` |
| `team_broadcast` | `omx team api broadcast --json` |
| `team_mailbox_list` | `omx team api mailbox-list --json` |
| `team_mailbox_mark_notified` | `omx team api mailbox-mark-notified --json` |
| `team_mailbox_mark_delivered` | `omx team api mailbox-mark-delivered --json` |
| `team_create_task` | `omx team api create-task --json` |
| `team_read_task` | `omx team api read-task --json` |
| `team_list_tasks` | `omx team api list-tasks --json` |
| `team_update_task` | `omx team api update-task --json` |
| `team_claim_task` | `omx team api claim-task --json` |
| `team_transition_task_status` | `omx team api transition-task-status --json` |
| `team_release_task_claim` | `omx team api release-task-claim --json` |
| `team_read_config` | `omx team api read-config --json` |
| `team_read_manifest` | `omx team api read-manifest --json` |
| `team_read_worker_status` | `omx team api read-worker-status --json` |
| `team_read_worker_heartbeat` | `omx team api read-worker-heartbeat --json` |
| `team_update_worker_heartbeat` | `omx team api update-worker-heartbeat --json` |
| `team_write_worker_inbox` | `omx team api write-worker-inbox --json` |
| `team_write_worker_identity` | `omx team api write-worker-identity --json` |
| `team_append_event` | `omx team api append-event --json` |
| `team_get_summary` | `omx team api get-summary --json` |
| `team_cleanup` | `omx team api cleanup --json` |
| `team_write_shutdown_request` | `omx team api write-shutdown-request --json` |
| `team_read_shutdown_ack` | `omx team api read-shutdown-ack --json` |
| `team_read_monitor_snapshot` | `omx team api read-monitor-snapshot --json` |
| `team_write_monitor_snapshot` | `omx team api write-monitor-snapshot --json` |
| `team_read_task_approval` | `omx team api read-task-approval --json` |
| `team_write_task_approval` | `omx team api write-task-approval --json` |

## Message lifecycle operations

- send: `send-message`, `broadcast`
- inspect: `mailbox-list`
- delivery markers: `mailbox-mark-notified`, `mailbox-mark-delivered`

## Dispatch policy (authoritative path)

- Use `omx team api ... --json` + team state files as the authoritative delivery/control path.
- Direct tmux typing (`tmux send-keys`, repeated Enter injection) is operational fallback only, not a mutation contract.
- Interop brokers and worker automations should never assume tmux keystroke delivery implies successful mailbox/task mutation; always verify via JSON envelope + state reads.
- Rust-core + thin-adapter reader compatibility and release gating are documented in
  `docs/contracts/rust-runtime-thin-adapter-contract.md` and
  `docs/qa/rust-runtime-thin-adapter-gate.md`.

## Event read / wakeability contract

When brokers inspect team events via `read-events` / `await-event`:

- Events are returned in canonical form. Legacy `worker_idle` log entries normalize to `worker_state_changed` and keep `source_type: "worker_idle"`.
- `wakeable_only=true` mirrors `omx team await` semantics. Wakeable events include terminal task events, worker state changes, `leader_notification_deferred`, `all_workers_idle`, `team_leader_nudge`, `worker_merge_conflict`, and the per-signal stale alerts.
- Audit-only diff/report events such as `worker_diff_report` and `worker_merge_report` stay durable but non-wakeable.
- `worker_merge_conflict` remains the compatibility event for actionable integration conflicts; consumers should continue routing conflict handling on that event type while reading richer `metadata` when present.

## JSON envelope contract

`--json` output is machine-readable and stable:

- success:
  - `{"schema_version":"1.0","timestamp":"<ISO>","command":"omx team api <operation>","ok":true,"operation":"<operation>","data":{...}}`
- failure:
  - `{"schema_version":"1.0","timestamp":"<ISO>","command":"omx team api ...","ok":false,"operation":"<operation|unknown>","error":{"code":"<code>","message":"<message>"}}`

## Notes

- `transition-task-status` is the claim-safe terminal transition path.
  - Runtime enforces `in_progress -> completed|failed`; other transitions return `invalid_transition`.
- `release-task-claim` intentionally resets the task to `pending`; it is not a completion operation.
- `update-task` only accepts `subject`, `description`, `blocked_by`, and `requires_code_change` as mutable fields.
- `append-event.type` and `write-task-approval.status` enforce strict enum validation.
