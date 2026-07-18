# Session Owner Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let every live native Codex session authenticate its own session-scoped Stop without changing another live session's selected pointer.

**Architecture:** Keep `.omx/state/session.json` as the backward-compatible selected pointer. Add one atomic `SessionState` sidecar under `.omx/state/sessions/<native-session-id>/session-owner.json`, reject cross-process selected-pointer replacement, and let Stop fall back to the exact usable sidecar with all root/global side effects suppressed.

**Tech Stack:** TypeScript, Node.js `node:test`, existing session pointer transaction and PID identity classifiers.

---

## File Map

- Modify `src/hooks/session.ts`: owner-sidecar path, atomic read/write helpers,
  same-process guard, and cross-PID selected-pointer rejection.
- Modify `src/hooks/__tests__/session.test.ts`: sidecar transaction, identity,
  stale replacement, malformed evidence, and selected-pointer guard tests.
- Modify `src/scripts/codex-native-hook.ts`: root SessionStart registration and
  exact-sidecar Stop fallback.
- Modify `src/scripts/__tests__/codex-native-hook.test.ts`: `%40/%46`,
  active-workflow, and stale-root regressions.
- Modify `docs/codex-native-hooks.md`: document native Stop ownership and the
  session/global side-effect boundary.
- Keep `docs/superpowers/specs/2026-07-18-session-owner-sidecar-design.md` as
  the approved design source of truth.

### Task 1: Lock the production failures with native-hook regression tests

**Files:**

- Modify: `src/scripts/__tests__/codex-native-hook.test.ts:99-145`
- Modify: `src/scripts/__tests__/codex-native-hook.test.ts:3960-4197`

- [ ] **Step 1: Add a test-only live sidecar fixture**

Add this helper beside the existing `writeJson` and session-state helpers:

```ts
async function writeLiveNativeSessionOwnerSidecar(
  cwd: string,
  stateDir: string,
  sessionId: string,
): Promise<void> {
  const selected = JSON.parse(
    await readFile(join(stateDir, "session.json"), "utf-8"),
  ) as Record<string, unknown>;
  await writeJson(
    join(stateDir, "sessions", sessionId, "session-owner.json"),
    {
      ...selected,
      session_id: sessionId,
      native_session_id: sessionId,
      started_at: new Date().toISOString(),
      cwd,
    },
  );
}
```

The helper copies the current process identity from a real
`writeSessionStart` result, so Linux start ticks and command-line evidence are
valid without test-only production seams.

- [ ] **Step 2: Add the `%40/%46` Stop regression**

Add a test near the existing issue `#3138` ownership tests:

