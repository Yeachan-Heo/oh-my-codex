# ADR: Codex host-consensus receipt verifier Phase 1

**Status:** Accepted, unavailable in production

## Context

Ralplan consensus needs authority that a same-user process cannot mint, replace, or replay. OMX currently has no documented Codex host receipt transport, no pinned host issuer trust root, and no replay-safe online consume operation. Local state and execution traces can improve lifecycle diagnostics but cannot close that authority gap.

A future host integration still needs a precise protocol and deterministic verifier behavior that can be reviewed and tested before any production authority path exists.

The cross-project enablement work is tracked by [OMX #3438](https://github.com/Yeachan-Heo/oh-my-codex/issues/3438) and [Codex #37016](https://github.com/openai/codex/issues/37016).

## Decision

Introduce a strict version-1 compact-JWS host-consensus receipt protocol and verifier scaffold with:

- an opaque Codex `{receipt: String}` response containing unpadded compact JWS with exact `typ`/`kid`/`alg: "EdDSA"` protected-header bytes;
- canonical, whitespace-free payload bytes with strict post-parse reserialization equality;
- a typed challenge with numeric `protocolVersion: 1`, a fresh 256-bit nonce, compiled audience `oh-my-codex.ralplan-handoff.v1`, exact canonical UUID root session, and domain-separated raw-artifact evidence digest, all echoed in signed claims;
- exact claims for issuer, unique receipt ID, Architect and Critic roles, distinct canonical UUID host threads, strict review order, and a bounded validity window;
- test-only explicit key input, with production reserved for a compiled, pinned trust root rather than dynamic or same-user-selected key discovery;
- stable failure reasons for transport, schema, version, algorithm, issuer, signature, claims, validity, replay, and online consume failures; and
- an online consume step that atomically binds the full challenge, receipt ID, and signed compact-JWS hash.

The verifier accepts receipt material only from an explicitly supplied documented-host transport interface. It contains no filesystem, `.omx`, environment, stdin, CLI, transcript, tracker, pointer, prompt, or artifact discovery path.

Production capability detection is conjunctive. It reports `available` only when the documented transport, compiled pinned issuer trust root, and replay-safe online consume bindings all exist. Phase 1 hardcodes none of these bindings; the production result remains `unavailable`, and Ralplan continues to fail with:

```text
documented_host_consensus_receipt_unavailable
```

The pure readiness assessor and in-memory verifier dependencies are test surfaces, not production discovery or configuration surfaces. Fixed RFC 8032 Ed25519 test material proves deterministic serialization and cryptographic verification without installing a trust root. The evidence digest uses the exact domain-separated formula documented in the consensus contract, including unsigned 64-bit big-endian raw-byte lengths and raw SHA-256 digests for requirements and plan bytes.

## Rejected alternatives

- Reading a serialized receipt or key from the repository, `.omx`, user-local files, environment, stdin, CLI arguments, transcripts, trackers, or planning artifacts. All are same-user writable or replayable.
- Accepting semantically equivalent JSON with different key order, whitespace, or escaping. Compact-JWS protected and payload bytes are normative and must reserialize exactly.
- Enabling capability after signature verification alone. Offline verification cannot prevent nonce preplay or establish atomic single use.
- Enabling capability with only a transport or only a pinned key. Each partial integration leaves a required authority property unproven.
- Treating lifecycle thread IDs, role labels, or review ordering as authentication. Those fields remain diagnostics until bound by a valid host receipt.

## Consequences

- The receipt shape and failure vocabulary can be reviewed and regression-tested now.
- Production behavior does not change: fresh Autopilot preflight and Ralplan handoff remain fail-closed.
- A later enablement change must cite the official Codex host transport documentation, pin the issuer trust root through a reviewed distribution channel, implement replay-safe online consume, add adversarial carrier/substitution tests, and separately wire a positive gate path.
- OMX #3438 and Codex #37016 track that later integration; closing either issue alone does not make the capability available.

See the [Ralplan consensus gate contract](../contracts/ralplan-consensus-gate.md) and [ADR 3212](./3212-same-user-native-child-auth-boundary.md).
