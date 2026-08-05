# Ralplan Consensus Gate Contract

The `ralplan -> ultragoal` transition is fail-closed. Architect and Critic lifecycle evidence is useful diagnostic data, but cannot authorize a transition by itself.

## Authority boundary

A successful transition requires a documented, versioned, official host-issued consensus receipt verified directly through an official host integration. The receipt must bind the exact transition session, installed Architect and Critic roles, distinct host thread identities, approved artifact digests, strict Architect-before-Critic order, issuer, version, and replay protection.

No current official host receipt integration exists. Production consensus therefore returns the exact blocker:

```text
documented_host_consensus_receipt_unavailable
```

The gate must not read a receipt from `.omx`, repository files, user-local files, environment variables, stdin, CLI arguments, transcripts, pointers, trackers, markers, task names, prompts, or review artifact fields. Those carriers are same-user writable and are not authority.

## Phase 1 receipt protocol

Phase 1 defines a verifier scaffold without enabling a production positive path. Codex supplies the result as the opaque object `{receipt: String}`. The string is a compact JWS:

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

Phase 1 supplies none of those production bindings, so capability detection reports all three missing and the gate remains unavailable. A partial implementation is still unavailable. Capability detection is not receipt verification and cannot authorize a transition.

Enablement is tracked in [OMX issue #3438](https://github.com/Yeachan-Heo/oh-my-codex/issues/3438) and the corresponding [Codex host issue #37016](https://github.com/openai/codex/issues/37016). Issue text, comments, and linked artifacts are coordination evidence only; they are not a trust root or receipt transport.

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

Fresh default Autopilot checks verifier capability before starting `deep-interview` or Ralplan review lanes. Deterministic verifier absence terminalizes the fresh Autopilot run with the same exact blocker, avoiding review work that cannot advance. The capability check is not receipt verification and never authorizes a transition; direct/manual Ralplan and existing active Autopilot sessions keep their diagnostic and resumability behavior.

## Future enablement

Enable a positive path only after official documentation specifies a non-user-mintable host receipt channel and OMX implements direct verification for that documented version and surface. Tests must prove that injected local JSON, environment, transcript, tracker, marker, and review artifacts cannot mint or substitute the receipt. Until then, preserve the fail-closed blocker and treat typed routing/lifecycle as non-authoritative.

See [the Phase 1 receipt ADR](../adr/codex-host-consensus-receipt-phase-1.md), [ADR 3212](../adr/3212-same-user-native-child-auth-boundary.md), and [ADR 3194](../adr/3194-codex-01445-documented-leader-proof.md).
