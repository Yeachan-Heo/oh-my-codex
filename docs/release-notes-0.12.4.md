# Release notes — 0.12.4

## Summary

`0.12.4` delivers MCP-CLI parity, HUD recovery/reconciliation hardening, native-hook and team-runtime stability fixes, and a new state operations module. This is the largest patch in the `0.12.x` train: 56 files changed across 18 non-merge commits with substantial new test coverage.

## Highlights

- **MCP-CLI parity** — `omx state`, `omx notepad`, `omx project-memory`, `omx trace`, and `omx code-intel` expose MCP server tools through the CLI, making every MCP operation scriptable without transport overhead.
- **HUD self-healing** — a new reconciliation module (`src/hud/reconcile.ts`) and shared tmux helpers (`src/hud/tmux.ts`) keep HUD panes alive across session boundaries, including prompt-submit recovery that actually restores the real HUD process.
- **Native-hook and team-runtime hardening** — stale Ralph state, unknown `$tokens`, stale stop-hook blockers, MCP transport death, and dirty worktree races are all resolved.
- **State operations extraction** — `src/state/operations.ts` provides a clean read/write/clear/list/status API that backs both the MCP state server and the new CLI parity surface.

## Included fixes and changes

### Added
- MCP-CLI parity surface: `omx state`, `omx notepad`, `omx project-memory`, `omx trace`, `omx code-intel`
- HUD reconciliation module (`src/hud/reconcile.ts`)
- Shared HUD tmux helpers extracted to `src/hud/tmux.ts`
- State operations module (`src/state/operations.ts`)
- Path traversal safety utilities (`src/utils/paths.ts`)

### Fixed
- HUD recovery through the OMX CLI entry during prompt-submit recovery (#1413, #1414)
- User-owned Codex hooks preserved during `omx setup` refresh
- HUD prompt-submit layout churn stopped
- Duplicate native-hook continuations from stale Ralph state and unknown `$tokens`
- Stale team worktree cleanup at `startTeam()` time (#1354, #1382)
- Stale stop-hook deep-interview suppression after skill-state canonicalization
- Native Stop trusting stale blocker skill state
- MCP transport death stalling team recovery
- Clean team shutdown without weakening dirty-worktree safety
- Detached session trap narrowed to EXIT only (no signal-triggered cleanup)
- CI hang prevention and reduced teardown dead-time (#1405)

### Changed
- State CLI routed consistently through `omx state`
- Tmux session name truncation preserves session token when name > 120 chars
- Release metadata synced to `0.12.4`

## Verification evidence

- `npm run build` ✅
- `npx biome lint src/` ✅ (435 files clean)
- `npm test` — 3068 of 3070 tests passing. The 2 failures (`dispatch request store keeps failed requests failed`, `sendWorkerMessage keeps failed hook receipts failed`) were introduced by commit `3a193cfb` which is present on `main` as well; they are **pre-existing contract-test failures**, not regressions introduced by this release.

## Remaining risk

- Verification is local; not a full GitHub Actions matrix rerun.
- HUD reconciliation and MCP-CLI parity are new surfaces — post-release monitoring should watch for edge cases in tmux-less environments and tool-name aliasing.
- The 2 pre-existing contract test failures around failed dispatch receipt persistence remain unresolved and should be tracked as a follow-up.
