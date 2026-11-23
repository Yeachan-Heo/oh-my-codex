# oh-my-codex v0.22.17

## Summary

This patch release enhances the ralplan workflow with improved Architect/Critic quality gates and lane reuse strategy, plus a fix for spark model inversion. The changes were intended for v0.22.16 but were not included in that release; they ship in this release instead.

## Improved

- **RALPLAN RE-REVIEW ARCHITECT/CRITIC/QUALITY-GATE LANE REUSE (#4130, #4131):** Improved ralplan workflow with better Architect/Critic quality gates and enhanced lane reuse strategy, fixing plan review cycle issues (#4129).

## Improved

- **PREVENT SPARK MODEL INVERSION WHEN CHEAPER FRONTIER MODEL CONFIGURED (#4135):** Fixed spark model selection logic to prevent costly model inversion when a cheaper frontier model is already configured. Fixes #4133.

## Compatibility

No breaking API changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.17`.

## Verification

- Dev CI gate on candidate commit verified (details recorded in [release readiness](docs/qa/release-readiness-0.22.17.md)).
- Release branch merged to main with two-parent merge commit.

## Contributors

Thanks to [@ev78394](https://github.com/ev78394) for contributing to this release.

**Full Changelog**: [`v0.22.15...v0.22.16`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.15...v0.22.16)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
