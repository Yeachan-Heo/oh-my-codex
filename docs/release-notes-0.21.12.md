# oh-my-codex 0.21.12

`0.21.12` is a patch release for the frozen range `v0.21.11..6937884f4d09a485d5b4f16498517bcd05384e06` (6 commits, 15 files, +998/−19).

Versioning: this release continues the established 0.21.x patch train. It adds a claim-bound evidence requirement only for implementation tasks explicitly marked `requires_code_change: true`; no CLI command, envelope version, or package layout changes are included. Clients completing those tasks must adapt to the documented evidence contract.

## Highlights

- **Claim-bound implementation completion evidence (#3797):** tasks marked `requires_code_change: true` require a report associated with the active claim and a structured verification summary before completion. The report is validated for identity, path, freshness, and content; it does not authenticate whether reported commands actually ran. Authored by @shenyankm.
- **More reliable HUD watcher repair (#3786):** a hung reconciliation child is bounded so later watcher ticks can repair state. Authored by @spicysharkco.
- **Cached HUD branch labels (#3791):** the git branch label is cached until HEAD, refs, or git config changes. Authored by @spicysharkco.

## Fixes and compatibility

- Existing clients completing a task with `requires_code_change: true` must write a non-empty JSON report under the assigned worker's `.omx/evidence/` directory, bind it to the current claim using the claim-token SHA-256, provide a structured verification summary, and include the evidence marker when transitioning to completed. Invalid evidence leaves the task in progress so the client can correct and retry.
- Tasks without the `requires_code_change: true` flag and transitions to `failed` retain their prior behavior. CLI operation names, the JSON envelope schema version, and the successful transition shape are unchanged.
- HUD watcher tests now use hermetic temporary resources (#3788, #3789; authored by @spicysharkco).
- Update `@modelcontextprotocol/sdk` from 1.32.0 to 1.32.1 (#3794; @dependabot).
- No package-layout change is included.

## Merged PR inventory

| PR | Author | Title |
|---|---|---|
| [#3786](https://github.com/Yeachan-Heo/oh-my-codex/pull/3786) | @spicysharkco | fix(hud): bound the watcher repair child so a hung reconcile cannot block repairs |
| [#3788](https://github.com/Yeachan-Heo/oh-my-codex/pull/3788) | @spicysharkco | test(hud): put the real-tmux test socket under tmpdir |
| [#3789](https://github.com/Yeachan-Heo/oh-my-codex/pull/3789) | @spicysharkco | test(hud): make the adaptive-budget resize watch test hermetic |
| [#3791](https://github.com/Yeachan-Heo/oh-my-codex/pull/3791) | @spicysharkco | perf(hud): cache the git branch label until HEAD, refs or git config change |
| [#3794](https://github.com/Yeachan-Heo/oh-my-codex/pull/3794) | @dependabot | build(deps): bump @modelcontextprotocol/sdk from 1.32.0 to 1.32.1 |
| [#3797](https://github.com/Yeachan-Heo/oh-my-codex/pull/3797) | @shenyankm | feat(team): Require completion evidence for implementation tasks |

## Validation evidence

The frozen candidate `6937884f4d09a485d5b4f16498517bcd05384e06` passed dev CI. Local build, typecheck, and focused test results are recorded in `docs/qa/release-readiness-0.21.12.md`.

## Contributors

Thanks to @spicysharkco, @shenyankm, and @dependabot.

## Inventory

The reproducible range is recorded in `artifacts/release-0.21.12/inventory.md`.

**Full Changelog**: [`v0.21.11...v0.21.12`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.11...v0.21.12)
