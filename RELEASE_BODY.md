# oh-my-codex v0.22.6

## Summary

This patch release ships two team runtime safety improvements: team lock recovery preservation and cleanup logic that protects active temporary directories.

## Fixed

- **PRESERVE SHARED LOCKS DURING RECOVERY (#4075):** Team membership, scaling, task-claim, mailbox, and shared dispatch locks now preserve stale locks and report `team_lock_recovery_required` instead of deleting another operation's replacement lock. After a crash, confirm all users of the lock have stopped before manually removing the reported directory; automatic crash recovery is intentionally disabled.
- **PRESERVE ACTIVE TEMPORARY DIRECTORIES DURING CLEANUP (#4076):** `omx cleanup` now preserves temporary directories and only reaps orphaned OMX MCP processes. A directory name and modification time do not establish ownership, and matching temporary directories may contain active projects or uncommitted work.

## Compatibility

No breaking API changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.6`.

## Verification

- Full CI on dev candidate (candidate details recorded in [release readiness](docs/qa/release-readiness-0.22.6.md)).
- PR #4075 CI passed on its merged head.
- PR #4076 CI passed on its merged head.

## Contributors

Thanks to [@shenyankm](https://github.com/shenyankm) for contributing to this release.

**Full Changelog**: [`v0.22.5...v0.22.6`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.5...v0.22.6)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
