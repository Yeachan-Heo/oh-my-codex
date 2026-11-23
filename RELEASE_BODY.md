# oh-my-codex v0.22.17

## Summary

This patch release enhances the ralplan workflow with improved Architect/Critic quality gates and lane reuse strategy. The changes were intended for v0.22.16 but were not included in that release; they ship in this release instead.

## Improved

- **RALPLAN RE-REVIEW ARCHITECT/CRITIC/QUALITY-GATE LANE REUSE (#4130, #4131):** Improved ralplan workflow with better Architect/Critic quality gates and enhanced lane reuse strategy, fixing plan review cycle issues (#4129).

## Compatibility

No breaking API changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.17`.

## Verification

- Full CI on dev candidate (candidate details recorded in [release readiness](docs/qa/release-readiness-0.22.17.md)).
- Release branch CI verification pending.

## Contributors

Thanks to [@Yeachan-Heo](https://github.com/Yeachan-Heo) for contributing to this release.

**Full Changelog**: [`v0.22.13...v0.22.14`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.13...v0.22.14)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
