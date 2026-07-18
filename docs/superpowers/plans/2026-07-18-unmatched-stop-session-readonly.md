# Unmatched Stop Session-Readonly Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an unmatched native Codex root session finish a turn by evaluating only its own session-scoped Stop blockers, without creating ownership state or mutating the selected pointer and root state.

**Architecture:** Keep the existing full Stop pipeline for payloads that match the usable selected pointer. Route a valid unmatched payload session through a `sessionScopedOnly` branch that reuses the existing autopilot, ultrawork, ultraqa, team, deep-interview, and ralplan blocker builders with every root workflow fallback and mutation disabled. The dispatcher may read root subagent tracking only to classify a known native child and preserve its existing Stop path. Leave stale-dead pointer cleanup, lock recovery, SessionStart, and issue #3202 unchanged.

### Approved implementation clarification (2026-07-18)

- Builder-level tracker reads remain forbidden in `sessionScopedOnly`; the
  dispatcher may read root `subagent-tracking.json` only for native-child
  classification. Tracker data is never blocker, ownership, pointer, cleanup,
  or lifecycle authority, and no marker or sidecar is added.
- Terminal suppression reads `run-state.json` directly from the exact payload
  session directory, with no root fallback.
- Payload prose, transcript text, and side-conversation heuristics cannot
  bypass unmatched root blocker evaluation.

**Tech Stack:** TypeScript, Node.js built-in test runner, existing OMX session/mode state helpers, Biome, npm.

---

## File Map

- Modify `src/scripts/__tests__/codex-native-hook.test.ts`: add the unmatched-root regressions, side-effect snapshots, named blocker matrix, and update three old fail-closed expectations.
- Modify `src/scripts/codex-native-hook.ts`: add the strict session-only read option and route only valid unmatched usable-pointer Stop events through it.
- Modify `docs/codex-native-hooks.md`: document the unmatched Stop read-only boundary.
- Preserve `src/hooks/session.ts`: no pointer, lock, owner, archive, or stale-dead changes.
- Preserve dependencies and package metadata: no new package or persisted artifact.

### Task 0: Pin the execution baseline and dependency tree

**Files:**
- Verify: `package-lock.json`
- Verify: `docs/superpowers/specs/2026-07-18-unmatched-stop-session-readonly-design.md`
- Verify: `src/scripts/__tests__/codex-native-hook.test.ts`

- [ ] **Step 1: Verify the task branch is based on current `origin/dev`**

Run:

```bash
git fetch origin dev
git rev-list --left-right --count origin/dev...HEAD
git status --short --branch
```

Expected: the left count is `0`, the branch contains only the approved design/plan commits ahead of `origin/dev`, and the worktree is clean. If the left count is non-zero, run `git rebase origin/dev` in this task worktree, resolve only conflicts in task-owned files, then repeat this step before continuing.

- [ ] **Step 2: Install exactly the reviewed dependency tree**

Run:

```bash
sha256sum package-lock.json
npm ci
sha256sum package-lock.json
```

Expected: `npm ci` succeeds and both lockfile hashes are identical.

- [ ] **Step 3: Build and run the pre-change ownership baseline**

Run:

```bash
npm run build
node --test \
  --test-name-pattern='issue #3138|session-scoped (team|Ralph) id' \
  dist/scripts/__tests__/codex-native-hook.test.js
```

Expected: build succeeds and the three existing tests pass on the unmodified runtime.

### Task 1: Lock the unmatched Stop contract with failing tests

**Files:**
- Modify: `src/scripts/__tests__/codex-native-hook.test.ts:133-136`
- Modify: `src/scripts/__tests__/codex-native-hook.test.ts:4108-4355`
- Modify: `src/scripts/__tests__/codex-native-hook.test.ts:24292-24328`
- Modify: `src/scripts/__tests__/codex-native-hook.test.ts:26222-26250`

- [ ] **Step 1: Add one fixture that proves the entire state tree stays read-only**

Insert after `writeJson()`:

