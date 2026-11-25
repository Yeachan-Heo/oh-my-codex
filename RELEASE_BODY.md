# oh-my-codex v0.22.26

## Summary

Patch release includes fixes for native agent TOML handling, autopilot setup, and model refresh ownership rules.

## Fixed

- **REFRESH MODEL FIELDS FOR PRISTINE AGENT TOMLs (#4193):** Fixes #4152. When setting up pristine agent TOMLs, model instructions are now properly refreshed to prevent stale configuration.

- **PRESERVE ASSIGNED TEAM EXECUTOR LANE (#4192):** Fixes autopilot mode behavior where assigned Team executor lanes were not being preserved.

- **NATIVE AGENT TOML SAFETY (#4189):** Addresses review findings from #4186. TOML parsing is now more robust.

- **ROUTE IMPLEMENTATION STORIES TO EXECUTOR (#4188):** Fixes autopilot mode by routing implementation stories correctly.

- **KEEP USER-MODIFIED NATIVE AGENTS UNTOUCHED (#4190):** Preserves native agents that have been manually modified.

- **MODEL REFRESH OWNERSHIP RULE AND TEST ASSERTION (#2820 follow-up):** Restores test assertions and clarifies ownership rules.

## Compatibility

No breaking changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.26`.

## Verification

- Dev CI gate on candidate commit verified.
- Release branch merged to main with two-parent merge commit.

## Contributors

Thanks to Yeachan-Heo and contributors for fixing native agent setup and autopilot routing.

**Full Changelog**: [`v0.22.25...v0.22.26`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.25...v0.22.26)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
