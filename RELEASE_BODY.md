# oh-my-codex v0.22.25

## Summary

This patch release fixes a regression in Autopilot Deep Interview mode that prevented valid questions from being asked when running in exact-session autopilot mode.

## Fixed

- **ALLOW AUTOPILOT DEEP INTERVIEW QUESTIONS (#4182):** Fixes #4183. When running in Autopilot mode with an exact-session `autopilot-state.json` file that lacks the autopilot marker, the mode is now correctly inferred as autopilot, allowing Deep Interview questions to proceed. The fix ensures that Deep Interview questions are not incorrectly blocked when autopilot state is present but the marker is missing, and normalizeSessionId is now properly exported for session identifier handling.

## Compatibility

No breaking changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.25`.

## Verification

- Dev CI gate on candidate commit verified.
- Release branch merged to main with two-parent merge commit.

## Contributors

Thanks to iqdoctor for fixing Autopilot Deep Interview mode and improving session handling.

**Full Changelog**: [`v0.22.24...v0.22.25`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.24...v0.22.25)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
