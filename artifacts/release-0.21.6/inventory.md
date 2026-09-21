# Release inventory — 0.21.6

Frozen range: `v0.21.5..dev` (52 commits, 101 files changed, +4294/-707).

Frozen candidate: `750fdd08ef6b902c8ac9bb4f48d440ead87f6d12`.

## Merged PRs

- [#3634](https://github.com/Yeachan-Heo/oh-my-codex/pull/3634): close remaining 0.21 capability-parity documentation gaps.
- [#3648](https://github.com/Yeachan-Heo/oh-my-codex/pull/3648): keep ordinary requests out of optional workflow machinery.
- [#3649](https://github.com/Yeachan-Heo/oh-my-codex/pull/3649): remove confirmed unused internal exports without adding new machinery.
- [#3660](https://github.com/Yeachan-Heo/oh-my-codex/pull/3660): skip stale Team leader panes during tmux HUD reconciliation.
- [#3661](https://github.com/Yeachan-Heo/oh-my-codex/pull/3661): survive Windows `EPERM` fsync during Team startup.
- [#3662](https://github.com/Yeachan-Heo/oh-my-codex/pull/3662): harden auth storage, TOML boundaries, PATH resolution, and stderr redaction.
- [#3663](https://github.com/Yeachan-Heo/oh-my-codex/pull/3663): reusable default-model cost/quality evaluation suite (issue #3655).
- [#3665](https://github.com/Yeachan-Heo/oh-my-codex/pull/3665): deterministic evaluation stage-transition records and reporting.
- [#3666](https://github.com/Yeachan-Heo/oh-my-codex/pull/3666): allow supplied-record evaluation reports without deterministic baselines.
- [#3667](https://github.com/Yeachan-Heo/oh-my-codex/pull/3667): clarify Astra evaluation declarations and validation limits.
- [#3668](https://github.com/Yeachan-Heo/oh-my-codex/pull/3668): strip complete ANSI CSI sequences in notifications.
- [#3673](https://github.com/Yeachan-Heo/oh-my-codex/pull/3673), [#3674](https://github.com/Yeachan-Heo/oh-my-codex/pull/3674), [#3675](https://github.com/Yeachan-Heo/oh-my-codex/pull/3675): dependency updates (`zod` 4.6.2, `@biomejs/biome` 2.5.13, `@types/node` 26.5.1).
- [#3676](https://github.com/Yeachan-Heo/oh-my-codex/pull/3676): stop oversized stderr suppression from eating the next auth record.
- [#3678](https://github.com/Yeachan-Heo/oh-my-codex/pull/3678): stop duplicating durable AGENTS content into session instructions.
- [#3680](https://github.com/Yeachan-Heo/oh-my-codex/pull/3680): skip non-directory entries when draining Team dispatch.
- [#3683](https://github.com/Yeachan-Heo/oh-my-codex/pull/3683): stop orphan HUD watchers and silence reconcile failures.
- [#3684](https://github.com/Yeachan-Heo/oh-my-codex/pull/3684): preserve global AGENTS in project scope at launch.
- [#3685](https://github.com/Yeachan-Heo/oh-my-codex/pull/3685): close the HUD when its tmux leader pane exits.

## Validation evidence

See `docs/qa/release-readiness-0.21.6.md` for the full verification record: exact-candidate `dev` CI, local release-worktree gates, and publication proof.
