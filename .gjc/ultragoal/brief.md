# HUD State/Session Reconciliation Plan

Status: pending approval
Workflow: ralplan
Mode: short
Created: 2026-05-30

## Consensus

Planner drafted the initial plan, Architect returned ITERATE, Planner revised, Architect returned APPROVE, and Critic returned APPROVE. This artifact is planning-only and does not authorize execution.

- Initial planner artifact: `agent://2-HudStateReconcilePlan`
- Architect iteration artifact: `agent://3-ReviewHudReconcilePlan`
- Revised planner artifact: `agent://4-ReviseHudReconcilePlan`
- Architect approval artifact: `agent://5-RereviewHudReconcilePlan`
- Critic approval artifact: `agent://6-CriticHudReconcilePlan`

## ADR

Adopt a single session-authoritative HUD/state/session architecture.

A valid resolved session id means authoritative active decisions read exactly that session scope. Root fallback is forbidden for HUD visibility, overlays, Stop/pre-tool workflow continuation, and workflow-transition decisions. Root remains only for unmanaged/no-session operation and explicitly named compatibility/status APIs.

Canonical `skill-active-state.json` gates workflow visibility and continuation. Mode detail files enrich canonical active entries but never activate a workflow alone.

Notify-hook scoped sidefiles and native/workflow-transition paths are in scope because they currently participate in HUD/continuation behavior and can otherwise preserve divergent session authority.

## Principles

1. Session id implies exactly one authoritative active state dir; missing canonical session state means inactive/missing, not root fallback.
2. Canonical `skill-active-state.json` gates HUD, overlay, Stop/pre-tool continuation, and workflow-transition visibility; mode detail files only enrich canonical active entries.
3. Compatibility is opt-in and named: status/debug/read APIs may inspect root/session fallback, but active decisions may not.
4. Writer-readiness precedes strict reader deletion so architecture does not trade stale visibility bugs for blank valid workflows.
5. Notify-hook, native hook, and workflow-transition are in scope because their state reads/writes can affect HUD or continuation behavior.
6. Tmux HUD pane ownership is session-authoritative; leader pane identity refines same-session lifecycle only and never authorizes cross-session reuse.
7. All HUD launch/reconcile paths use one env builder preserving documented state-root precedence.

## Decision Drivers

1. Notify-hook has a separate scoped state resolver for `hud-state.json`/dedupe sidefiles and must not remain a parallel authority.
2. Native Stop/pre-tool and workflow-transition fallback behavior can reactivate workflows without canonical session state and must be migrated or explicitly narrowed.
3. Current resolver shape omits session metadata/native aliases used by HUD/Hermes/native paths; centralization requires a richer result.
4. Current tmux matching allows same-leader cross-session reuse; ownership rules need an implementation truth table.
5. State-root precedence currently honors `OMX_TEAM_STATE_ROOT` before `OMX_ROOT`/`OMX_STATE_ROOT`; HUD env construction must preserve that across detached/inside-tmux/reconcile paths.
6. Existing `skill-active` tests encode root-mirror visibility when session files are missing; strict readers must be sequenced after writer guarantees and test updates.
7. Compatibility APIs exist across MCP/Hermes/HUD/overlay/CLI and need an explicit allowed/forbidden boundary to prevent fallback behavior surviving under new names.

## Alternatives Considered

### Option A — Strict session-authoritative HUD/state model

Chosen.

Pros:
- Deletes cross-session HUD reuse, HUD root fallback, `useCompatibilityFallback`, duplicated env construction, and divergent metadata reads.
- Gives a simple invariant: session id means session dir only; no session id means root/unmanaged only; canonical skill-active gates visibility.
- Reduces regression surface by naming authoritative and compatibility APIs separately.

Cons:
- Legacy sessions without session-scoped canonical state may no longer show workflow HUD sections.
- Requires coordinated updates across HUD, CLI launch, overlay, state operations, notify/native hooks, transitions, and tests.

Why chosen: It is the only option that actually reconciles the split-brain architecture rather than adding more guards.

### Option B — Compatibility-preserving shim with stricter predicates

Rejected.

Pros:
- Smaller short-term diff.
- Less risk of legacy HUD sections disappearing immediately.

Cons:
- Keeps active-state authority split.
- Keeps fallback behavior available to future active decision callsites.
- Does not fully eliminate stale root/session leaks.

### Option C — Transitional dual-write migration plus strict reads

Accepted as sequencing, not final architecture.

Pros:
- Reduces risk that strict readers blank valid workflows.
- Lets writer guarantees land before reader deletion.

