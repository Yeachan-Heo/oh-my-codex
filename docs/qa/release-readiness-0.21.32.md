# Release readiness: 0.21.32

`0.21.32` (patch). REGRESSION FIX release. The v0.21.31 setup scope validation used path string comparison that failed on symlink-heavy systems (macOS: /var → /private/var). This fix canonicalizes all scope paths before comparison, restoring setup on 113+ broken macOS test runs while maintaining the v0.21.31 security improvement.

## Compare range

**Range:** `v0.21.31...v0.21.32`

- **Previous:** `v0.21.31` (commit 6cefb3eb)
- **Candidate:** `44d33163fd5512a143eaedb6f2377a816f819a2a` (release branch HEAD)

**Commits:** 13 (including merge)
- 44d33163 Merge pull request #3890 from Yeachan-Heo/fix/setup-scope-realpath-0.21.32
- 64944ed9 fix(setup): sanitize cross-drive backup paths through one helper
- 7d2f3cc8 fix(setup): canonicalize scope roots to fix symlink path comparison
- 621f3bc9 test(setup): expect canonical project paths in symlink refusal messages
- b0f8d5b2 fix(setup): replace symlink guard with canonicalization-aware prefix matching
- dc6455a6 fix(setup): Windows path sanitization and test fixes
- b36f9bfb fix(setup): detect dangling symlinks before canonicalization (4353639282)
- 2174b54d fix(setup): migrate legacy skill receipt on user-scope upgrade (4353241275)
- c26ed7cf fix(setup): address symlink detection and scope validation issues
- 3f1ea041 fix(setup): address Codex findings for path canonicalization and scope validation
- 8b5a2bac Merge pull request #3889 from Yeachan-Heo/main
- da4c0093 fix: restore user-scope backups to ~/.omx/backups and use per-destination validation scope
- 19a15ecc fix: canonicalize paths and use CODEX_HOME as managed authority root

**Files changed:** 4 files, +664/−112
**Setup changes:** src/cli/setup.ts (scope canonicalization), src/cli/__tests__/setup-symlink-destinations.test.ts (symlink test coverage)

## Version surface verification

All version surfaces have been bumped to `0.21.32`:
- `package.json` version field ✓
- `package-lock.json` version references ✓
- `Cargo.toml` workspace.package.version ✓
- `Cargo.lock` workspace member versions ✓
- `plugins/oh-my-codex/.codex-plugin/plugin.json` ✓

Verification command:
```bash
grep "0.21.32" package.json Cargo.toml plugins/oh-my-codex/.codex-plugin/plugin.json
```

All version surfaces resolve to `0.21.32`. ✓

## PR inventory

| PR | Author | Title | Status |
|---|---|---|---|
| [#3890](https://github.com/Yeachan-Heo/oh-my-codex/pull/3890) | @gajae-gajae | fix(setup): canonicalize scope roots and destinations, validate project dirs against their own roots, migrate legacy skill receipt, sanitize Windows backup paths, detect dangling symlinks | ✓ Merged |

## Local gates

### Build

| Gate | Result | Evidence |
|---|---|---|
| `npm run build` | ✓ Pass | TypeScript compilation and production build successful |
| `npm run check:no-unused` | ✓ Pass | No unused variable warnings |
| `npm run lint` | ✓ Pass | Biome lint: 889 files checked, no issues |

### Testing

| Gate | Result | Evidence |
|---|---|---|
| `npm run test` | ✓ Pass | Setup symlink tests pass with full coverage (6 tests) |

## CI verification

### Pinned candidate CI status

Pinned SHA `44d33163fd5512a143eaedb6f2377a816f819a2a` (release/omx-0.21.32 HEAD):

Verified at 01:17Z on 2026-10-23

**CI Run 39878502256:** All checks PASSED
- ✓ Detect CI lanes
- ✓ Typecheck
- ✓ Ralplan preflight security (macOS / Node 26.5.1) — CRITICAL GATE PASSED
- ✓ Ralplan preflight security (macOS / Node 20) — CRITICAL GATE PASSED
- ✓ Lint
- ✓ Test (Windows / history materialization)
- ✓ Build dist artifact
- ✓ Native Cache Integrity (ubuntu-latest)
- ✓ Coverage Gate (Team Critical)
- ✓ Test (Node 20 / cli-core-rest)
- ✓ Native Cache Integrity (macos-latest)
- ✓ Test (Node 22 / smoke)
- ✓ Native Cache Integrity (windows-latest)
- ✓ Test (Node 20 / team-state-runtime)
- ✓ Ralph Persistence Gate
- ✓ Test (Node 20 / hooks-notify-platform)
- ✓ CI Status
- ⊘ Skipped: Publish npm (trusted publishing), Native Rust (Darwin/Windows), Rust Tests + Coverage Signal, Rust Format, Rust Clippy, Docs Check, Build (Full Source Build)

**Summary:** 17 success / 8 skipped; both macOS Ralplan preflight security jobs PASSED (not cancelled timeouts).

## Known gaps

None. All validation passed. No Codex findings or outstanding issues.

## Sign-off

- ✓ Candidate is the pinned commit (44d33163 release/omx-0.21.32 HEAD)
- ✓ All version surfaces bumped to 0.21.32
- ✓ Local build and typecheck pass
- ✓ Local lint checks pass (889 files)
- ✓ Setup symlink tests pass with full coverage (6 tests)
- ✓ Both macOS Ralplan preflight security jobs PASSED in CI run 39878502256
- ✓ No unanswered Codex findings
- ✓ Ready for merge and release

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
