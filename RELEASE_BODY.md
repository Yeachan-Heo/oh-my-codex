# oh-my-codex 0.20.3

`0.20.3` is a patch release for the reliability and workflow-safety work in the exact range `v0.20.2..f967cfed64ec57614af136f75d7cb81509808f7e`, plus one additive, backward-compatible feature.

## Highlights

- Reasoning effort can be capped per agent through the team model contract (#3143).
- Team validates exact live tmux panes before explicit lifecycle effects and preserves pane ownership through startup, scaling, rollback, recovery, and teardown, with durable failure-atomic membership/scaling transactions and pane-pid-bound notify dispatch (#3153; issue #3121).
- Ralplan requires strict direct review order, fails closed without documented leader proof, attests the reconciled leader in `PreToolUse`, and resolves the App leader-proof regression by parsing collaboration results structurally (#3186, #3196, #3187, #3218; issues #3194, #3181, #3204).
- Team mailbox wakeups are coalesced with every wake acknowledged (#3217; issue #3195), and exact session pointer lock recovery is added (#3215; issue #3203).
- Native child write identity is hardened across the native hook, code-intel, and wiki MCP surfaces (#3135; issue #3127), and the configuration generator reconciles duplicate project trust tables idempotently (#3201; issue #3199).
- The plugin native hook returns structured responses for oversized tool-hook payloads (#3211), and Windows regular-file `fsync` `EPERM` is tolerated across hooks, uninstall, and the native hook (#3191).

## Additional fixes

- Isolated standard launches are documented in the CLI and README (#3192).

## Release collateral

- `1c007fff`, `122b0cba`, `fb13a6db`, and `0a7baa81` are v0.20.2 post-publish evidence corrections carried forward; they are release-collateral inventory only. `4b557d13` is the 0.20.3 version-development preparation commit.

## Merged PRs since v0.20.2

#3135, #3143, #3153, #3186, #3187, #3191, #3192, #3196, #3201, #3211, #3215, #3217, #3218. Issues #3121, #3127, #3181, #3194, #3195, #3199, #3203, and #3204 are associated issues, not additional PRs.

## Compatibility

Patch release with no intentional breaking CLI or package-layout changes; the one feature (#3143) is additive and backward-compatible.

## Validation

Local build, lint, typecheck, plugin-bundle, native-agents, and Node test gates for the touched surface are recorded in `docs/qa/release-readiness-0.20.3.md`. External CI, tag, GitHub release, and npm provenance publication evidence is recorded in that same readiness record as the publish sequence completes.

## Contributors

Thanks to Bellman (@Yeachan-Heo) for commits in this range.

**Full Changelog**: [`v0.20.2...v0.20.3`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.20.2...v0.20.3)
