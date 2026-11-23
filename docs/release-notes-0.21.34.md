# oh-my-codex 0.21.34

`0.21.34` is a patch release that preserves worker worktrees when shutdown cannot save work (PR #3896).

This release fixes an issue where worker worktrees could be deleted during shutdown even when checkpointing or merging failed, or when the working directory contained ignored files. The shutdown process no longer deletes worker worktrees in these failure cases, allowing recovery state to be preserved for retries. Submodules, report provenance, and partial pane/prompt teardown are still handled correctly.

## What's new

### Shutdown resilience

**Worker worktree preservation on shutdown failure (#3896):** When the shutdown process failed to save work (due to checkpointing failure, merge failure, or ignored files in the working directory), it would still proceed to delete worker worktrees, losing all recovery state. The fix separates worktree deletion from the main shutdown failure path, preserving the worktrees when recovery may be possible. This also resolves issue #3897.

**Selective teardown:** Submodule handling, report provenance management, and partial pane/prompt cleanup are now independent of worktree preservation. A failure in pane cleanup no longer cascades to worktree deletion.

## Compatibility

- No breaking API changes; shutdown resilience improvement only.
- **Team runtime users:** If shutdown failed to save work in earlier versions, worker worktrees were lost. Upgrade to v0.21.34 to preserve recovery state in shutdown failure cases.
- Existing sessions remain unaffected unless they experienced shutdown failures with ignored files or checkpointing errors.
- The fix improves robustness without changing the shutdown API contract.

## Known issues

- #3898 (live-pin fix) is in progress (#3900); `Codex 0.164.0` hook validation was invalidated by `.omx-live-pin` files in the plugin cache. Workaround: manually clear `.omx-live-pin` from the cache if running Codex 0.164.0.

## PR inventory

**Fixes and improvements:**
| PR | Author | Title | Impact |
|---|---|---|---|
| [#3896](https://github.com/Yeachan-Heo/oh-my-codex/pull/3896) | @shenyankm | fix(team): preserve worker worktrees when shutdown cannot save work | Shutdown resilience; resolves #3897 |

## Contributors

Thanks to @shenyankm for the shutdown preservation fix, and @Claude Code for release validation.

## Verify the upgrade

To verify that you are running `0.21.34`, check the version in your installed package:

```bash
npm list oh-my-codex
# or: gh release view v0.21.34 --repo Yeachan-Heo/oh-my-codex
```

## Installation

```bash
npm install -g oh-my-codex@latest
# or install from the release page: https://github.com/Yeachan-Heo/oh-my-codex/releases/tag/v0.21.34
```

**Full Changelog**: [`v0.21.33...v0.21.34`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.33...v0.21.34)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
