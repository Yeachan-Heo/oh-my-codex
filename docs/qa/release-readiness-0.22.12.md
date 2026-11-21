# Release Readiness: oh-my-codex v0.22.12

Compare range: `v0.22.11..f757c674b`

## PR Inventory

User-facing changes in this release:

| PR | Title | Author | Merged | Type |
|----|-------|--------|--------|------|
| #4112 | fix: recover quarantined live-pin lock links (Fixes #4111) | Yeachan-Heo | 2026-11-21 | fix |

## CI Status

- **Dev CI:** Passed on f757c674b
  - Run ID: 44898312325
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
✓ dev CI green (44898312325)
✓ Release notes complete and reviewed
✓ Release collateral generated and validated
✓ Local gates passing
✓ All PRs accounted for in release notes

**Status:** Ready for merge to main
