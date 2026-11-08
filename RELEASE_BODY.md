# oh-my-codex v0.22.2

## Summary

This patch release ships a team-runtime safety fix: integration and cleanup now preserve manual Git operations, corrupted task state, and completion evidence instead of aborting, dropping, or deleting them.

## Fixed

- **PRESERVE WORK AND STATE ACROSS TEAM INTEGRATION AND CLEANUP (#4053):** Team integration and shutdown no longer abort a manual Git operation (rebase, merge, cherry-pick, revert, bisect) in the leader or a worker worktree; they stop and report it, and only abort a merge or cherry-pick they started themselves. A malformed, id-mismatched or unreadable task file now fails with `team_task_read_failed` instead of silently vanishing from completion and cleanup gates. Valid ignored completion-evidence reports are archived under the git common dir (`omx-completion-evidence/`) before worktree removal, so cleanup no longer refuses or deletes them; unknown files still block removal.

## Compatibility

No breaking API changes. Teams with a corrupted task file now get an explicit `team_task_read_failed` error instead of a silently shorter task list. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.2`.

## Verification

- Full CI passed on dev `09fc2b47` (the source of this release), [CI run 42501034833](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/42501034833).
- PR #4053 CI passed 26/26 on its merged head `240492a3`, including the 30 new `p1-safety` team tests.

## Contributors

[@shenyankm](https://github.com/shenyankm) and [@Yeachan-Heo](https://github.com/Yeachan-Heo)

**Full Changelog**: [`v0.22.1...v0.22.2`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.1...v0.22.2)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
