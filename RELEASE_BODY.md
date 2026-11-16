# oh-my-codex v0.22.8

## Summary

This patch release ships critical fixes for team lock recovery and Stop hook stability. The native Stop hook no longer loops on stale team membership locks, preventing Codex API quota exhaustion reported in #4086.

## Fixed

- **STOP HOOK STABILITY WITH TEAM LOCK RECOVERY (#4087, #4090):** Stop hook now properly detects `team_lock_recovery_required` errors and terminates cleanly with `continue:false` instead of looping. Stale team membership locks are correctly identified as terminal stops, preventing indefinite continuation attempts that could exhaust the Codex API quota. Fixes #4086.
  - **#4087**: Stop hook now halts on `team_lock_recovery_required` instead of looping indefinitely
  - **#4090**: Stale team locks properly output as terminal stops to prevent continuation

## Compatibility

No breaking API changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.8`.

## Verification

- Full CI on dev candidate (candidate details recorded in [release readiness](docs/qa/release-readiness-0.22.8.md)).
- PR #4087 and #4090 CI passed on merged heads.

## Contributors

Thanks to [@Yeachan-Heo](https://github.com/Yeachan-Heo) for contributing to this release.

**Full Changelog**: [`v0.22.7...v0.22.8`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.7...v0.22.8)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
