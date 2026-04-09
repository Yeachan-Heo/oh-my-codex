# oh-my-codex v0.12.4

**MCP-CLI parity, HUD recovery hardening, native-hook and team-runtime stability fixes**

`0.12.4` is the largest patch in the `0.12.x` train — 56 files changed across 18 non-merge commits. It introduces a full MCP-CLI parity surface, hardens HUD recovery and reconciliation, resolves a family of native-hook and team-runtime stability bugs, and extracts state operations into a clean shared module.

## Highlights

- **MCP-CLI parity** — `omx state`, `omx notepad`, `omx project-memory`, `omx trace`, and `omx code-intel` expose MCP server tools through the CLI without transport overhead.
- **HUD self-healing** — new reconciliation module and shared tmux helpers keep HUD panes alive across session boundaries.
- **Native-hook hardening** — stale Ralph state, unknown `$tokens`, stale stop-hook blockers, and MCP transport death are all resolved.
- **State operations module** — clean read/write/clear/list/status API backing both MCP and CLI.

## What's Changed

### Added
- MCP-CLI parity surface: `omx state`, `omx notepad`, `omx project-memory`, `omx trace`, `omx code-intel`
- HUD reconciliation module and shared tmux helpers
- State operations module (`src/state/operations.ts`)
- Path traversal safety utilities

### Fixes
- HUD recovery via OMX CLI entry during prompt-submit recovery (PRs #1413, #1414)
- User-owned Codex hooks preserved during setup refresh
- HUD prompt-submit layout churn stopped
- Duplicate native-hook continuations from stale Ralph state and unknown `$tokens`
- Stale team worktree cleanup at `startTeam()` time (#1354, PR #1382)
- Stale stop-hook deep-interview suppression after skill-state canonicalization
- Native Stop trusting stale blocker skill state
- MCP transport death stalling team recovery
- Clean team shutdown without weakening dirty-worktree safety
- Detached session trap narrowed to EXIT only
- CI hang prevention and reduced teardown dead-time (PR #1405)

### Changed
- State CLI routed consistently through `omx state`
- Tmux session name truncation preserves session token
- Release metadata synced to `0.12.4`

## Verification

- `npm run build` ✅
- `npx biome lint src/` ✅ (435 files)
- `npm test` — 3068/3070 passing (2 pre-existing dispatch-receipt contract failures from commit `3a193cfb` on main, not regressions)

## Remaining risk

- Local verification only — not a full CI matrix rerun.
- HUD reconciliation and MCP-CLI parity are new surfaces; monitor for edge cases in tmux-less environments.
- 2 pre-existing contract test failures around failed dispatch receipt persistence remain unresolved (tracked as follow-up).

## Contributors

- [@Yeachan-Heo](https://github.com/Yeachan-Heo) (Bellman)
- [@HaD0Yun](https://github.com/HaD0Yun)
- [@dyl-joseph](https://github.com/dyl-joseph)

**Full Changelog**: [`v0.12.3...v0.12.4`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.12.3...v0.12.4)