```ts
interface IndependentStopFixture {
  cwd: string;
  stateDir: string;
  sessionId: string;
  threadId: string;
}

async function withIndependentStopFixture(
  suffix: string,
  arrange: (fixture: IndependentStopFixture) => Promise<string[]>,
  verify: (
    result: Awaited<ReturnType<typeof dispatchCodexNativeHook>>,
  ) => void | Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), `omx-native-hook-independent-stop-${suffix}-`));
  try {
    const stateDir = join(cwd, ".omx", "state");
    const selectedSessionId = `selected-${suffix}`;
    const sessionId = `independent-${suffix}`;
    const threadId = `thread-${suffix}`;

    await writeSessionStart(cwd, selectedSessionId, {
      nativeSessionId: selectedSessionId,
      pid: process.pid,
    });

    const rootSkillPath = join(stateDir, "skill-active-state.json");
    const rootModePath = join(stateDir, "autopilot-state.json");
    const nativeStopPath = join(stateDir, "native-stop-state.json");
    await writeJson(rootSkillPath, {
      active: true,
      skill: "autopilot",
      phase: "executing",
      session_id: selectedSessionId,
      active_skills: [{
        active: true,
        skill: "autopilot",
        phase: "executing",
        session_id: selectedSessionId,
      }],
    });
    await writeJson(rootModePath, {
      active: true,
      mode: "autopilot",
      current_phase: "executing",
      session_id: selectedSessionId,
      workingDirectory: cwd,
    });
    await writeJson(nativeStopPath, {
      sessions: {
        [selectedSessionId]: {
          signature: "selected-session-sentinel",
        },
      },
    });

    const arrangedPaths = await arrange({ cwd, stateDir, sessionId, threadId });
    const watchedPaths = [
      join(stateDir, "session.json"),
      rootSkillPath,
      rootModePath,
      nativeStopPath,
      ...arrangedPaths,
    ];
    const contentsBefore = await Promise.all(
      watchedPaths.map((path) => readFile(path, "utf-8")),
    );
    const treeBefore = (await readdir(stateDir, { recursive: true }))
      .map(String)
      .sort();

    const result = await dispatchCodexNativeHook(
      {
        hook_event_name: "Stop",
        cwd,
        session_id: sessionId,
        thread_id: threadId,
      },
      { cwd },
    );

    await verify(result);
    assert.deepEqual(
      (await readdir(stateDir, { recursive: true })).map(String).sort(),
      treeBefore,
    );
    for (const [index, path] of watchedPaths.entries()) {
      assert.equal(await readFile(path, "utf-8"), contentsBefore[index]);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
```

- [ ] **Step 2: Add the no-blocker, invalid-ID, and blocker-matrix regressions**

Add near the existing issue #3138 Stop assertions:

