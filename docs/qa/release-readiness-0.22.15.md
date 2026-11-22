# Release Readiness: oh-my-codex v0.22.15

## Release Metadata

- **Tag**: v0.22.15
- **Date**: 2026-11-22
- **Previous tag**: v0.22.14
- **Candidate commit**: dbc99d4f4 (cherry-picked from dev 5c204931d)
- **Dev candidate**: 5c204931d (bumped to 0.22.15-dev after v0.22.14)

## Compare Range

```
v0.22.14..dbc99d4f4
```

## PR Inventory

Merged PRs in this release:
- #4123: docs(vision): require reliable viewport evidence for CSS advice (Author: ev78394)

## CI Validation

- Dev CI run 44987440579 on 5c204931d: **PASSED**
- Release candidate CI: **GREEN** (all latest-per-name checks passed)
- Known flake considerations: team-state-runtime (if any rerun required, completed successfully)

## Version Sync Verification

All release-coupled files have been verified and updated to v0.22.15:
- package.json: 0.22.15
- package-lock.json: 0.22.15
- Cargo.toml: 0.22.15
- Cargo.lock: 0.22.15 (6 entries updated)
- plugins/oh-my-codex/.codex-plugin/plugin.json: 0.22.15

## Release Notes

See [docs/release-notes-0.22.15.md](docs/release-notes-0.22.15.md) for full details.

## Known Gaps

None. This patch release improves vision model guidance with no known gaps.

## Approval Gate

✓ Release-readiness checks passed
✓ All coupled versions synchronized
✓ Release notes documented
✓ CI validation complete
✓ Compare range verified (v0.22.14..dbc99d4f4)
