---
name: worker
description: Team worker protocol (ACK, mailbox, task lifecycle) for tmux-based OMX teams
---

# Worker Skill

This skill is for a Codex session that was started as an OMX Team worker (a tmux pane spawned by `$team`).

## Identity

You MUST be running with `OMX_TEAM_WORKER` set. It looks like:

`<team-name>/worker-<n>`

Example: `alpha/worker-2`

## Load Worker Skill Path (Claude/Codex)

When a worker inbox tells you to load this skill, resolve the first existing path:

1. `${CODEX_HOME:-~/.codex}/skills/worker/SKILL.md`
2. `~/.codex/skills/worker/SKILL.md`
3. `<leader_cwd>/.codex/skills/worker/SKILL.md`
4. `<leader_cwd>/skills/worker/SKILL.md` (repo fallback)

## Startup Protocol (ACK)

1. Parse `OMX_TEAM_WORKER` into:
   - `teamName` (before the `/`)
   - `workerName` (after the `/`, usually `worker-<n>`)
2. Send a startup ACK to the lead mailbox **before task work**:
   - Recipient worker id: `leader-fixed`
   - Body: one short deterministic line (recommended: `ACK: <workerName> initialized`).
3. After ACK, proceed to your inbox instructions.

The lead will see your message in:

`<team_state_root>/team/<teamName>/mailbox/leader-fixed.json`

Use CLI interop:
- `omx team api send-message --input <json> --json` with `{team_name, from_worker, to_worker:"leader-fixed", body}`

Copy/paste template:

```bash
omx team api send-message --input "{\"team_name\":\"<teamName>\",\"from_worker\":\"<workerName>\",\"to_worker\":\"leader-fixed\",\"body\":\"ACK: <workerName> initialized\"}" --json
```

## Inbox + Tasks

1. Resolve canonical team state root in this order:
   1) `OMX_TEAM_STATE_ROOT` env
   2) worker identity `team_state_root`
   3) team config/manifest `team_state_root`
   4) local cwd fallback (`.omx/state`)
2. Read your inbox:
   `<team_state_root>/team/<teamName>/workers/<workerName>/inbox.md`
3. Pick the first unblocked task assigned to you.
4. Read the task file:
   `<team_state_root>/team/<teamName>/tasks/task-<id>.json` (example: `task-1.json`)
5. Task id format:
   - The MCP/state API uses the numeric id (`"1"`), not `"task-1"`.
   - Never use legacy `tasks/{id}.json` wording.
6. Claim the task (do NOT start work without a claim) using claim-safe lifecycle CLI interop (`omx team api claim-task --json`).
7. Do the work.
8. Complete/fail the task via lifecycle transition CLI interop (`omx team api transition-task-status --json`) from `in_progress` to `completed` or `failed`.
   - Do NOT directly write lifecycle fields (`status`, `owner`, `result`, `error`) in task files.
9. Use `omx team api release-task-claim --json` only for rollback/requeue to `pending` (not for completion).
10. Update your worker status:
   `<team_state_root>/team/<teamName>/workers/<workerName>/status.json` with `{"state":"idle", ...}`

## Mailbox

Check your mailbox for messages:

`<team_state_root>/team/<teamName>/mailbox/<workerName>.json`

When notified, read messages and follow any instructions. Use short ACK replies when appropriate.

Note: leader dispatch is state-first. The durable queue lives at:
`<team_state_root>/team/<teamName>/dispatch/requests.json`
Hooks/watchers may nudge you after mailbox/inbox state is already written.

Use CLI interop:
- `omx team api mailbox-list --json` to read
- `omx team api mailbox-mark-delivered --json` to acknowledge delivery

Copy/paste templates:

```bash
omx team api mailbox-list --input "{\"team_name\":\"<teamName>\",\"worker\":\"<workerName>\"}" --json
omx team api mailbox-mark-delivered --input "{\"team_name\":\"<teamName>\",\"worker\":\"<workerName>\",\"message_id\":\"<MESSAGE_ID>\"}" --json
```

## Dispatch Discipline (state-first)

Worker sessions should treat team state + CLI interop as the source of truth.

- Prefer inbox/mailbox/task state and `omx team api ... --json` operations.
- Do **not** rely on ad-hoc tmux keystrokes as a primary delivery channel.
- If a manual trigger arrives (for example `tmux send-keys` nudge), treat it only as a prompt to re-check state and continue through the normal claim-safe lifecycle.

## Shutdown

If the lead sends a shutdown request, follow the shutdown inbox instructions exactly, write your shutdown ack file, then exit the Codex session.
