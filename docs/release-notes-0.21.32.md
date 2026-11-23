# oh-my-codex 0.21.32

`0.21.32` is a patch release that fixes a v0.21.31 regression in setup scope validation (PR #3890).

This release restores valid macOS and other symlink-heavy systems to working order. On these systems, when HOME or CODEX_HOME crosses a symlink (e.g., `/var` → `/private/var` on macOS), v0.21.31's strict path comparison rejected valid destinations as "outside managed scope," breaking setup for 113 macOS test runs. The fix canonicalizes all scope paths before comparison, allowing setup to work correctly across symlink boundaries while maintaining security.

## Highlights

- **REGRESSION FIX: Symlink canonicalization in scope validation (#3890):** The v0.21.31 symlink guard used path string comparison that failed when HOME or CODEX_HOME contains symlinks (common on macOS where `/var → /private/var`). The fix canonicalizes all paths to their real destinations before comparing, allowing valid scope entries on symlink-heavy systems while maintaining the v0.21.31 security improvement. Setup now correctly validates scope boundaries across OS symlinks in scope ancestors.
- **Correct project root validation scope (#3890):** Directories like `.codex` and OMX_ROOT are now validated against their own root boundaries, not the workspace root. This prevents rejecting valid configurations where project-scope .codex lives in a nested subdirectory or OMX_ROOT points to a managed third-party path.
- **Legacy skill receipt migration (#3890):** The setup command now detects and migrates legacy user-scope skill receipts from pre-0.21 locations during upgrade, preventing loss of historical skill data.
- **Windows cross-drive backup path handling (#3890):** Backup paths that cross drive boundaries on Windows are now sanitized through the unified helper, preventing path traversal issues and invalid references.
- **Dangling symlink detection (#3890):** Before canonicalizing paths, the setup command now detects dangling symlinks and refuses them with clear error messages, preventing silent failures and ambiguous path resolution.

## Compatibility

- No breaking API changes; setup security improvement only.
- **macOS users:** If you hit "outside managed scope" errors on v0.21.31, update to v0.21.32 to restore setup functionality.
- Existing sessions remain unaffected unless they were broken by v0.21.31's regression.
- Setup now succeeds on symlink-heavy systems while maintaining symlink-destination refusal (the v0.21.31 behavior) for managed paths.

## Known gaps

None. The regression is fully addressed. No Codex findings or local test failures remain.

## Validation evidence

The pinned candidate (release branch HEAD, commit 44d33163) passed all gates:
- `npm run build` ✓
- `npm run check:no-unused` ✓
- `npm run lint` ✓
- Setup symlink tests (6 tests) ✓
- All macOS Ralplan preflight security jobs ✓

## Merged PR inventory

| PR | Author | Title |
|---|---|---|
| [#3890](https://github.com/Yeachan-Heo/oh-my-codex/pull/3890) | @gajae-gajae | fix(setup): canonicalize scope roots and destinations, validate project dirs against their own roots, migrate legacy skill receipt, sanitize Windows backup paths, detect dangling symlinks |

## Contributors

Thanks to @gajae-gajae for the regression fix, and @Claude Code for release validation.

**Full Changelog**: [`v0.21.31...v0.21.32`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.31...v0.21.32)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
