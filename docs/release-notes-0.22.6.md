# oh-my-codex 0.22.6

`0.22.6` ships three fixes: team lock recovery preservation, cleanup logic that protects active temporary directories, and question terminal state preservation for reliable answer handling.

## Fixed

- **PRESERVE SHARED LOCKS DURING RECOVERY (#4075):** Team membership, scaling, task-claim, mailbox, and shared dispatch locks now preserve stale locks and report `team_lock_recovery_required` instead of deleting another operation's replacement lock. After a crash, confirm all users of the lock have stopped before manually removing the reported directory; automatic crash recovery is intentionally disabled.
- **PRESERVE ACTIVE TEMPORARY DIRECTORIES DURING CLEANUP (#4076):** `omx cleanup` now preserves temporary directories and only reaps orphaned OMX MCP processes. A directory name and modification time do not establish ownership, and matching temporary directories may contain active projects or uncommitted work.
- **PRESERVE THE FIRST TERMINAL QUESTION STATE (#4077):** A stale question UI, renderer replacement, or timeout handler could overwrite an accepted answer or report it as a failure. Question state transitions are now serialized and the first terminal state is preserved across API, UI, error, and supersede paths. Only the winning answer runs answer side effects; terminal records survive late submissions and cancellation.

## Compatibility

No breaking API changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.6` at the pinned source.

## Included scope

The pinned source is dev `6fdbb32ff`. Product changes from `v0.22.5`: #4075, #4076, #4077. The other commits are dependency bumps (#4073) and the version bump (#4072).

**Full Changelog**: [`v0.22.5...v0.22.6`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.5...v0.22.6)

## Validation

Release-pipeline evidence is recorded in [release readiness](qa/release-readiness-0.22.6.md).

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
