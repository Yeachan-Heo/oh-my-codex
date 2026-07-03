# oh-my-codex 0.18.17

> Release status: candidate. Publication proof is recorded in `docs/qa/release-readiness-0.18.17.md`; this body is finalized after dev/main CI, tag workflow, GitHub release, native asset, and npm publication evidence are complete.

`0.18.17` is a patch release after `0.18.16` focused on runtime reliability and cross-platform workflow hardening. It preserves the existing CLI/package/plugin contract while tightening Ultragoal, Ralplan, planning-gate, Team/MSYS, and Windows psmux behavior from the current `origin/dev` delta.

## Highlights

- Recover Ultragoal null `get_goal` loops instead of leaving sessions stuck.
- Fix MSYS Team worker startup script paths and Windows psmux question rendering.
- Tighten Ralplan terminal session state and planning-gate state-write guards.
- Improve profile Discord mention fallback and stop-keyword path false-positive handling.
- Include dependency maintenance for Biome and Node type definitions.

## Compatibility

No breaking CLI, package, plugin-layout, or configuration changes are intended.

## Validation

Release readiness evidence is recorded in `docs/qa/release-readiness-0.18.17.md`.

Release-prep gates include version sync for `v0.18.17`, build, native-agent verification, plugin mirror/bundle checks, catalog docs check, targeted runtime/cross-platform regression tests, `npm pack --dry-run`, and `git diff --check`. Branch CI, dev/main promotion, tag-triggered release workflow, GitHub release proof, and npm publication proof are appended to readiness evidence after publication.

## Excluded backlog

Open PRs #3018 and #3010 are blocked/dirty/draft and are not included in this release candidate unless separately fixed and merged before publication.

## Contributors

Thanks to the contributors who made this release possible.

**Full Changelog**: [`v0.18.16...v0.18.17`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.18.16...v0.18.17)
