# ADR 3212: Same-user native-child authentication boundary

**Status:** Accepted

## Decision

Treat every native child running under the same user identity as fully hostile for authority decisions. A same-user child can read, forge, replay, replace, or invoke repository-local and user-local state. Sandbox labels, filesystem permissions, environment variables, local files, transcripts, pointers, trackers, markers, task names, prompts, PIDs, session or thread IDs, local helpers, and absence-based inference are therefore not authentication.

Delete the native-anchor key, signed launch-claim, leader-attestation, and adapted role-intent authority paths. Historical serialized fields may be tolerated as inert compatibility data, but are never verified, migrated, emitted, or used as authority.

Keep `agent_type`, `agent_role`, launch IDs, native-session metadata, tracker role/mode/completion fields, task names, and routing markers as typed routing, lifecycle, or diagnostic data only. They may select or describe work; they cannot authorize Ralplan consensus or release `ralplan -> ultragoal`.

## Consensus consequence

Consensus requires a documented, versioned, official host-issued receipt that OMX verifies directly through an official host surface and that a same-user child cannot mint, rewrite, replay, or substitute. No such integration exists today. Production consensus therefore fails closed with exactly:

```text
documented_host_consensus_receipt_unavailable
```

Architect and Critic lifecycle evidence remains observable, including ordering and distinct-thread diagnostics, but does not release the transition without that receipt. Local JSON, environment, stdin, review artifacts, tracker data, or any other repository/user-writable carrier cannot stand in for the receipt.

Future enablement requires official documentation and a reviewed implementation that verifies the issuer, receipt version, exact session, installed Architect and Critic roles, distinct host thread identities, artifact digests, strict Architect-before-Critic order, and replay binding through the official host surface before any release. Observed behavior or a locally serialized receipt is insufficient.

## Packaged plugin boundary

The packaged plugin uses `OMX_CODEX_LAUNCH_ID` and `OMX_ENTRY_PATH` only as a spoofable, non-secret routing discriminator. Its bounded `plugin-hook-routing` record may preserve owner, plain, inherited-nested, and related-child delegation behavior, but is consumed by no source-hook, consensus, or authorization decision. The launcher creates or reads no native-anchor key, HMAC, signed claim, or `plugin-hook-launches` authority record.

## Preflight mutation boundary

Direct hook and direct role-intent CLI denials are zero-write. `omx ralplan preflight --json` may only neutralize an exact current keyword-detector Ralplan routing seed after strict session-scoped, regular-file, bounded, schema, identity, and no-progress checks. It does not call general mode cancellation, reconcile workflow state, or modify pointers, trackers, markers, runtime/HUD state, foreign state, stale state, or substantive work.

The exact preflight and installed-role CLI result is:

```json
{"ok":false,"reason":"unsupported_documented_leader_proof"}
```

The canonical installed-role `PreToolUse` denial reason is:

```text
unsupported_documented_leader_proof: Codex 0.144.5 hooks do not expose documented root identity required for adapted Ralplan.
```

## Relationship to ADR 3194

[ADR 3194](./3194-codex-01445-documented-leader-proof.md) remains the narrower Codex 0.144.5 adapted-leader proof decision. This ADR supersedes no typed-routing behavior from ADR 3194; it extends the same fail-closed principle to all same-user-mintable adapted authority and to consensus. Both ADRs require an official documented host integration before a positive authority path is enabled.

## Consequences

- Typed native dispatch and ordinary lifecycle tracking remain supported and explicitly non-authoritative.
- `omx_adapted`, roleless legacy lanes, historical pending/bound intents, attestations, and markers cannot release consensus.
- The current production transition is intentionally unavailable rather than weakened by a local compatibility fallback.
- Package, source, and documentation must preserve this distinction so routing data cannot later be mistaken for authentication.