```ts
it("allows an unmatched root Stop without importing or mutating selected root workflow state", async () => {
  await withIndependentStopFixture(
    "ordinary",
    async () => [],
    (result) => {
      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    },
  );
});

it("keeps invalid unmatched Stop session ids fail-closed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-invalid-unmatched-stop-"));
  try {
    await writeSessionStart(cwd, "selected-valid-stop", {
      nativeSessionId: "selected-valid-stop",
      pid: process.pid,
    });

    const result = await dispatchCodexNativeHook(
      {
        hook_event_name: "Stop",
        cwd,
        session_id: "../foreign",
      },
      { cwd },
    );

    assert.equal(result.outputJson?.decision, "block");
    assert.equal(result.outputJson?.stopReason, "session_scope_unmatched");
    assert.equal(
      existsSync(join(cwd, ".omx", "state", "sessions", "foreign")),
      false,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

const independentStopBlockers: Array<{
  name: string;
  expectedStopReason: string | RegExp;
  arrange: (fixture: IndependentStopFixture) => Promise<string[]>;
}> = [
  ...(["autopilot", "ultrawork", "ultraqa"] as const).map((mode) => ({
    name: mode,
    expectedStopReason: new RegExp(`^${mode}_`),
    arrange: async ({ cwd, stateDir, sessionId }: IndependentStopFixture) => {
      const path = join(stateDir, "sessions", sessionId, `${mode}-state.json`);
      await writeJson(path, {
        active: true,
        mode,
        current_phase: "executing",
        session_id: sessionId,
        workingDirectory: cwd,
      });
      return [path];
    },
  })),
  {
    name: "team",
    expectedStopReason: "team_team-exec",
    arrange: async ({ stateDir, sessionId, threadId }) => {
      const path = join(stateDir, "sessions", sessionId, "team-state.json");
      await writeJson(path, {
        active: true,
        mode: "team",
        team_name: "independent-team",
        current_phase: "team-exec",
        session_id: sessionId,
        owner_codex_thread_id: threadId,
      });
      return [path];
    },
  },
  {
    name: "deep-interview",
    expectedStopReason: "deep_interview_question_required",
    arrange: async ({ stateDir, sessionId, threadId }) => {
      const skillPath = join(
        stateDir,
        "sessions",
        sessionId,
        "skill-active-state.json",
      );
      const modePath = join(
        stateDir,
        "sessions",
        sessionId,
        "deep-interview-state.json",
      );
      await writeJson(skillPath, {
        active: true,
        skill: "deep-interview",
        phase: "intent-first",
        session_id: sessionId,
        thread_id: threadId,
      });
      await writeJson(modePath, {
        active: true,
        mode: "deep-interview",
        current_phase: "intent-first",
        session_id: sessionId,
        thread_id: threadId,
        question_enforcement: {
          obligation_id: "independent-question",
          source: "omx-question",
          status: "pending",
          requested_at: "2026-07-18T00:00:00.000Z",
        },
      });
      return [skillPath, modePath];
    },
  },
  {
    name: "ralplan",
    expectedStopReason: "skill_ralplan_planning_continue_artifact",
    arrange: async ({ stateDir, sessionId, threadId }) => {
      const skillPath = join(
        stateDir,
        "sessions",
        sessionId,
        "skill-active-state.json",
      );
      const modePath = join(
        stateDir,
        "sessions",
        sessionId,
        "ralplan-state.json",
      );
      await writeJson(skillPath, {
        active: true,
        skill: "ralplan",
        phase: "planning",
        session_id: sessionId,
        thread_id: threadId,
      });
      await writeJson(modePath, {
        active: true,
        mode: "ralplan",
        current_phase: "planning",
        session_id: sessionId,
        thread_id: threadId,
      });
      return [skillPath, modePath];
    },
  },
];

for (const blocker of independentStopBlockers) {
  it(`uses only the unmatched session ${blocker.name} Stop blocker`, async () => {
    await withIndependentStopFixture(
      blocker.name,
      blocker.arrange,
      (result) => {
        assert.equal(result.outputJson?.decision, "block");
        const stopReason = String(result.outputJson?.stopReason ?? "");
        if (blocker.expectedStopReason instanceof RegExp) {
          assert.match(stopReason, blocker.expectedStopReason);
        } else {
          assert.equal(stopReason, blocker.expectedStopReason);
        }
      },
    );
  });
}
```

- [ ] **Step 3: Update the three existing expectations that encode the old singleton rule**

Apply these exact changes without altering the surrounding fixtures:

```ts
// Replace the two output assertions for `unmatchedStop` in the issue #3138 case:
assert.equal(unmatchedStop.outputJson, null);
assert.equal(
  existsSync(join(conflictingCwd, ".omx", "state", "native-stop-state.json")),
  false,
);

// Rename:
"fails closed on Stop when a session-scoped team id is not bound to session.json"
// To:
"uses a session-scoped team blocker when its id is not bound to session.json"
// Replace the reason assertion block with:
assert.equal(result.outputJson?.decision, "block");
assert.equal(result.outputJson?.stopReason, "team_team-exec");

// Rename:
"fails closed on Stop when a session-scoped Ralph id is not bound to session.json"
// To:
"does not import unsupported Ralph blockers into unmatched Stop"
// Replace its three output assertions with:
assert.equal(result.omxEventName, "stop");
assert.equal(result.outputJson, null);
```

Remove the superseded `session_scope_unmatched` reason assertions from those three cases. Do not remove the foreign-cwd or invalid-ID fail-closed assertions.

- [ ] **Step 4: Build and run the new tests to verify RED**

Run:

```bash
npm run build
node --test \
  --test-name-pattern='unmatched root Stop|invalid unmatched Stop|unmatched session .* Stop blocker|session-scoped team blocker|unsupported Ralph blockers|issue #3138' \
  dist/scripts/__tests__/codex-native-hook.test.js
```