```ts
it("authorizes a live unmatched Stop from its exact session owner sidecar without changing the selected pointer", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-sidecar-stop-"));
  try {
    const stateDir = join(cwd, ".omx", "state");
    const selectedSessionId = "native-selected-owner";
    const independentSessionId = "native-independent-owner";
    await writeSessionStart(cwd, selectedSessionId, {
      nativeSessionId: selectedSessionId,
      pid: process.pid,
    });
    await writeLiveNativeSessionOwnerSidecar(
      cwd,
      stateDir,
      independentSessionId,
    );
    const pointerBefore = await readFile(
      join(stateDir, "session.json"),
      "utf-8",
    );

    const result = await dispatchCodexNativeHook(
      {
        hook_event_name: "Stop",
        cwd,
        session_id: independentSessionId,
        thread_id: independentSessionId,
      },
      { cwd },
    );

    assert.equal(result.outputJson, null);
    assert.equal(
      await readFile(join(stateDir, "session.json"), "utf-8"),
      pointerBefore,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Add the session-scoped active-workflow regression**

```ts
it("uses the unmatched sidecar session workflow as the Stop blocker", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-sidecar-skill-"));
  try {
    const stateDir = join(cwd, ".omx", "state");
    const selectedSessionId = "native-selected-skill";
    const independentSessionId = "native-independent-skill";
    await writeSessionStart(cwd, selectedSessionId, {
      nativeSessionId: selectedSessionId,
      pid: process.pid,
    });
    await writeLiveNativeSessionOwnerSidecar(
      cwd,
      stateDir,
      independentSessionId,
    );
    await writeJson(
      join(
        stateDir,
        "sessions",
        independentSessionId,
        "skill-active-state.json",
      ),
      {
        active: true,
        skill: "ralplan",
        phase: "planning",
        session_id: independentSessionId,
        owner_codex_session_id: independentSessionId,
      },
    );
    await writeJson(
      join(
        stateDir,
        "sessions",
        independentSessionId,
        "ralplan-state.json",
      ),
      {
        active: true,
        current_phase: "planning",
        session_id: independentSessionId,
      },
    );

    const result = await dispatchCodexNativeHook(
      {
        hook_event_name: "Stop",
        cwd,
        session_id: independentSessionId,
        thread_id: independentSessionId,
      },
      { cwd },
    );

    assert.equal(result.outputJson?.decision, "block");
    assert.match(
      String(result.outputJson?.stopReason ?? ""),
      /^skill_ralplan_planning_/,
    );
    assert.notEqual(
      result.outputJson?.stopReason,
      "session_scope_unmatched",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Add the nested stale-root regression**

```ts
it("uses a live parent sidecar when a nested selected pointer is stale-dead", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-sidecar-stale-root-"));
  try {
    const stateDir = join(cwd, ".omx", "state");
    const parentSessionId = "native-live-parent";
    await writeSessionStart(cwd, parentSessionId, {
      nativeSessionId: parentSessionId,
      pid: process.pid,
    });
    await writeLiveNativeSessionOwnerSidecar(
      cwd,
      stateDir,
      parentSessionId,
    );
    await writeJson(join(stateDir, "session.json"), {
      session_id: "native-dead-nested",
      native_session_id: "native-dead-nested",
      started_at: "2026-01-01T00:00:00.000Z",
      cwd,
      pid: 999_999,
      platform: process.platform,
    });
    const pointerBefore = await readFile(
      join(stateDir, "session.json"),
      "utf-8",
    );

    const result = await dispatchCodexNativeHook(
      {
        hook_event_name: "Stop",
        cwd,
        session_id: parentSessionId,
        thread_id: parentSessionId,
      },
      { cwd },
    );

    assert.equal(result.outputJson, null);
    assert.equal(
      await readFile(join(stateDir, "session.json"), "utf-8"),
      pointerBefore,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 5: Run the focused tests and verify RED**

Run:

```bash
npm run build
node --test \
  --test-name-pattern="session owner sidecar|unmatched sidecar|nested selected pointer" \
  dist/scripts/__tests__/codex-native-hook.test.js
```

Expected: all three new tests fail because Stop returns
`session_scope_unmatched` or `session_pointer_unusable`; existing filtered
tests remain green.

- [ ] **Step 6: Commit the failing regression tests**

```bash
git add src/scripts/__tests__/codex-native-hook.test.ts
git commit \
  -m "Prove independent native sessions cannot finish through one selected pointer" \
  -m "Add the live-owner, active-workflow, and stale-root Stop reproductions before changing runtime behavior." \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: Focused native-hook tests fail on the expected ownership boundary."
```

### Task 2: Add the atomic native session owner primitive

**Files:**

- Modify: `src/hooks/session.ts:149-180`
- Modify: `src/hooks/session.ts:622-713`
- Modify: `src/hooks/session.ts:1315-1499`
- Modify: `src/hooks/__tests__/session.test.ts:1-40`
- Modify: `src/hooks/__tests__/session.test.ts:1070-1145`

- [ ] **Step 1: Add failing unit tests for the desired API**

Import:

```ts
import {
  readNativeSessionOwner,
  writeNativeSessionOwner,
} from "../session.js";
```

Add these tests inside `session pointer transaction`:

```ts
it("keeps native session owner sidecars isolated and rejects live cross-process reuse", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "omx-session-owner-sidecar-"));
  try {
    __setSessionPointerTransactionDependenciesForTests({
      probePid: () => "alive",
    });
    const first = await writeNativeSessionOwner(
      cwd,
      "native-owner-a",
      { pid: 11, platform: "win32" },
    );
    const second = await writeNativeSessionOwner(
      cwd,
      "native-owner-b",
      { pid: 22, platform: "win32" },
    );
    assert.equal(first.pid, 11);
    assert.equal(second.pid, 22);
    assert.equal(
      (await readNativeSessionOwner(cwd, "native-owner-a"))?.pid,
      11,
    );
    assert.equal(
      (await readNativeSessionOwner(cwd, "native-owner-b"))?.pid,
      22,
    );
    await assert.rejects(
      writeNativeSessionOwner(
        cwd,
        "native-owner-a",
        { pid: 22, platform: "win32" },
      ),
      (error: unknown) =>
        isSessionPointerLaunchAbort(error)
        && error.code === "session_pointer_owner_conflict",
    );
  } finally {
    __resetSessionPointerTransactionDependenciesForTests();
    await rm(cwd, { recursive: true, force: true });
  }
});

