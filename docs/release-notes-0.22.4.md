# oh-my-codex 0.22.4

`0.22.4` ships three improvements to the resume command: exit-time resume hints for better workflow continuation, fixes for directory overrides in resume commands, and corrections to quote escaping.

## Added

- **PRINT RESUME BLOCK ON EXIT FOR WORKFLOW CONTINUATION (#4061, #4060):** The CLI now prints a resume-hint block when exiting after a work session, enabling users to resume their previous workflow context. The `omx resume --last` command errors appropriately when no previous session exists, providing clear guidance instead of silently succeeding with empty context.

## Fixed

- **HONOR DIRECTORY OVERRIDES IN RESUME COMMANDS (#4062):** The resume hint now respects the `-C`/`--cd` directory override flags and worktree-specific Codex home paths, ensuring session resolution uses the correct context when launched with directory overrides.
- **RESTORE APOSTROPHE ESCAPING IN SHELLQUOTE (#4063):** Fixed quote-escaping regression where apostrophes in shell-quoted values were incorrectly escaped, causing shell syntax errors in paths and identifiers containing apostrophes.

## Compatibility

No breaking API changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.4` at the pinned source.

## Included scope

The pinned source is dev `c81c0aa4`. Product changes from `v0.22.3`: #4061, #4062, #4063. The other commits are the post-0.22.3 back-merge (#4058) and version bump (#4059).

**Full Changelog**: [`v0.22.3...v0.22.4`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.3...v0.22.4)

## Validation

Release-pipeline evidence is recorded in [release readiness](qa/release-readiness-0.22.4.md).

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