Expected: the invalid-ID and foreign-pointer boundaries remain green; the new ordinary and named-blocker expectations fail because the runtime still returns `session_scope_unmatched`.

- [ ] **Step 5: Commit the regression contract**

```bash
git add src/scripts/__tests__/codex-native-hook.test.ts
git commit \
  -m "Lock unmatched Stop to a read-only session contract" \
  -m "Record the ordinary, workflow-blocked, invalid-id, and byte-identical state expectations before changing native Stop routing." \
  -m $'Constraint: Tests must fail on the old session_scope_unmatched boundary before runtime changes.\nConfidence: high\nScope-risk: narrow\nReversibility: clean\nDirective: Keep the fixture independent from owner sidecars and pointer cleanup.\nTested: Focused unmatched Stop tests fail on the expected old boundary.\nNot-tested: Runtime implementation remains intentionally absent in this commit.'
```

### Task 2: Implement the strict session-only Stop path

**Files:**
- Modify: `src/scripts/codex-native-hook.ts:2802-2914`
- Modify: `src/scripts/codex-native-hook.ts:3193-3241`
- Modify: `src/scripts/codex-native-hook.ts:18394-18462`
- Modify: `src/scripts/codex-native-hook.ts:18754-18805`
- Modify: `src/scripts/codex-native-hook.ts:19147-19179`
- Modify: `src/scripts/codex-native-hook.ts:19286-19504`
- Modify: `src/scripts/codex-native-hook.ts:19713-20317`

- [ ] **Step 1: Make autopilot, ultrawork, and ultraqa read the exact session file**

Change `readModeStateWithStopSource()` to:

```ts
async function readModeStateWithStopSource(
  mode: "autopilot" | "ultrawork" | "ultraqa",
  cwd: string,
  sessionId?: string,
  options: { sessionScopedOnly?: boolean } = {},
): Promise<{ state: Record<string, unknown>; path: string } | null> {
  if (options.sessionScopedOnly) {
    const normalizedSessionId = safeString(sessionId).trim();
    if (!normalizedSessionId) return null;
    const path = getStateFilePath(`${mode}-state.json`, cwd, normalizedSessionId);
    const state = await readJsonIfExists(path);
    return state ? { state, path } : null;
  }
  const paths = await getAuthoritativeActiveStatePaths(
    mode,
    cwd,
    sessionId?.trim() || undefined,
  ).catch(() => [] as string[]);
  const path = paths[0];
  if (!path) return null;
  const state = await readJsonIfExists(path);
  return state ? { state, path } : null;
}
```

Make these three exact substitutions in `buildModeBasedStopOutput()`:

```ts
// 1. Replace the signature with:
async function buildModeBasedStopOutput(
  mode: "autopilot" | "ultrawork" | "ultraqa",
  cwd: string,
  sessionId?: string,
  options: { sessionScopedOnly?: boolean } = {},
): Promise<Record<string, unknown> | null> {
}

// 2. Replace the sourced-state call with:
const sourcedState = await readModeStateWithStopSource(
  mode,
  cwd,
  sessionId,
  options,
);

// 3. Replace the root canonical-state assignment with:
const rootCanonicalState = options.sessionScopedOnly
  ? null
  : await readRawSkillActiveState(
    getSkillActiveStatePathsForStateDir(getBaseStateDir(cwd)).rootPath,
  );
```

Preserve the terminal-run semantics, but in `sessionScopedOnly` read
`run-state.json` directly through
`getStateFilePath("run-state.json", cwd, normalizedSessionId)` instead of the
root-aware reader. Do not change the autopilot question-wait check,
continuation test, or output construction around these substitutions.

- [ ] **Step 2: Make Team use only session `team-state.json` and its coarse phase**

Add `options: { sessionScopedOnly?: boolean } = {}` to
`readTeamModeStateForStop()`. Immediately after the scoped-state branch, add:

```ts
if (options.sessionScopedOnly) return null;
```

Make these exact changes in `buildTeamStopOutput()`:

