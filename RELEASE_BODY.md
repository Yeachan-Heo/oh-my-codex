# oh-my-codex 0.21.8

`0.21.8` is a bugfix and compatibility release for the frozen range `v0.21.7..d2e91b866d540b9e2454edb1b928a56d9bd9a30c` (14 commits, 25 files, +1249/−51): Windows binary path handling, session management improvements, legacy configuration support, session export capability, and diagnostic message clarifications.

## Highlights

- **Windows binary path compatibility:** platform-specific `.exe` suffix is now correctly applied to omx-runtime binary paths on Windows, resolving resolution failures on Windows platforms (#3736, #3737).
- **Session management robustness:** thread identity resolution for native `$ralplan --advisory` is improved with dedicated `readPayloadSessionId` helper (#3740, #3741); `writeAtomic` Windows EPERM errors are handled correctly (#3744, #3746).
- **Legacy configuration support:** support for legacy v0.21.6 AGENTS.md backup paths is restored via git rev-parse, with proper handling of linked worktrees (#3739, #3742).
- **Session export capability (#3745):** local sessions can now be exported as Markdown or JSON format for integration and documentation pipelines (authored by @hiSandog).
- **Diagnostic improvements:** warning messages for non-OMX Codex sessions are clarified (#3747, #3749).

## Fixes and compatibility

- Windows path handling: apply platform-specific `.exe` suffix to omx-runtime binary paths (#3736, #3737); handle `writeAtomic` Windows EPERM errors correctly by using `syncRegularFile` (#3744, #3746).
- Session management: resolve native `$ralplan --advisory` thread identity from `session_id` when hook payload carries no thread field (#3740, #3741).
- Legacy backup support: support legacy v0.21.6 AGENTS.md backup path via git rev-parse (#3739, #3742); resolve absolute `--git-path` in linked worktrees; prefer team-state backup over legacy git-dir backup.
- Diagnostic output: clarify warning message for non-OMX Codex sessions (#3747, #3749).

## Validation evidence

Frozen candidate verified with all core gates passing. All 14 commits in the range are verified present with clear user-visible changes.

Full readiness evidence: `docs/qa/release-readiness-0.21.8.md`.

## Contributors

Thanks to [@Yeachan-Heo](https://github.com/Yeachan-Heo), [@hiSandog](https://github.com/hiSandog), and [@gaebal-gajae](https://github.com/gaebal-gajae).

## Inventory

The reproducible range is recorded in `artifacts/release-0.21.8/inventory.md`.

**Full Changelog**: [`v0.21.7...v0.21.8`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.7...v0.21.8)
