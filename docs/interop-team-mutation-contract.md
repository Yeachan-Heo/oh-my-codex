# OMX Team Mutation Contract for Interop Brokers

This document defines the supported **mutation path** for external interoperability brokers.

## Rule of record

External systems must mutate team state **only** through `team_*` MCP tools exposed by `src/mcp/state-server.ts`.
Direct writes to `.omx/state/team/...` are unsupported and may violate runtime invariants.

## Required task mutation flow

1. Read current task:
   - `team_read_task`
2. Claim with optimistic version:
   - `team_claim_task`
3. Transition terminal state with claim token:
   - `team_transition_task_status` (`in_progress -> completed|failed`)
4. Use `team_release_task_claim` only for rollback/requeue-to-pending flows.

## Message lifecycle APIs

- send: `team_send_message`, `team_broadcast`
- inspect: `team_mailbox_list`
- delivery markers: `team_mailbox_mark_notified`, `team_mailbox_mark_delivered`

## Notes

- `team_transition_task_status` is the claim-safe terminal transition path.
- `team_release_task_claim` intentionally resets the task to `pending`; it is not a completion operation.