Cons:
- Larger implementation surface.
- Root ambiguity can survive unless root writes are explicitly compatibility mirrors.

## Affected Scope

- `src/mcp/state-paths.ts` or a small adjacent resolver module
- `src/state/skill-active.ts`
- `src/hud/state.ts`
- `src/hud/tmux.ts`
- `src/hud/reconcile.ts`
- `src/hud/index.ts`
- `src/cli/index.ts`
- `src/hooks/agents-overlay.ts`
- `src/scripts/notify-hook/state-io.ts`
- `src/scripts/notify-hook.ts`
- `src/scripts/codex-native-hook.ts`
- `src/state/workflow-transition-reconcile.ts`
- `src/mcp/hermes-bridge.ts`
- Focused tests under:
  - `src/state/__tests__/skill-active.test.ts`
  - `src/hud/__tests__/state.test.ts`
  - `src/hud/__tests__/tmux.test.ts`
  - `src/hud/__tests__/reconcile.test.ts`
  - `src/cli/__tests__/index.test.ts`
  - native/transition/notify tests where existing coverage lives

## Resolver Contract

Implement a shared resolver contract after approval.

```ts
type StateRootSource = 'team-env' | 'omx-root-env' | 'omx-state-root-env' | 'cwd-default';
type SessionScopeSource = 'explicit' | 'env' | 'session-json' | 'native-alias' | 'root';

interface ResolvedSessionMetadata {
  sessionId: string;
  nativeSessionId?: string;
  nativeSessionAliases: string[];
  ownerOmxSessionId?: string;
  ownerCodexSessionId?: string;
  ownerCodexThreadId?: string;
  leaderPaneId?: string;
  tmuxSessionName?: string;
  displayName?: string;
  raw?: SessionState;
  sourcePath?: string;
}

interface ResolvedRuntimeStateScope {
  cwd: string;
  baseStateDir: string;
  stateDir: string;
  rootSource: StateRootSource;
  sessionId?: string;
  source: SessionScopeSource;
  metadata?: ResolvedSessionMetadata;
  isSessionScoped: boolean;
  authoritativeActiveDirs: string[];
  compatibilityReadDirs: string[];
}
```

Resolution rules:
- Validate explicit session id first.
- Then validated `OMX_SESSION_ID` / `CODEX_SESSION_ID` / `SESSION_ID`.
- Then usable `session.json`.
- Then validated native aliases only when usable session metadata maps native id to canonical `session_id`.
- Otherwise root/no-session.
- `metadata.sessionId` must equal canonical `sessionId` when present.
- Native aliases never replace canonical session id for state dir naming.
- `authoritativeActiveDirs` is always `[stateDir]`; when session-scoped this is the session dir even if missing.
- `compatibilityReadDirs` must be chosen explicitly by compatibility/status callers.

## HUD Env Builder Contract

```ts
interface BuildHudRuntimeEnvInput {
  cwd: string;
  scope: ResolvedRuntimeStateScope;
  inheritedEnv?: NodeJS.ProcessEnv;
  owner?: { sessionId?: string; leaderPaneId?: string; tmuxSessionName?: string };
  preset?: 'minimal' | 'focused' | 'full';
}

interface BuildHudRuntimeEnvOutput {
  env: Record<string, string>;
  owner: { sessionId?: string; leaderPaneId?: string; tmuxSessionName?: string };
  baseStateDir: string;
  stateDir: string;
  rootSource: StateRootSource;
}
```

Output rules:
- Always set `OMX_TMUX_HUD_OWNER=1`.
- Set `OMX_SESSION_ID` only when `scope.sessionId` exists.
- Set `OMX_TMUX_HUD_LEADER_PANE` only for a non-empty leader pane.
- Preserve team state by forwarding `OMX_TEAM_STATE_ROOT` when `rootSource === 'team-env'`.
- Otherwise forward normalized `OMX_ROOT` when root came from `OMX_ROOT` and normalized `OMX_STATE_ROOT` when root came from `OMX_STATE_ROOT`.
- For cwd-default, either omit root env or set normalized cwd root consistently across all HUD launch paths.
- Precedence: `OMX_TEAM_STATE_ROOT` direct base state dir, then `OMX_ROOT` mapped to `<OMX_ROOT>/.omx/state`, then `OMX_STATE_ROOT` mapped to `<OMX_STATE_ROOT>/.omx/state`, then `<cwd>/.omx/state`.
- Do not silently normalize `OMX_TEAM_STATE_ROOT` into `OMX_STATE_ROOT`.

## Tmux Ownership Matrix