```ts
// 1. Replace the signature with:
async function buildTeamStopOutput(
  cwd: string,
  sessionId?: string,
  threadId?: string,
  options: { sessionScopedOnly?: boolean } = {},
): Promise<Record<string, unknown> | null> {
}

// 2. Replace the readTeamModeStateForStop call with:
const teamStateForStop = await readTeamModeStateForStop(
  cwd,
  getBaseStateDir(cwd),
  sessionId,
  threadId,
  options,
);

// 3. Immediately after the existing `teamName` assignment, insert:
const coarsePhase = teamState.current_phase;
if (options.sessionScopedOnly) {
  return isNonTerminalPhase(coarsePhase)
    ? buildTeamStopOutputForPhase(teamName, formatPhase(coarsePhase))
    : null;
}
```

Remove the later duplicate `const coarsePhase = teamState.current_phase;`.
Use the same direct exact-session terminal-run read described above. Leave the
matched-session canonical team-directory and phase handling unchanged.

- [ ] **Step 3: Make deep-interview and ralplan read-only**

Add `options: { sessionScopedOnly?: boolean } = {}` to
`buildDeepInterviewQuestionStopOutput()` and guard its reconciliation write:

```ts
if (!options.sessionScopedOnly) {
  await reconcileDeepInterviewQuestionEnforcementFromAnsweredRecords(
    cwd,
    sessionId,
  );
}
```

Add the same option to `readBlockingSkillForStop()` and guard the root
inactive-state comparison:

```ts
if (
  !options.sessionScopedOnly
  && await shouldIgnoreSessionSkillBlockerForCanonicalInactiveRoot(
    cwd,
    stateDir,
    skill,
    sessionId,
    threadId,
  )
) continue;
```

Add the option to `buildSkillStopOutput()`, forward it to
`readBlockingSkillForStop()`, and keep builder-level root tracker reads
disabled. Dispatcher-level read-only native-child classification remains the
sole exception:

```ts
const blocker = await readBlockingSkillForStop(
  cwd,
  stateDir,
  sessionId,
  threadId,
  undefined,
  options,
);
if (!blocker) return null;

const subagentSummary = options.sessionScopedOnly
  ? null
  : await readSubagentSessionSummary(cwd, sessionId).catch(() => null);
```

Keep the existing ralplan status/message builder unchanged.

- [ ] **Step 4: Compose only the six approved blockers**

Extend `buildStopHookOutput()` options:

```ts
options: {
  skipAutoNudge?: boolean;
  skipRalphStopBlock?: boolean;
  canonicalSessionId?: string;
  sessionScopedOnly?: boolean;
} = {},
```

Immediately after computing `canonicalSessionId`, `threadId`, and
`suppressParentWorkflowStop`, add:

```ts
if (options.sessionScopedOnly) {
  if (!canonicalSessionId) return null;

  for (const mode of ["autopilot", "ultrawork", "ultraqa"] as const) {
    const modeOutput = await buildModeBasedStopOutput(
      mode,
      cwd,
      canonicalSessionId,
      { sessionScopedOnly: true },
    );
    if (modeOutput) return modeOutput;
  }

  const teamOutput = await buildTeamStopOutput(
    cwd,
    canonicalSessionId,
    threadId,
    { sessionScopedOnly: true },
  );
  if (teamOutput) return teamOutput;

  const deepInterviewQuestionOutput =
    await buildDeepInterviewQuestionStopOutput(
      cwd,
      stateDir,
      canonicalSessionId,
      threadId,
      { sessionScopedOnly: true },
    );
  if (deepInterviewQuestionOutput) {
    return deepInterviewQuestionOutput.output;
  }

  return await buildSkillStopOutput(
    cwd,
    stateDir,
    canonicalSessionId,
    threadId,
    { sessionScopedOnly: true },
  );
}
```

This return must stay before root reconciliation, exec follow-up, Ralph,
autoresearch, Team worker, release-readiness, persistent signatures,
auto-nudge, goal cleanup, and plugin side effects.

- [ ] **Step 5: Route only valid unmatched usable-pointer root Stops into the strict branch**

Near `allowImplicitSessionSideEffects`, add:

```ts
let sessionScopedStopOnly = false;
```

Replace the unmatched part of the native Stop session resolution with:

