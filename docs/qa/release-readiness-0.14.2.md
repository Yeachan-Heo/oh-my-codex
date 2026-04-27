# Release Readiness Verdict - 0.14.2

Date: **2026-04-21**
Target version: **0.14.2**
Comparison base: **`v0.14.1..dev`**
Verdict: **GO** ✅

`0.14.2` packages the post-`0.14.1` fast-follow patch train: Korean IME drift handling for the `ulw` ultrawork shorthand, shared tmux answer-submit semantics for `omx question`, fail-closed question rendering outside attached tmux panes, background-question guidance for deep-interview, duplicate MCP sibling idle self-cleanup, session-scoped clear tombstones that suppress stale root fallback state, TypeScript/Biome baseline refresh, and release collateral alignment.

## Scope reviewed

### Keyword routing / workflow activation
- `src/hooks/keyword-detector.ts` — narrow Korean 2-set typo normalization from `ㅕㅣㅈ` to the existing `ulw` ultrawork shorthand before activation.
- `src/hooks/__tests__/keyword-detector.test.ts`, `src/scripts/__tests__/codex-native-hook.test.ts` — regression coverage for direct detection, explicit `$ㅕㅣㅈ`, prompt-submit activation, mixed workflow persistence, and active-workflow override behavior.

### Question / deep-interview behavior
- `src/question/renderer.ts` — question-answer injection now reuses `buildSendPaneArgvs` for literal text delivery, isolated `C-m` submit calls, and shared newline sanitization.
- `src/question/renderer.ts`, `src/cli/__tests__/question.test.ts`, `src/question/__tests__/renderer.test.ts` — `omx question` now fails closed outside attached tmux and proves it does not create detached tmux sessions when no visible renderer exists.
- `src/question/__tests__/renderer.test.ts` — regression coverage asserts question injection matches shared tmux argv construction.
- `skills/deep-interview/SKILL.md`, `templates/AGENTS.md`, `src/scripts/codex-native-hook.ts` — deep-interview guidance now requires waiting for background `omx question` terminals to finish and reading the JSON answer before continuing.
- `src/question/__tests__/deep-interview.test.ts` — failed question-renderer launches now clear pending deep-interview question obligations instead of leaving stale enforcement state behind.
- `src/hooks/__tests__/deep-interview-contract.test.ts`, `src/scripts/__tests__/codex-native-hook.test.ts` — contract coverage for the shipped guidance.

### Session-scoped state / lifecycle behavior
- `src/state/operations.ts`, `src/mcp/state-server.ts` — session-scoped clears now write an inactive `current_phase: "cleared"` tombstone when a legacy root fallback state file exists, preventing stale root state from reappearing as active.
- `src/state/__tests__/operations.test.ts`, `src/mcp/__tests__/state-server.test.ts`, `src/cli/__tests__/session-scoped-runtime.test.ts` — parity coverage proves cleared session scope stays inactive across CLI, MCP, and status/read surfaces.

### MCP duplicate lifecycle behavior
- `src/mcp/bootstrap.ts` — duplicate sibling cleanup timing is now env-configurable and older duplicate stdio siblings can self-exit after safe post-duplicate idle rather than only before handling any traffic.
- `src/mcp/__tests__/bootstrap.test.ts`, `src/mcp/__tests__/server-lifecycle.test.ts` — regression coverage proves the older duplicate exits after post-duplicate idle while the newest sibling remains alive.

### Tooling / release metadata
- `package.json`, `package-lock.json`, `tsconfig.json` — TypeScript 6.0.3 baseline and explicit Node ambient types.
- `Cargo.toml`, `Cargo.lock`, `CHANGELOG.md`, `RELEASE_BODY.md`, `docs/release-notes-0.14.2.md` — release metadata and notes aligned to `0.14.2`.

## Code review evidence

`$code-review` was refreshed against `git diff v0.14.1..Yeachan-Heo/dev` after `dev` advanced during release prep:

| Lane | Result | Blocking? |
|---|---|---|
| code-reviewer | **COMMENT** — no blocking findings; LOW concerns on broad Korean typo normalization and retained detached-renderer strategy branch | No |
| local latest-scope synthesis | **COMMENT** — no correctness or release-blocking regressions found across question, state, MCP, or keyword-detector fast-follow changes | No |
| architect | **WATCH** — non-blocking boundary-drift concerns around duplicated cleared-session tombstone helpers, retained detached-renderer branch ambiguity, heuristic duplicate-sibling timing, and duplicated deep-interview prose contracts | No |
| final synthesis | **COMMENT** — release accepted with documented follow-up cleanup risks | No release blocker accepted for this patch cut |

## Validation evidence

| Check | Command | Result |
|---|---|---|
| Lint gate | `npm run lint` | PASS |
| Full Node build/test/catalog gate | `npm test` | PASS |
| Native crates | `cargo test -p omx-explore-harness -p omx-sparkshell` | PASS |
| Publish-path packaging | `npm pack --dry-run` | PASS |

## Risk assessment

- The code-review WATCH items are maintainability risks rather than correctness or security blockers. They should be considered for follow-up cleanup: state-clear tombstone writing is duplicated in both CLI and MCP paths, detached renderer semantics are retained but no longer selected in normal strategy resolution, and deep-interview prose contracts are still repeated across shipped guidance surfaces.
- The TypeScript major upgrade is broader than the runtime behavior fixes, but the release gate includes a full Node build/test/catalog pass and package dry run.
- Duplicate MCP sibling cleanup still relies on conservative same-parent/process-age/timing heuristics, but the new lifecycle coverage proves the intended idle self-exit path.
- GitHub Actions release and npm publish remain delegated to the tag-triggered release workflow.

## Final verdict

Release **0.14.2** is **ready for release commit/tag cut from `dev`** on the basis of the passing review and validation evidence above.
