# oh-my-codex 0.21.15

`0.21.15` is a patch release for the frozen range `v0.21.14..38bbaab4c818cadcfe2b69de22c52cf56e670ca0` (6 commits, 39 files, +2,199/−152).

The v0.21.14 baseline already includes the single-footer correction from PR #3805 by @Yeachan-Heo.

## Highlights

- **Native subagent completion and nested lifecycle routing (#3798, #3809):** record native `SubagentStop` completion events and keep nested children associated with their tracked parent, so completion routing and deduplication continue to work through nested native subagents.
- **Bounded startup context (#3808):** avoid delivering memory already present in session instructions and cap Wiki startup context at 3,500 characters while retaining complete lines and retrieval guidance.
- **Deterministic collector timing tests (#3811):** inject a clock and replace wall-clock sleeps with exact latency assertions.

## Compatibility

- This continues the 0.21.x patch train. Native hook lifecycle handling is additive; existing commands and package layout are unchanged.

## Validation evidence

Frozen candidate `38bbaab4c818cadcfe2b69de22c52cf56e670ca0` passed latest-per-name dev CI: 17 checks succeeded and 8 conditional checks were skipped, with no failures. Local build, typecheck, and relevant test results are recorded in `docs/qa/release-readiness-0.21.15.md`.

Full readiness evidence: `docs/qa/release-readiness-0.21.15.md`.

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

## Inventory

The frozen candidate and local verification evidence are recorded in `docs/qa/release-readiness-0.21.15.md`.

**Full Changelog**: [`v0.21.14...v0.21.15`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.14...v0.21.15)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
