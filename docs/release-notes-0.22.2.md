# oh-my-codex 0.22.2

`0.22.2` ships a team-runtime safety fix: integration and cleanup now preserve manual Git operations, corrupted task state, and completion evidence instead of aborting, dropping, or deleting them.

## Fixed

- **PRESERVE WORK AND STATE ACROSS TEAM INTEGRATION AND CLEANUP (#4053):** Team integration and shutdown no longer abort a manual Git operation (rebase, merge, cherry-pick, revert, bisect) in the leader or a worker worktree; they stop and report it, and only abort a merge or cherry-pick they started themselves. A malformed, id-mismatched or unreadable task file now fails with `team_task_read_failed` instead of silently vanishing from completion and cleanup gates. Valid ignored completion-evidence reports are archived under the git common dir (`omx-completion-evidence/`) before worktree removal, so cleanup no longer refuses or deletes them; unknown files still block removal.

## Compatibility

No breaking API changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.2` at the pinned source.

## Included scope

The pinned source is dev `09fc2b47`. Product change from `v0.22.1`: #4053. The other commits are the post-0.22.1 back-merge (#4051) and version bump (#4052).

**Full Changelog**: [`v0.22.1...v0.22.2`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.1...v0.22.2)

## Validation

Release-pipeline evidence is recorded in [release readiness](qa/release-readiness-0.22.2.md).

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
