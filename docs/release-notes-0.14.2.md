# Release notes — 0.14.2

## Summary

`0.14.2` is a patch release after `0.14.1` focused on fast-follow operator reliability: safer `omx question` behavior outside attached tmux panes, duplicate MCP sibling self-cleanup after idle, tighter deep-interview state/intent handling, Korean IME drift for the `ulw` shorthand, shared tmux answer-submit semantics for `omx question`, clearer deep-interview background-question guidance, and the TypeScript/Biome toolchain refresh that landed on `dev`.

## Highlights

- **`omx question` now fails closed when no visible tmux renderer exists** — outside an attached tmux pane, OMX now returns a clear operator-facing error instead of silently creating a detached tmux session.
- **Duplicate MCP siblings now clean themselves up after idle** — older same-parent stdio duplicates can self-exit after a safe post-traffic idle window, reducing stale MCP server buildup.
- **Deep-interview clear/read behavior is safer** — session-scoped mode clears now leave an inactive session tombstone when needed so legacy root fallback state does not immediately reactivate the mode, and failed question launches clear pending deep-interview obligations.
- **Korean `ulw` keyboard drift now routes correctly** — prompts typed as `ㅕㅣㅈ` on a Korean 2-set keyboard normalize to the existing `ulw` ultrawork shorthand before keyword activation.
- **`omx question` answer injection reuses shared tmux submit semantics** — question-answer injection now goes through the same `buildSendPaneArgvs` path as reply-listener pane injection, preserving literal text delivery, isolated `C-m` submits, and newline sanitization.
- **Deep-interview guidance now closes the background-terminal gap** — shipped guidance explicitly tells agents to wait for background `omx question` terminals to finish and read the JSON answer before continuing the interview, while keyword routing now avoids activating deep-interview from cleanup/state-management mentions alone.
- **Tooling baselines are current** — TypeScript is refreshed to `6.0.3`, Biome lockfile metadata is refreshed to `2.4.12`, and `tsconfig.json` pins Node ambient types for the TS 6 build path.

## Fixed

- Question rendering outside attached tmux now fails visibly instead of spawning an unseen detached renderer.
- Stale duplicate MCP siblings now self-exit after safe post-traffic idle rather than accumulating under one parent.
- Session-scoped deep-interview clears now stay cleared even when a legacy root fallback file exists.
- Failed deep-interview question launches now clear pending question obligations.
- Korean IME typo activation for the `ulw` ultrawork shorthand.
- Question-answer submission drift between `src/question/renderer.ts` and the shared tmux pane-send helper.
- Deep-interview prompt/template/hook guidance around background `omx question` execution.
- Release metadata and lockfile synchronization to `0.14.2`.

## Verification evidence

Release verification evidence is recorded in `docs/qa/release-readiness-0.14.2.md`.

- `$code-review` over `v0.14.1..Yeachan-Heo/dev`: code-reviewer **COMMENT** and architect **WATCH** on follow-up boundary cleanup; no blocking findings accepted for release.
- Latest-scope local review of the same range found no release-blocking correctness regressions across question, state, MCP, or keyword-detector changes.
- `npm run lint` ✅
- `npm test` ✅
- `cargo test -p omx-explore-harness -p omx-sparkshell` ✅
- `npm pack --dry-run` ✅

## Remaining risk

- This is a local release-readiness pass rather than a full CI matrix rerun.
- The code-review architect lane flagged non-blocking WATCH concerns: the cleared-session tombstone helper is duplicated across CLI and MCP state paths, detached question-renderer code remains as a retained legacy branch, MCP duplicate cleanup still relies on conservative process/timing heuristics, and the deep-interview instruction remains duplicated across shipped guidance surfaces.
- The highest-value post-release observation surface is still real tmux / reused-session behavior around `omx question`, prompt submission, workflow/state clearing, duplicate MCP sibling cleanup, and workflow activation from multilingual input.
