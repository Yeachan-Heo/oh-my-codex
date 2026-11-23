# oh-my-codex 0.21.35

`0.21.35` is a patch release that fixes legacy recovery journal ownership and platform-aware replay logic.

## Changes

### Legacy recovery improvements

**Worktree-scoped journal recovery (#3903):** A pending legacy (array-format) recovery journal owned by another worker no longer blocks a healthy worker's shutdown with `shutdown_worktree_preservation_failed`. This fixes a regression introduced by v0.21.34's shutdown preservation (#3896).

**Platform-aware legacy journal ownership (#3904):** Legacy journal names beginning with `".."` are no longer treated as parent traversal attempts. Module-only replay is now enforced for legacy journals.

**Codex P2 findings resolved (#3904):** Addressed remaining code review findings on recovery logic and journal ownership handling.

## Compatibility

- No breaking API changes; recovery robustness improvements only.
- **Team runtime users:** If you experienced recovery journal blocking on shutdown in v0.21.34, this release resolves the issue.
- Existing sessions with pending legacy recovery journals will be handled correctly by the platform-aware logic.
- The fix improves legacy recovery robustness without changing the recovery API contract.

## Known issues

- #3898 (live-pin fix) is in progress (#3900); `Codex 0.164.0` hook validation was invalidated by `.omx-live-pin` files in the plugin cache. Workaround: manually clear `.omx-live-pin` from the cache if running Codex 0.164.0.

## PR inventory

**Fixes and improvements:**
| PR | Author | Title | Impact |
|---|---|---|---|
| [#3903](https://github.com/Yeachan-Heo/oh-my-codex/pull/3903) | @shenyankm | fix(team): scope legacy recovery journals to the owning worktree | Legacy journal blocking fix |
| [#3904](https://github.com/Yeachan-Heo/oh-my-codex/pull/3904) | @Claude Code | fix(team): platform-aware legacy journal ownership and modules-only replay | Platform awareness, Codex findings |

## Contributors

Thanks to @shenyankm for the legacy journal fix, and @Claude Code for platform-aware ownership and Codex resolution.

## Verify the upgrade

To verify that you are running `0.21.35`, check the version in your installed package:

```bash
npm list oh-my-codex
# or: gh release view v0.21.35 --repo Yeachan-Heo/oh-my-codex
```

## Installation

```bash
npm install -g oh-my-codex@latest
# or install from the release page: https://github.com/Yeachan-Heo/oh-my-codex/releases/tag/v0.21.35
```

**Full Changelog**: [`v0.21.34...v0.21.35`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.34...v0.21.35)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
