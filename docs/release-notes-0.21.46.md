# oh-my-codex 0.21.46

`0.21.46` keeps generated native-agent guidance within its assigned scope and defines clearer authority and safety boundaries for Git Master.

## Fixed

- **ASSIGNMENT-SCOPED NATIVE AGENT OVERLAYS (#3989):** Native-agent posture and exact-model overlays preserve the assigned scope. Read-only and advisory roles are not told to implement; generated guidance no longer requires builds or tests unconditionally, and verification is based on the task and repository requirements.
- **GIT MASTER AUTHORITY BOUNDARIES (#3997):** History rewrites and remote writes require task authority. Unrelated dirty and untracked work must be preserved rather than stashed, reset, cleaned, or overwritten. Commits are split by independent concern, keeping each behavior with its required tests, configuration, and documentation.

## Compatibility

No breaking API changes. Release-coupled metadata was synchronized to `0.21.46` on dev by #3993, so the release branch does not bump those values again. `package.json`, both root `package-lock.json` version entries, the Cargo workspace and six workspace crates, and plugin metadata all report `0.21.46` at the pinned source.

## Included scope

The pinned source is `41f8cd5c3cbcce8803f3d14c72e32bace88011dd`. The source-only diff from `v0.21.45` to that commit is limited to `src/agents/native-config.ts`, its regression tests in `src/agents/__tests__/native-config.test.ts`, and `prompts/git-master.md`; no commits after the pinned source are included. The only user-facing changes in this release are #3989 and #3997.

**Full Changelog**: [`v0.21.45...v0.21.46`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.45...v0.21.46)

## Validation

Local release gates and release-pipeline evidence are recorded in [release readiness](qa/release-readiness-0.21.46.md).

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
