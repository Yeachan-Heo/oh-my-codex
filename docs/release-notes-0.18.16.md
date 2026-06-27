# oh-my-codex 0.18.16

> Release note status: published. Validation and publication evidence is tracked in `docs/qa/release-readiness-0.18.16.md`.

`0.18.16` is a patch release after `0.18.15` focused on local-session diagnostics, stale HUD/Ralph guard cleanup, and safer doctor artifact ownership warnings. It preserves the existing CLI/package contract while tightening developer-facing failure reporting and stale-state behavior from the current `origin/dev` delta.

## Highlights

- **Local session friction reporting is available** — `omx session friction` can surface local run/session friction signals so resume and debugging workflows have more actionable history.
- **Stale HUD and Ralph continuation state is guarded** — HUD review status and Ralph Stop continuation handling avoid carrying stale review/stop signals across later workflow phases.
- **Doctor artifact ownership diagnostics are safer** — `omx doctor` detects root-owned repository artifacts more clearly without over-warning on normal local files.

## Fixes and compatibility notes

- The release remains a patch release: package layout, CLI entrypoint, plugin manifest shape, and Cargo workspace package contract are unchanged.
- Root/package/plugin/Cargo metadata are bumped to `0.18.16`.
- Session-search help and tests cover the local friction report surface.
- Native Stop hook coverage guards against stale Ralph stop continuations.

## Merged PR inventory

- [#2970](https://github.com/Yeachan-Heo/oh-my-codex/pull/2970) — Add local session friction report.
- [#2972](https://github.com/Yeachan-Heo/oh-my-codex/pull/2972) — Fix HUD stale review status.
- [#2973](https://github.com/Yeachan-Heo/oh-my-codex/pull/2973) — Fix root-owned artifact warning in omx doctor.
- [#2975](https://github.com/Yeachan-Heo/oh-my-codex/pull/2975) — Guard stale Ralph stop continuations.

## Validation evidence

Release readiness evidence is recorded in `docs/qa/release-readiness-0.18.16.md`.

Release-prep gates include version sync for `v0.18.16`, build, native-agent verification, plugin mirror/bundle checks, catalog docs check, targeted regression tests for doctor/session-search/HUD/native-hook/session friction, `npm pack --dry-run`, and `git diff --check`. Branch CI, dev/main promotion, tag-triggered release workflow, GitHub release proof, and npm publication proof are recorded in the readiness evidence.

**Full Changelog**: [`v0.18.15...v0.18.16`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.18.15...v0.18.16)
