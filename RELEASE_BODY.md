# oh-my-codex v0.22.4

## Summary

This patch release ships three improvements to the resume command: exit-time resume hints for better workflow continuation, fixes for directory overrides in resume commands, and corrections to quote escaping.

## Added

- **PRINT RESUME BLOCK ON EXIT FOR WORKFLOW CONTINUATION (#4061, #4060):** The CLI now prints a resume-hint block when exiting after a work session, enabling users to resume their previous workflow context. The `omx resume --last` command errors appropriately when no previous session exists, providing clear guidance instead of silently succeeding with empty context.

## Fixed

- **HONOR DIRECTORY OVERRIDES IN RESUME COMMANDS (#4062):** The resume hint now respects the `-C`/`--cd` directory override flags and worktree-specific Codex home paths, ensuring session resolution uses the correct context when launched with directory overrides.
- **RESTORE APOSTROPHE ESCAPING IN SHELLQUOTE (#4063):** Fixed quote-escaping regression where apostrophes in shell-quoted values were incorrectly escaped, causing shell syntax errors in paths and identifiers containing apostrophes.

## Compatibility

No breaking API changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.4`.

## Verification

- Full CI passed on dev `c81c0aa4` (the source of this release), [CI run 42603444740](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/42603444740).
- PR #4061 CI passed on its merged head.
- PR #4062 CI passed on its merged head.
- PR #4063 CI passed on its merged head.

## Contributors

Thanks to [@Yeachan-Heo](https://github.com/Yeachan-Heo) for contributing to this release.

**Full Changelog**: [`v0.22.3...v0.22.4`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.3...v0.22.4)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
