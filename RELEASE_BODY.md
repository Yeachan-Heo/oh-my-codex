# oh-my-codex v0.22.30

## Summary

Minor release adds live-session health checks and triage with omx supervision, improves launcher reasoning flags, and includes fixes for HUD authority management and plugin hook launcher stability.

## Added

- **OMX SUPERVISION - LIVE-SESSION HEALTH CHECKS AND TRIAGE (#4218):** Introduces `omx supervision` command for checking and triaging the health of active Codex sessions. Provides live session monitoring and status diagnostics.

- **ADD --LOW AND --MEDIUM LAUNCHER REASONING FLAGS (#4226):** Adds `--low` and `--medium` flags to launcher to allow users to control the reasoning level during task execution. These complementary flags provide granular control over how much reasoning effort is applied.

## Fixed

- **CHECK ALL ACTIVE SESSIONS WITH CORRECT STATE AUTHORITY (#4223):** Fixes #4222 and resolves P2s from #4218. The supervision command now correctly checks all active sessions and uses the appropriate state authority for session validation.

- **BACK OFF AUTHORITY CHILD SPAWNS WHILE CONTROL PLANE IS IDLE (#4219):** Fixes #4215. HUD authority management now backs off from spawning child processes while the control plane is idle, reducing resource consumption during inactive periods.

- **PIN STABLE HOMEBREW NODE IN PLUGIN HOOK LAUNCHER (#4230):** Fixes plugin hook launcher to use a stable Homebrew node installation, ensuring consistent behavior across macOS environments.

## Compatibility

No breaking changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.30`.

## Verification

- Dev CI gate on candidate commit verified.
- Release branch merged to main with two-parent merge commit.

## Contributors

Thanks to contributors for the supervision improvements, launcher reasoning enhancements, and HUD/plugin fixes.

**Full Changelog**: [`v0.22.29...v0.22.30`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.29...v0.22.30)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
