# oh-my-codex 0.20.0 release notes

`0.20.0` migrates OMX's entire model contract to OpenAI's GPT-5.6 generation (Sol/Terra/Luna, publicly released 2026-07-09), replacing the `gpt-5.5` / `gpt-5.4-mini` / `gpt-5.3-codex-spark` lane trio, and rolls up the dev-branch fixes and features merged since `0.19.1`.

## Highlights

- Frontier lane resolves to `gpt-5.6-sol`, standard lane to `gpt-5.6-terra`, spark/fast lane to `gpt-5.6-luna` across runtime defaults, Codex agent defaults, Rust crates, docs, prompts, skills, and the plugin mirror.
- Sub-agent role allocation: planner (`gpt-5.6-sol`, medium) and architect (`gpt-5.6-sol`, xhigh) exact pins; researcher exact `gpt-5.6-terra`; standard worker/review roles on `gpt-5.6-terra`; explore/style-reviewer and team low-complexity workers on `gpt-5.6-luna`.
- The exact-model composition seam now keys off `gpt-5.6-terra` (trim-then-exact, case-sensitive) and takes precedence over role `exactModel` pins.
- Setup offers prompt-gated upgrades from legacy `gpt-5.3-codex` and `gpt-5.5` root models to `gpt-5.6-sol`; declined and non-interactive runs preserve the current model.
- Autopilot classifies canonical Terra/Luna as cheap lanes, routing heavy planning to the dedicated planner when the main model is Terra.
- Doctor reports accurate Spark model sources including `.omx-config.json models.team_low_complexity`.
- New `omx capabilities lock`/`check` CLI providing a manual capabilities-lockfile preflight command (#3087).
- Project setup defaults to plugin mode with a plugin cache (#3085); plugin hooks gated to omx-launched sessions (#3086); resume plugin preflight opt-in (#3088).
- Persisted subagents reopen on SessionStart (#3099); canonical worktree tool context (#3102).

## Merged PRs since v0.19.1

#3079 (conductor deadlock without native subagents), #3080 (resume updated-sort mtimes), #3082 (plugin Stop hook last-line JSON), #3085 (project setup plugin mode default), #3086 (plugin hooks gated to omx sessions), #3087 (capabilities lockfile preflight), #3088 (resume plugin preflight opt-in), #3091 (deep-interview runtime state allowlist), #3092 (terminal deep-interview state normalization), #3094 (ralplan approval handoff and lane reuse), #3097 (ralplan handoff goal derivation guard), #3099 (reopen persisted subagents on SessionStart), #3100 (structured ultragoal steering cleanup), #3102 (canonical worktree tool context), #3104 (GPT-5.6 model aliases), plus the direct GPT-5.6 migration commits `3e579633`, `0ac484e0`, `51ee0c28`.

## Compatibility

- Existing explicit model overrides (including prior-generation names) keep working as opaque strings; no closed allow-list is enforced.
- Project-scoped `omx setup` now defaults to plugin install mode with a plugin cache (#3085); legacy installs remain supported.
- Plugin hooks only activate for omx-launched sessions (#3086).
- Fresh `gpt-5.6-sol` managed configs keep the `model_context_window = 250000` / `model_auto_compact_token_limit = 200000` seeding recommendations.

## Validation

Release readiness evidence is recorded in `docs/qa/release-readiness-0.20.0.md`. Full node suite (370/371; the single failure is a pre-existing macOS-only GNU `stat -c` test-environment issue, reproduced on the previous release commit — CI runs Linux where it passes), full Rust workspace suite (237/237), three architect review rounds on the migration ending CLEAR/APPROVE, adversarial QA/red-team runs with CLI replay artifacts, green dev and main CI on the release commit, and a successful tag-triggered release workflow with native assets and npm publication.

## Full changelog

[`v0.19.1...v0.20.0`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.19.1...v0.20.0)
