# oh-my-codex 0.20.0 release notes

`0.20.0` migrates OMX's entire model contract to OpenAI's GPT-5.6 generation (Sol/Terra/Luna, publicly released 2026-07-09), replacing the `gpt-5.5` / `gpt-5.4-mini` / `gpt-5.3-codex-spark` lane trio.

## Highlights

- Frontier lane resolves to `gpt-5.6-sol`, standard lane to `gpt-5.6-terra`, spark/fast lane to `gpt-5.6-luna` across runtime defaults, Codex agent defaults, Rust crates, docs, prompts, skills, templates, and the plugin mirror.
- Sub-agent role allocation: planner (`gpt-5.6-sol`, medium) and architect (`gpt-5.6-sol`, xhigh) exact pins; researcher exact `gpt-5.6-terra`; standard worker/review roles on `gpt-5.6-terra`; explore/style-reviewer and team low-complexity workers on `gpt-5.6-luna`.
- The exact-model composition seam now keys off `gpt-5.6-terra` (trim-then-exact, case-sensitive) and takes precedence over role `exactModel` pins.
- Setup offers prompt-gated upgrades from legacy `gpt-5.3-codex` and `gpt-5.5` root models to `gpt-5.6-sol`; declined and non-interactive runs preserve the current model.
- Autopilot classifies canonical Terra/Luna as cheap lanes, routing heavy planning to the dedicated planner when the main model is Terra.
- Doctor reports accurate Spark model sources including `.omx-config.json models.team_low_complexity`.

## Compatibility

- Existing explicit model overrides (including prior-generation names) keep working as opaque strings; no closed allow-list is enforced.
- No CLI, package, plugin-layout, or configuration schema changes.
- Fresh `gpt-5.6-sol` managed configs keep the `model_context_window = 250000` / `model_auto_compact_token_limit = 200000` seeding recommendations.

## Validation

Full node suite (370/371; the single failure is a pre-existing macOS-only GNU `stat -c` test-environment issue, reproduced on the previous release commit), full Rust workspace suite (237/237), three architect review rounds ending CLEAR/APPROVE, and adversarial QA/red-team runs with CLI replay artifacts.

## Full changelog

[`v0.19.1...v0.20.0`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.19.1...v0.20.0)
