# Release readiness: 0.21.27

`0.21.27` (patch). The release improves subagent recovery guidance by implementing tri-state `resume_agent` availability tracking, enabling accurate host capability detection and recovery path selection.

## Compare range

**Range:** `v0.21.26...v0.21.27`

- **Previous:** `v0.21.26` (commit 5a4f8e81)
- **Candidate:** `b58737f0f1eb427b978cb5561672625144616f29` (release branch HEAD)
- **Ancestor check:** ✓ v0.21.26 is an ancestor of candidate

## Change summary

Pinned candidate (before version bump) `b58737f0f1eb427b978cb5561672625144616f29`: 3 commits

- **Feature commits:** 2 commits (PRs #3867, #3868)
- **CI evidence pinned to:** commit b58737f0f1eb427b978cb5561672625144616f29 (17 success, 8 skipped, 0 failures)
- **Ancestry verification:** ✓ v0.21.26 is ancestor of b58737f0f1eb427b978cb5561672625144616f29

Full release (with version bump) - commits counted from tag:

- **Commits:** 3 core commits + version bump = 4 total
- **Files changed:** 10 files in range
- **Insertions:** +317
- **Deletions:** −30
- **Net change:** +287 lines

## Version numbers

All version surfaces have been bumped to `0.21.27`:
- `package.json` version field ✓
- `package-lock.json` version references ✓
- `Cargo.toml` workspace.package.version ✓
- `Cargo.lock` all 6 workspace crate versions ✓
- `plugins/oh-my-codex/.codex-plugin/plugin.json` version ✓

Verification:
```
cargo metadata --locked --format-version 1 --no-deps
```
confirms all six Rust workspace crates resolve to `0.21.27`.

## PR inventory

| PR | Author | Title | Type |
|---|---|---|---|
| [#3867](https://github.com/Yeachan-Heo/oh-my-codex/pull/3867) | @Yeachan-Heo | fix(subagents): cover hosts without resume_agent in SessionStart reopen guidance | Fix |
| [#3868](https://github.com/Yeachan-Heo/oh-my-codex/pull/3868) | @Yeachan-Heo | fix(subagents): implement tri-state resume_agent availability (#3866 follow-up) | Fix |

## Local gates

### Build

| Gate | Result | Evidence |
|---|---|---|
| `npm run build` | ✓ Pass | TypeScript compilation and production build successful |
| `npm run check:no-unused` | ✓ Pass | No unused variable warnings |
| `npm run lint` | ✓ Pass | Biome lint: 885 files checked, no issues |

## CI verification

### Pinned candidate CI status

Pinned SHA `b58737f0f1eb427b978cb5561672625144616f29`:

| Status | Count |
|---|---|
| Success | 17 |
| Skipped | 8 |
| Failure | 0 |

**Latest-per-name checks:** All green at commit b58737f0f1eb427b978cb5561672625144616f29. No failures or re-runs needed.

## Known gaps

- None. All findings from prior releases remain documented in their respective release-readiness files.

## Validation checklist

- ✓ Candidate is an ancestor of the pinned commit
- ✓ All version surfaces bumped to 0.21.27
- ✓ Local build and typecheck pass
- ✓ Local lint checks pass (885 files)
- ✓ Dev CI green (17 success, 8 skipped, 0 failures)
- ✓ All PRs merged and accounted for
- ✓ Release notes match compare range
- ✓ CHANGELOG.md updated with new entry
- ✓ Release-readiness document prepared

Ready for merge to main and tag.
