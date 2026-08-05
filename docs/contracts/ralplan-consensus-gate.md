# Ralplan Consensus Gate Contract

The `ralplan -> ultragoal` transition is fail-closed. This fork compiles one active authority policy:

```json
{
  "authority_policy": "local_owner_lifecycle"
}
```

Under this policy, only a valid, fresh, ordered, distinct native Architect→Critic approving pair authorizes the transition.

## Authority boundary

A successful transition requires all of the following lifecycle evidence for the current planning pass:

- native-subagent provenance for both reviews;
- the installed `architect` role followed by the installed `critic` role;
- an approving verdict from both roles;
- completed, distinct native thread identities;
- strict Architect-before-Critic ordering; and
- reviews newer than the return-to-Ralplan boundary, when the workflow is revising a prior plan.

A successful gate result is:

```json
{
  "complete": true,
  "blockedReason": null,
  "authority_policy": "local_owner_lifecycle"
}
```

Plans, PRD/test-spec paths, user-written gate fields, receipt-shaped local data, prompt role labels, task names, transcripts, pointers, tracker records alone, adapted-role evidence, same-thread reviews, reversed ordering, non-approving verdicts, and stale approvals cannot authorize the transition. The gate reports the specific lifecycle blocker and keeps `complete:false` when validation fails.

This policy is a local product-owner authority choice. It is not a `host_consensus_receipt`, and implementations and documentation must never represent it as one.

## Optional stronger host receipt protocol

The Phase 1 verifier scaffold defines a future, stronger host authority mode without enabling a production host-receipt path. Codex supplies the result as the opaque object `{receipt: String}`. The string is a compact JWS:

```text
BASE64URL(protected-header) + "." + BASE64URL(payload) + "." + BASE64URL(Ed25519-signature)
```

Base64url segments are unpadded and must round-trip exactly. The protected header has exactly the keys `typ`, `kid`, and `alg`, in that order, and its normative UTF-8 bytes are:

```json
{"typ":"omx-ralplan-consensus-receipt+jws","kid":"<kid>","alg":"EdDSA"}
```

The payload is whitespace-free JSON with keys in this exact order: `protocolVersion`, `requestNonce`, `audience`, `rootSessionId`, `evidenceSha256`, `receiptId`, `issuer`, `sequence`, `architect`, `critic`, `issuedAt`, `notBefore`, `expiresAt`. Architect and Critic objects use the exact order `role`, `threadId`, `approvedAt`. `rootSessionId` and both `threadId` values are canonical lowercase hyphenated UUIDs compatible with Codex `ThreadId`; other strings are restricted to their canonical ASCII ID, base64url, lowercase-hex, or ISO timestamp forms. Alternate JSON escaping is not accepted. After parsing, both protected header and payload must reserialize byte-for-byte to the received decoded bytes before signature verification.

The exact-key claims bind:

- every field of the verifier-generated challenge: numeric `protocolVersion: 1`, a fresh 256-bit `requestNonce` encoded as canonical unpadded base64url (exactly 32 decoded bytes with re-encoding equality), compiled audience `oh-my-codex.ralplan-handoff.v1`, exact `rootSessionId`, and `evidenceSha256`;
- issuer and unique receipt ID;
- the literal `architect-review` then `critic-review` sequence;
- literal Architect and Critic roles, distinct host thread IDs, and strict approval timestamps;
- issued-at, not-before, and expiry timestamps.

`evidenceSha256` is defined over the raw requirements and plan bytes. Let `R` and `P` be those byte strings, `H(x)` be raw 32-byte SHA-256 output, `U64(n)` be an unsigned 8-byte big-endian byte length, and `||` be concatenation. The exact lowercase-hex mapping is:

```text
hex(H(UTF8("omx.ralplan.consensus-evidence.v1") || 0x00
  || UTF8("requirements") || 0x00 || U64(len(R)) || H(R)
  || UTF8("plan")         || 0x00 || U64(len(P)) || H(P)))
```

