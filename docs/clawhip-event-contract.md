# Clawhip Event Contract

OMX emits hook events for clawhip through the existing hooks extensibility pipeline.

## Canonical routing rule

Route on `context.normalized_event`, not just raw `event`.

This keeps clawhip stable even when OMX uses legacy-compatible raw event names such as `session-start`, `session-end`, and `session-idle`.

## Envelope

All events use the existing hook envelope:

- `schema_version: "1"`
- `event`
- `timestamp`
- `source`
- `context`
- optional IDs: `session_id`, `thread_id`, `turn_id`, `mode`

## Common context fields

When available, OMX includes these fields in `context`:

- `normalized_event`
- `session_name`
- `repo_path`
- `repo_name`
- `worktree_path`
- `branch`
- `issue_number`
- `pr_number`
- `pr_url`
- `command`
- `tool_name`
- `status`
- `error_summary`

## Normalized events

| `context.normalized_event` | Typical raw `event` values | Source | Notes |
| --- | --- | --- | --- |
| `started` | `session-start` | native | Session launch began. |
| `blocked` | `session-idle`, `blocked` | native/derived | Session is waiting on input or another dependency. |
| `run.heartbeat` | `run.heartbeat` | native/derived | Runtime heartbeat proving the active run is still alive. |
| `run.blocked_on_user` | `run.blocked_on_user` | native/derived | Runtime is paused pending user input or approval. |
| `run.blocked_on_system` | `run.blocked_on_system` | native/derived | Runtime is paused pending tool/system/environment repair. |
| `finished` | `session-end`, `finished` | native/derived | Session or turn finished successfully. |
| `failed` | `session-end`, `failed` | native/derived | Session, dispatch, or turn failed. |
| `worker.assigned` | `worker.assigned` | native/derived | Team runtime assigned a worker to a concrete task. |
| `worker.stalled` | `worker.stalled` | native/derived | Team runtime detected a worker that now needs supervisor intervention. |
| `worker.recovered` | `worker.recovered` | native/derived | A stalled/interrupted worker successfully resumed or was relaunched. |
| `retry-needed` | `retry-needed` | native/derived | Retryable delivery or execution follow-up is needed. |
| `pr-created` | `pr-created` | derived | Derived from successful `gh pr create` command output. |
| `test-started` | `test-started` | derived | Derived from test command invocation. |
| `test-finished` | `test-finished` | derived | Derived from successful test command completion. |
| `test-failed` | `test-failed` | derived | Derived from failed test command completion. |
| `handoff-needed` | `handoff-needed` | native/derived | Human or orchestrator follow-up is needed. |

## Lifecycle ownership

- native session lifecycle events are the canonical source for `started`, `blocked`, `run.heartbeat`, `run.blocked_on_user`, `run.blocked_on_system`, `finished`, and `failed`
- team/runtime operational events add canonical worker-state signals for `worker.assigned`, `worker.stalled`, and `worker.recovered`
- derived operational events add follow-up detail for `retry-needed`, `pr-created`, `test-*`, and `handoff-needed`
- operational contexts resolve `session_name` from the OMX session id + worktree so session metadata stays stable across native and derived events

## Noise and duplicate controls

- `notify-hook` turn dedupe suppresses duplicate `agent-turn-complete` processing by `thread_id + turn_id + type`.
- `session-idle` emission still uses the idle cooldown gate.
- assistant-text heuristics emit follow-up signals (`retry-needed`, `handoff-needed`) but do not duplicate session completion/failure lifecycle events.
- team dispatch retry and failure events emit only on explicit queue transition branches.
- rollout-derived command events are correlated by `call_id` and only emit once per matching command lifecycle.

## Consumer guidance

clawhip should:

1. trust `context.normalized_event` as the canonical signal
2. use raw `event` as a secondary discriminator
3. use `command`, `tool_name`, `issue_number`, `pr_number`, and `error_summary` for follow-up routing
4. ignore events without `context.normalized_event` if it only wants the hardened clawhip contract
