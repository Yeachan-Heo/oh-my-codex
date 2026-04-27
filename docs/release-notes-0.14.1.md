# Release notes — 0.14.1

## Summary

`0.14.1` is a patch release after `0.14.0` focused on reliability follow-through for the new interactive orchestration surfaces: deep-interview question enforcement, `omx question` tmux rendering, update/setup refresh behavior, stop/lifecycle normalization, and a smaller round of guidance/CI hardening.

## Highlights

- **Pending deep-interview question obligations now block Stop correctly** — even when the mode already marked itself inactive, OMX still treats the pending structured question as a blocking obligation.
- **Question panes are more resilient across tmux environments** — non-POSIX shells, missing panes, and detached-session startup failures now fail closed instead of silently leaving a dead question UI behind.
- **Setup refresh is easier to recover** — explicit `omx update` can refresh setup state even when the installed version is already current, and advisory update-state write failures no longer block the refresh path.
- **Lifecycle compatibility code is centralized** — terminal lifecycle helpers now reuse the shared runtime run-outcome contract instead of carrying a parallel normalization implementation.
- **Review/explore guidance stays aligned with current defaults** — the code-review skill is stronger, and lightweight fallback lanes remain intentionally lean.

## Fixed

- Deep-interview Stop gating around pending question obligations.
- Question renderer/session liveness and answer-submission reliability in tmux/Codex panes.
- Postinstall/setup refresh rooting and explicit-update stale-setup retry behavior.
- Stale Ralph / skill-active / ultrawork Stop leakage across sessions.
- Release metadata and lockfile synchronization to `0.14.1`.

## Verification evidence

Release verification evidence is recorded in `docs/qa/release-readiness-0.14.1.md`.

- `npm test` ✅
- `cargo test -p omx-explore-harness -p omx-sparkshell` ✅
- `npm pack --dry-run` ✅

## Remaining risk

- This is a local release-readiness pass rather than a full CI matrix rerun.
- The most valuable post-release observation surface remains real multi-session tmux/operator behavior around `omx question`, Stop gating, and upgraded-install setup refresh flows.
