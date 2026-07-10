# oh-my-codex 0.20.0

`0.20.0` migrates the entire OMX model contract to OpenAI's GPT-5.6 generation (Sol/Terra/Luna).

## Highlights

- Frontier lane `gpt-5.6-sol`, standard lane `gpt-5.6-terra`, spark lane `gpt-5.6-luna` across runtime, agents, Rust crates, docs, prompts, skills, and the plugin mirror.
- Planner/architect exact `gpt-5.6-sol` pins (medium/xhigh); researcher exact `gpt-5.6-terra`; fast lanes on `gpt-5.6-luna`.
- Exact-model composition seam retargeted to `gpt-5.6-terra` with final-resolved-model precedence.
- Setup offers prompt-gated upgrades from legacy `gpt-5.3-codex` / `gpt-5.5` to `gpt-5.6-sol`.
- Autopilot classifies canonical Terra/Luna as cheap planning lanes.
- Doctor reports accurate Spark model sources including `models.team_low_complexity`.

## Compatibility

No breaking CLI, package, plugin-layout, or configuration changes. Existing explicit model overrides keep their semantics as opaque strings.

## Validation

Green dev CI, full node + Rust suites, three architect review rounds ending CLEAR/APPROVE, adversarial QA/red-team artifacts.

**Full Changelog**: [`v0.19.1...v0.20.0`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.19.1...v0.20.0)
