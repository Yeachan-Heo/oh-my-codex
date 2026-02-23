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

## Startup Protocol (ACK)

1. Parse `OMX_TEAM_WORKER` into:
   - `teamName` (before the `/`)
   - `workerName` (after the `/`, usually `worker-<n>`)
2. Send an ACK to the lead mailbox:
   - Recipient worker id: `leader-fixed`
   - Body: one short line including your workerName and what you’re ready to do.
3. After ACK, proceed to your inbox instructions.

The lead will see your message in:

`<team_state_root>/team/<teamName>/mailbox/leader-fixed.json`

Use the MCP tool:
- `team_send_message` with `{team_name, from_worker, to_worker:"leader-fixed", body}`

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
6. Claim the task (do NOT start work without a claim). Use the team state APIs described in your inbox/overlay.
7. Do the work.
8. Write completion to the task file:
   - `{"status":"completed","result":"..."}` or `{"status":"failed","error":"..."}`
9. Update your worker status:
   `<team_state_root>/team/<teamName>/workers/<workerName>/status.json` with `{"state":"idle", ...}`

## Mailbox

Check your mailbox for messages:

`<team_state_root>/team/<teamName>/mailbox/<workerName>.json`

When notified, read messages and follow any instructions. Use short ACK replies when appropriate.

Use MCP tools:
- `team_mailbox_list` to read
- `team_mailbox_mark_delivered` to acknowledge delivery

## Shutdown

If the lead sends a shutdown request, follow the shutdown inbox instructions exactly, write your shutdown ack file, then exit the Codex session.
