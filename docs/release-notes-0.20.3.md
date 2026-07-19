# oh-my-codex 0.20.3 release notes

Release date: 2026-07-19

`0.20.3` is a patch release covering the exact frozen range `v0.20.2..f967cfed64ec57614af136f75d7cb81509808f7e`. It contains 13 merged product PRs (one additive, backward-compatible feature plus reliability and workflow-safety fixes), four v0.20.2 post-publish evidence corrections carried forward, and one release-development preparation commit.

## Highlights

- **Max per-agent reasoning effort** — reasoning effort can now be capped per agent through the team model contract, giving finer control over model behavior across a team (#3143).
- **Team exact live-pane authority** — Team validates exact live tmux panes before applying explicit lifecycle effects and preserves pane ownership through startup, scaling, rollback, recovery, and teardown. Membership and scaling transactions are durable and failure-atomic, teardown/recovery authority is replayable, and notify dispatch is bound to the owning worker pane pid (#3153; issue #3121).
- **Ralplan review integrity** — Ralplan requires strict direct review order, fails closed when leader proof is not documented, attests the reconciled leader in `PreToolUse`, and resolves the App leader-proof regression by parsing collaboration results structurally. Together these close ambiguous-authority and live-exec regression paths in the planning workflow (#3186, #3196, #3187, #3218; issues #3194, #3181, #3204).
- **Team mailbox and session recovery** — mailbox wakeups are coalesced with every wake acknowledged (#3217; issue #3195), and exact session pointer lock recovery is added (#3215; issue #3203).
- **Native hook and configuration safety** — native child write identity is hardened across the native hook, code-intel, and wiki MCP surfaces (#3135; issue #3127), and the configuration generator reconciles duplicate project trust tables idempotently (#3201; issue #3199).
- **Plugin and platform robustness** — the plugin native hook returns structured responses for oversized tool-hook payloads (#3211), and regular-file `fsync` `EPERM` is tolerated on Windows across hooks, uninstall, and the native hook (#3191).

## Other fixes

- Isolated standard launches are documented in both the CLI and the README (#3192).

## Release collateral

- `1c007fff`, `122b0cba`, `fb13a6db`, and `0a7baa81` are v0.20.2 post-publish evidence corrections carried forward into this range; they are release-collateral inventory only, not 0.20.3 product headlines.
- `4b557d13` began 0.20.3 development and synchronized version metadata; it is release preparation only.

## Merged PR inventory

The merged product PR set is #3135, #3143, #3153, #3186, #3187, #3191, #3192, #3196, #3201, #3211, #3215, #3217, and #3218. Associated issues #3121, #3127, #3181, #3194, #3195, #3199, #3203, and #3204 are not additional PRs. The remaining commits in the 99-commit range are the squashed-in constituents of PRs #3153, #3196, #3215, #3217, and #3218. Reproduce the inventory with:

```sh
git log --reverse --format='%H%x09%s' v0.20.2..f967cfed64ec57614af136f75d7cb81509808f7e
```

A full commit-level classification is in `artifacts/release-0.20.3/inventory.md`.

## Compatibility

Patch release with no intentional breaking CLI or package-layout changes. The one feature (#3143) is additive and backward-compatible.

## Validation

Local build, lint, typecheck, plugin-bundle, native-agents, and Node test gates for the touched surface are recorded in `docs/qa/release-readiness-0.20.3.md`. External CI, tag, GitHub release, and npm publication evidence is recorded in that same readiness record as the publish sequence completes.

## Contributors

Thanks to Bellman (@Yeachan-Heo) for the commits in this range.

**Full Changelog**: [`v0.20.2...v0.20.3`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.20.2...v0.20.3)
