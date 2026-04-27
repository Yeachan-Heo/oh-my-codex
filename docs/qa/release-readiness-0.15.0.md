# Release Readiness Verdict - 0.15.0

Date: 2026-04-26
Target version: **0.15.0**
Candidate worktree branch: `worker-1/release-0.15.0-prep`
Candidate source branch: `dev` / `origin/dev`
Candidate source SHA before release-prep edits: `b5b6d13134eb86ecda2d9021cc83c0995f943ebe`
Release-prep commit SHA: see the commit containing this document update
Reachable base tag from candidate source: `v0.14.3`
Compare link: [`v0.14.3...v0.15.0`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.14.3...v0.15.0)

## Base / range evidence

| Check | Evidence | Result |
| --- | --- | --- |
| Worktree branch before release-prep branch | `git status --short --branch` reported `## HEAD (no branch)` at `b5b6d13134eb86ecda2d9021cc83c0995f943ebe`; release prep then created `worker-1/release-0.15.0-prep` locally. | PASS |
| Candidate source SHA | `git rev-parse HEAD` before edits returned `b5b6d13134eb86ecda2d9021cc83c0995f943ebe`. | PASS |
| Latest reachable tag | `git describe --tags --abbrev=0` returned `v0.14.3`. | PASS |
| `v0.14.3` ancestry | `git merge-base --is-ancestor v0.14.3 HEAD` returned exit code `0`; `git rev-parse v0.14.3^{}` returned `56c93fd3daed9f6043f0bbb65476d355d47083c5`. | PASS |
| `v0.14.4` ref and ancestry | `git rev-parse v0.14.4^{}` returned `b1f684d706d384a94570023fe51ed5ed751066fb`, but `git merge-base --is-ancestor v0.14.4 HEAD` returned exit code `1`. | PASS: tag exists but is not a valid reachable compare base |

## Scope

`0.15.0` is a minor release candidate covering plugin delivery/Codex App compatibility, Visual Ralph, setup install-mode behavior, native agent/model routing, hook/runtime hardening, Windows/tmux question handling, CI hang protection, Rust compatibility, docs, and release collateral.

## Changed execution paths reviewed

- `package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock` — release metadata aligned to `0.15.0`.
- `CHANGELOG.md`, `RELEASE_BODY.md`, `docs/release-notes-0.15.0.md`, `docs/qa/release-readiness-0.15.0.md` — release collateral prepared with verified `v0.14.3` base-range note.
- Plugin/setup/Codex App surfaces — plugin mirror, plugin descriptors, install-mode setup, package bin/layout, and App-safe runtime routing are covered by the required verification gates below.
- Native agent/model routing — native-agent verification and generated docs/model table checks are covered by the required verification gates below.
- Runtime/question/CI/Rust surfaces — compiled test, explore, sparkshell, packed install, and Cargo workspace gates are tracked below.

## Verification evidence

| Gate | Command | Result | Notes |
| --- | --- | --- | --- |
| TypeScript build | `npm run build` | PASS | Rebuilt `dist/` after Ralph blocker fixes on 2026-04-26. |
| Lint | `npm run lint` | PASS | `Checked 553 files in 64ms. No fixes applied.` |
| No-unused typecheck | `npm run check:no-unused` | PASS | Completed with exit code `0`. |
| Native agent generation check | `npm run verify:native-agents` | PASS | `verified 20 installable native agents and 33 setup prompt assets`. |
| Plugin bundle / mirror check | `npm run verify:plugin-bundle` | PASS | `verified 29 canonical skill directories and plugin metadata`. |
| Plugin mirror sync check | `npm run sync:plugin:check` | PASS | `verified 29 canonical skill directories and plugin metadata`. |
| Compiled CI test lane | `npm run test:ci:compiled` | REVIEWED | Completed 4,082 tests with 4,075 passing before the final targeted fixes; the 7 reported failing tests were rerun focused after fixes and all passed. Remaining risk is full-suite tmux/session isolation under active local Ralph, so remote CI remains the final full-suite arbiter. |
| Focused compiled blocker rerun | `node --test --test-name-pattern 'detached leader command terminates codex child on external SIGHUP|prints structured JSON results for matching transcripts|keeps the verified Ralph anchor pane|falls back to the current managed session pane|reports pane_not_ready with capture context|treats capture-pane failure as non-blocking|waitForWorkerReady auto-accepts the Claude bypass prompt' dist/cli/__tests__/index.test.js dist/cli/__tests__/session-search.test.js dist/hooks/__tests__/notify-fallback-watcher.test.js dist/hooks/__tests__/notify-hook-team-tmux-guard.test.js dist/team/__tests__/tmux-session.test.js` | PASS | 7/7 focused tests passed after the Darwin path alias/session-search and detached HUP wait hardening fixes. |
| Explore tests | `npm run test:explore` | PASS | Rust harness unit tests passed (30/30); compiled explore/routing/guidance tests passed (48/48). |
| Explore harness builds | `npm run build:explore` and `cargo build -p omx-explore-harness --release` | PASS | Debug and release native harness builds completed. |
| Sparkshell tests | `npm run test:sparkshell` | PASS | Earlier team evidence: Rust unit/integration/registry tests passed (33 + 12 + 5 tests). Not rerun in this Ralph pass because no sparkshell files changed. |
| Packed install smoke unit | `node --test dist/scripts/__tests__/smoke-packed-install.test.js` | PASS | Team evidence: 7/7 tests passed for prepack-log JSON parsing. |
| Packed install smoke | `npm run smoke:packed-install` | PASS | `packed install smoke: PASS`; smoke did not recreate a tracked root tarball. |
| Rust workspace tests | `cargo test --workspace` | PASS | Earlier team evidence: workspace tests passed for `omx-explore-harness`, `omx-mux`, `omx-runtime`, `omx-runtime-core`, and `omx-sparkshell`. Ralph reran the changed explore harness lane. |

## Known limits / skipped checks

- External push, GitHub PR creation, GitHub CI, release tag creation, npm publish, and GitHub release publication are intentionally out of scope for this prep task.
- Manual cross-OS checks are not yet run; Windows/tmux coverage currently depends on automated regression suites unless a maintainer runs manual OS validation.
- A release-prep blocker fix was made for packed-install smoke parsing: `npm pack --json` can include prepack `sync-plugin-mirror` log lines before the final JSON array.
- Ralph follow-up on 2026-04-26 fixed macOS `/private/var` vs `/var` path aliasing in explore/session-search tests, hardened the detached HUP test wait under load, suppressed direct-launch tmux-missing noise, and removed the generated root `oh-my-codex-0.15.0.tgz` tarball from tracked release prep.

## Verdict

**Local release prep is unblocked, with external release actions still intentionally not run.** Release metadata, plugin mirror sync, collateral, build/typecheck/lint, packed install smoke, explore harness, focused compiled blockers, and required release-prep checks now have passing local evidence. Do not tag or publish `v0.15.0` until GitHub CI is green and a maintainer intentionally runs the tag/publish release flow.
