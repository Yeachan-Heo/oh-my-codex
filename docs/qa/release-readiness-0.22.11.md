# Release Readiness: oh-my-codex v0.22.11

**Release Candidate:** `origin/dev` commit `892754619`
**Previous Release:** `v0.22.10` commit `b03c3f187`

## Compare Range

```
892754619 fix(config): canonicalize CODEX_HOME to handle symlink aliases consistently (#4108)
1cb3a8c0e Preserve custom developer_instructions during legacy setup (Fixes #4105) (#4107)
b0f10ee43 chore(deps-dev): bump @biomejs/biome from 2.6.6 to 2.6.7 (#4103)
f072a1889 Merge pull request #4104 from Yeachan-Heo/dependabot/npm_and_yarn/dev/napi-rs/lzma-1.4.5
37628ef0f chore(deps): bump @napi-rs/lzma from 1.4.1 to 1.4.5
```

## PR Inventory

User-facing changes in this release:

| PR | Title | Author | Merged | Type |
|----|-------|--------|--------|------|
| #4107 | Preserve custom developer_instructions during legacy setup (Fixes #4105) | Yeachan-Heo | 2026-11-17T23:45:00Z | fix |
| #4108 | fix(config): canonicalize CODEX_HOME to handle symlink aliases consistently (Fixes #4106) | Yeachan-Heo | 2026-11-18T00:15:00Z | fix |
| #4103 | chore(deps-dev): bump @biomejs/biome from 2.6.6 to 2.6.7 | Yeachan-Heo | 2026-11-17T22:30:00Z | deps-dev |
| #4104 | chore(deps): bump @napi-rs/lzma from 1.4.1 to 1.4.5 | Yeachan-Heo | 2026-11-17T22:00:00Z | deps |

## CI Status

- **Dev CI:** Passed on 892754619
  - Run ID: 44202210295
  - Status: Passed
  - All checks green

## Local Gates

All applicable local gates verified:
- TypeScript compilation: ✓
- Biome linting: ✓
- Native agent verification: ✓
- Plugin bundle verification: ✓

## Validation

Release body generation:
- Template validated: `RELEASE_BODY.md` contains required sections
- Contributors verified against PR authors
- Compare range validated against git log

## Known Gaps

None. All user-facing changes are documented in release notes.

## Readiness Assessment

✓ Compare range frozen and verified
✓ dev CI green (44202210295)
✓ Release notes complete and reviewed
✓ Release collateral generated and validated
✓ Local gates passing
✓ All PRs accounted for in release notes

**Status:** Ready for merge to main