it("replaces only stale-dead owner evidence and preserves malformed evidence", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "omx-session-owner-recovery-"));
  try {
    __setSessionPointerTransactionDependenciesForTests({
      probePid: (pid) => pid === 11 ? "dead" : "alive",
    });
    await writeNativeSessionOwner(
      cwd,
      "native-owner-recovery",
      { pid: 11, platform: "win32" },
    );
    const recovered = await writeNativeSessionOwner(
      cwd,
      "native-owner-recovery",
      { pid: 22, platform: "win32" },
    );
    assert.equal(recovered.pid, 22);

    const malformedPath = join(
      cwd,
      ".omx",
      "state",
      "sessions",
      "native-owner-malformed",
      "session-owner.json",
    );
    await mkdir(dirname(malformedPath), { recursive: true });
    await writeFile(malformedPath, "{ malformed", "utf-8");
    assert.equal(
      await readNativeSessionOwner(cwd, "native-owner-malformed"),
      null,
    );
    await assert.rejects(
      writeNativeSessionOwner(
        cwd,
        "native-owner-malformed",
        { pid: 22, platform: "win32" },
      ),
      (error: unknown) =>
        isSessionPointerLaunchAbort(error)
        && error.code === "session_pointer_unusable"
        && error.pointerStatus === "malformed",
    );
  } finally {
    __resetSessionPointerTransactionDependenciesForTests();
    await rm(cwd, { recursive: true, force: true });
  }
});

