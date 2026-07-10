# oh-my-codex 0.20.0

`0.20.0` migrates the entire OMX model contract to OpenAI's GPT-5.6 generation (Sol/Terra/Luna) and rolls up the dev-branch fixes and features merged since `0.19.1`.

## Highlights

- Frontier lane `gpt-5.6-sol`, standard lane `gpt-5.6-terra`, spark lane `gpt-5.6-luna` across runtime, agents, Rust crates, docs, prompts, skills, and the plugin mirror.
- Planner/architect exact `gpt-5.6-sol` pins (medium/xhigh); researcher exact `gpt-5.6-terra`; fast lanes on `gpt-5.6-luna`.
- Exact-model composition seam retargeted to `gpt-5.6-terra` with final-resolved-model precedence.
- Setup offers prompt-gated upgrades from legacy `gpt-5.3-codex` / `gpt-5.5` to `gpt-5.6-sol`.
- Autopilot classifies canonical Terra/Luna as cheap planning lanes.
- Doctor reports accurate Spark model sources including `models.team_low_complexity`.
- New `omx capabilities lock`/`check` CLI providing a manual capabilities-lockfile preflight command (#3087).
- Project setup defaults to plugin mode with plugin cache (#3085); plugin hooks gated to omx-launched sessions (#3086); resume plugin preflight opt-in (#3088).
- Persisted subagents reopen on SessionStart (#3099); canonical worktree tool context (#3102).

## Merged PRs since v0.19.1

#3079, #3080, #3082, #3085, #3086, #3087, #3088, #3091, #3092, #3094, #3097, #3099, #3100, #3102, #3104, plus direct migration commits `3e579633`, `0ac484e0`, `51ee0c28`.

## Compatibility

No breaking CLI or package-layout changes. Existing explicit model overrides keep their semantics as opaque strings. Project-scoped setup now defaults to plugin install mode (#3085) and plugin hooks activate only for omx-launched sessions (#3086).

## Validation

Green dev and main CI, full node + Rust suites, three architect review rounds ending CLEAR/APPROVE, adversarial QA/red-team artifacts; readiness evidence in `docs/qa/release-readiness-0.20.0.md`.

## Contributors

Thanks to the contributors who made this release possible.

**Full Changelog**: [`v0.19.1...v0.20.0`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.19.1...v0.20.0)
