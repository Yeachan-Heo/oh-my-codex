# oh-my-codex v0.22.3

## Summary

This patch release ships routing-surface alignment for Plan and Ralplan skills to document their correct execution-admission gates.

## Fixed

- **ALIGN PLAN AND RALPLAN WITH AVAILABLE ROUTING SURFACES (#3998):** Plan and Ralplan skills now document their correct execution-admission gates in alignment with available GJC routing surfaces and handoff contracts. Updated guidance clarifies the skills' execution boundaries and integration points without changing production behavior or regressions across capability contracts.

## Compatibility

No breaking API changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.3`.

## Verification

- Full CI passed on dev `f7569d2b8` (the source of this release), [CI run 42516047121](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/42516047121).
- PR #3998 CI passed on its merged head.

## Contributors

[@ev78394](https://github.com/ev78394) and [@Yeachan-Heo](https://github.com/Yeachan-Heo)

**Full Changelog**: [`v0.22.2...v0.22.3`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.2...v0.22.3)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
