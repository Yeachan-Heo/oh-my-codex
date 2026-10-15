# oh-my-codex 0.21.14

`0.21.14` is a patch release for the frozen range `v0.21.13..7fd6e95a839c0c0c14de67a7bc976c4d9134b923` (3 commits, 9 files, +1,480/−71).

## Highlights

- **Session execution timelines and tool diagnostics (#3793):** add `omx session timeline <session-id>` to reconstruct tool execution, turn boundaries, and context compactions from active or archived transcripts. Filter and sort tool events, inspect observed durations, exit codes, failures, incomplete calls, and per-tool totals.

## Compatibility

- This continues the 0.21.x patch train with an additive session subcommand; it does not remove or change existing CLI commands, protocols, or package layout.

## Validation evidence

Frozen candidate `7fd6e95a839c0c0c14de67a7bc976c4d9134b923` is green on dev CI (24 checks succeeded; the conditional npm publish job was skipped). Local build, typecheck, and relevant test results are recorded in `docs/qa/release-readiness-0.21.14.md`.

Full readiness evidence: `docs/qa/release-readiness-0.21.14.md`.

## Merged PR inventory

| PR | Author | Title |
|---|---|---|
| [#3793](https://github.com/Yeachan-Heo/oh-my-codex/pull/3793) | @hiSandog | feat(session): add execution timelines and tool diagnostics |
| [#3803](https://github.com/Yeachan-Heo/oh-my-codex/pull/3803) | @Yeachan-Heo | chore: back-merge v0.21.13 release to dev (integration only) |

## Contributors

Thanks to @hiSandog for the session timeline feature and @Yeachan-Heo for the release back-merge.

## Inventory

The reproducible range is recorded in `artifacts/release-0.21.14/inventory.md`.

**Full Changelog**: [`v0.21.13...v0.21.14`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.13...v0.21.14)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
