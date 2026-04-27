# Release Readiness Verdict - 0.14.1

Date: **2026-04-21**
Target version: **0.14.1**
Comparison base: **`v0.14.0..origin/dev`**
Verdict: **GO** ✅

`0.14.1` packages the post-`0.14.0` hardening train as a patch release: deep-interview question-enforcement fixes, question-pane/tmux reliability, setup-update refresh resilience, lifecycle normalization deduplication, stop-state leakage fixes, and release collateral alignment.

## Scope reviewed

### Question / deep-interview / Stop behavior
- `src/question/*`, `src/scripts/codex-native-hook.ts` — pending-question enforcement, reused-session bridge guidance, and tmux question lifecycle handling
- `src/question/__tests__/*`, `src/scripts/__tests__/codex-native-hook.test.ts` — regression coverage for inactive-but-pending question obligations and detached renderer liveness

### Setup / update / install refresh
- `src/cli/update.ts`, `src/scripts/postinstall.ts` — setup refresh retry paths, npm install-root anchoring, and explicit update behavior when setup state is stale
- `src/cli/__tests__/update.test.ts`, `src/scripts/__tests__/postinstall.test.ts` — install stamp, setup refresh, and failure-path coverage

### Lifecycle / guidance / release collateral
- `src/runtime/run-outcome.ts`, `src/runtime/terminal-lifecycle.ts` — shared lifecycle normalization contract
- `skills/code-review/SKILL.md`, prompt/help/docs updates, release workflow/docs alignment
- `package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`, `CHANGELOG.md`, `RELEASE_BODY.md`, `docs/release-notes-0.14.1.md`

## Validation evidence

| Check | Command | Result |
|---|---|---|
| Full Node build/test/catalog gate | `npm test` | PASS |
| Native crates | `cargo test -p omx-explore-harness -p omx-sparkshell` | PASS |
| Publish-path packaging | `npm pack --dry-run` | PASS |

## Risk assessment

- The patch train is broader than a single hotfix but still concentrated on reliability follow-through rather than a new top-level feature surface.
- The strongest remaining operator-facing risk is still real tmux / reused-session behavior around `omx question`, deep-interview Stop blocking, and upgrade-triggered setup refresh.
- GitHub Actions release and npm publish remain delegated to the tag-triggered release workflow.

## Final verdict

Release **0.14.1** is **ready for release commit/tag cut from `dev`** on the basis of the passing validation evidence above.
