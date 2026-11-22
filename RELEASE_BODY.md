# oh-my-codex v0.22.13

## Summary

This patch release ships a fix for safely resuming verified OMX session owners and updating notification fixtures to canonical cwd contracts.

## Fixed

- **SAFELY RESUME VERIFIED OMX SESSION OWNERS (#3965):** Fixed session resumption logic to safely handle verified session owners, preventing dead-pointer issues during session reactivation. Also updated notification fixtures to use the canonical session pointer contract. Fixes #3964.

## Compatibility

No breaking API changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.13`.

## Verification

- Full CI on dev candidate (candidate details recorded in [release readiness](docs/qa/release-readiness-0.22.13.md)).
- PR #3965 CI passed on merged head.

## Contributors

Thanks to [@Yeachan-Heo](https://github.com/Yeachan-Heo) for contributing to this release.

**Full Changelog**: [`v0.22.12...v0.22.13`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.12...v0.22.13)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
