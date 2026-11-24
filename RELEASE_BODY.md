# oh-my-codex v0.22.20

## Summary

This patch release maps Homebrew Cellar node paths to stable symlinks to ensure managed codex hooks survive node upgrades (#4155, fixes #4153).

## Fixed

- **MAP HOMEBREW CELLAR NODE PATHS TO STABLE SYMLINKS (#4155):** Fixes #4153. Homebrew stores node in a version-pinned Cellar path (e.g. `/opt/homebrew/Cellar/node/26.0.0/bin/node`). When persisted in `~/.codex/hooks.json`, hooks exit 127 immediately after node is upgraded and the old Cellar directory is cleaned up. The `resolveStableNodePath()` helper now detects Homebrew Cellar paths and maps them to the stable prefix symlink, allowing hooks to survive upgrades. Applied to both managed codex hooks and MCP server configuration.

## Compatibility

Behavior change for Homebrew node path handling. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.20`.

## Verification

- Dev CI gate on candidate commit verified.
- Release branch merged to main with two-parent merge commit.

## Contributors

Thanks to the team for ensuring this release reaches users with improved hook stability across node upgrades.

**Full Changelog**: [`v0.22.19...v0.22.20`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.19...v0.22.20)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