Verification is ordered and fail-closed: send the typed challenge to the documented host transport, accept only its exact `{receipt: String}` response, enforce canonical compact-JWS bytes, select the pinned issuer/key, verify Ed25519 over the compact JWS signing input, validate every echoed challenge and expected claim, then atomically consume the tuple `(challenge, receiptId, SHA256(compact-JWS-string))` through an online replay-safe host operation. This prevents nonce preplay and root-session, evidence, or token substitution.

The audience is a compiled protocol constant, not caller configuration. Challenge construction and receipt parsing both reject any other audience.

The cryptographic verifier can currently be exercised only through an explicitly named test-only key seam. It does not discover integrations, keys, or receipt material. Test vectors use a fixed RFC 8032 Ed25519 seed and in-memory test doubles; they do not create a production trust root. Production must use a compiled, pinned issuer trust root and must not accept key input.

Production capability is available only when all three bindings exist together:

1. a documented Codex host receipt transport;
2. a compiled, pinned issuer trust root shipped through a reviewed trust-root channel; and
3. a replay-safe online consume operation with atomic single-use semantics.

Phase 1 supplies none of those production bindings, so host-receipt capability detection reports all three missing. A partial host implementation remains unavailable. Capability detection is not receipt verification and cannot authorize a transition under a future host-receipt policy.

Issue text, comments, and linked artifacts are coordination evidence only; they are not a trust root or receipt transport.

## Routing and lifecycle evidence

Review artifacts can describe native lifecycle observations using:

- `agent_role`: `architect` or `critic`
- `provenance_kind`: `native_subagent`; `omx_adapted` is rejected
- `session_id`: the transition session id
- `thread_id`: the native lane thread id
- `tracker_path`: `.omx/state/subagent-tracking.json`
- `completed_at`: exactly the matched tracker thread's completion timestamp
- `ralplan_pass_started_at`: a system-stamped pass boundary on the enclosing Ralplan/Autopilot state

The `local_owner_lifecycle` validator evaluates the review records and native tracking evidence together. It requires current-session tracker entries with exact native provenance and roles, exact review-to-tracker completion timestamp binding, both completions at or after the current pass boundary, and strict tracker-observed Architect-before-Critic order. Return passes require their own explicit `ralplan_pass_started_at`. No single field, marker, tracker entry, transcript, or locally authored `complete:true` value is sufficient on its own. The positive result comes from validating the complete pair against the compiled policy.

Typed `native_subagent` Architect and Critic lanes must be tracked for validation. A roleless legacy lane, `omx_adapted` lane, pending/bound role intent, claimant token, leader attestation, or historical routing marker is inert and cannot release consensus. When the native task surface reports `role_routing_unavailable`, adapted Planner, Architect, Critic, role-intent, and consensus authority remain subject to `omx ralplan preflight --json`; `unsupported_documented_leader_proof` stops that adapted authority path.

## Diagnostics

The gate renders diagnostics for the expected tracker schema, current session, Architect/Critic thread IDs, session/thread existence, thread kinds, completion, approval, distinctness, ordering, freshness, and remediation. These diagnostics explain why the compiled lifecycle policy passed or failed; they are not a receipt verifier.

Invalid or missing evidence remains fail-closed. Representative blockers include `native_subagent_consensus_evidence_missing`, `non_approving_ralplan_consensus_review`, and `missing_sequential_architect_then_critic_approval`.

Fresh default Autopilot does not terminalize solely because the optional host verifier is unavailable. It proceeds to Ralplan and applies the compiled `local_owner_lifecycle` policy. Existing active Autopilot sessions retain their diagnostic and resumability behavior.

## Future enablement

The host verifier may become an optional stronger authority policy only after official documentation specifies a non-user-mintable host receipt channel and OMX implements direct verification for that documented version and surface. Tests must prove that injected local JSON, environment, transcript, tracker, marker, and review artifacts cannot mint or substitute the receipt. Adding that mode must not relabel existing `local_owner_lifecycle` decisions as host receipts or weaken the local policy's provenance, role, approval, distinctness, ordering, and freshness checks.

See [the Phase 1 receipt ADR](../adr/codex-host-consensus-receipt-phase-1.md), [ADR 3212](../adr/3212-same-user-native-child-auth-boundary.md), and [ADR 3194](../adr/3194-codex-01445-documented-leader-proof.md).
