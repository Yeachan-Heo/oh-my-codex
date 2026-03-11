# Ralph State Contract (Frozen)

## Canonical Ralph state schema

Ralph runtime state is stored at `.omx/state/{scope}/ralph-state.json` and MUST use this schema:

- `active: boolean` **(required)**
- `iteration: number` **(required while active)**
- `max_iterations: number` **(required while active)**
- `current_phase: string` **(required while active)**
- `started_at: ISO8601 string` **(required while active)**
- `completed_at?: ISO8601 string`
- Optional linkage fields: `linked_ultrawork`, `linked_ecomode`, `linked_team`, `linked_mode`, `linked_team_terminal_phase`, `linked_team_terminal_at`

## Team-linked launch path guarantees

When Ralph is launched through `omx team ralph ...`, the authoritative scope
MUST reflect that linked launch from the start:

- team state records `linked_ralph=true` and the resolved `team_name`
- Ralph state records `active=true`, `linked_team=true`, `linked_mode='team'`,
  and the same `team_name`
- `linked_team_terminal_phase` and `linked_team_terminal_at` stay unset until
  the linked team reaches a terminal phase

This is a linked launch path over the shared team runtime, not a separate team
state schema.

Legacy phase aliases may be normalized for compatibility, but persisted values MUST end in the frozen enum below.

## Frozen Ralph phase vocabulary

`current_phase` for Ralph MUST be one of:

- `starting`
- `executing`
- `verifying`
- `fixing`
- `complete`
- `failed`
- `cancelled`

Unknown phase values MUST be rejected.

Phase progression reference (illustrative):
starting
- `executing`
- `verifying`
- `fixing`
- `complete`

## Frozen scope policy

1. If `session_id` is present (explicit argument or current `.omx/state/session.json`), session scope (`.omx/state/sessions/{session_id}/...`) is authoritative.
2. Root scope (`.omx/state/*.json`) is compatibility fallback only.
3. Writes MUST target one scope (authoritative scope), never broadcast to unrelated sessions.

## Consumer compatibility matrix

| Consumer | Responsibility under frozen scope/phase contract |
|---|---|
| `src/hud/state.ts` | Read session scope first when current session is known; fall back to root only when scoped file is absent. |
| `src/mcp/trace-server.ts` | Build mode timeline from authoritative scope paths resolved via state-path helpers. |
| `scripts/notify-hook.js` | Update lifecycle counters/sync only in the authoritative session scope (or root fallback), never all sessions. |
| `src/hooks/agents-overlay.ts` | Summarize active modes from scope-preferred mode files (session overrides root). |
| `src/cli/index.ts` (`status`/`cancel`) | Status and cancellation operate on scope-preferred mode files; cancellation does not mutate unrelated sessions. |

## Canonical PRD/progress sources

- Canonical PRD: `.omx/plans/prd-{slug}.md`
- Canonical progress ledger: `.omx/state/{scope}/ralph-progress.json`
- Legacy compatibility migration:
  - `.omx/prd.json` migrates one-way to canonical PRD markdown when no canonical PRD exists.
  - `.omx/progress.txt` migrates one-way to canonical `ralph-progress.json` when no canonical ledger exists.
  - Legacy files remain read-only compatibility artifacts for one release cycle.
