# Ralplan Consensus Gate Contract

The `ralplan -> ultragoal` transition requires durable Architect and Critic approval evidence from native subagent lanes. Advisory lanes such as Scholastic do not replace this gate.

## Required review artifact fields

Each review artifact used by the gate must include:

- `agent_role`: `architect` or `critic`
- `provenance_kind`: `native_subagent` from a routing-capable surface; `omx_adapted` is rejected on the documented Codex 0.144.5 boundary
- `session_id`: the current transition session id, unless supplied by the transition context
- `thread_id`: the native subagent thread id for that review lane
- `tracker_path`: `.omx/state/subagent-tracking.json`

The Architect and Critic reviews must approve in order and must refer to distinct native subagent threads.

## Unsupported adapted provenance

When the native tool reports `role_routing_unavailable`, Ralplan must fail its explicit preflight before review work. The consensus gate rejects `omx_adapted` review artifacts even when legacy tracker journals or `native-subagent-role-routing.json` markers remain after an upgrade. Prompt labels, task-name carriers, markers, pending intents, and historical adapted ledger records do not grant review authority. Typed `native_subagent` lanes remain subject to the tracker, completion, distinct-thread, role, and strict Architect-before-Critic checks below.

## Required tracker schema

`.omx/state/subagent-tracking.json` must contain the session and both review threads:

```text
sessions["<current_session_id>"].threads["<architect_thread_id>"].kind = "subagent"
sessions["<current_session_id>"].threads["<critic_thread_id>"].kind = "subagent"
both threads have completed_at
architect and critic thread IDs are distinct
```

The transition session is the explicit transition `sessionId` when available; otherwise it is resolved from the review artifact `session_id` fields.

## Failure diagnostics

Rejected transitions include a structured diagnostic object on `RalplanConsensusGateEvidence.diagnostic` and a rendered error with:

- expected tracker schema,
- current session id used for lookup,
- Architect/Critic thread ids,
- whether the tracker session exists,
- whether each thread exists,
- each thread `kind`,
- whether each thread has `completed_at`,
- whether thread ids are distinct,
- remediation steps,
- this docs path.

## Remediation

Re-run native ralplan Architect/Critic reviews, or repair the review artifacts so `agent_role`, `provenance_kind`, `session_id`, `thread_id`, and `tracker_path` point to completed native subagent threads in the current tracker.
