# Release Readiness: 0.22.6

## Compare Range

- **Previous release**: v0.22.5
- **Candidate commit**: `6fdbb32ff` (dev HEAD at release time)
- **Comparison**: `git log v0.22.5..6fdbb32ff`

## PR Inventory

1. **#4075** — PRESERVE SHARED LOCKS DURING RECOVERY (fix, @shenyankm)
   - Merge commit: `a9b4281ac` (PR head `7d7c2c9b6`)
2. **#4076** — PRESERVE ACTIVE TEMPORARY DIRECTORIES DURING CLEANUP (fix)
   - Merge commit: `ab0a58207` (PR head `26053ff16`)
3. **#4077** — PRESERVE THE FIRST TERMINAL QUESTION STATE (fix, @shenyankm)
   - Merge commit: `6fdbb32ff` (PR head `36ec301aa`)
4. **#4073** — biome 2.6.4 → 2.6.6 (dependency)
5. **#4072** — bump dev to 0.22.6 (infra)

## Gates

- PR #4075, #4076, #4077: CI passed on the merged head; no open Codex findings at merge.
- Dev push CI on `6fdbb32ff` (run 42807290504): passed (18 success; Rust, native, full-build, and publish jobs skipped by the push path filter).
- Release PR #4079 CI on `9f92e69ae` (dev `6fdbb32ff` + release docs only, run 42807710748): 27 success, 1 skipped, including Rust format/clippy/tests, full source build, Node test matrix, Windows, and coverage gate.
- Release PR Codex review on `9f92e69ae`: completed with no findings.

## Known gaps

- None. The release PR diff against dev is limited to `CHANGELOG.md`, `RELEASE_BODY.md`, `docs/release-notes-0.22.6.md`, and this file.

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
