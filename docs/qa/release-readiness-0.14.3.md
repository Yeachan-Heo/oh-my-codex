# Release Readiness Verdict - 0.14.3

Date: 2026-04-22
Target version: **0.14.3**
Base: `v0.14.2`
Candidate branch: `release/0.14.3`

## Scope

`0.14.3` packages the `v0.14.2..dev` patch train: question/deep-interview pane-return reliability, project-local `CODEX_HOME` launch resolution for explore, setup TOML root-entry repair, HUD reconcile window targeting, deep-interview summary gates and stale-answer reconciliation, ultrawork protocol sync, BusyBox cleanup compatibility, stale Stop/autopilot loop prevention, canonical runtime supervisor events, Docker-host tmux question bridging, and native Windows psmux worker pane bootstrap hardening.

## Changed execution paths reviewed

- `src/question/*` — question renderer strategy, answer injection, state, UI, and deep-interview enforcement reconciliation.
- `src/hooks/*` / `src/scripts/*` — keyword/state guidance, native hook Stop/operational event handling, and runtime dispatch notifications.
- `src/team/*` / `src/hud/*` — tmux worker startup, psmux/Windows handling, HUD resize/reconcile targeting, and canonical team/runtime events.
- `src/cli/*` — cleanup process discovery, explore/project-local Codex home launch context, and CLI command routing.
- `src/config/generator.ts` — setup config merge/repair for multiline root TOML strings and launcher timeout repair.
- `skills/deep-interview/SKILL.md`, `skills/ultrawork/SKILL.md`, docs/contracts — operator guidance and runtime-event contract updates.
- Release collateral — `package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`, `CHANGELOG.md`, `RELEASE_BODY.md`, and these release notes/readiness docs aligned to `0.14.3`.

## Verification evidence

| Gate | Command | Result |
| --- | --- | --- |
| Full Node/build/catalog suite | `npm test` | PASS — 3910 tests, 0 failed; catalog check ok |
| Type unused gate | `npm run check:no-unused` | PASS |
| Rust workspace tests | `cargo test --workspace` | PASS |
| Lint gate | `npm run lint` | PASS |
| TypeScript build | `npm run build` | PASS |
| Changed-path targeted suites | `node --test dist/cli/__tests__/cleanup.test.js dist/cli/__tests__/explore.test.js dist/cli/__tests__/index.test.js dist/cli/__tests__/question.test.js dist/config/__tests__/generator-idempotent.test.js dist/hooks/__tests__/clawhip-event-contract.test.js dist/hooks/__tests__/deep-interview-contract.test.js dist/hooks/__tests__/keyword-detector.test.js dist/hooks/__tests__/skill-guidance-contract.test.js dist/hooks/extensibility/__tests__/events.test.js dist/hud/__tests__/reconcile.test.js dist/question/__tests__/deep-interview.test.js dist/question/__tests__/renderer.test.js dist/question/__tests__/state.test.js dist/question/__tests__/ui.test.js dist/scripts/__tests__/codex-native-hook.test.js dist/scripts/notify-hook/__tests__/operational-events.test.js dist/team/__tests__/events.test.js dist/team/__tests__/runtime.test.js dist/team/__tests__/tmux-session.test.js` | PASS |

## Known limits

- External push/npm/GitHub release publication depends on local credentials and network availability outside the repository evidence.

## Verdict

Release **0.14.3** is **ready for release commit/tag cut** after the metadata bump and verification gates above. It is safe to merge `release/0.14.3` into `dev` and `main` and create tag `v0.14.3`.
