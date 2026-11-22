# Release Notes: oh-my-codex v0.22.13

## Candidate and Compare Range

- **Previous tag**: `v0.22.12`
- **Candidate**: `d9b961366f63e5dde8b3c64f888ec914109a5e9f`
- **Compare range**: `v0.22.12..d9b961366`

## PR Inventory

### Merged PRs (1)

- **#3965**: fix: safely resume verified OMX session owners
  - Commits: 1
  - Author: Yeachan-Heo
  - Merged: Sat Nov 21 2026

## Commits in Release Range

```
d9b961366 fix: safely resume verified OMX session owners (#3965)
```

## User-Visible Changes

### Fixes

- **Session resumption reliability**: Fixed a dead-pointer issue in session resumption logic that could occur when resuming verified OMX session owners. Session reactivation now safely handles verified owner state.

- **Notification fixture consistency**: Updated notification test fixtures to consistently use the canonical session pointer contract, improving test reliability.

## Validation

- Dev CI run 44965800003 on candidate d9b961366 passed all checks
- Release-coupled versions verified synchronized across package.json, Cargo.toml, Cargo.lock, and plugin.json

## Compatibility

No breaking changes. All public APIs remain stable.