```ts
if (hookEventName === "Stop") {
  const stopPayloadSessionId = readPayloadSessionId(payload);
  const stopCanonicalSessionId = await resolveInternalSessionIdForPayload(
    cwd,
    stopPayloadSessionId,
    undefined,
    currentSessionState,
    pointer.status === "absent",
  );
  if (stopPayloadSessionId && !stopCanonicalSessionId) {
    const scopedStopSessionId = normalizeSessionId(stopPayloadSessionId);
    if (
      pointer.status === "usable"
      && scopedStopSessionId
      && !stopAuthorizationFailure
    ) {
      canonicalSessionId = scopedStopSessionId;
      allowImplicitSessionSideEffects = false;
      sessionScopedStopOnly = true;
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
  if (
    canonicalSessionId
    && safeString(currentSessionState?.session_id).trim() === canonicalSessionId
  ) {
    resolvedNativeSessionId =
      safeString(currentSessionState?.native_session_id).trim()
      || resolvedNativeSessionId;
  }
}
```

Preserve native subagent behavior by widening the existing recovery condition
and clearing the strict-root flag:

```ts
if (
  isSubagentStop
  && (
    sessionScopedStopOnly
    || stopAuthorizationFailure?.stopReason === "session_scope_unmatched"
  )
) {
  sessionScopedStopOnly = false;
  canonicalSessionId = normalizeSessionId(readPayloadSessionId(payload)) ?? "";
  allowImplicitSessionSideEffects = true;
  stopAuthorizationFailure = null;
  eventSessionId = canonicalSessionId || nativeSessionId || undefined;
  sessionIdForState = canonicalSessionId || null;
}
```

Finally, replace the Stop output branch with:

```ts
} else if (hookEventName === "Stop") {
  if (sessionScopedStopOnly) {
    outputJson = await buildStopHookOutput(payload, cwd, stateDir, {
      canonicalSessionId: canonicalSessionId || undefined,
      sessionScopedOnly: true,
    });
  } else if (allowImplicitSessionSideEffects) {
    outputJson = await buildStopHookOutput(payload, cwd, stateDir, {
      canonicalSessionId: canonicalSessionId || undefined,
      skipRalphStopBlock: isSubagentStop,
      skipAutoNudge: isSubagentStop,
    }) ?? await buildCompletedGoalCleanupStopOutput(payload, cwd);
  } else {
    const failure = stopAuthorizationFailure ?? {
      stopReason: "session_pointer_unusable",
      reason: "OMX cannot authorize Stop without a writable session authority.",
    };
    outputJson = {
      decision: "block",
      stopReason: failure.stopReason,
      reason: failure.reason,
      systemMessage: failure.reason,
    };
  }
}
```

Do not change `allowPromptGlobalSideEffects`, SessionStart reconciliation,
pointer helpers, or state schemas.

- [ ] **Step 6: Build and run the focused tests to verify GREEN**

Run:

```bash
npm run build
node --test \
  --test-name-pattern='unmatched root Stop|invalid unmatched Stop|unmatched session .* Stop blocker|session-scoped team blocker|unsupported Ralph blockers|issue #3138' \
  dist/scripts/__tests__/codex-native-hook.test.js
```

Expected: all selected tests pass; the no-blocker case returns no output, the
six named blockers return their workflow output, invalid IDs remain blocked,
and every state snapshot is unchanged.

- [ ] **Step 7: Run the complete native-hook test file**

Run:

```bash
node --test dist/scripts/__tests__/codex-native-hook.test.js
```

Expected: all tests in the file pass with zero failures.

- [ ] **Step 8: Commit the runtime change**

```bash
git add src/scripts/codex-native-hook.ts
git commit \
  -m "Let unmatched native sessions stop without pointer ownership" \
  -m "Use the explicit payload session only as an exact read scope, while retaining the full pipeline for selected sessions and the existing fail-closed pointer boundaries." \
  -m $'Constraint: Unmatched blocker evaluation may read exact session state only; the root subagent tracker is allowed solely for read-only native-child classification.\nRejected: Owner sidecars | no persisted identity is required for a read-only caller-local decision.\nConfidence: high\nScope-risk: narrow\nReversibility: clean\nDirective: Do not use root tracker data for blocker, ownership, pointer, cleanup, or lifecycle decisions.\nTested: Focused unmatched Stop regressions and complete codex-native-hook test file.\nNot-tested: Full repository suite remains for final verification.'
```

