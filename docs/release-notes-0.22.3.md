# oh-my-codex 0.22.3

`0.22.3` ships routing-surface alignment for Plan and Ralplan skills to document their correct execution-admission gates.

## Fixed

- **ALIGN PLAN AND RALPLAN WITH AVAILABLE ROUTING SURFACES (#3998):** Plan and Ralplan skills now document their correct execution-admission gates in alignment with available GJC routing surfaces and handoff contracts. Updated guidance clarifies the skills' execution boundaries and integration points without changing production behavior or regressions across capability contracts.

## Compatibility

No breaking API changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.3` at the pinned source.

## Included scope

The pinned source is dev `f7569d2b8`. Product change from `v0.22.2`: #3998. The other commits are the post-0.22.2 back-merge (#4055) and version bump (#4056).

**Full Changelog**: [`v0.22.2...v0.22.3`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.2...v0.22.3)

## Validation

Release-pipeline evidence is recorded in [release readiness](qa/release-readiness-0.22.3.md).

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
