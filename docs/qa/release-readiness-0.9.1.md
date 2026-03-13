# Release Readiness Draft - 0.9.1

Date: **2026-03-13**
Target version: **0.9.1**
Verdict: **GO (LOCAL RELEASE-CRITICAL GATES PASSED)**

`0.9.1` is the smallest main-based hotfix release intended to supersede the historically red `v0.9.0` release.

## Scope reviewed

- `main` / tag `v0.9.0` baseline
- PR [#806](https://github.com/Yeachan-Heo/oh-my-codex/pull/806) hotfix (`d86165d`) for smoke hydration asset localization
- version bump and release metadata updates required for `0.9.1`

## Validation plan

| Check | Command | Status |
|---|---|---|
| Version sync | `node scripts/check-version-sync.mjs --tag v0.9.1` | PASS |
| Lint | `npm run lint` | PASS |
| TypeScript noEmit | `npx tsc --noEmit` | PASS |
| No-unused gate | `npm run check:no-unused` | PASS |
| Full test suite | `npm test` | PASS (`2397` pass / `0` fail) |
| Smoke test coverage | `node --test scripts/__tests__/smoke-packed-install.test.mjs` | PASS (`1` pass / `0` fail) |
| Release build | `npm run build:full` | PASS |
| Packed install smoke | `npm run smoke:packed-install` | PASS |
| Packed tarball dry run | `npm pack --dry-run` | PASS (`oh-my-codex-0.9.1.tgz`) |

## Historical release note

- **`v0.9.0` remains historically red.**
- **`v0.9.1` is the clean superseding release.**

## Local evidence summary

- version sync passed with `package=0.9.1 workspace=0.9.1 tag=v0.9.1`
- lint passed with `Checked 337 files in 72ms. No fixes applied.`
- full test suite passed with `2397` passing tests and `0` failures
- packed install smoke passed with `packed install smoke: PASS`
- dry-run tarball produced `oh-my-codex-0.9.1.tgz`
