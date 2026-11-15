# Release Readiness: 0.22.7

## Compare Range

- **Previous release**: v0.22.6
- **Candidate commit**: `a023e9ef1` (dev HEAD at release time)
- **Comparison**: `git log v0.22.6..a023e9ef1`

## PR Inventory

1. **#4080** — back-merge: main into dev after v0.22.6 (infra)
   - Merge commit: `f1d4fd531`
2. **#4081** — chore(dev): bump version to 0.22.7 (infra)
   - Merge commit: `04787be7a`
3. **#4083** — docs(agents): prioritize complete, maintainable repairs over small diffs (fix, @Yeachan-Heo, co-author @ev78394)
   - Merge commit: `a023e9ef1` (PR head `a023e9ef1`)

## Gates

- PR #4083: CI passed on the merged head; no open Codex findings at merge.
- Dev push CI on `a023e9ef1` (verified 06:15Z): passed (full CI green).
- Release PR CI (pending): awaiting PR #4084 release/0.22.7 to main.

## Known gaps

- Release PR CI not yet run (will be recorded after PR merge).
- GitHub release workflow not yet triggered (will be recorded after tag push).

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
