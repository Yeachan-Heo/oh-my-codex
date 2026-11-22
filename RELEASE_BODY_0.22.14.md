# oh-my-codex v0.22.14

## Summary

This patch release ships part A of exit-block improvements, which suggests appropriate reattach commands when session owners are still alive, plus a regression fix ensuring resume hints are preserved for completed launches.

## Fixed

- **EXIT-BLOCK REATTACH SUGGESTION FOR ACTIVE SESSION OWNERS (#4117 Part A):** Exit-block now suggests `tmux attach` or `psmux attach` when a detached session owner is still alive, reducing the need for manual session recovery. Part B (alternative attach paths) remains open. Fixes #4117 (partial).
- **PRESERVE RESUME HINT FOR COMPLETED FOREGROUND LAUNCHES (#4120):** Fixed a regression from #4118 where the omx resume hint was being dropped for completed foreground launches. Resume hints are now correctly preserved throughout the launch lifecycle. Fixes #4119.

## Compatibility

No breaking API changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.14`.

## Verification

- Full CI on dev candidate (candidate details recorded in [release readiness](docs/qa/release-readiness-0.22.14.md)).
- Dev CI run 44979121056 passed all checks including macOS Ralplan preflight jobs.

## Contributors

Thanks to [@Yeachan-Heo](https://github.com/Yeachan-Heo) for contributing to this release.

**Full Changelog**: [`v0.22.13...v0.22.14`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.13...v0.22.14)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
