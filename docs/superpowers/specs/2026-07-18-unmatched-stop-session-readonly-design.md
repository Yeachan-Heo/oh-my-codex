# Unmatched Stop Session-Readonly Design

**Status:** Approved direction

**Base:** `origin/dev` at `0e67d48d63decdb3234562ac9626a122221e02a0`

**Scope:** Native Codex `Stop` handling only

## Problem

One checkout has one selected pointer at `.omx/state/session.json`. When two
root Codex sessions are live in that checkout, the pointer can describe only
one of them. A `Stop` event from the other session is rejected:

```text
OMX cannot authorize Stop for unmatched session id <id>; the selected session pointer remains authoritative.
```

This is a turn-ending decision, not a process shutdown or pointer ownership
transfer. Requiring singleton pointer ownership for this read-mostly decision
causes a live independent session to be blocked by another live session.

Issue #3202 is separate: it concerns wrapper-owned cleanup of a stale-dead
pointer after `omx exec` exits. This design does not alter pointer cleanup,
archival, locking, or stale evidence.

## Decision

Treat an unmatched native root `Stop` as a strictly session-scoped, read-only
decision after native-child classification.

For blocker evaluation, the payload session ID is only a lookup scope for:

```text
.omx/state/sessions/<payload-session-id>/
```

It does not become selected-pointer authority, root-state authority, or
permission to mutate lifecycle state. The dispatcher may additionally read
root `subagent-tracking.json` only to recognize a known native child and
preserve its existing Stop path. That tracker is not blocker, ownership,
pointer, cleanup, or lifecycle authority and does not create a marker or
sidecar.

## Behavior

### Existing selected session

When the payload session matches the usable selected pointer through its
canonical, native, or verified owner alias, keep the existing full `Stop`
pipeline unchanged.

### Unmatched session

When a usable selected pointer exists but does not match the payload session:

1. Validate the payload session ID with the existing session-ID validator.
2. Read root `subagent-tracking.json` only to classify a known native child;
   if matched, preserve the existing native-child Stop path.
3. Otherwise use the ID only as the exact session directory lookup key.
4. Read terminal `run-state.json` directly from that exact session so terminal
   truth can suppress stale blocker state.
5. Evaluate existing session-pinned blockers without root fallback. Payload
   prose, transcript text, and side-conversation heuristics cannot bypass this
   root blocker evaluation.
6. Return the first applicable blocker, or allow `Stop` when none applies.

The first implementation is limited to these currently proven session-safe
blockers:

- `autopilot`
- `ultrawork`
- `ultraqa`
- `team`
- pending `deep-interview` question obligations
- `ralplan`

It should reuse the existing blocker builders with a `sessionScopedOnly`
option instead of adding a second workflow engine.

Other blocker families remain on the matched selected-session path until they
are separately proven read-only and session-local.

### Fail-closed boundaries

Keep the existing failure behavior for:

- missing or invalid payload session IDs;
- malformed, foreign-cwd, or identity-indeterminate selected pointers;
- stale-dead selected pointers, which remain part of #3202;
- native subagent lifecycle cases already handled by the subagent guard.

## Mandatory side-effect boundary

The unmatched branch must not:

- write, replace, delete, or repair `session.json`;
- acquire or recover the selected-pointer lock;
- create owner sidecars, tokens, leases, or a session registry;
- read root workflow state as fallback;
- reconcile or clear root workflow state;
- persist root `native-stop-state.json` signatures;
- update HUD, mode, team, release-readiness, or lifecycle state;
- inspect or promote neighboring session directories.
- use root `subagent-tracking.json` for anything except read-only native-child
  classification.

The selected pointer and all root-scoped files must remain byte-identical.

## Security model

The native payload session ID is not promoted to global ownership. Even if a
caller supplies another valid session ID, blocker evaluation can only read
that exact session directory and return a decision to the caller. The
dispatcher-only tracker classification exception cannot supply blocker or
ownership authority. Neither path can change the selected session, the
referenced session, or any global state.

The existing session-ID validator prevents path traversal. Removing all writes
from this branch keeps the authority granted to the payload narrower than the
authority already granted to a matched selected session.

## Implementation surface

The expected implementation is limited to:

- `src/scripts/codex-native-hook.ts`
- `src/scripts/__tests__/codex-native-hook.test.ts`
- `docs/codex-native-hooks.md`

`src/hooks/session.ts` must not change. The design adds no dependency and no
new persisted artifact.

## Verification

Regression coverage must prove:

1. An unmatched root session with no scoped blocker may stop.
2. Each named session-pinned workflow still blocks its own unmatched session.
3. A blocker belonging to the selected or another session is ignored.
4. Exact-session terminal `run-state.json` suppresses stale blocker state.
5. Payload text and side-conversation heuristics do not bypass blockers.
6. Root tracker reads only preserve an already-known native child's Stop path.
7. `session.json` and representative root state files remain byte-identical.
8. No new root or session files, markers, or sidecars are created.
9. Invalid session IDs and unusable selected pointers remain blocked.
10. Matched selected-session and native-subagent behavior remains unchanged.

Use a table-driven test for the named workflow blockers and one focused
side-effect assertion shared by those cases.

## Rejected alternatives

### Per-session owner sidecar

Rejected because it adds identity persistence, locking, replacement, stale
owner, and recovery rules to a branch that does not need mutation authority.
PR #3207 demonstrated that this turns a narrow `Stop` problem into a broader
ownership redesign.

### Multi-session pointer registry

Rejected because replacing the singleton pointer affects launch, archive,
cancel, HUD, notify, and compatibility paths. The unmatched `Stop` decision
does not require that migration.

### Solving #3202 in the same change

Rejected because stale-dead wrapper cleanup has different ownership and
mutation requirements. It remains under the owner-controlled #3202 work.
