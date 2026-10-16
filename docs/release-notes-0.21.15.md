# oh-my-codex 0.21.15

`0.21.15` is a patch release for the frozen range `v0.21.14..38bbaab4c818cadcfe2b69de22c52cf56e670ca0` (6 commits, 39 files, +2,199/−152; PRs #3798, #3806, #3807, #3808, #3809, and #3811).

Versioning: this continues the 0.21.x patch train. The release adds native subagent completion and nested lifecycle handling, bounds startup context, and makes collector latency tests deterministic without removing existing commands or changing the package layout.

The v0.21.14 tag already includes PR #3805's single-footer correction by @Yeachan-Heo; it is part of the previous release baseline, not this compare range.

## Highlights

- **Native subagent lifecycle (#3798, #3809):** record native `SubagentStop` completion events and preserve tracked parent routing for nested subagents. Lifecycle opt-in, leader gates, and per-child/turn deduplication remain enforced. Authored by @shenyankm and @Yeachan-Heo.
- **Bounded startup context (#3808):** suppress memory already present in session instructions and cap Wiki startup context at 3,500 characters while retaining complete lines and retrieval guidance. Authored by @shenyankm.
- **Deterministic collector tests (#3811):** inject a clock into latency collection and replace wall-clock sleeps with exact assertions. Authored by @Yeachan-Heo.

## Compatibility

- The native hook lifecycle coverage is additive; existing CLI commands and package layout remain unchanged.
- Startup context changes avoid duplicate memory and bound Wiki context size; they do not change explicit retrieval behavior.

## Validation evidence

The pinned candidate `38bbaab4c818cadcfe2b69de22c52cf56e670ca0` passed latest-per-name dev CI: 17 checks succeeded and 8 conditional checks were skipped, with no failures. Local build, typecheck, and relevant test results are recorded in `docs/qa/release-readiness-0.21.15.md`.

## Merged PR inventory

| PR | Author | Title |
|---|---|---|
| [#3798](https://github.com/Yeachan-Heo/oh-my-codex/pull/3798) | @shenyankm | fix(hooks): Record native SubagentStop completion events |
| [#3806](https://github.com/Yeachan-Heo/oh-my-codex/pull/3806) | @Yeachan-Heo | chore(release): back-merge v0.21.14 from main to dev |
| [#3807](https://github.com/Yeachan-Heo/oh-my-codex/pull/3807) | @Yeachan-Heo | chore(release): restore main ancestry in dev after v0.21.14 |
| [#3808](https://github.com/Yeachan-Heo/oh-my-codex/pull/3808) | @shenyankm | fix(hooks): Bound and deduplicate startup context |
| [#3809](https://github.com/Yeachan-Heo/oh-my-codex/pull/3809) | @Yeachan-Heo | fix(hooks): retain nested native subagent lifecycle routing |
| [#3811](https://github.com/Yeachan-Heo/oh-my-codex/pull/3811) | @Yeachan-Heo | test(evals): make collector latency assertions deterministic |

## Contributors

Thanks to @shenyankm and @Yeachan-Heo for contributing to this release.

**Full Changelog**: [`v0.21.14...v0.21.15`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.14...v0.21.15)
