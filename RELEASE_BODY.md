# oh-my-codex v0.22.11

## Summary

This patch release ships two fixes for setup reliability: preserving custom `developer_instructions` during legacy setup mode and canonicalizing `CODEX_HOME` for consistent symlink handling. These changes improve setup robustness when users have customized configurations or symlinked home directories.

## Fixed

- **PRESERVE CUSTOM DEVELOPER_INSTRUCTIONS DURING LEGACY SETUP (#4107):** Legacy setup mode now correctly preserves user-customized `developer_instructions` from existing configurations instead of overwriting them with default values. Fixes #4105.
- **CANONICALIZE CODEX_HOME FOR SYMLINK CONSISTENCY (#4108):** Doctor hook and setup logic now canonicalize `CODEX_HOME` paths to handle symlink aliases consistently. Symlinked home directories are now treated with uniform trust and identity across all setup and runtime operations. Fixes #4106.

## Dependencies

- @biomejs/biome: 2.6.6 → 2.6.7 (#4103, dev dependency)
- @napi-rs/lzma: 1.4.1 → 1.4.5 (#4104, runtime dependency)

## Compatibility

No breaking API changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.11`.

## Verification

- Full CI on dev candidate (candidate details recorded in [release readiness](docs/qa/release-readiness-0.22.11.md)).
- PR #4107 and #4108 CI passed on merged heads.

## Contributors

Thanks to [@Yeachan-Heo](https://github.com/Yeachan-Heo) for contributing to this release.

**Full Changelog**: [`v0.22.10...v0.22.11`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.10...v0.22.11)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
