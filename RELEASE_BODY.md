# oh-my-codex v0.22.12

## Summary

This patch release ships a fix for recovering quarantined live-pin lock links from JSONL record streams in team state. The fix improves reliability of team lock recovery when processing stored JSONL records.

## Fixed

- **RECOVER QUARANTINED LIVE-PIN LOCK LINKS (#4112):** Fixed deserialization of live-pin tracking data from JSONL streams. Quarantined lock links in team state were not being properly recovered due to incomplete deserialization logic. Lock recovery now correctly processes all stored JSONL records. Fixes #4111.

## Compatibility

No breaking API changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.12`.

## Verification

- Full CI on dev candidate (candidate details recorded in [release readiness](docs/qa/release-readiness-0.22.12.md)).
- PR #4112 CI passed on merged head.

## Contributors

Thanks to [@Yeachan-Heo](https://github.com/Yeachan-Heo) for contributing to this release.

**Full Changelog**: [`v0.22.11...v0.22.12`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.11...v0.22.12)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
