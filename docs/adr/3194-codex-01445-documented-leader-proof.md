# ADR 3194: Documented leader proof for Codex 0.144.5 Ralplan

**Status:** Accepted

## Decision

Treat adapted Ralplan role routing as unsupported on the documented Codex CLI 0.144.5 hook surface. The surface does not provide a documented, positive root-to-`PreToolUse` identity proof. Run the explicit fail-closed CLI preflight only when native role routing reports `role_routing_unavailable` and the caller attempts adapted Ralplan Planner, Architect, or Critic authority, adapted role-intent, or adapted consensus authority.

Keep typed native routing as the preferred path where the native spawn surface exposes `agent_type`: callers select an installed OMX role explicitly. Typed routing and lifecycle fields are non-authoritative. On a role-routing-unavailable surface, the adapted role path is unavailable rather than silently weakened. Do not substitute prompt labels, inferred identities, or unvalidated carriers.

## Drivers

- A same-user child can forge every local adapted role-intent or attestation carrier.
- Authorization must rely on documented, positive evidence rather than correlations or omissions.
- A false positive would let child or ambiguous context acquire leader-only planning authority.
- The implementation must fail before it creates workflow state or runtime side effects.

## Official evidence and version boundary

This ADR is limited to the documented Codex CLI **0.144.5** hook contract evaluated for #3194. Its documented `PreToolUse` fields do not bind an event to the root identity required by adapted Ralplan. This is not a claim that no other Codex surface can provide such proof, nor a claim about future versions. Enablement requires official documentation for the actual surface, not behavior observed in a particular run.

`session_id` is parent-shared and does not prove root identity. `thread_id` is undocumented for this authority decision. Session files, resolved session aliases, pointers, transcripts, cwd, and absence of child evidence are all non-authoritative. They cannot be combined into a leader proof.

## Trust boundaries

Structural routing carriers are routing/lifecycle data, not authority. The unsupported boundary requires both the native task surface reporting `role_routing_unavailable` and an attempt to use adapted Ralplan Planner, Architect, or Critic authority, adapted role-intent, or adapted consensus authority; it is not inferred from hook payload shape. Typed native `agent_type` routing remains enabled and unchanged, but cannot authorize consensus. Ordinary native planning, lifecycle, state, status, health, HUD, runtime, setup, install, sync, and unrelated delegation are outside this preflight boundary and remain governed by their existing controls.

## Exact output contract

When both boundary conditions apply, the explicit `omx ralplan preflight --json` result is exactly:

```json
{"ok":false,"reason":"unsupported_documented_leader_proof"}
```

A canonical standalone `omx ralplan role-intent write --role <role> --parent-thread "$CODEX_THREAD_ID" --json` request for an installed role is denied by `PreToolUse` with exactly:

```text
unsupported_documented_leader_proof: Codex 0.144.5 hooks do not expose documented root identity required for adapted Ralplan.
```

Its CLI JSON result is exactly:

```json
{"ok":false,"reason":"unsupported_documented_leader_proof"}
```

Unknown roles remain separately denied as `unknown_role`; that result is validation only and is never an authority fallback.

## Alternatives

1. **Infer the leader from `session_id`, `thread_id`, pointer state, transcript, cwd, or missing child fields.** Rejected because none is a documented positive root proof; `session_id` is parent-shared and `thread_id` is undocumented.
2. **Preserve the adapted role-intent path with a prompt role label or carrier token.** Rejected because labels and carriers can route task text but cannot attest authority.
3. **Allow the path on observed behavior and tighten it later.** Rejected because the harmful event is first authority acquisition; post-hoc correction cannot make it safe.
4. **Disable all native typed routing.** Rejected because routing-capable surfaces can explicitly select installed roles without relying on the unsupported adapted proof.

## Why chosen

Failing closed only when the runtime surface identifies the unsupported adapted authority path is the smallest policy that preserves typed native routing and ordinary native work while preventing unproven authority elevation. It produces stable machine-readable diagnostics and creates no planning or role-intent state on the blocked path.

## Compatibility and migration

Existing routing-capable callers continue to use explicit `agent_type` with an installed OMX role. On documented 0.144.5 surfaces that report `role_routing_unavailable`, callers run `omx ralplan preflight --json` and stop on `unsupported_documented_leader_proof` only before attempting adapted Ralplan Planner, Architect, or Critic authority, adapted role-intent, or adapted consensus authority; they must use a Codex surface with documented root proof or a reviewed alternative workflow for that authority. Ordinary native planning, lifecycle, state, status, health, HUD, runtime, setup, install, sync, and unrelated delegation remain outside preflight and under their existing controls. There is no compatibility shim that turns old session/thread/pointer evidence, native anchors, signed claims, tracker state, or local artifacts into authority. See [ADR 3212](./3212-same-user-native-child-auth-boundary.md) for the same-user hostile boundary and consensus consequence.

## Consequences

- Adapted Ralplan Planner, Architect, Critic, role-intent, and consensus authority are unavailable when the native surface reports `role_routing_unavailable`.
- Direct role-intent writes fail deterministically with `unsupported_documented_leader_proof` for installed roles.
- Keyword routing may seed ordinary Ralplan selection state before the model can inspect the native task schema; that state is not authority. The explicit preflight neutralizes only an exact current keyword seed before returning failure. Direct hook and CLI denials are zero-write.
- Ordinary native planning, lifecycle, state, status, health, HUD, runtime, setup, install, sync, and unrelated delegation do not enter this preflight; their existing controls remain in force.
- Typed native role-routing and lifecycle guidance remains valid where `agent_type` is exposed; it cannot release `ralplan -> ultragoal` without the official host receipt required by ADR 3212.

## Rollback

Rollback is removal of this unsupported-only gate and associated guidance only after the future enablement criterion is met and a reviewed replacement has been released. Do not roll back by adding heuristic identity inference or a compatibility fallback.

## Future enablement criterion

Enable a positive adapted-authority path only when official documentation for the target Codex version and hook/spawn surface defines a positive, stable binding from the current event to root identity and supplies a non-user-mintable official host consensus receipt channel. A reviewed implementation must verify the receipt directly through that official surface before adapted Ralplan Planner, Architect, Critic, role-intent, or consensus-release authority work. The receipt must bind issuer, version, session, installed roles, distinct host threads, artifact digests, ordering, and replay protection; local JSON, environment, tracker, transcript, marker, pointer, or absence-based inference cannot substitute it.

## Follow-ups

- Re-evaluate only when official Codex documentation adds the required root-to-event binding for a concrete version and surface.
- Add a reviewed implementation and regression coverage for that documented positive path before changing this ADR's decision.
- Keep public guidance aligned with the exact reason and output contract while the documented 0.144.5 boundary remains in force.
