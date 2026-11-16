# Release Readiness: oh-my-codex v0.22.10

## Release Scope

**Previous Release:** v0.22.9 (commit 66ca2c596)  
**Candidate:** origin/dev (commit b03c3f187)  
**Release Tag:** v0.22.10  

## Compare Range

```
git log --oneline v0.22.9..HEAD
b03c3f187 (HEAD -> release/0.22.10, origin/dev) Merge pull request #4100 from Yeachan-Heo/back-merge/0.22.9-to-dev-0.22.10
34de34805 chore(dev): bump version to 0.22.10-dev after v0.22.9 release
78d1dfe44 back-merge: main into dev after v0.22.9 release + bump to 0.22.10-dev
5181cf464 docs(ralplan): align unavailable custom-gate guidance with warn-and-skip runtime policy (#4097)
```

## PR Inventory

User-facing changes in this release:

| PR | Title | Author | Merged | Type |
|----|-------|--------|--------|------|
| #4097 | docs(ralplan): align unavailable custom-gate guidance with warn-and-skip runtime policy | Yeachan-Heo | 2026-11-16T17:48:52Z | docs |
| #4100 | back-merge: main into dev after v0.22.9 release + bump to 0.22.10-dev | Yeachan-Heo | 2026-11-16T18:18:41Z | internal |

## CI Status

- **Dev CI:** Passed on b03c3f187
  - Run ID: 43927487119
  - Status: Passed on attempt 2 (attempt 1 failed on flaky runtime.test.js timing)
  - Known flaky test: `assignTask worker_notify_failed` timing assertion (resolved by retry)

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
✓ dev CI green (43927487119 attempt 2)
✓ Release notes complete and reviewed
✓ Release collateral generated and validated
✓ Local gates passing
✓ All PRs accounted for in release notes

**Status:** Ready for merge to main
