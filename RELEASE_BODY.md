# oh-my-codex v0.22.18

## Summary

This patch release ships the runtime spark/explore resolution fix that was intended for v0.22.17 but was not included in the published v0.22.17 package. The fix ensures that spark and explore models respect the configured main model setting at runtime, completing the fix for #4133.

## Fixed

- **MAKE SPARK/EXPLORE RUNTIME RESOLUTION FOLLOW CONFIGURED MODEL (#4138):** Fixes #4133: runtime spark/explore resolution follows the configured main model; planner/architect/researcher astra pins unchanged pending owner decision.

## Compatibility

No breaking API changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.18`.

## Verification

- Dev CI gate on candidate commit verified.
- Release branch merged to main with two-parent merge commit.

## Contributors

Thanks to the team for ensuring this critical fix reaches users.

**Full Changelog**: [`v0.22.17...v0.22.18`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.17...v0.22.18)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
