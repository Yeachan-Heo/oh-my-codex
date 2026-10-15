# oh-my-codex 0.21.14

`0.21.14` is a patch release for the frozen range `v0.21.13..7fd6e95a839c0c0c14de67a7bc976c4d9134b923` (3 commits, 9 files, +1,480/−71; PRs #3793 and #3803).

Versioning: this continues the 0.21.x patch train. The session timeline is an additive CLI subcommand that leaves existing commands and protocols intact.

## Highlights

- **Session execution timelines and tool diagnostics (#3793):** add `omx session timeline <session-id>` to reconstruct tool execution, turn boundaries, and context compactions from active or archived transcripts. The command supports filtering and sorting tool events and reports observed durations, exit codes, failures, incomplete calls, and per-tool totals. Authored by @hiSandog.

## Compatibility

- The release adds a session subcommand without removing or changing existing CLI commands, protocols, or package layout.

## Validation evidence

The pinned candidate `7fd6e95a839c0c0c14de67a7bc976c4d9134b923` passed dev CI: 24 check runs succeeded and the conditional npm publish job was skipped. Local build, typecheck, and focused test results are recorded in `docs/qa/release-readiness-0.21.14.md`.

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
