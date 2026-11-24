# oh-my-codex v0.22.21

## Summary

This patch release fixes repeated Stop hook invocations for blocked team workers, ensuring deterministic worker lifecycle management and preventing accumulating dedup state.

## Fixed

- **SUPPRESS REPEATED STOP HOOK FOR BLOCKED TEAM WORKERS (#4162):** Fixes #4156. Team workers in blocked state were triggering repeated Stop hooks due to improper state management, causing lifecycle dedup accumulation. The fix restores correct stateDir handling throughout resolveTeamWorkerStopDecision, adds dedupeStateDir field to TeamWorkerStopDecision.blocked variant, and ensures allowRepeatDuringStopHook narrowing remains functional. All team worker stop tests passing: nudge dedup, serialization, leader busy.

## Compatibility

Behavior change for team worker Stop hook handling. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.21`.

## Verification

- Dev CI gate on candidate commit verified.
- Release branch merged to main with two-parent merge commit.

## Contributors

Thanks to the team for ensuring this release reaches users with improved team worker lifecycle stability.

**Full Changelog**: [`v0.22.20...v0.22.21`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.20...v0.22.21)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
