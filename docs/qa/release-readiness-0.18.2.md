# Release readiness: oh-my-codex 0.18.2

## Range

- Previous tag: `v0.18.1` (`8f460a0aa353873ea567de4fd00bd1cc84379d9c`, created 2026-05-21T04:44:28Z)
- Candidate before release metadata commit: `dev` / `origin/dev` at `5bc15d4b613237c97635e525243d5c326f3434fa`
- Release tag: `v0.18.2`
- Compare: `v0.18.1..dev` before promotion, then `v0.18.1..v0.18.2` after tagging

## Closed issue audit since v0.18.1

Filter used: GitHub issues with `createdAt > 2026-05-21T04:44:28Z` and `state = CLOSED`.

| Issue | State reason | Merge evidence | Release disposition |
| --- | --- | --- | --- |
| #2428 | NOT_PLANNED | None required | Closed as too broad; requested narrower follow-ups. |
| #2429 | COMPLETED | PR #2431 | Included. |
| #2430 | COMPLETED | PR #2432 | Included. |
| #2433 | COMPLETED | PR #2434 | Included. |
| #2435 | COMPLETED | PR #2436 | Included. |
| #2438 | COMPLETED | PR #2439 | Included. |
| #2440 | COMPLETED | PR #2442 | Included. |
| #2443 | COMPLETED | PR #2447 | Included. |
| #2445 | COMPLETED | PR #2448 | Included. |
| #2449 | COMPLETED | PR #2450 | Included. |
| #2451 | COMPLETED | PR #2452 | Included. |
| #2453 | COMPLETED | PR #2455 | Included. |
| #2456 | COMPLETED | PR #2457 | Included. |
| #2460 | COMPLETED | PR #2461 | Included. |
| #2462 | COMPLETED | PR #2463 | Included. |
| #2465 | NOT_PLANNED | None required | Closed by contribution gate; not an execution-track merge for 0.18.2. |
| #2466 | COMPLETED | PR #2467 | Included. |
| #2468 | COMPLETED | PR #2469 | Included. |
| #2470 | COMPLETED | PR #2471 | Included. |

## Merged PR inventory

- #2415 — Add clean-room Prometheus Strict planner
- #2427 — Guard deep-interview from implicit implementation handoff
- #2431 — Fix doctor plugin hook diagnostics
- #2432 — Fix autopilot chain status observability
- #2434 — Fix tmux 3.2a HUD resize hook registration
- #2436 — Fix madmax detached lock identity for independent launches
- #2437 — feat(prometheus-strict): reintroduce canonical surface with omx question routing
- #2439 — Fix team startup-direct evidence gating
- #2442 — Forward OMX_ROOT to tmux HUD watch panes
- #2447 — Guard autopilot ralplan consensus handoff (review fixes)
- #2448 — Suppress workflow keyword state in native subagents (review fixes)
- #2450 — fix: isolate team stop state
- #2452 — Fix stale madmax detached lock timeouts
- #2455 — Align ralplan handoff docs with Ultragoal default
- #2457 — Bound notify dispatcher turn-ended storms
- #2461 — Keep tmux HUD panes scoped to leader sessions
- #2463 — Clarify madmax same-directory lock diagnostic
- #2467 — Fix ultragoal get_goal recovery for missing goal storage
- #2469 — Clarify research planning boundaries
- #2471 — Fix duplicate native hooks and trust-state loss for project-scope launches
- #2472 — Show Ultragoal progress in HUD and tighten review followups

## Local validation

Completed before promotion:

- [x] `npm run build` — PASS.
- [x] `npm run verify:native-agents` — PASS (`21` installable native agents, `36` setup prompt assets).
- [x] `npm run verify:plugin-bundle` — PASS after `npm run sync:plugin` updated plugin metadata to `0.18.2`.
- [x] `env -u OMX_ROOT -u OMX_STATE_ROOT -u OMX_SESSION_ID -u CODEX_SESSION_ID -u SESSION_ID npm run test:recent-bug-regressions:compiled` — PASS (`627` tests). The first unsanitized attempt failed because the active OMX runtime `OMX_ROOT` contaminated temp-root team tests; rerun with release-clean env passed.
- [x] `env -u OMX_ROOT -u OMX_STATE_ROOT -u OMX_SESSION_ID -u CODEX_SESSION_ID -u SESSION_ID node --test dist/hud/__tests__/authority.test.js dist/hooks/__tests__/notify-fallback-watcher.test.js dist/scripts/__tests__/notify-dispatcher.test.js dist/ultragoal/__tests__/artifacts.test.js dist/cli/__tests__/codex-plugin-layout.test.js dist/cli/__tests__/setup-install-mode.test.js dist/hooks/__tests__/keyword-detector.test.js dist/team/__tests__/runtime.test.js` — PASS (`436` tests). This gate previously exposed a real slow-dispatch coalescing gap; the release candidate now fixes it with completion-anchored identity-scoped coalescing plus pruning and includes the clean rerun.
- [x] `env -u OMX_ROOT -u OMX_STATE_ROOT -u OMX_SESSION_ID -u CODEX_SESSION_ID -u SESSION_ID node --test dist/scripts/__tests__/notify-dispatcher.test.js` — PASS (`15`/`15`).
- [x] `npm run sync:plugin:check` — PASS.
- [x] `cargo check --workspace` — PASS.
- [x] `npm pack --dry-run --json` — PASS after parsing mixed lifecycle output; produced `oh-my-codex-0.18.2.tgz`, `entryCount=2893`, `unpackedSize=21598080`, no `.omx` package leaks.
- [x] `git diff --check` — PASS.
- [x] `node dist/scripts/generate-release-body.js --template RELEASE_BODY.md --out /tmp/RELEASE_BODY.generated.md --current-tag v0.18.2 --previous-tag v0.18.1 --repo Yeachan-Heo/oh-my-codex` — PASS against a local annotated `v0.18.2` tag; generated body includes Contributors and the `v0.18.1...v0.18.2` changelog link.
- [x] `$code-review` final gate: APPROVE / CLEAR (code-reviewer APPROVE; architect CLEAR).

## CI / publish evidence

Promotion and publication proof:

- `dev` CI for shipped candidate `29e87a24a0ed354283604bfc1ba995d1245813c4`: PASS, GitHub Actions run `26334978724`.
- `main` CI after fast-forward merge to `29e87a24a0ed354283604bfc1ba995d1245813c4`: PASS, GitHub Actions run `26335226535`.
- `v0.18.2` release workflow for tag `29e87a24a0ed354283604bfc1ba995d1245813c4`: PASS, GitHub Actions run `26335367646`. The first attempt had a transient checkout credential failure in `Build native (aarch64-unknown-linux-gnu)`; rerunning failed jobs passed and the workflow completed successfully.
- GitHub release: `v0.18.2` is published, non-draft, non-prerelease, target `main`, with `57` assets including `native-release-manifest.json` and native archives/checksums.
- npm publication: `npm view oh-my-codex version dist-tags --json` returns version `0.18.2` and `latest: 0.18.2`.
- Final branch/tag state at publication: `origin/main`, `origin/dev`, local `HEAD`, and tag `v0.18.2^{}` all pointed to `29e87a24a0ed354283604bfc1ba995d1245813c4`.

Post-publish correction note: this section was filled after npm publication to replace pre-promotion placeholders with final evidence. The published npm provenance tag was not moved; this docs-only correction may intentionally make `main`/`dev` advance beyond the release tag after the correction is promoted.

## Known gaps

- #2428 and #2465 are closed `NOT_PLANNED`, not completed fixes. They are intentionally listed in the audit so the release does not claim they were merged.
