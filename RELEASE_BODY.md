# oh-my-codex v0.22.5

## Summary

This patch release ships two critical team runtime safety improvements: fail-closed task-read error handling and memory/secrets/API preservation across state mutations.

## Fixed

- **FAIL CLOSED ON TASK READS AND STALE REPLY TARGETS (#4067):** Team runtime now fails closed on task read failures, handling corrupted task files and unresolvable reply targets instead of silently ignoring them. This prevents task loss and state inconsistency during malformed or id-mismatched operations.
- **PRESERVE MEMORY WRITES, SECRETS, AND API AVAILABILITY (#4068):** Integration and worker operations now preserve memory writes, API availability state, and secret values across state mutations. Previous mutations could lose in-flight writes, reset API state during recovery, or drop configured secrets, causing workflows to restart or fail. This fix ensures state consistency across all operations.

## Compatibility

No breaking API changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.5`.

## Verification

- Full CI on dev candidate (candidate details recorded in [release readiness](docs/qa/release-readiness-0.22.5.md)).
- PR #4067 CI passed on its merged head.
- PR #4068 CI passed on its merged head.

## Contributors

Thanks to [@shenyankm](https://github.com/shenyankm) for contributing to this release.

**Full Changelog**: [`v0.22.4...v0.22.5`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.4...v0.22.5)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