1. Requested `{sessionId:S, leaderPaneId:L}`; pane `{sessionId:S, leaderPaneId:L, owner:1}`: reuse/resize allowed; duplicate cleanup allowed among same exact owner panes.
2. Requested `{sessionId:S, leaderPaneId:L}`; pane `{sessionId:S, leaderPaneId missing, owner:1}`: reuse allowed only as same-session legacy session-owned pane; retag with leader metadata when possible.
3. Requested `{sessionId:S, leaderPaneId:L}`; pane `{sessionId:S, leaderPaneId:Other, owner:1}`: do not reuse for this leader; recommended default is ignore to avoid killing another live leader in same session.
4. Requested `{sessionId:S, leaderPaneId:L}`; pane `{sessionId:Other, leaderPaneId:L, owner:1}`: forbidden reuse, forbidden resize, forbidden duplicate cleanup for S.
5. Requested `{sessionId:S}` no leader; pane `{sessionId:S, any leader/missing, owner:1}`: reuse allowed for session-level lookup; duplicate cleanup may keep one pane for S according to tests.
6. Requested `{sessionId:S}`; pane `{sessionId:Other|missing, any leader, owner:1}`: no reuse, no resize, no cleanup as S duplicate.
7. Requested `{leaderPaneId:L}` no session; pane `{leaderPaneId:L, sessionId missing, owner:1}`: reuse allowed only for unmanaged/no-session HUDs.
8. Requested `{leaderPaneId:L}` no session; pane `{leaderPaneId:L, sessionId:S, owner:1}`: no reuse.
9. Requested `{}` unmanaged/global; pane with no `OMX_SESSION_ID`, no leader, owner-tag-only or watch command: may be listed as unmanaged HUD; cleanup must not affect session-tagged panes.
10. Pane without HUD watch command: never matches.

## Compatibility Boundary

### Authoritative active APIs

Allowed consumers:
- HUD state/render decisions
- agents overlay active modes
- native Stop/pre-tool continuation blockers
- workflow-transition visible modes
- prompt-submit HUD reconcile
- activation writer verification

Forbidden consumers:
- status pages that intentionally need legacy fallback unless they explicitly call compatibility APIs

Semantics:
- No root fallback when a session id exists.
- Missing session canonical state is inactive.

### Canonical writer APIs

Allowed consumers:
- `state_write`
- `startMode`
- keyword/native hooks
- prompt-submit activation
- workflow state initialization

Semantics:
- When a session id exists, write session canonical state first.
- Optional root mirror writes must be named compatibility mirrors and cannot be required for readers.

### Notify scoped sidefile APIs

Allowed consumers:
- `src/scripts/notify-hook/state-io.ts`
- `src/scripts/notify-hook.ts`
- auto-nudge/team tmux helpers that own notify dedupe or `hud-state.json`

Forbidden:
- HUD active-mode decisions

Semantics:
- Session sidefiles route to canonical session state dir.
- Root fallback only for no-session/unmanaged notify compatibility.

### Compatibility/status read APIs

Allowed consumers:
- MCP/Hermes status summaries
- explicit `omx state read` compatibility/status commands
- diagnostics
- migration/audit tooling

Forbidden consumers:
- HUD visibility
- overlay active modes
- Stop/pre-tool continuation
- workflow-transition visible modes
- tmux ownership

Semantics:
- May include root fallback for implicit current session but must project scope/source in output.

### Session metadata APIs

Allowed consumers:
- HUD session display
- Hermes session/status summaries
- CLI/HUD env builder
- native alias checks
- notify sidefile routing

Forbidden:
- direct ad hoc `session.json` reads in HUD/native/Hermes when resolver metadata is sufficient

Semantics:
- Canonical `sessionId` names state dirs.
- Native aliases are matching metadata only.

## Phased Implementation

1. Introduce the shared session/state resolver and HUD env builder without changing readers yet. Expose explicit authoritative vs compatibility methods.
2. Writer-readiness before strict reader deletion. Audit and update activation writers for `deep-interview`, `ralplan`, `autopilot`, `team`, `ralph`, `ultragoal`, `ultrawork`, `ultraqa`, and notify/native prompt activation. `state_write`, `startMode`, keyword/native hooks, prompt-submit reconcile, and CLI state initialization must create session-scoped canonical `skill-active-state.json` when a session id exists.
3. Migrate authoritative readers. `readVisibleSkillActiveState*`, HUD `readAllState`, overlay generation, Stop/pre-tool planning-mode blockers, and workflow-transition reconciliation must use authoritative resolver paths. Delete `useCompatibilityFallback`, root mode-state activation, root skill-active inheritance for a requested/current session, and transition logic that adds active mode details when canonical skill-active is absent.
4. Migrate notify-hook scoped I/O. Replace notify-local session/state resolver behavior with shared resolver semantics or thin wrappers.
5. Migrate native hook and workflow transition. Missing canonical session `skill-active-state.json` means inactive for planning/workflow continuation, except documented terminal cleanup reads that verify terminal canonical run-state.
6. Consolidate HUD tmux ownership according to the matrix. Delete same-leader cross-session reuse.
7. Consolidate HUD env construction. Detached bootstrap, inside-tmux launch, `omx hud --tmux`, prompt-submit reconcile, and watch command paths call one builder.
8. Migrate compatibility/status surfaces. Hermes/status/MCP read APIs keep compatibility only through explicitly named APIs and projected status output.
9. Remove obsolete helpers/comments/tests after replacements pass focused tests.

