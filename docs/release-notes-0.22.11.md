# Release Notes: oh-my-codex v0.22.11

## Highlights

### Setup: Preserve Custom developer_instructions During Legacy Setup

The legacy setup mode now correctly preserves custom `developer_instructions` from existing configurations instead of overwriting them with default values. This fixes #4105, which reported that user-customized developer instructions were lost when running legacy setup after a configuration update.

- **#4107**: Preserve custom developer_instructions during legacy setup

### Setup: Canonicalize CODEX_HOME for Symlink Aliases

The doctor hook and related setup logic now canonicalize `CODEX_HOME` paths to handle symlink aliases consistently. This ensures that symlinked home directories are treated with consistent trust and identity across all setup and runtime operations, fixing #4106.

- **#4108**: Canonicalize CODEX_HOME to handle symlink aliases consistently

## Dependencies

- **#4103**: @biomejs/biome updated from 2.6.6 to 2.6.7 (dev dependency)
- **#4104**: @napi-rs/lzma updated from 1.4.1 to 1.4.5 (runtime dependency)

## Merged PRs

- **#4107**: Preserve custom developer_instructions during legacy setup (Fixes #4105) by Yeachan-Heo
- **#4108**: fix(config): canonicalize CODEX_HOME to handle symlink aliases consistently (Fixes #4106) by Yeachan-Heo
- **#4103**: chore(deps-dev): bump @biomejs/biome from 2.6.6 to 2.6.7 by Yeachan-Heo
- **#4104**: chore(deps): bump @napi-rs/lzma from 1.4.1 to 1.4.5 by Yeachan-Heo

## Contributors

- Yeachan-Heo

## Full Changelog

Compare full changes: https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.10...v0.22.11

**v0.22.11** was released on {{ release_date }} (UTC).
