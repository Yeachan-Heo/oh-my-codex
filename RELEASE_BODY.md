# oh-my-codex 0.21.12

`0.21.12` is a patch release for the frozen range `v0.21.11..6937884f4d09a485d5b4f16498517bcd05384e06` (6 commits, 15 files, +998/−19).

## Highlights

- **Claim-bound completion evidence (#3797):** implementation tasks marked `requires_code_change: true` now require a report tied to the active task claim and a structured verification summary before completion. Existing clients must supply that evidence; tasks without the flag and transitions to `failed` retain their previous behavior.
- **More reliable HUD updates (#3786, #3791):** watcher repair children are bounded so hung reconciliation cannot block later repairs, and git branch labels are cached until HEAD, refs, or git config changes.
- **Dependency update (#3794):** update `@modelcontextprotocol/sdk` from 1.32.0 to 1.32.1.

## Fixes and compatibility

- Implementation-task clients completing tasks marked `requires_code_change: true` must write claim-bound evidence under `.omx/evidence/` and include a structured verification summary and evidence marker. Non-code-change tasks and failed transitions do not require a report (#3797).
- No breaking CLI or package-layout changes are included. HUD test fixture isolation improvements are covered by #3788 and #3789.

## Validation evidence

Frozen candidate `6937884f4d09a485d5b4f16498517bcd05384e06` is green on dev CI. Local build, typecheck, and relevant test results are recorded in `docs/qa/release-readiness-0.21.12.md`.

Full readiness evidence: `docs/qa/release-readiness-0.21.12.md`.

## Merged PR inventory

| PR | Author | Title |
|---|---|---|
| [#3786](https://github.com/Yeachan-Heo/oh-my-codex/pull/3786) | @spicysharkco | fix(hud): bound the watcher repair child so a hung reconcile cannot block repairs |
| [#3788](https://github.com/Yeachan-Heo/oh-my-codex/pull/3788) | @spicysharkco | test(hud): put the real-tmux test socket under tmpdir |
| [#3789](https://github.com/Yeachan-Heo/oh-my-codex/pull/3789) | @spicysharkco | test(hud): make the adaptive-budget resize watch test hermetic |
| [#3791](https://github.com/Yeachan-Heo/oh-my-codex/pull/3791) | @spicysharkco | perf(hud): cache the git branch label until HEAD, refs or git config change |
| [#3794](https://github.com/Yeachan-Heo/oh-my-codex/pull/3794) | @dependabot | build(deps): bump @modelcontextprotocol/sdk from 1.32.0 to 1.32.1 |
| [#3797](https://github.com/Yeachan-Heo/oh-my-codex/pull/3797) | @shenyankm | feat(team): Require completion evidence for implementation tasks |

## Contributors

Thanks to @spicysharkco, @shenyankm, and @dependabot.

## Inventory

The reproducible range is recorded in `artifacts/release-0.21.12/inventory.md`.

**Full Changelog**: [`v0.21.11...v0.21.12`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.11...v0.21.12)
