---
name: worker
description: Team worker protocol (ACK, mailbox, task lifecycle) for tmux-based OMX teams
---

# Worker Skill

## When to use

Use only when the session was started as an OMX Team worker. Read `AGENTS.md#durable-runtime-invariants-canonical-ssot` before acting; it defines the durable ownership and coordination boundaries.

## Inputs and preconditions

- Require `OMX_TEAM_WORKER=<team-name>/worker-<n>`.
- Resolve this skill from the first existing path:
  `${CODEX_HOME:-~/.codex}/skills/worker/SKILL.md`, `~/.codex/skills/worker/SKILL.md`, `<leader_cwd>/.codex/skills/worker/SKILL.md`, then `<leader_cwd>/skills/worker/SKILL.md`.
- Resolve the Team state root in this order: `OMX_TEAM_STATE_ROOT`, worker identity `team_state_root`, config/manifest `team_state_root`, local `.omx/state`.

## Operational steps

1. Split the environment into `teamName` and `workerName`; Send a startup ACK before task work:
   ```bash
   omx team api send-message --input '{"team_name":"<teamName>","from_worker":"<workerName>","to_worker":"leader-fixed","body":"ACK: <workerName> initialized"}' --json
   ```
2. Read `<team_state_root>/team/<teamName>/workers/<workerName>/inbox.md` and take the first unblocked assignment.
3. Read `<team_state_root>/team/<teamName>/tasks/task-<id>.json`; APIs use the bare numeric `task_id` (for example `"1"`).
4. Claim an unclaimed task before editing:
   ```bash
   omx team api claim-task --input '{"team_name":"<teamName>","task_id":"<id>","worker":"<workerName>"}' --json
   ```
   If the leader already claimed the task for you, do not re-claim it. Use the inbox handoff's current claim token, version, and lease; verify they match the task file. If they differ or the lease has expired, stop and ask the leader for a current assignment.
5. Do the assigned work. Do not write task lifecycle fields directly.
6. Complete or fail through the lifecycle API, from `in_progress` to `completed` or `failed`:
   ```bash
   omx team api transition-task-status --input '{"team_name":"<teamName>","task_id":"<id>","from":"in_progress","to":"completed","claim_token":"<token>","result":"<evidence>"}' --json
   ```
   Use `release-task-claim` only to requeue a blocked task to `pending`.
7. Check and acknowledge mailbox messages:
   ```bash
   omx team api mailbox-list --input '{"team_name":"<teamName>","worker":"<workerName>"}' --json
   omx team api mailbox-mark-delivered --input '{"team_name":"<teamName>","worker":"<workerName>","message_id":"<MESSAGE_ID>"}' --json
   ```
8. Write idle status after the transition:
   `<team_state_root>/team/<teamName>/workers/<workerName>/status.json` with `{"state":"idle","updated_at":"<ISO timestamp>"}`.

## Exit and evidence

Completion evidence names the task id, changed artifacts, verification performed, and any blocker. ACKs, task transitions, mailbox acknowledgements, and status writes must be observable through the Team API/state files. On shutdown, follow the lead's inbox instructions and write the required shutdown acknowledgement before exiting.
