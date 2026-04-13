# Ralph State Contract (Frozen)

## Canonical Ralph state schema

Ralph runtime state is stored at `.omx/state/{scope}/ralph-state.json` and MUST use this schema:

- `active: boolean` **(required)**
- `iteration: number` **(required while active)**
- `max_iterations: number` **(required while active)**
- `current_phase: string` **(required while active)**
- `started_at: ISO8601 string` **(required while active)**
- `completed_at?: ISO8601 string`
- Optional linkage fields: `linked_ultrawork`, `linked_ecomode`, `linked_mode`
- Optional ownership fields:
  - `owner_omx_session_id`
  - `owner_codex_session_id`
  - `owner_codex_thread_id` (legacy compatibility only)
- Optional tmux anchor fields:
  - `tmux_pane_id`
  - `tmux_pane_set_at`
- Optional stop/audit fields:
  - `stop_reason`

Ralph still owns its own mode state and there is no built-in
`omx team ralph ...` linked launch path anymore. Under the multi-state
transition compatibility contract, `team + ralph` is an approved peer overlap,
so Ralph may coexist with team when the canonical allowlist permits it. Other
overlaps remain deny-by-default until they are explicitly approved. See
`docs/contracts/multi-state-transition-contract.md`.

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
4. If the current authoritative session already owns an active Ralph state, notify-hook MAY backfill missing owner metadata and refresh its tmux anchor fields in place.
5. Same-Codex-session continuation MAY migrate a single active Ralph from one session scope into the current authoritative session scope when:
   - the source Ralph is still active and non-terminal,
   - `owner_codex_session_id` matches the live Codex payload `session_id`, or reconciliation consults legacy `owner_codex_thread_id` only when that session-id field is absent on the source Ralph,
   - the current authoritative session does not already have `ralph-state.json` in that scope,
   - reconciliation is driven by persisted Ralph ownership/state files, not by prompt-keyword parsing.
6. If the current authoritative session already has `ralph-state.json`, notify-hook MUST NOT auto-revive it, replace it, or migrate another session's Ralph over it just because the current file is inactive/terminal. Explicit user-driven Ralph starts continue to write current scope through the normal mode/state-write path.
7. Migration MUST preserve single-owner semantics:
   - notify-hook reconciliation MUST serialize transfer decisions per state root before it writes session-scoped Ralph files,
   - the destination session becomes authoritative,
   - the source session is immediately deactivated with audit fields describing the transfer, and if deactivation fails after the destination write, the destination write MUST be rolled back,
   - unrelated sessions MUST remain untouched.
8. This scope reconciliation MUST run inside `scripts/notify-hook.js` before lifecycle counters, active-scope iteration updates, or tmux prompt injection read the active Ralph scope.
9. `owner_codex_thread_id` is a legacy compatibility input. A current authoritative Ralph MAY temporarily retain it until a notify payload provides `session_id`; refreshed/current authoritative Ralph state canonicalizes to `owner_codex_session_id` once that session owner is available.

## Consumer compatibility matrix

| Consumer | Responsibility under frozen scope/phase contract |
|---|---|
| `src/hud/state.ts` | Read session scope first when current session is known; fall back to root only when scoped file is absent. |
| `src/mcp/trace-server.ts` | Build mode timeline from authoritative scope paths resolved via state-path helpers. |
| `scripts/notify-hook.js` | Update lifecycle counters only in the authoritative session scope (or root fallback), never all sessions. |
| `scripts/notify-hook.js` | During notify-hook reconciliation, an active current-session Ralph may be normalized in place; otherwise a same-Codex-session continuation may migrate a single active Ralph only into an otherwise empty current authoritative session scope before later lifecycle/update/injection steps consume Ralph state. Existing current-scope Ralph files, even inactive ones, are not auto-replaced. Reconciliation stays keyed to persisted state ownership, not prompt-keyword parsing. |
| `src/hooks/agents-overlay.ts` | Summarize active modes from scope-preferred mode files (session overrides root). |
| `src/cli/index.ts` (`status`/`cancel`) | Status and cancellation operate on scope-preferred mode files; cancellation does not mutate unrelated sessions. |

## Canonical PRD/progress sources

- Canonical PRD: `.omx/plans/prd-{slug}.md`
- Startup validation source during the legacy-compatibility window: `.omx/prd.json`
- Canonical progress ledger: `.omx/state/{scope}/ralph-progress.json`
- Legacy compatibility migration:
  - `.omx/prd.json` migrates one-way to canonical PRD markdown when no canonical PRD exists.
  - `.omx/progress.txt` migrates one-way to canonical `ralph-progress.json` when no canonical ledger exists.
  - Legacy files remain read-only compatibility artifacts for one release cycle.
- Canonical PRD markdown is storage/documentation-canonical today; Ralph `--prd` startup still validates machine-readable story approval state from `.omx/prd.json` until a structured replacement exists.
