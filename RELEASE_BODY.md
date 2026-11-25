# oh-my-codex v0.22.27

## Summary

Patch release includes fixes for HUD pane independence, native subagent support, and external launcher setup management.

## Fixed

- **KEEP TMUX HUDS INDEPENDENT AND SHOW STACKED NATIVE SUBAGENTS (#4194):** Fixes #4191. Keeps tmux HUD ownership pane-local, shows native subagents as a vertical roster, and lets external launchers opt out of deferred setup without skipping the package update. Tested: isolated npm upgrade and real tmux probes; compiled update, HUD, hook and Team regressions.

- **INFER AUTOPILOT MODE FOR EXACT-SESSION STATE (#4197):** Fixes #4196. Resolves the Codex P2 that shipped unresolved in v0.22.26 by properly inferring autopilot mode for exact-session state.

## Compatibility

No breaking changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.27`.

## Verification

- Dev CI gate on candidate commit verified.
- Release branch merged to main with two-parent merge commit.

## Contributors

Thanks to NagyVikt and contributors for HUD improvements and native subagent support.

**Full Changelog**: [`v0.22.26...v0.22.27`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.26...v0.22.27)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
