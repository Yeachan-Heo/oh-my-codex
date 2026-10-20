# Release readiness: 0.21.24

`0.21.24` (patch). The release improves setup plugin-cache repair safety and idempotency by hardening the `removalSafe` field derivation logic, enforcing fail-closed behavior in dry-run mode, and ensuring repair returns `unchanged` for identical caches.

## Compare range

**Range:** `v0.21.23...v0.21.24`

- **Previous:** `v0.21.23` (commit d530b7d00c39ab44138870609a2e3de4f47493ce)
- **Candidate:** `e5370084006560eb76df4c79aeecf50e4a3f90f0` (pinned dev SHA)
- **Ancestor check:** ✓ v0.21.23 is an ancestor of candidate

## Change summary

- **Commits:** 9 non-merge commits (13 with back-merge commits)
- **Files changed:** 5 files
- **Insertions:** +365
- **Deletions:** −28
- **Net change:** +337 lines

## Version numbers

All version surfaces have been bumped to `0.21.24`:
- `package.json` version field ✓
- `package-lock.json` version references ✓
- `Cargo.toml` workspace.package.version ✓
- `Cargo.lock` all 6 workspace crate versions ✓
- `plugins/oh-my-codex/.codex-plugin/plugin.json` version ✓

Verification:
```
cargo metadata --locked --format-version 1 --no-deps
```
confirms all six Rust workspace crates resolve to `0.21.24`.

## PR inventory

| PR | Author | Title | Type |
|---|---|---|---|
| [#3851](https://github.com/Yeachan-Heo/oh-my-codex/pull/3851) | @Yeachan-Heo | fix(setup): require removalSafe and fail closed in dry-run repair | Fix |
| [#3852](https://github.com/Yeachan-Heo/oh-my-codex/pull/3852) | @Yeachan-Heo | chore: ignore gjc runtime session state | Chore |
| [#3853](https://github.com/Yeachan-Heo/oh-my-codex/pull/3853) | @Yeachan-Heo | fix(setup): derive removalSafe only from verified repair eligibility | Fix |
| [#3854](https://github.com/Yeachan-Heo/oh-my-codex/pull/3854) | @Yeachan-Heo | fix(setup): keep identical caches unchanged in repair dry-runs | Fix |
| [#3849](https://github.com/Yeachan-Heo/oh-my-codex/pull/3849) | @Yeachan-Heo | test(setup): add comprehensive removalSafe field tests for late-pin scenarios | Test |

## Local gates

### Build & typecheck

| Gate | Result | Evidence |
|---|---|---|
| `npm run build` | ✓ Pass | TypeScript compilation successful |
| `npm run build:runtime` | ✓ Pass | Cargo build for omx-runtime successful |
| `npm run check:no-unused` | ✓ Pass | TypeScript unused-variable check passes |

### Tests

| Gate | Result | Notes |
|---|---|---|
| `npm run test` | ✓ Pass | All tests green, including coverage gates |
| `npm run test:explore` | ✓ Pass | Explore harness tests pass |
| `npm run test:recent-bug-regressions` | ✓ Pass | Recent regressions all pass |
| `npm run test:team:cross-rebase-smoke` | ✓ Pass | Team cross-rebase smoke test passes |
| `npm run test:compat:node` | ✓ Pass | Node compat tests pass |

### Setup integrity

| Gate | Result | Notes |
|---|---|---|
| `npm run sync:plugin:check` | ✓ Pass | Plugin metadata and skill directories verified |
| `npm run verify:native-agents` | ✓ Pass | Native agent binaries verified |
| `npm run verify:plugin-bundle` | ✓ Pass | Plugin bundle structure verified |

## CI verification

### Pinned candidate CI status

Pinned SHA `e5370084006560eb76df4c79aeecf50e4a3f90f0` dev CI run:

| Status | Count |
|---|---|
| Success | 17 |
| Skipped | 8 |
| Failure | 0 |

**Latest-per-name checks:** All green. No failures or re-runs needed.

## Known gaps

- None. All findings from prior releases (#3840 design follow-up) remain documented in their respective release-readiness files.

## Validation checklist

- ✓ Candidate is an ancestor of the pinned commit
- ✓ All version surfaces bumped to 0.21.24
- ✓ Local build and typecheck pass
- ✓ Local test suite passes
- ✓ Dev CI green (17 success, 8 skipped, 0 failures)
- ✓ All PRs merged and accounted for
- ✓ Release notes match compare range
- ✓ CHANGELOG.md updated with new entry
- ✓ RELEASE_BODY.md prepared

Ready for merge to main and tag.
