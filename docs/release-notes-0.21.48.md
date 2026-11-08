# oh-my-codex 0.21.48

`0.21.48` fixes live-pin storage and reasoning-effort defaults. Live pins now persist across Codex plugin updates by storing outside the plugin fingerprint root. Role prompts receive task-based reasoning-effort recommendations that preserve leader effort selection, and Vision stays extraction-only unless reassessment is justified.

## Fixed

- **LIVE PINS OUTSIDE CODEX PLUGIN FINGERPRINT ROOT (#4010, fixes #3898):** Codex hook approval repeatedly invalidated Codex plugin pins because they were stored in the Codex plugin cache root and invalidated on plugin refreshes. Live pins are now stored in `<cacheBase>/.omx-pins/<version>`, outside the plugin fingerprint root, persisting across plugin updates and cache maintenance (reviewers: @iqdoctor; reporter: @AkiraLan).
- **ROLE-BASED REASONING-EFFORT DEFAULTS (#4020, #4021):** #4021 replaced fixed 'Default effort: low/medium' role defaults with task-based effort recommendations that preserve the leader's selected effort. Vision prompt is updated to make effort recommendations conditional: 'If reassessment is justified from task demands, remaining uncertainty, available proof, and resource limits, recommend a supported reasoning effort and briefly compare plausible alternatives without a role-based default; otherwise preserve extraction-only output.' The modification ensures all role prompts correctly preserve extraction-only output and deference to leader effort selection.

## Compatibility

No breaking API changes. Release-coupled metadata was synchronized to `0.21.48` on dev by #4017, so the release branch does not bump those values again. `package.json`, both root `package-lock.json` version entries, the Cargo workspace and six workspace crates, and plugin metadata all report `0.21.48` at the pinned source.

## Included scope

The pinned source is `a153daee49a0931788c3f3ac5e53f5f1a393aeb2` (tag v0.21.48). The source-only diff from `v0.21.47` to that commit includes the live-pins fix (#4010), reasoning-effort fixes (#4021), test fix (#4018), generation-release-body enforcement (#4019), and README locale refreshes (#4011–#4014). No commits after the pinned source are included.

**Full Changelog**: [`v0.21.47...v0.21.48`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.47...v0.21.48)

## Validation

Local release gates and release-pipeline evidence are recorded in [release readiness](qa/release-readiness-0.21.48.md).

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
