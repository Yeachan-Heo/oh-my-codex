# Ralplan Consensus Gate Contract

The `ralplan -> ultragoal` transition is fail-closed. Architect and Critic lifecycle evidence is useful diagnostic data, but cannot authorize a transition by itself.

## Authority boundary

A successful transition requires a documented, versioned, official host-issued consensus receipt verified directly through an official host integration. The receipt must bind the exact transition session, installed Architect and Critic roles, distinct host thread identities, approved artifact digests, strict Architect-before-Critic order, issuer, version, and replay protection.

No current official host receipt integration exists. Production consensus therefore returns the exact blocker:

```text
documented_host_consensus_receipt_unavailable
```

The gate must not read a receipt from `.omx`, repository files, user-local files, environment variables, stdin, CLI arguments, transcripts, pointers, trackers, markers, task names, prompts, or review artifact fields. Those carriers are same-user writable and are not authority.

## Routing and lifecycle evidence

Review artifacts can describe native lifecycle observations using:

- `agent_role`: `architect` or `critic`
- `provenance_kind`: `native_subagent`; `omx_adapted` is rejected
- `session_id`: the transition session id
- `thread_id`: the native lane thread id
- `tracker_path`: `.omx/state/subagent-tracking.json`

`agent_type`, `agent_role`, `provenance_kind`, session/thread IDs, tracker roles/modes/completion, task names, routing markers, transcripts, and local review artifacts are routing, lifecycle, or diagnostic data only. A same-user child can forge them. They never satisfy the receipt requirement.

Typed `native_subagent` Architect and Critic lanes may still be tracked for diagnostics. A valid lifecycle pair uses distinct threads, completed lanes, and Architect-before-Critic ordering. A roleless legacy lane, `omx_adapted` lane, pending/bound role intent, claimant token, leader attestation, or historical routing marker is inert and cannot release consensus.

## Diagnostics

When lifecycle evidence is present, the gate may render diagnostics for the expected tracker schema, current session, Architect/Critic thread IDs, session/thread existence, thread kinds, completion, distinctness, ordering, and remediation. These diagnostics explain lifecycle quality; they are not a receipt verifier.

Every production result remains incomplete until the official verifier is available and validates a receipt. The unavailable result includes `blockedReason: "documented_host_consensus_receipt_unavailable"`.

## Future enablement

Enable a positive path only after official documentation specifies a non-user-mintable host receipt channel and OMX implements direct verification for that documented version and surface. Tests must prove that injected local JSON, environment, transcript, tracker, marker, and review artifacts cannot mint or substitute the receipt. Until then, preserve the fail-closed blocker and treat typed routing/lifecycle as non-authoritative.

See [ADR 3212](../adr/3212-same-user-native-child-auth-boundary.md) and [ADR 3194](../adr/3194-codex-01445-documented-leader-proof.md).
