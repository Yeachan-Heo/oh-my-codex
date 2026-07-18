# Session Owner Sidecar Design

**Status:** Approved

**Date:** 2026-07-18

## Context

Native Codex hooks currently use one cwd-scoped
`.omx/state/session.json` as the selected session pointer. Multiple live Codex
processes can legitimately use the same checkout, but only one can match that
pointer. A Stop hook from another live process is therefore rejected with
`session_scope_unmatched`.

The production reproduction had eight live Codex panes in the same checkout.
Pane `%40` owned the usable selected pointer while pane `%46` attempted Stop.
Both Codex processes were alive, so moving the pointer to `%46` would only
transfer the failure to `%40`.

The same single-pointer boundary also allows a nested ephemeral Codex process
to leave `session.json` stale-dead after it exits. The still-live parent then
cannot prove lifecycle authority through the selected pointer.

UserPromptSubmit already supports an explicit independent session while
suppressing global side effects. Stop does not yet have equivalent
session-scoped ownership evidence.

## Goals

- Give every native Codex session independently verifiable lifecycle authority
  within a shared cwd.
- Preserve `session.json` as a backward-compatible selected/default pointer.
- Prevent a live selected pointer from being replaced by a different Codex
  process.
- Allow an unmatched but authenticated Stop to evaluate only its own
  session-scoped state.
- Keep malformed, stale, reused-PID, foreign-cwd, or forged evidence
  fail-closed.

## Non-Goals

- Do not make multiple sessions share workflow state.
- Do not transfer active workflow ownership between sessions.
- Do not automatically select a replacement global pointer.
- Do not treat a native Stop event as process termination.
- Do not add automatic stale-owner garbage collection in this change.
- Do not change tmux panes, worker registries, or OpenCode state.

## Chosen Design

### 1. Session owner sidecar

Each native root session gets one owner sidecar:

```text
.omx/state/sessions/<native-session-id>/session-owner.json
```

The sidecar reuses the existing `SessionState` process-identity fields:

```text
session_id
native_session_id
started_at
cwd
pid
platform
pid_start_ticks
pid_cmdline
```

Reusing `SessionState` avoids a second identity schema and lets the existing
PID, Linux start-tick, command-line, and cwd classifiers remain authoritative.

The sidecar uses the existing session transaction mechanics: adjacent lock
directory, transaction-owned temporary file, fsync, and atomic rename. Its
lock is per session, so independent sessions do not contend on one owner file.

An existing usable sidecar may be refreshed only by the same process identity.
A different live process using the same session ID is an owner conflict.
A stale-dead sidecar may be replaced by a successor for that same session ID.
Malformed, foreign-cwd, or identity-indeterminate sidecars are preserved and
block adoption.

### 2. SessionStart behavior

For a native root SessionStart:

1. Validate and atomically write the session's owner sidecar.
2. Attempt the existing legacy `session.json` reconciliation.
3. If the selected pointer is absent, stale-dead, or belongs to the same
   process identity, preserve current compatibility behavior.
4. If another live process owns the selected pointer, preserve that pointer.
   The new session remains valid only for its own session-scoped state and
   receives no global side-effect authority.

Native subagent SessionStart handling remains unchanged and must not create a
root owner sidecar.

### 3. Stop authorization

Stop first follows the existing selected-pointer alias path.

If the payload session does not match `session.json`, Stop reads only:

```text
.omx/state/sessions/<payload-session-id>/session-owner.json
```

The sidecar authorizes the payload only when:

- the path session ID and stored native session ID match the payload;
- cwd matches the selected state root;
- the recorded process is alive;
- Linux start ticks and command-line identity match when present;
- the evidence is usable rather than stale or indeterminate.

An authorized sidecar Stop:

- uses the payload session as the canonical session-scoped ID;
- reads only that session's workflow and skill state;
- suppresses HUD reconciliation and other root/global side effects;
- never changes or deletes another session's selected pointer.

If its own workflow is active, Stop still returns the normal workflow
continuation block. If no scoped blocker exists, Stop is allowed without
requiring the public pointer to name that session.

### 4. End and stale evidence

A native Stop event ends one assistant turn, not the Codex process. It must not
delete the owner sidecar.

Wrapper-owned `writeSessionEnd` may delete an owner sidecar only when the
ending identity owns that exact sidecar. Native process death is detected by
the existing liveness classifier. Dead sidecars are inert and may be replaced
only by a later start for the same session ID.

No background garbage collector or automatic pointer promotion is included.

## Failure Behavior

- Missing sidecar: retain the existing `session_scope_unmatched` block.
- Stale-dead sidecar: block; a Stop cannot resurrect dead ownership.
- PID reuse or identity mismatch: block and preserve evidence.
- Malformed or foreign-cwd sidecar: block and preserve evidence.
- Live sidecar for another session: ignore it; exact-path lookup prevents
  cross-session adoption.
- Root pointer conflict: preserve the live selected owner and continue only
  with session-scoped authority.
- Sidecar write or lock ambiguity: fail closed before hook side effects.

## Test Design

### Session lifecycle tests

- Write and classify one usable owner sidecar.
- Refresh it from the same process identity.
- Reject a different live process using the same session ID.
- Replace a stale-dead sidecar for the same session ID.
- Preserve malformed, foreign-cwd, and identity-indeterminate evidence.
- Prove independent session sidecars do not overwrite each other.

### Native hook regression tests

- Reproduce `%40` as selected owner A and `%46` as live sidecar owner B.
  Stop B succeeds when B has no active workflow and pointer A remains
  byte-identical.
- Give B an active session-scoped workflow and prove Stop B blocks for that
  workflow rather than `session_scope_unmatched`.
- Reproduce a nested ephemeral selected pointer becoming stale-dead while the
  parent sidecar remains live; parent Stop uses its sidecar and does not repair
  or rewrite the stale root pointer.
- Reject a forged, dead, reused-PID, or foreign-cwd sidecar.
- Preserve legacy selected-pointer behavior when no sidecar is required.
- Keep native subagent Stop suppression and child lifecycle behavior unchanged.

### Verification commands

```text
npm run build
node dist/scripts/run-test-files.js \
  dist/hooks/__tests__/session.test.js \
  dist/hooks/__tests__/prompt-session-provenance.test.js \
  dist/scripts/__tests__/codex-native-hook.test.js
npm test
```

## Alternatives Rejected

### Replace `session.json` with a full per-session pointer namespace

This is architecturally clean but changes every selected-session consumer and
requires a broad migration. The sidecar design provides independent lifecycle
authority while retaining compatibility.

### Enforce one Codex process per checkout

This is smaller but incompatible with the observed multi-pane workflow and
does not let already-running non-selected sessions finish safely.

### Reassign the selected pointer during Stop

This transfers the failure to another live process and creates another race.
Stop must never claim global ownership as a side effect of ending a turn.

## Rollout Boundary

The source change is complete only after the focused and full test suites pass
and an upstream pull request is ready. Installing or hot-patching the global
`oh-my-codex` runtime is a separate deployment action and requires explicit
authorization.
