# oh-my-codex v0.22.29

## Summary

Minor release extends Beads command support to every workflow phase and fixes command detection regressions introduced during the stabilization.

## Added

- **ALLOW BEADS COMMANDS IN EVERY WORKFLOW PHASE (#4205):** Closes #4200. Read-only Beads operations (list, ready, show) are now allowed in every phase, not just specific phases. The fix ensures that Beads commands are properly tokenized to avoid false positives from punctuation in quoted arguments (e.g., 'Issue & note').

## Fixed

- **ADDRESS UNRESOLVED CODEX P2S FOR BEADS COMMANDS (#4211):** Fixes integration with Beads metadata by properly detecting Beads commands in all workflow phases while preserving other PreToolUse advisories like destructive-command detection.

- **NORMALIZE EXISTING OUTPUT BEFORE MERGING BEADS ADVISORY (#4212):** Fixes regression where destructive commands in chained shell commands (e.g., 'bd && rm -rf dist') were not being detected. Updated regex matching to work after shell operators (&, ;, |).

## Compatibility

No breaking changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.29`.

## Verification

- Dev CI gate on candidate commit verified.
- Release branch merged to main with two-parent merge commit.

## Contributors

Thanks to contributors for the Beads command improvements and regression fixes.

**Full Changelog**: [`v0.22.28...v0.22.29`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.28...v0.22.29)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
