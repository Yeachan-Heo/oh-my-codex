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
| `finished` | `session-end`, `finished` | native/derived | Session or turn finished successfully. |
| `failed` | `session-end`, `failed` | native/derived | Session, dispatch, or turn failed. |
| `retry-needed` | `retry-needed` | native/derived | Retryable delivery or execution follow-up is needed. |
| `pr-created` | `pr-created` | derived | Derived from successful `gh pr create` command output. |
| `test-started` | `test-started` | derived | Derived from test command invocation. |
| `test-finished` | `test-finished` | derived | Derived from successful test command completion. |
| `test-failed` | `test-failed` | derived | Derived from failed test command completion. |
| `handoff-needed` | `handoff-needed` | native/derived | Human or orchestrator follow-up is needed. |

## Noise and duplicate controls

- `notify-hook` turn dedupe suppresses duplicate `agent-turn-complete` processing by `thread_id + turn_id + type`.
- `session-idle` emission still uses the idle cooldown gate.
- team dispatch retry and failure events emit only on explicit queue transition branches.
- rollout-derived command events are correlated by `call_id` and only emit once per matching command lifecycle.

## Consumer guidance

clawhip should:

1. trust `context.normalized_event` as the canonical signal
2. use raw `event` as a secondary discriminator
3. use `command`, `tool_name`, `issue_number`, `pr_number`, and `error_summary` for follow-up routing
4. ignore events without `context.normalized_event` if it only wants the hardened clawhip contract
