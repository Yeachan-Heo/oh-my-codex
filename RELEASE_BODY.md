# oh-my-codex v0.22.28

## Summary

Patch release stops the per-second authority churn in attached HUDs.

## Fixed

- **STOP PER-SECOND AUTHORITY CHURN IN ATTACHED HUDS (#4203):** Refs #4201. The HUD authority tick no longer writes any state file while rate-limited, and the watch loop runs the authority tick at most once per 5s instead of every second, reducing file writes and authority calls with several attached HUDs (5 HUDs on one repo: 1.08% -> 0.72% CPU per HUD in a single noisy run; 1 HUD within noise). Tested: new no-write cooldown and 12-ticks-to-3-calls watch regressions; tsc, no-unused, lint and build clean.

## Compatibility

No breaking changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.28`.

## Verification

- Dev CI gate on candidate commit verified.
- Release branch merged to main with two-parent merge commit.

## Contributors

Thanks to contributors for the HUD authority-tick fix.

**Full Changelog**: [`v0.22.27...v0.22.28`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.27...v0.22.28)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
