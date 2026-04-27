# OMX State Model

This document explains how OMX tracks workflow/skill state, how transition rules are evaluated, and which transitions are commonly allowed or blocked.

## Goals

- make mode state predictable across CLI, MCP, hooks, and HUD
- show which files are authoritative vs compatibility-only
- explain how allowlisted handoffs and overlap rules work
- document common workflow transitions in one place

## State authorities

### 1. Per-mode state files — authoritative

Authoritative workflow state lives in per-mode files under `.omx/state/`:

- root scope: `.omx/state/<mode>-state.json`
- session scope: `.omx/state/sessions/<session_id>/<mode>-state.json`

Examples:

- `.omx/state/ralplan-state.json`
- `.omx/state/sessions/<session_id>/ralph-state.json`
- `.omx/state/team-state.json`

These files determine whether a workflow mode is active, completed, cancelled, or failed. Those mode phases are not always identical to the user-facing terminal lifecycle vocabulary; see the explicit terminal lifecycle section below for that compatibility boundary.

### 2. `skill-active-state.json` — compatibility / visibility layer

`skill-active-state.json` is still used as a compatibility surface for hooks/HUD/native messaging, but transition reconciliation should be driven from the shared transition/reconciliation helpers rather than re-deriving semantics ad hoc.

Locations:

- `.omx/state/skill-active-state.json`
- `.omx/state/sessions/<session_id>/skill-active-state.json`

### 3. Session precedence

Read precedence is:

1. explicit session scope
2. current session scope
3. root scope fallback

If root and session disagree for the same mode, session wins for the active execution context, but stale root survivors should be terminalized during reconciliation when they would otherwise resurrect old state.

## Terminal lifecycle outcome compatibility

For the explicit terminal stop model, treat workflow `current_phase` and user-facing terminal lifecycle outcome as related but separate concepts.

Canonical user-facing lifecycle outcomes are:

- `finished`
- `blocked`
- `failed`
- `userinterlude`
- `askuserQuestion`

Compatibility rules:

- Prefer a dedicated canonical lifecycle field over legacy `run_outcome` when both exist.
- Treat legacy `run_outcome` as a compatibility layer during migration.
- Infer from `current_phase` only when neither canonical lifecycle metadata nor legacy `run_outcome` is available.
- Keep `cancelled` as an internal legacy/admin phase, not as the canonical public lifecycle vocabulary.

Recommended read precedence for terminal lifecycle interpretation:

1. canonical lifecycle metadata (for example `lifecycle_outcome`)
2. legacy `run_outcome`
3. compatibility inference from `current_phase`, question metadata, and persisted error/completion fields

`blocked_on_user` is also compatibility-only. When surrounding question metadata proves OMX asked a blocking question, classify it as `askuserQuestion`; otherwise treat it as a user-wait compatibility signal instead of exposing it as the canonical vocabulary directly.

## Core files

- `src/state/workflow-transition.ts` — transition policy and decision model
- `src/state/workflow-transition-reconcile.ts` — shared transition reconciliation helper
- `src/modes/base.ts` — mode start/update lifecycle
- `src/mcp/state-server.ts` — MCP state writes/reads/clears
- `src/hooks/keyword-detector.ts` — prompt keyword activation + state seeding
- `src/scripts/codex-native-hook.ts` — native hook routing and prompt-submit output

## Transition flow

```mermaid
flowchart TD
  A[Prompt / CLI / MCP request] --> B[Detect requested workflow skill(s)]
  B --> C[Evaluate transition policy]
  C -->|deny| D[Return denial message]
  C -->|allow overlap| E[Keep current active modes + add destination]
  C -->|allow auto-complete| F[Complete source mode(s)]
  F --> G[Sync compatibility skill-active state]
  G --> H[Activate destination mode(s)]
  E --> G
  H --> I[Emit routing / transition message]
```

## Reconciliation sequence

The shared reconciliation helper should follow this sequence:

1. decide outcome
2. complete source mode(s) with audit metadata
3. sync compatibility `skill-active` state
4. activate destination mode(s)
5. return transition message for rendering

This ordering matters because syncing too early can resurrect a mode that was just auto-completed.

