# Release Readiness: oh-my-codex v0.22.13

## Release Metadata

- **Tag**: v0.22.13
- **Date**: 2026-11-22
- **Previous tag**: v0.22.12
- **Candidate commit**: d9b961366f63e5dde8b3c64f888ec914109a5e9f

## Compare Range

```
v0.22.12..d9b961366
```

## PR Inventory

Merged PRs in this release:
- #3965: fix: safely resume verified OMX session owners

## CI Validation

- Dev CI run 44965800003 on d9b961366: **PASSED**
- All latest-per-name checks: **PASSED**

## Version Sync Verification

All release-coupled files have been verified and updated to v0.22.13:
- package.json: 0.22.13
- package-lock.json: 0.22.13
- Cargo.toml: 0.22.13
- plugins/oh-my-codex/.codex-plugin/plugin.json: 0.22.13

## Release Notes

See [docs/release-notes-0.22.13.md](docs/release-notes-0.22.13.md) for full details.

## Known Gaps

None. This patch release fixes critical session resumption issues with no known gaps.

## Approval Gate

✓ Release-readiness checks passed
✓ All coupled versions synchronized
✓ Release notes documented
✓ CI validation complete