### Task 3: Document the operator-visible boundary

**Files:**
- Modify: `docs/codex-native-hooks.md:53-71`

- [ ] **Step 1: Add the unmatched Stop section after the native hook mapping table**

Insert:

```markdown
## Stop: unmatched root-session read-only boundary

A native root `Stop` whose valid payload session ID does not match the usable
selected `session.json` pointer is evaluated only against
`.omx/state/sessions/<payload-session-id>/`. This narrow path may return
session-pinned autopilot, ultrawork, ultraqa, Team, pending deep-interview
question, or ralplan continuation output. Exact-session terminal
`run-state.json` may suppress stale blockers; if none applies, the turn may
stop. Payload prose, transcript text, and side-conversation heuristics cannot
bypass this evaluation.

The unmatched path does not promote the payload ID to selected or global
authority. It does not dispatch hook plugins, read root workflow fallback,
use canonical Team phase, persist Stop signatures, reconcile state, mutate HUD
or modes, acquire locks, run completed-goal cleanup, or write/delete/repair the
selected pointer. Invalid payload IDs and unusable selected pointers remain
fail-closed, and Ralph is excluded.

The dispatcher may read root `subagent-tracking.json` only to classify a known
native child and preserve its existing Stop path. Tracker data is never
blocker, ownership, pointer, cleanup, or lifecycle authority, and no marker or
sidecar is added.

This rule does not change wrapper-owned stale-dead pointer archive/cleanup;
that lifecycle remains tracked separately by issue #3202.
```

- [ ] **Step 2: Verify the documentation-only diff**

Run:

```bash
git diff --check
git diff -- docs/codex-native-hooks.md
```

Expected: no whitespace errors and only the approved Stop boundary is added.

- [ ] **Step 3: Commit the documentation**

```bash
git add docs/codex-native-hooks.md
git commit \
  -m "Explain why unmatched Stop needs no pointer ownership" \
  -m "Document the exact session-only read boundary, preserved fail-closed cases, and separation from issue #3202." \
  -m $'Constraint: Operator documentation must not imply pointer repair, ownership transfer, or stale-dead cleanup.\nConfidence: high\nScope-risk: narrow\nReversibility: clean\nDirective: Keep #3202 lifecycle cleanup separate from unmatched Stop decisions.\nTested: git diff --check and targeted documentation diff review.\nNot-tested: No runtime behavior changed in this commit.'
```

### Task 4: Run final verification and prepare review evidence

**Files:**
- Verify: `src/scripts/codex-native-hook.ts`
- Verify: `src/scripts/__tests__/codex-native-hook.test.ts`
- Verify: `docs/codex-native-hooks.md`
- Verify: `docs/superpowers/specs/2026-07-18-unmatched-stop-session-readonly-design.md`
- Verify: `docs/superpowers/plans/2026-07-18-unmatched-stop-session-readonly.md`

- [ ] **Step 1: Run fresh static checks**

Run:

```bash
npm run build
npm run lint
npm run check:no-unused
node dist/scripts/generate-catalog-docs.js --check
git diff --check origin/dev...HEAD
```

Expected: every command exits zero.

- [ ] **Step 2: Run focused and full tests**

Run:

```bash
node --test dist/scripts/__tests__/codex-native-hook.test.js
npm test
```

Expected: both commands exit zero. If `npm test` fails outside the changed
native-hook surface, reproduce the exact failure on a clean `origin/dev`
worktree with the same `npm ci` dependency tree and report both results; do not
modify unrelated code to hide a baseline failure.

- [ ] **Step 3: Verify the final scope and commit provenance**

Run:

```bash
git status --short --branch
git diff --name-only origin/dev...HEAD
git log --format=fuller --decorate origin/dev..HEAD
git rev-list --left-right --count origin/dev...HEAD
```

Expected:

- the worktree is clean;
- the changed paths are limited to the five files listed in this task;
- every commit has contiguous Lore trailers;
- the branch is not behind `origin/dev`.

- [ ] **Step 4: Stop before external publication**

Do not push, open a replacement PR, install globally, or deploy from this
plan. Present the final diff, test evidence, current `origin/dev` base SHA, and
the #3202 non-overlap statement for user review before any external write.