it("rejects cross-process native reconciliation while preserving the live selected pointer", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "omx-session-cross-process-selected-"));
  try {
    __setSessionPointerTransactionDependenciesForTests({
      probePid: () => "alive",
    });
    await writeSessionStart(
      cwd,
      "native-selected-a",
      {
        nativeSessionId: "native-selected-a",
        pid: 11,
        platform: "win32",
      },
    );
    const before = await readFile(
      resolveSessionPointerContext(cwd).sessionPath,
      "utf-8",
    );
    await assert.rejects(
      reconcileNativeSessionStart(
        cwd,
        "native-selected-b",
        { pid: 22, platform: "win32" },
      ),
      (error: unknown) =>
        isSessionPointerLaunchAbort(error)
        && error.code === "session_pointer_owner_conflict",
    );
    assert.equal(
      await readFile(
        resolveSessionPointerContext(cwd).sessionPath,
        "utf-8",
      ),
      before,
    );
  } finally {
    __resetSessionPointerTransactionDependenciesForTests();
    await rm(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the build and verify RED**

Run:

```bash
npm run build
```

Expected: TypeScript fails with `TS2305` because
`readNativeSessionOwner` and `writeNativeSessionOwner` do not exist.

- [ ] **Step 3: Add the sidecar path and same-process classifier**

In `src/hooks/session.ts`, add:

```ts
const SESSION_OWNER_FILE = "session-owner.json";

function resolveNativeSessionOwnerContext(
  cwd: string,
  nativeSessionId: string,
): SessionPointerContext {
  const normalized = normalizeSessionId(nativeSessionId);
  const root = resolveSessionPointerContext(cwd);
  if (!normalized) {
    throw resolvedAbort(root, {
      code: "session_pointer_io_failure",
      operation: "pointer-classify",
      lockPath: root.lockPath,
      reason: "A valid native session ID is required for owner evidence.",
    });
  }
  const baseStateDir = join(
    root.baseStateDir,
    "sessions",
    normalized,
  );
  const sessionPath = join(baseStateDir, SESSION_OWNER_FILE);
  return {
    ...root,
    baseStateDir,
    sessionPath,
    lockPath: `${sessionPath}.lock`,
  };
}

function sameProcessIdentity(
  existing: SessionState,
  pid: number,
  platform: NodeJS.Platform,
  linuxIdentity: LinuxProcessIdentity | null,
): boolean {
  if (existing.pid !== pid) return false;
  if (platform !== "linux") return true;
  if (!linuxIdentity || existing.pid_start_ticks !== linuxIdentity.startTicks) {
    return false;
  }
  const expected = normalizeCmdline(existing.pid_cmdline);
  const current = normalizeCmdline(linuxIdentity.cmdline);
  return !expected || expected === current;
}
```

- [ ] **Step 4: Add atomic sidecar read/write functions**

Add after `writeSessionStart`:

```ts
function nativeSessionOwnerTransition(
  nativeSessionId: string,
  options: SessionStartOptions,
): (
  pointer: SessionPointerReadResult,
  context: SessionPointerContext,
) => SessionState {
  return (pointer, context) => {
    if (
      pointer.status !== "absent"
      && pointer.status !== "stale-dead"
      && pointer.status !== "usable"
    ) {
      throw unusablePointerAbort(context, nativeSessionId, pointer);
    }
    const pid = resolvePid(options);
    const platform = options.platform ?? process.platform;
    const identity = sessionIdentityFor(pid, platform);
    const existing =
      pointer.status === "usable" ? pointer.state : undefined;
    if (
      existing
      && !sameProcessIdentity(existing, pid, platform, identity)
    ) {
      throw ownerConflictAbort(
        context,
        nativeSessionId,
        existing,
      );
    }
    return createSessionState(
      context.cwd,
      nativeSessionId,
      pid,
      platform,
      identity,
      {
        nativeSessionId,
        startedAt: existing?.started_at,
        tmuxSessionName:
          options.tmuxSessionName ?? existing?.tmux_session_name,
        tmuxPaneId:
          options.tmuxPaneId ?? existing?.tmux_pane_id,
      },
    );
  };
}

export async function writeNativeSessionOwner(
  cwd: string,
  nativeSessionId: string,
  options: SessionStartOptions = {},
): Promise<SessionState> {
  const normalized = normalizeSessionId(nativeSessionId);
  const context = resolveNativeSessionOwnerContext(
    cwd,
    normalized ?? nativeSessionId,
  );
  const result = await writePointerTransaction(
    cwd,
    normalized,
    { context },
    NATIVE_POINTER_TIMEOUT_MS,
    nativeSessionOwnerTransition(
      normalized ?? nativeSessionId,
      options,
    ),
    (state) => state,
  );
  return result.value;
}

export async function readNativeSessionOwner(
  cwd: string,
  nativeSessionId: string,
): Promise<SessionState | null> {
  const normalized = normalizeSessionId(nativeSessionId);
  if (!normalized) return null;
  try {
    const pointer = await readSessionPointer(
      resolveNativeSessionOwnerContext(cwd, normalized),
    );
    const state = pointer.status === "usable"
      ? pointer.state
      : undefined;
    return state?.session_id === normalized
      && state.native_session_id === normalized
      ? state
      : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Reject cross-process selected-pointer replacement**

Inside `reconcileNativeTransition`, immediately before the existing
`existingNativeSessionId !== nativeSessionId` replacement branch, add:

```ts
if (
  existingNativeSessionId
  && existingNativeSessionId !== nativeSessionId
  && !sameProcessIdentity(
    existing,
    pid,
    platform,
    linuxIdentity,
  )
) {
  throw ownerConflictAbort(
    context,
    nativeSessionId,
    existing,
  );
}
```

Keep the existing different-native-ID replacement behavior for the same
process.

- [ ] **Step 6: Run the owner tests and verify GREEN**

Run:

```bash
npm run build
node --test \
  --test-name-pattern="native session owner|cross-process native reconciliation" \
  dist/hooks/__tests__/session.test.js
```

Expected: the new owner-sidecar and selected-pointer tests pass. The Task 1
native-hook tests remain red because Stop does not consume the sidecar yet.

- [ ] **Step 7: Commit the session primitive**

```bash
git add src/hooks/session.ts src/hooks/__tests__/session.test.ts
git commit \
  -m "Keep native session process identity outside the singleton selected pointer" \
  -m "Reuse the atomic pointer transaction for exact per-session owner sidecars and reject cross-process selected-pointer replacement." \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Tested: Focused session owner and reconciliation tests."
```

### Task 3: Authorize exact sidecar sessions in native SessionStart and Stop

**Files:**

- Modify: `src/scripts/codex-native-hook.ts:38-51`
- Modify: `src/scripts/codex-native-hook.ts:10149-10345`
- Modify: `src/scripts/__tests__/codex-native-hook.test.ts`

- [ ] **Step 1: Import the owner helpers**

Add to the `../hooks/session.js` import:

```ts
readNativeSessionOwner,
writeNativeSessionOwner,
```

- [ ] **Step 2: Make the global-side-effect flag lifecycle-aware**

Replace:

```ts
const allowPromptGlobalSideEffects =
  promptTurnContext?.status !== "authorized"
  || promptTurnContext.authorization.globalSideEffects === "allow";
```

with:

```ts
let allowGlobalSideEffects =
  promptTurnContext?.status !== "authorized"
  || promptTurnContext.authorization.globalSideEffects === "allow";
```

Replace every use of `allowPromptGlobalSideEffects` in
`dispatchCodexNativeHook` with `allowGlobalSideEffects`. Do not change the
conditions themselves.

- [ ] **Step 3: Register root SessionStart before selected-pointer reconciliation**

In the non-subagent SessionStart branch:

```ts
let ownerState: SessionState | null = null;
try {
  const sessionOwnerPid =
    options.sessionOwnerPid ?? resolveSessionOwnerPid(payload);
  ownerState = await writeNativeSessionOwner(
    cwd,
    nativeSessionId,
    {
      pid: sessionOwnerPid,
    },
  );
  const ownerOmxSessionId =
    await resolveVerifiedOwnerOmxSessionId();
  const sessionState = await reconcileNativeSessionStart(
    cwd,
    nativeSessionId,
    {
      context: pointerContext,
      pid: sessionOwnerPid,
      ...(ownerOmxSessionId
        ? {
          ownerOmxSessionId,
          ownerAliasVerified: true,
        }
        : {}),
    },
  );
  canonicalSessionId =
    safeString(sessionState.session_id).trim();
  resolvedNativeSessionId =
    safeString(sessionState.native_session_id).trim()
    || nativeSessionId;
  allowImplicitSessionSideEffects = true;
  stopAuthorizationFailure = null;
} catch (error) {
  if (
    ownerState
    && isSessionPointerLaunchAbort(error)
    && error.code === "session_pointer_owner_conflict"
  ) {
    canonicalSessionId = ownerState.session_id;
    resolvedNativeSessionId =
      ownerState.native_session_id ?? nativeSessionId;
    allowImplicitSessionSideEffects = true;
    allowGlobalSideEffects = false;
    stopAuthorizationFailure = null;
  } else {
    if (!isSessionPointerLaunchAbort(error)) throw error;
    canonicalSessionId = "";
    resolvedNativeSessionId = nativeSessionId;
    skipCanonicalSessionStartContext = true;
    allowImplicitSessionSideEffects = false;
    stopAuthorizationFailure = {
      stopReason: "session_pointer_unusable",
      reason:
        `OMX cannot authorize Stop while the selected session pointer is ${pointer.status}; repair the pointer evidence before continuing.`,
    };
  }
}
```

Do not register a sidecar in either native-subagent SessionStart branch.

- [ ] **Step 4: Add exact-sidecar Stop fallback**

Replace the unmatched Stop branch with:

```ts
if (stopPayloadSessionId && !stopCanonicalSessionId) {
  const ownerState = await readNativeSessionOwner(
    cwd,
    stopPayloadSessionId,
  );
  if (ownerState) {
    canonicalSessionId = ownerState.session_id;
    resolvedNativeSessionId =
      ownerState.native_session_id ?? stopPayloadSessionId;
    allowImplicitSessionSideEffects = true;
    allowGlobalSideEffects = false;
    stopAuthorizationFailure = null;
  } else {
    canonicalSessionId = "";
    allowImplicitSessionSideEffects = false;
    if (!stopAuthorizationFailure) {
      stopAuthorizationFailure = {
        stopReason: "session_scope_unmatched",
        reason:
          `OMX cannot authorize Stop for unmatched session id ${stopPayloadSessionId}; the selected session pointer remains authoritative.`,
      };
    }
  }
} else if (stopCanonicalSessionId) {
  canonicalSessionId = stopCanonicalSessionId;
}
```

This exact-path lookup is the only new fallback. Do not scan neighboring
session directories and do not rewrite `session.json`.

- [ ] **Step 5: Run focused native-hook tests and verify GREEN**

Run:

```bash
npm run build
node --test \
  --test-name-pattern="session owner sidecar|unmatched sidecar|nested selected pointer|issue #3138" \
  dist/scripts/__tests__/codex-native-hook.test.js
```

Expected: all Task 1 tests pass; issue `#3138`, native subagent, and legacy
unmatched-without-sidecar tests remain green.

- [ ] **Step 6: Run the complete focused ownership suite**

Run:

```bash
node dist/scripts/run-test-files.js \
  dist/hooks/__tests__/session.test.js \
  dist/hooks/__tests__/prompt-session-provenance.test.js \
  dist/scripts/__tests__/codex-native-hook.test.js
```

Expected: at least the 598-test baseline plus the new tests passes with zero
failures.

- [ ] **Step 7: Commit the hook integration**

```bash
git add \
  src/scripts/codex-native-hook.ts \
  src/scripts/__tests__/codex-native-hook.test.ts
git commit \
  -m "Let each authenticated native session finish without stealing the selected pointer" \
  -m "Register root session owners before legacy reconciliation and authorize unmatched Stop only from exact usable sidecar evidence with global side effects suppressed." \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Directive: Never scan or promote neighboring sidecars during Stop." \
  -m "Tested: Full native session, prompt provenance, and hook ownership suite."
```

### Task 4: Document, verify, and prepare the upstream PR

**Files:**

- Modify: `docs/codex-native-hooks.md:209-217`
- Verify: `docs/superpowers/specs/2026-07-18-session-owner-sidecar-design.md`
- Verify: `docs/superpowers/plans/2026-07-18-session-owner-sidecar-implementation.md`

- [ ] **Step 1: Document Stop session provenance**

Insert after `## UserPromptSubmit: session provenance`:

```md
## Stop: session owner provenance

Native root SessionStart records process-bound owner evidence under
`.omx/state/sessions/<native-session-id>/session-owner.json`. The singleton
`.omx/state/session.json` remains the backward-compatible selected pointer,
but a different live process cannot replace it.

When a Stop payload does not match the selected pointer, OMX reads only the
payload session's exact owner sidecar. Usable PID, Linux start-tick,
command-line, cwd, and session-id evidence authorizes only that session's
scoped workflow checks. Root/global hook side effects remain suppressed, the
selected pointer is not rewritten, and missing, dead, reused, malformed,
foreign, or indeterminate evidence stays fail-closed.

Native Stop ends one assistant turn rather than the Codex process, so a
successful Stop does not delete owner evidence.
```

- [ ] **Step 2: Run static checks**

```bash
npm run build
npm run lint
npm run check:no-unused
git diff --check
```

Expected: all commands exit zero with no new warnings.

- [ ] **Step 3: Run the full project suite**

```bash
npm test
```

Expected: all project tests pass. If a pre-existing unrelated failure appears,
record its exact test and reproduce it on `origin/main` before continuing.

- [ ] **Step 4: Review the final diff**

```bash
git status --short --branch
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
git log --oneline --decorate origin/main..HEAD
```

Expected:

- only the design, plan, session lifecycle, native hook, tests, and native-hook
  documentation are changed;
- no generated `dist/`, credentials, runtime state, or task-local evidence is
  tracked;
- every implementation commit has the intended verification trailers.

- [ ] **Step 5: Commit the documentation**

```bash
git add docs/codex-native-hooks.md
git commit \
  -m "Make native Stop ownership and global side-effect suppression explicit" \
  -m "Document the exact sidecar authority, fail-closed evidence classes, and why successful Stop preserves owner evidence." \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: Build, lint, no-unused, focused ownership suite, and full npm test."
```

- [ ] **Step 6: Rebase and publish**

```bash
git fetch origin
git rebase origin/main
npm run build
node dist/scripts/run-test-files.js \
  dist/hooks/__tests__/session.test.js \
  dist/hooks/__tests__/prompt-session-provenance.test.js \
  dist/scripts/__tests__/codex-native-hook.test.js
git push -u origin fix/session-pointer-owner-isolation-20260718
```

Expected: rebase is clean, the focused suite passes again, and the remote head
matches local `HEAD`.

If direct push to upstream is not authorized, push the same branch to the
authenticated user's fork and use that fork as the PR head. Do not change the
commit history or tests for the transport difference.

- [ ] **Step 7: Create and verify the upstream PR**

```bash
gh pr create \
  --repo Yeachan-Heo/oh-my-codex \
  --base main \
  --head WangErgouaaaa:fix/session-pointer-owner-isolation-20260718 \
  --title "fix(hooks): isolate native session Stop ownership" \
  --body-file /tmp/omx-session-owner-sidecar-pr-body.md
gh pr view \
  --repo Yeachan-Heo/oh-my-codex \
  --json url,state,headRefOid,baseRefOid,mergeable,statusCheckRollup
```

The PR body must state:

```text
Problem: one cwd-scoped selected pointer blocks another live Codex Stop.
Fix: exact per-session process-bound owner sidecars; no pointer reassignment.
Safety: unmatched sessions get session-scoped authority only; global effects remain suppressed.
Tests: focused ownership suite and full npm test.
Deployment: no global runtime install is included.
```

Expected: one open PR URL is recorded and its `headRefOid` equals local
`HEAD`. Stop before any global install or hot patch; deployment requires
separate explicit authorization.
