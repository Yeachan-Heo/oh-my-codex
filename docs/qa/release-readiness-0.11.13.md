# Release Readiness Verdict - 0.11.13

Date: **2026-04-04**
Target version: **0.11.13**
Verdict: **NO-GO** ❌

## Scope reviewed

- Restore `src/hooks/__tests__/notify-fallback-watcher.test.ts` after placeholder corruption on the release branch
- Version bump to `0.11.13` across Node and Cargo workspace metadata
- Release collateral refresh (`CHANGELOG.md`, `RELEASE_BODY.md`, `docs/release-notes-0.11.13.md`)
- Release hygiene cleanup in `README.vi.md`
- Release-focused verification for current dispatch/runtime and notify-hook surfaces

## Validation evidence

| Check | Command | Result |
|---|---|---|
| Build | `npm run build` | PASS |
| Rust runtime core | `cargo test -p omx-runtime-core` | PASS (`54` pass / `0` fail) |
| Lint | `npm run lint` | PASS |
| Notify fallback watcher suite | `node --test dist/hooks/__tests__/notify-fallback-watcher.test.js` | PASS (`40` pass / `0` fail) |
| Version sync contract | `node --test dist/cli/__tests__/version-sync-contract.test.js` | PASS |
| Working tree whitespace check | `git diff --check` | PASS |
| Dispatch/runtime focused suites | `node dist/scripts/run-test-files.js dist/hooks/__tests__/notify-hook-team-dispatch.test.js dist/team/__tests__/mcp-comm.test.js dist/team/__tests__/state.test.js` | FAIL (`16` failing tests) |

## Current blockers

- `notify-hook team dispatch consumer` still has multiple failing cases around deferred leader notifications, retry/unconfirmed dispatch state, and session-only target resolution.
- `mcp-comm` still has failing cases around deferred leader mailbox dispatch and failed transport handling.
- `team state` still has failing cases around dispatch fallback recovery semantics and mailbox delivered timestamp persistence.
- Because those dispatch/runtime suites are still red, the branch is **not** ready for tag/release/merge.

## Final verdict

Release **0.11.13** is **not ready to publish yet**. The branch is buildable again and release metadata is prepared, but dispatch/runtime verification is still failing and must be fixed before release.