## Prompt-submit flow

```mermaid
flowchart TD
  A[UserPromptSubmit] --> B[detectKeywords()]
  B --> C[ordered explicit skill list]
  C --> D[recordSkillActivation()]
  D --> E[shared reconciliation helper]
  E --> F[final active skills]
  F --> G[buildAdditionalContextMessage()]
  G --> H[native hook output]
```

## Transition rule categories

### A. Allow with no change

The requested mode is already active.

### B. Allow as overlap

The requested mode is added without completing the source mode.

Examples:

- `team + ralph`
- `ultrawork + <any tracked mode>`

### C. Allow with source auto-complete

The source mode is terminalized and the destination becomes active.

Current allowlisted forward handoffs:

- `deep-interview -> ralplan`
- `ralplan -> team`
- `ralplan -> ralph`
- `ralplan -> autopilot`

### D. Deny

The requested transition is not allowed and no state is changed.

## Common transition rules

| From | To | Result |
|---|---|---|
| `deep-interview` | `ralplan` | auto-complete `deep-interview`, start `ralplan` |
| `ralplan` | `team` | auto-complete `ralplan`, start `team` |
| `ralplan` | `ralph` | auto-complete `ralplan`, start `ralph` |
| `ralplan` | `autopilot` | auto-complete `ralplan`, start `autopilot` |
| `team` | `ralph` | allowed overlap |
| `ralph` | `team` | allowed overlap |
| `<any tracked mode>` | `ultrawork` | allowed overlap |
| `ultrawork` | `<any tracked mode>` | allowed overlap |
| execution-like mode | planning-like mode | denied rollback auto-complete |
| anything else non-allowlisted | new conflicting mode | denied |

## Planning-like vs execution-like

### Planning-like

- `deep-interview`
- `ralplan`
- `autoresearch`

### Execution-like

- `team`
- `ralph`
- `autopilot`
- `ultrawork`
- `ultraqa`

Execution-like -> planning-like rollback auto-complete is forbidden. The denial should tell the user, in substance:

> first clear current state first and retry if this action is intended

## Multi-skill prompt-submit behavior

A single prompt can explicitly invoke multiple contiguous `$skill` tokens.

Example:

```text
$ralplan $team $ralph ship this fix
```

Expected result:

1. `ralplan` is recognized as the planning source
2. simultaneous execution follow-ups are deferred instead of auto-starting
3. final active skill remains `ralplan`
4. deferred execution skills are surfaced in native-hook output for traceability
5. native hook output should describe all explicit skills, not only the primary one

Recommended message shape:

- detected keywords summary
- deferred-skill summary, e.g. `planning preserved over simultaneous execution follow-up; deferred skills: team, ralph`
- final active skill / initialized state summary
- team runtime hint only when `team` is actually among the final active skills

## Audit fields for auto-complete

When a source mode is auto-completed during transition, the source state should record:

- `active: false`
- `current_phase: completed`
- `completed_at`
- `auto_completed_reason` or equivalent
- `completion_note` or equivalent
- destination metadata when useful (`transition_target_mode`, source path, etc.)

## Invariants

These rules should remain true unless intentionally changed:

- rollback to planning never auto-completes
- non-allowlisted transitions remain blocked
- `ultrawork` overlap-any must not weaken `ralplan-first` gating
- native-hook output is a presentation layer over shared transition results, not a separate decision engine
- compatibility sync must not resurrect completed source modes

## Practical guidance

### If you are changing transition rules

Update together:

- `src/state/workflow-transition.ts`
- `src/state/workflow-transition-reconcile.ts`
- lifecycle / MCP callers
- prompt-submit/native-hook rendering
- regression tests

### If you are debugging stale state

Check these in order:

1. session-scoped `<mode>-state.json`
2. root `<mode>-state.json`
3. session/root `skill-active-state.json`
4. whether a previous auto-complete wrote audit metadata but compatibility sync reintroduced the mode

### If you are adding a new allowlisted handoff

Define:

- source mode
- destination mode(s)
- whether source auto-completes or destination overlaps
- rollback behavior
- expected native-hook / CLI / MCP transition output
- regression tests for both session and root scope
