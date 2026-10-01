# Release inventory — 0.21.7

Frozen range: `v0.21.6..dev` (49 commits, 102 files changed, +7246/-642).

Frozen candidate: `38d27ed752d17f18690c43a2acc0f28c7a0e81ed`.

## Merged PRs

- [#3691](https://github.com/Yeachan-Heo/oh-my-codex/pull/3691): docs: clarify fresh config doctor evidence.
- [#3692](https://github.com/Yeachan-Heo/oh-my-codex/pull/3692): fix(team): make queued leader notices safe after shutdown.
- [#3693](https://github.com/Yeachan-Heo/oh-my-codex/pull/3693): fix(doctor): show resolved config path when missing.
- [#3694](https://github.com/Yeachan-Heo/oh-my-codex/pull/3694): fix(notifications): strip OSC terminal escapes.
- [#3696](https://github.com/Yeachan-Heo/oh-my-codex/pull/3696): build(deps): bump zod from 4.6.2 to 4.6.5.
- [#3697](https://github.com/Yeachan-Heo/oh-my-codex/pull/3697): build(deps-dev): bump @biomejs/biome from 2.5.13 to 2.5.14.
- [#3698](https://github.com/Yeachan-Heo/oh-my-codex/pull/3698): build(deps-dev): bump @types/node from 26.5.1 to 26.6.2.
- [#3699](https://github.com/Yeachan-Heo/oh-my-codex/pull/3699): fix(setup): keep non-Team guidance when Team is disabled (follow-up).
- [#3700](https://github.com/Yeachan-Heo/oh-my-codex/pull/3700): fix(setup): keep non-Team guidance when Team is disabled.
- [#3701](https://github.com/Yeachan-Heo/oh-my-codex/pull/3701): feat(models): recognize GPT-6 Sol and Luna.
- [#3704](https://github.com/Yeachan-Heo/oh-my-codex/pull/3704): fix: preserve foreign hook trust during legacy hook migration.
- [#3706](https://github.com/Yeachan-Heo/oh-my-codex/pull/3706): fix(hud): idle CPU verification and atomic hook metadata.
- [#3707](https://github.com/Yeachan-Heo/oh-my-codex/pull/3707): fix(#3707): add templates provenance check to plugin cache validation.
- [#3708](https://github.com/Yeachan-Heo/oh-my-codex/pull/3708): fix(#3707): plugin skill contract links resolve inside snapshot.
- [#3711](https://github.com/Yeachan-Heo/oh-my-codex/pull/3711): fix(question): preserve tmux question probe errors.
- [#3712](https://github.com/Yeachan-Heo/oh-my-codex/pull/3712): fix(config): preserve hashes in quoted TOML values.
- [#3713](https://github.com/Yeachan-Heo/oh-my-codex/pull/3713): build(deps): bump @modelcontextprotocol/sdk from 1.30.0 to 1.30.1.
- [#3714](https://github.com/Yeachan-Heo/oh-my-codex/pull/3714): build(deps-dev): bump @types/node from 26.6.2 to 26.6.3.
- [#3716](https://github.com/Yeachan-Heo/oh-my-codex/pull/3716): feat(models): add gpt-6.1-sol to model catalogs.
- [#3718](https://github.com/Yeachan-Heo/oh-my-codex/pull/3718): fix(#3717): remove worker runtime instructions from leader AGENTS.md.
- [#3720](https://github.com/Yeachan-Heo/oh-my-codex/pull/3720): fix(#3719): stop writing removed child_agents_md feature flag.
- [#3722](https://github.com/Yeachan-Heo/oh-my-codex/pull/3722): fix(#3721): native thread identity resolution for ralplan --advisory.
- [#3726](https://github.com/Yeachan-Heo/oh-my-codex/pull/3726): fix(#3725): distinguish matching-but-unverified selectors in bindings.
- [#3727](https://github.com/Yeachan-Heo/oh-my-codex/pull/3727): fix(#3723): include stderr summary in describeDetachedLeaderFailure.
- [#3728](https://github.com/Yeachan-Heo/oh-my-codex/pull/3728): fix(#3724): deliver exec follow-ups in session-scoped Stop path.
- [#3732](https://github.com/Yeachan-Heo/oh-my-codex/pull/3732): fix(#3731): omx exec --help no longer attempts session establishment.
- [#3734](https://github.com/Yeachan-Heo/oh-my-codex/pull/3734): fix(#3733): add 'ultragoal' to supported state read modes.

## Validation evidence

See `docs/qa/release-readiness-0.21.7.md` for the full verification record: typecheck, lint, plugin mirror sync, capabilities lock verification, prompt guidance, native agents, prompt inventory, and test suite results.
