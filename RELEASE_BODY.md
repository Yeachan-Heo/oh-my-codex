# oh-my-codex v0.22.22

## Summary

This patch release enhances the setup command to refresh stale model, provider, and reasoning pins when configurations change, without requiring the `--force` flag. This partially addresses #3919 for option A.

## Fixed

- **REFRESH AGENTS WHEN ONLY MODEL CHANGES (#4165):** Fixes #3919 (partial). The setup command now detects and refreshes stale model/provider/reasoning pins while preserving other user edits, eliminating the need for `--force` in many cases. Users can now keep custom workflows and other configuration intact while updating agent definitions based on the latest model capabilities.

## Compatibility

Behavior change for setup command. Stale model pins are now automatically refreshed without user intervention. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.22`.

## Verification

- Dev CI gate on candidate commit verified.
- Release branch merged to main with two-parent merge commit.

## Contributors

Thanks to iqdoctor for improving the setup experience and to the team for ensuring this release reaches users with better agent configuration management.

**Full Changelog**: [`v0.22.21...v0.22.22`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.21...v0.22.22)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
