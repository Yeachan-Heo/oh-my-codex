# oh-my-codex v0.22.23

## Summary

This patch release improves the update flow to automatically refresh native agents after package updates, switches the notify fallback watcher to file-system events, removes redundant agent refresh suppression logic, restores rollout replay during reconciliation, and clarifies Team and native model routing in the AGENTS.md templates.

## Fixed

- **OMX UPDATE REFRESHES NATIVE AGENTS AFTER PACKAGE UPDATES (#4167):** Fixes #4166. When OMX packages are updated via npm, the setup command now automatically refreshes native agent TOMLs without requiring manual re-setup. The update hook detects package changes and triggers native agent refresh.

- **NOTIFY FALLBACK WATCHER USES FS.WATCH INSTEAD OF POLLING (#4170):** Improves notify watcher performance by switching from polling to file-system events. The fallback notify watcher now uses `fs.watch()` for more efficient real-time file monitoring when native fsevents are unavailable.

- **REMOVE AGENT REFRESH SUPPRESSION FLAG (#4172):** Removes the `OMX_SKIP_NATIVE_AGENT_REFRESH` environment variable and associated suppression logic, simplifying the native agent refresh flow during updates.

- **REPLAY ROLLOUTS FOUND DURING RECONCILIATION (#4173):** Restores rollout replay functionality during reconciliation. Rollouts that were paused or incomplete are now replayed when their parent task is reconciled.

## Changed

- **DOCS: CLARIFY TEAM AND NATIVE MODEL ROUTING IN AGENTS.MD TEMPLATES (#4174):** Template documentation in AGENTS.md now clarifies how Team executor, native model routing, and agent discovery interact. This helps users understand model tier selection and agent resolution behavior.

## Compatibility

Behavior change for setup and update commands. Agents are now automatically refreshed after package updates. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.23`.

## Verification

- Dev CI gate on candidate commit verified.
- Release branch merged to main with two-parent merge commit.

## Contributors

Thanks to iqdoctor for improving the update experience and to the team for delivering better agent management and documentation.

**Full Changelog**: [`v0.22.22...v0.22.23`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.22...v0.22.23)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