## Risks and Mitigations

- Strict readers can hide valid workflows if writers are incomplete. Mitigation: mandatory writer-readiness phase and activation-writer tests before reader deletion.
- Notify/native scope broadens the diff. Mitigation: thin wrappers over the shared resolver rather than parallel logic.
- Legacy sessions may lose HUD visibility. Mitigation: no-session/root compatibility views and status APIs report legacy state without activating it.
- Tmux cleanup can kill or reuse the wrong pane if ownership semantics are vague. Mitigation: matrix plus reconciliation tests before behavior changes.
- Env-root precedence changes can break team workers. Mitigation: preserve `OMX_TEAM_STATE_ROOT` direct-base semantics and add launch-path assertions.

## Verification Plan

No tests or project-wide commands were run during planning.

After approval, run focused verification:

1. State/skill-active tests: `src/state/__tests__/skill-active.test.ts`
   - session file present => visible
   - session file missing with root mirror active => null
   - writer helpers create session canonical state before strict readers rely on it
   - root/no-session behavior remains explicit

2. HUD state tests: `src/hud/__tests__/state.test.ts`
   - stale root mode details hidden
   - missing canonical skill-active hidden
   - canonical active with detail enrichment shown
   - canonical active excluding stale detail hidden
   - no-session root HUD compatibility preserved

3. Tmux ownership tests: `src/hud/__tests__/tmux.test.ts`, `src/hud/__tests__/reconcile.test.ts`
   - every ownership matrix class
   - duplicate cleanup limited to matching ownership class

4. HUD env tests: `src/cli/__tests__/index.test.ts`, `src/hud/__tests__/reconcile.test.ts`, HUD index/tmux tests
   - detached, inside-tmux, `omx hud --tmux`, and prompt-submit reconcile all call the shared builder
   - state-root precedence is `OMX_TEAM_STATE_ROOT` > `OMX_ROOT` > `OMX_STATE_ROOT` > cwd-default

5. Notify tests
   - `hud-state.json` and `notify-hook-state.json` write/read under session state dir when a session exists
   - root fallback only for no-session/unmanaged notify
   - session A sidefiles do not affect HUD state for session B

6. Native hook tests
   - missing canonical session `skill-active-state.json` does not block/continue ralplan/deep-interview
   - terminal canonical run-state cleanup exceptions do not create active blockers
   - native alias payload resolves to canonical session metadata before state lookup

7. Workflow-transition tests
   - active mode detail without canonical skill-active is not visible
   - canonical skill-active controls visible tracked modes
   - completion/retirement writes target resolved session scope

8. Hermes/status tests
   - native aliases map to canonical session metadata
   - compatibility fallback is reported as status/debug data only, not active authority

9. Static regression searches
   - `useCompatibilityFallback`
   - `rootModeStateBelongsToSession`
   - `sanitizeInheritedSkillActiveBase`
   - `filterRootEntriesForSession`
   - same-leader cross-session comments
   - direct `session.json` reads in HUD/native/Hermes
   - direct duplicated HUD env construction
   - `getReadScopedStateDirs` / `getReadScopedStateFilePaths` in HUD/overlay/native/transition active paths

Expected result: removed or confined to explicitly named compatibility/status APIs.

## Consensus Results

### Architect

Verdict: APPROVE

Architectural status: CLEAR. The revised plan addresses notify scope, native/workflow-transition behavior, resolver metadata/native aliases, tmux ownership, env construction, writer-readiness, and bounded compatibility APIs.

### Critic

Verdict: APPROVE

The plan is execution-ready after approval. Acceptance criteria and verification are concrete and enforceable.

## Approval Boundary

This plan is pending approval. Execution must not start until the user explicitly approves implementation. Recommended execution path after approval: `/skill:team` with this plan as the execution contract.
