# Ralplan Consensus Gate Contract

The `ralplan -> ultragoal` transition requires durable Architect and Critic approval evidence from native subagent lanes. Advisory lanes such as Scholastic do not replace this gate.

## Required review artifact fields

Each review artifact used by the gate must include:

- `agent_role`: `architect` or `critic`
- `provenance_kind`: `native_subagent` (routing-capable surface) or `omx_adapted` (a `role_routing_unavailable` surface, e.g. the Codex App `spawn_agent` tool with no `agent_type` parameter)
- `session_id`: the current transition session id, unless supplied by the transition context
- `thread_id`: the native subagent thread id for that review lane
- `tracker_path`: `.omx/state/subagent-tracking.json`

The Architect and Critic reviews must approve in order and must refer to distinct native subagent threads.

## OMX-adapted provenance (role_routing_unavailable surfaces)

When the native tool exposes no `agent_type` routing, OMX cannot pass a native role. The gate then accepts an `omx_adapted` lane only when ALL of the following hold, so provenance is never faked by a prompt label:

- a scoped, unexpired `role_routing_unavailable` marker (`native-subagent-role-routing.json`) exists for the transition `cwd`/`session_id`;
- the tracked child thread's ledger `role` equals the review artifact `agent_role` and its `provenance_kind` is `omx_adapted` (bound from a pre-recorded, installed-role-validated role intent, not from artifact text);
- both review threads are completed and distinct;
- strict Architect-before-Critic order is proven from tracker timestamps (architect `completed_at` strictly before critic `first_seen_at`/`started_at`); missing or artifact-only order is rejected.

A review artifact that claims `native_subagent` provenance over an `omx_adapted` ledger thread is rejected.

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
