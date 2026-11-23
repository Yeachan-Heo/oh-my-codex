# oh-my-codex v0.22.17

## Summary

This patch release enhances the ralplan workflow with improved Architect/Critic quality gates and lane reuse strategy, plus fixes for spark/explore model runtime resolution. The changes were intended for v0.22.16 but were not included in that release; they ship in this release instead.

## Improved

- **RALPLAN RE-REVIEW ARCHITECT/CRITIC/QUALITY-GATE LANE REUSE (#4130, #4131):** Improved ralplan workflow with better Architect/Critic quality gates and enhanced lane reuse strategy, fixing plan review cycle issues (#4129).

## Fixed

- **PREVENT SPARK MODEL INVERSION WHEN CHEAPER FRONTIER MODEL CONFIGURED (#4135):** Fixed spark model selection logic to prevent costly model inversion when a cheaper frontier model is already configured. Fixes #4133.
- **MAKE SPARK/EXPLORE RUNTIME RESOLUTION FOLLOW CONFIGURED MODEL (#4138):** Fixed spark and explore model runtime resolution to respect configured model settings, completing the fix for #4133.

## Compatibility

No breaking API changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.17`.

## Verification

- Release branch CI verification passed before merge to main.
- Release branch merged to main with two-parent merge commit.

## Contributors

Thanks to [@Yeachan-Heo](https://github.com/Yeachan-Heo) for contributing to this release.

**Full Changelog**: [`v0.22.13...v0.22.14`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.13...v0.22.14)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
