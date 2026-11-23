# Release readiness: 0.21.33

`0.21.33` (patch). CRASH RECOVERY release. The dispatch finalization journal (`runtime-finalizations.jsonl`) could be corrupted after a crash mid-append, causing subsequent receipts to be lost. This fix adds tolerant parsing to recover valid commands from corrupted journals and newline-isolated appends to protect new entries from torn tails.

## Compare range

**Range:** `v0.21.32...v0.21.33`

- **Previous:** `v0.21.32` (commit 5a0e91bc)
- **Candidate:** `fa9b223d8f9fe961a26f048f2132397ccdf7a938` (release branch HEAD)
- **Commits:** 2 (fix + version bump)
- **Changes:** 9 files, +262 additions, −19 deletions

Commits in range:
- fa9b223d fix: recover team dispatch finalizations from torn journal lines (#3893)
- 332d658c chore(version): advance dev base to 0.21.33 following v0.21.32 release

## PR inventory

| PR | Author | Title | Lines |
|---|---|---|---|
| [#3893](https://github.com/Yeachan-Heo/oh-my-codex/pull/3893) | @shenyankm | fix: recover team dispatch finalizations from torn journal lines | +251, −8 |

**Scope:** 1 PR (crash recovery / dispatch finalization), 1 contributor (shenyankm)

## Local gates

### Build and type checking

```
$ npm run build
✓ TypeScript compilation
✓ CLI executable produced (dist/cli/omx.js)
$ npm run check:no-unused
✓ No unused variables or imports
$ npm run lint
✓ 889 files checked, 0 violations
```

### Tests

```
$ npm test -- src/team/__tests__/dispatch-finalization-journal.test.ts
✓ reads dispatch requests past torn, null and array lines
✓ reconciles and removes a journal containing only torn lines
✓ preserves and replays commands appended after an unterminated tail
✓ keeps valid commands while skipping malformed lines
```

**Summary:** 4 dispatch finalization journal recovery tests; all pass.

## CI verification

### Pinned candidate CI status

Pinned SHA `fa9b223d8f9fe961a26f048f2132397ccdf7a938` (release/omx-0.21.33 HEAD):

Verified at 07:17Z on 2026-10-23

**CI Run 39913485838:** All checks PASSED
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

- ✓ Candidate is the pinned commit (fa9b223d release/omx-0.21.33 HEAD)
- ✓ All version surfaces bumped to 0.21.33
- ✓ Local build and typecheck pass
- ✓ Local lint checks pass (889 files)
- ✓ Dispatch finalization journal recovery tests pass (4 tests)
- ✓ Both macOS Ralplan preflight security jobs PASSED in CI run 39913485838
- ✓ No unanswered Codex findings
- ✓ Ready for merge and release

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
