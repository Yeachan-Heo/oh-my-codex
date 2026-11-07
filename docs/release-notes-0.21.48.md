# oh-my-codex 0.21.48

`0.21.48` drops role-based reasoning-effort defaults from seven role prompts, ensuring Vision stays extraction-only unless reassessment is justified.

## Fixed

- **LIVE PINS OUTSIDE CODEX PLUGIN FINGERPRINT ROOT (#4010, fixes #3898):** Codex hook approval repeatedly invalidated Codex plugin pins because they were stored in the Codex plugin cache root and invalidated on plugin refreshes. Live pins are now stored in a separate OMX-managed directory outside the plugin fingerprint, persisting across plugin updates and cache maintenance. OMX's `omx_pins` hook registration ensures the registration survives host Codex app-server versions without cached plugin interference (reviewers: @iqdoctor; reporter: @AkiraLan).
- **ROLE-BASED REASONING-EFFORT DEFAULTS (#4020, #4021):** Seven role prompts (analyst, api-reviewer, architect, code-reviewer, code-simplifier, critic, and designer) included hardcoded reasoning-effort recommendations that read as unconditional requests for commentary, conflicting with their documented success criteria. These recommendations are now removed; Vision prompt is updated to make effort recommendations conditional: 'If reassessment is justified from task demands, remaining uncertainty, available proof, and resource limits, recommend a supported reasoning effort and briefly compare plausible alternatives without a role-based default; otherwise preserve extraction-only output.' The modification ensures all role prompts correctly follow their extraction-only or analysis-only mandates unless reassessment is genuinely warranted.

## Compatibility

No breaking API changes. Release-coupled metadata was synchronized to `0.21.48` on dev by #4017, so the release branch does not bump those values again. `package.json`, both root `package-lock.json` version entries, the Cargo workspace and six workspace crates, and plugin metadata all report `0.21.48` at the pinned source.

## Included scope

The pinned source is `a153daee49a0931788c3f3ac5e53f5f1a393aeb2` (tag v0.21.48). The source-only diff from `v0.21.47` to that commit includes the live-pins fix (#4010), reasoning-effort fixes (#4021), test fix (#4018), generation-release-body enforcement (#4019), and README locale refreshes (#4011–#4014). No commits after the pinned source are included.

**Full Changelog**: [`v0.21.47...v0.21.48`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.47...v0.21.48)

## Validation

Local release gates and release-pipeline evidence are recorded in [release readiness](qa/release-readiness-0.21.48.md).

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
