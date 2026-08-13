# Retired Ralplan Consensus Gate Contract

This contract is retained as historical context. The hard `ralplan -> ultragoal`
host-receipt gate was removed by #3492. Restoring Autopilot's canonical chain does
not restore this host-authority gate.
Ordinary workflow progression no longer depends on a host-issued consensus
receipt, and missing host provenance must not terminalize planning or block
authority-decreasing cancel, clear, or recovery operations.

## Authority boundary

Local lifecycle evidence, repository files, environment variables, transcripts,
trackers, markers, task names, prompts, and review artifacts are still not
host-issued authority. That boundary now means they must not be promoted into a
security claim; it does not justify a workflow-wide hard gate.

## Routing and lifecycle evidence

Review artifacts can describe native lifecycle observations using:

- `agent_role`: `architect` or `critic`
- `provenance_kind`: `native_subagent`; `omx_adapted` is rejected
- `session_id`: the transition session id
- `thread_id`: the native lane thread id
- `tracker_path`: `.omx/state/subagent-tracking.json`

`agent_type`, `agent_role`, `provenance_kind`, session/thread IDs, tracker
roles/modes/completion, task names, routing markers, transcripts, and local
review artifacts are routing, lifecycle, or diagnostic data only. They may
inform review without authorizing or denying the workflow transition.

Typed `native_subagent` Architect and Critic lanes may still be tracked for
diagnostics and review quality. Their lifecycle does not create a host-security
boundary around ordinary progression.

## Diagnostics

Lifecycle diagnostics may still report tracker schema, session/thread existence,
completion, distinctness, ordering, and remediation. They describe review
quality only. They must not emit a missing-receipt blocker, terminalize
Autopilot, or prevent authority-decreasing recovery.

## Current contract

Keep typed routing and lifecycle records non-authoritative, while allowing the
canonical Autopilot progression to proceed. Security-sensitive capabilities may
define their own documented authority checks, but they must not reintroduce the
retired project-wide Ralplan/Autopilot progression gate.

See [ADR 3212](../adr/3212-same-user-native-child-auth-boundary.md) and [ADR 3194](../adr/3194-codex-01445-documented-leader-proof.md).
