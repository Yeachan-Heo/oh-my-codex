# oh-my-codex 0.22.5

`0.22.5` ships two critical team runtime safety improvements: fail-closed task-read error handling and memory/secrets/API preservation across state mutations.

## Fixed

- **FAIL CLOSED ON TASK READS AND STALE REPLY TARGETS (#4067):** Team runtime now fails closed on task read failures, handling corrupted task files and unresolvable reply targets instead of silently ignoring them. This prevents task loss and state inconsistency during malformed or id-mismatched operations.
- **PRESERVE MEMORY WRITES, SECRETS, AND API AVAILABILITY (#4068):** Integration and worker operations now preserve memory writes, API availability state, and secret values across state mutations. Previous mutations could lose in-flight writes, reset API state during recovery, or drop configured secrets, causing workflows to restart or fail. This fix ensures state consistency across all operations.

## Compatibility

No breaking API changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.5` at the pinned source.

## Included scope

The pinned source is dev `684c46b67`. Product changes from `v0.22.4`: #4067, #4068. The other commit is the version bump (#4066).

**Full Changelog**: [`v0.22.4...v0.22.5`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.4...v0.22.5)

## Validation

Release-pipeline evidence is recorded in [release readiness](qa/release-readiness-0.22.5.md).

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
