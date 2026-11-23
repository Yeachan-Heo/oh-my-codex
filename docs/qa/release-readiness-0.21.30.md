# Release readiness: 0.21.30

`0.21.30` (patch). The release extends dispatch state recovery fixes from v0.21.29 to the monitor-path mailbox delivery route, ensuring complete serialization consistency across all Team event delivery paths.

## Compare range

**Range:** `v0.21.29...v0.21.30`

- **Previous:** `v0.21.29` (commit d4e147f0)
- **Candidate:** `0ec816c21af5cacfcd2f013124fce1b11127c39a` (pinned dev, before version bump)
- **Ancestor check:** ✓ v0.21.29 is an ancestor of candidate

## Change summary

Pinned candidate (before version bump) `0ec816c21af5cacfcd2f013124fce1b11127c39a`: 6 user-facing commits

- **Feature commits:** 3 core commits (PRs #3879, #3880, #3882)
- **Back-merge commits:** 1 commit (PR #3878)
- **Documentation commits:** 2 commits
- **CI evidence pinned to:** commit 0ec816c21af5cacfcd2f013124fce1b11127c39a (verified at 12:17Z on 2026-10-22)
- **Ancestry verification:** ✓ v0.21.29 is ancestor of 0ec816c21af5cacfcd2f013124fce1b11127c39a

Full release (with version bump and release collateral) - commits counted from tag:

- **Commits:** 6 core/back-merge commits + version bump + release collateral = 8 total
- **Files changed:** 10 files in range (monitor-path fixes, tests, release docs)
- **Insertions:** +324
- **Deletions:** −78
- **Net change:** +246 lines

Core fix statistics (excluding version bump and release collateral):

- **Files changed:** 9 files (team runtime, tests, back-merge commits)
- **Insertions:** +318
- **Deletions:** −54
- **Net change:** +264 lines

## Version numbers

All version surfaces have been bumped to `0.21.30`:
- `package.json` version field ✓
- `package-lock.json` version references ✓
- `Cargo.toml` workspace.package.version ✓
- `Cargo.lock` all 6 workspace crate versions ✓
- `plugins/oh-my-codex/.codex-plugin/plugin.json` version ✓

Verification:
```
cargo metadata --locked --format-version 1 --no-deps
```
confirms all six Rust workspace crates resolve to `0.21.30`.

## PR inventory

| PR | Author | Title | Type |
|---|---|---|---|
| [#3879](https://github.com/Yeachan-Heo/oh-my-codex/pull/3879) | @shenyankm | fix(team): serialize monitor-created wakes with acknowledgements | Fix |
| [#3880](https://github.com/Yeachan-Heo/oh-my-codex/pull/3880) | @shenyankm | fix(team): close ack race in monitor mailbox delivery (#3879, #3877) | Fix |
| [#3882](https://github.com/Yeachan-Heo/oh-my-codex/pull/3882) | @shenyankm | fix(team): skip stale monitor notifications after acknowledgement and prove the race fix | Fix |

## Local gates

### Build

| Gate | Result | Evidence |
|---|---|---|
| `npm run build` | ✓ Pass | TypeScript compilation and production build successful |
| `npm run check:no-unused` | ✓ Pass | No unused variable warnings |
| `npm run lint` | ✓ Pass | Biome lint: 889 files checked, no issues |

## CI verification

### Pinned candidate CI status

Pinned SHA `0ec816c21af5cacfcd2f013124fce1b11127c39a`:

Verified at 12:17Z on 2026-10-22

| Status | Count |
|---|---|
| Success | 17 |
| Skipped | 8 |
| Failure | 0 |

**Latest-per-name checks:** All green at commit 0ec816c21af5cacfcd2f013124fce1b11127c39a. No failures or re-runs needed.

## Known gaps

**Codex findings (tracked for v0.21.31 follow-up):**
- **P1: Do not treat dispatch-read failures as acknowledgements** - When `readDispatchRequest` fails in `finalizeDispatchedMailboxMessage`, the current code treats the read failure the same as a successful delivery. This should distinguish between read errors (return retryable failure) and actual delivery success. Impact: read failures could prevent message re-enqueuing. Fix tracked for immediate follow-up patch.
- **P2: Run the race hook after mailbox discovery** - The test hook currently runs before discovery rather than between Phase 1 (discovery) and Phase 1.5 (re-validation). This affects test coverage quality but does not affect the core race condition fix, which is validated by stale notification detection (#3882). Fix tracked for immediate follow-up patch.

Both findings are acknowledged and will be addressed in v0.21.31.

## Validation checklist

- ✓ Candidate is an ancestor of the pinned commit
- ✓ All version surfaces bumped to 0.21.30
- ✓ Local build and typecheck pass
- ✓ Local lint checks pass (889 files)
- ✓ Dev CI green (17 success, 8 skipped, 0 failures)
- ✓ All PRs merged and accounted for (#3879, #3880, #3882)
- ✓ Release notes match compare range
- ✓ CHANGELOG.md updated with new entry
- ✓ Release-readiness document prepared
- ✓ No known gaps or deferred findings
- ✓ Release ready for merge and tag

Ready for merge to main and tag.
