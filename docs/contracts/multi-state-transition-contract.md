# Multi-state transition compatibility contract

This document freezes the first-pass peer workflow state model for the approved
multi-state compatibility rollout from `.omx/plans/prd-multi-state-compat.md`.

## Canonical sources of truth

The runtime must treat workflow state as a combination of:

- mode state files under `.omx/state/{scope}/<mode>-state.json`
- canonical workflow enumeration under `.omx/state/{scope}/skill-active-state.json`

`skill-active-state.json` is the canonical active-set inventory. Legacy top-level
fields such as `skill` or `phase` may remain as compatibility metadata, but they
must not override the authoritative active set when multiple workflow members
are live.

## Approved first-pass combinations

Allowed active-set shapes in this rollout are intentionally narrow:

- standalone single-workflow state for tracked workflows
- `team + ralph`
- `team + ultrawork`

The resulting active set is peer state. Neither member is semantically primary
just because it was activated first or happens to occupy the legacy top-level
`skill` field.

## Standalone-only workflows

These workflows remain standalone in this pass and must reject overlap attempts:

- `autopilot`
- `autoresearch`

A denied overlap must preserve the current state unchanged.

## Transition rules

A canonical transition helper should answer three questions for every writer or
consumer that mutates workflow state:

1. Is the requested transition allowed from the current active set?
2. What is the resulting active set if it is allowed?
3. What operator guidance should be shown if it is denied?

Until a combination is explicitly approved, the default rule is deny-without-
mutation.

## Invalid transition UX

Every denied transition must:

1. keep the current active state unchanged
2. name the denied combination explicitly
3. explain how to clear incompatible state before retrying
4. mention both supported clearing surfaces:
   - `omx state ...`
   - `omx_state.*` MCP tools

Example operator guidance shape:

> Cannot activate `<requested>` while `<active-set>` is still active. Clear the
> incompatible state first via `omx state ...` or the `omx_state.*` MCP tools,
> then retry the transition.

### Operator recovery examples

CLI parity surface:

- `omx state clear --input '{"mode":"team"}' --json`
- `omx state clear --input '{"mode":"ralph","all_sessions":true}' --json`

MCP parity surface:

- `omx_state.state_clear({ mode: "team" })`
- `omx_state.state_clear({ mode: "ralph", all_sessions: true })`

## Brownfield consumer expectations

The following surfaces must consume the same transition semantics instead of
re-inventing their own precedence rules:

- `src/state/skill-active.ts` — canonical active-set persistence/sync
- `src/hooks/keyword-detector.ts` — keyword-triggered activation should add or
  deny according to the allowlist instead of overwriting to a single owner
- `src/modes/base.ts` — mode start validation must defer to the same transition
  rules and emit the same operator guidance
- `src/mcp/state-server.ts` — state writes/clears must preserve combined state
  correctly and remove only the cleared member
- `src/hud/state.ts` — HUD rendering must show approved combined states even
  when legacy top-level metadata is non-authoritative
- `src/hooks/agents-overlay.ts` — AGENTS overlay active-mode reporting must list
  every active approved member
- `src/scripts/codex-native-hook.ts` — Stop/continuation logic must respect the
  combined state and stop blocking when the relevant member is cleared

## Scope behavior

Session-scoped state remains authoritative when present. Root scope remains a
compatibility fallback only. Clearing one member of an approved combined set
must not accidentally delete the entire combined state.

## Regression expectations

Implementation should be considered complete only when tests prove:

1. canonical active state can hold a multi-entry active set
2. `team + ralph` is allowed in both activation orders
3. `team + ultrawork` is allowed in both activation orders
4. unsupported overlaps deny without mutation
5. denial messages mention both `omx state` and `omx_state.*`
6. HUD / overlay / stop-hook consumers honor the combined set consistently
7. `autopilot` and `autoresearch` still reject unsupported overlap attempts; Autopilot review-driven planning loopbacks keep `autopilot` active and update its `current_phase` to `ralplan` instead of starting standalone `ralplan`
8. `deep-interview -> ralplan` is evidence-gated: answered or handoff-cleared question obligations alone do not complete deep-interview, and Autopilot ralplan handoff requires tracker-backed native Architect and Critic lane evidence rather than `codex_exec`/artifact-only approvals
