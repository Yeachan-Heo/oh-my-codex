# Unmatched Codex Stop Safe Exit Design

## Problem

OMX keeps one authoritative `.omx/state/session.json` pointer per working
directory. When a second root Codex session starts from the same directory
while the pointer owner is still live, SessionStart correctly rejects the
second session. The rejected session remains usable for conversation, but its
later Stop payload cannot map to the authoritative pointer. The native Stop
hook therefore returns `decision: "block"` with
`stopReason: "session_scope_unmatched"`.

Every final response triggers Stop again. Because the pointer remains owned by
the first session, the rejected session enters an unproductive loop: final
response, blocked Stop, another response, then another blocked Stop.

On the affected host, Cursor also restores several integrated terminals from
the same shared checkout. The shell `codex()` wrapper creates a fresh tmux
session for each terminal, so one restart can recreate many competing root
Codex processes. This both reproduces the pointer conflict and materially
increases memory and inotify pressure.

## Goals

- Let a root Codex session whose SessionStart was rejected exit normally.
- Preserve the authoritative owner pointer and all owner-scoped workflow state.
- Keep Stop fail-closed when the unmatched session has acquired any
  session-scoped state.
- Prevent Cursor's automatic tmux wrapper from launching another Codex root in
  a checkout that already has a verified live owner.
- Keep both changes small, testable, and dependency-free.

## Non-goals

- Do not transfer ownership between live sessions.
- Do not delete, rewrite, or recover a live session pointer.
- Do not attach to, interrupt, or terminate an existing tmux pane.
- Do not redesign native subagent Stop handling.
- Do not add a general session registry or multi-owner pointer model.

## Approach

Use two independent safety layers.

### Layer 1: Safe unmatched Stop in OMX

Keep the existing session resolver and pointer validation unchanged. When Stop
produces `session_scope_unmatched`, inspect only the rejected payload session's
scoped state directory:

```text
<stateDir>/sessions/<payloadSessionId>
```

- If that directory does not exist, return no Stop output. The Codex TUI may
  exit, but OMX performs no implicit side effects.
- If that directory exists, retain the current blocking response.
- Continue blocking every `session_pointer_unusable` case.
- Keep the existing trusted native-subagent exception unchanged.

The absence of a scoped directory is the narrow evidence that SessionStart
failed before this root session acquired OMX-owned state. This avoids calling
`buildStopHookOutput`, which can reconcile modes, write native Stop signatures,
or nudge workflows. Allowing exit is therefore separate from authorizing any
state mutation.

The production change belongs in:

- `src/scripts/codex-native-hook.ts`

Regression coverage belongs in:

- `src/scripts/__tests__/codex-native-hook.test.ts`

Required cases:

1. A live owner pointer plus an unmatched root Stop with no scoped directory
   returns `null`, leaves the pointer byte-identical, and creates no
   `native-stop-state.json`.
2. An unmatched session with an existing scoped Team state still blocks.
3. An unmatched session with an existing scoped Ralph state still blocks.
4. An unusable pointer still blocks.
5. Trusted native-subagent Stop behavior remains unchanged.

### Layer 2: Cursor launch guard

Add a host-local, dependency-free pointer checker and call it from the Cursor
`codex()` wrapper immediately before `__cursor_tui_tmux_run`.

The checker resolves the current git root, then reads:

```text
<git-root>/.omx/state/session.json
```

It classifies the pointer as:

- `absent`: allow launch.
- `stale`: allow launch so OMX SessionStart can reconcile it.
- `live`: reject the new root launch and print the owner session ID plus the
  task-worktree guidance.
- `unusable`: reject the launch and direct the operator to repair pointer
  evidence.

A live Linux pointer requires:

- a positive PID;
- `kill(pid, 0)` success;
- matching `/proc/<pid>/stat` start ticks when `pid_start_ticks` is present;
- a pointer `cwd` matching the current git root.

The wrapper must not attach, kill, send tmux input, or mutate pointer state.
An explicit one-shot environment escape hatch,
`CODEX_ALLOW_SHARED_CHECKOUT=1`, may bypass the guard for recovery work.

The host files are:

- `/home/ergou-aa/.local/bin/codex-live-pointer-guard`
- `/home/ergou-aa/.bashrc`

The checker uses Python's standard library only and exposes a read-only
`--check <root>` command. Its smallest runnable verification covers absent,
stale, live, PID-reuse, malformed, and override cases using temporary
directories and injected process metadata.

## Data Flow

```text
Cursor terminal
  -> codex() shell wrapper
  -> live-pointer guard
     -> live/unusable: explain and return nonzero
     -> absent/stale/override: create tmux session
  -> Codex SessionStart
  -> OMX pointer reconciliation

Rejected secondary root
  -> final response
  -> Stop payload with unmatched session ID
  -> scoped state directory absent
  -> no Stop block, no OMX writes, TUI exits
```

## Error Handling

- Malformed pointer JSON fails closed at launch time.
- Missing `/proc` evidence classifies the pointer as stale only when the PID is
  definitely gone; indeterminate identity remains unusable.
- The Stop hook never treats an unusable pointer as safe.
- The Stop hook never removes state as part of the safe-exit path.
- The launch guard prints recovery guidance but does not attempt recovery.

## Verification

1. Build OMX from the isolated branch.
2. Run the focused native-hook test file and confirm the new test fails before
   implementation, then passes after the minimal change.
3. Run the full Node test suite and repository checks.
4. Run the host pointer checker's temporary-directory self-check.
5. Verify `bash -n /home/ergou-aa/.bashrc`.
6. Install the built OMX package through the normal user-level install path.
7. Use an isolated `/tmp` repository to black-box:
   - create a live owner pointer;
   - send Stop for an unmatched session;
   - verify no block output and byte-identical owner state;
   - verify an existing scoped state directory still blocks.
8. Do not use the current live shared-checkout pointer for acceptance.

## Rollback

- Revert the OMX source commit and reinstall the previous package.
- Remove the single `codex()` guard call and the host checker.
- No state migration or pointer cleanup is required.
