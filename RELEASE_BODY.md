# oh-my-codex 0.18.7

`0.18.7` is a patch release after `0.18.6` for the runtime reliability train that landed on `dev`. It focuses on preventing duplicate UI/HUD panes, preserving HUD ownership across native tmux session replacement, hardening question and Stop-hook duplicate suppression, and tightening planning/autopilot gates without changing published APIs.

## Highlights

- **Duplicate HUD pane fixes are release-blocker covered** — attached tmux HUD rendering now reuses an existing same-owner HUD instead of splitting duplicates, standalone HUD restore reuses the correct pane, and native session replacement preserves HUD ownership metadata.
- **Question and Stop-hook duplication is safer** — answered question renderer panes close correctly, duplicate question renderer panes are prevented, and duplicate worker Stop nudges preserve the evidence needed for recovery.
- **Autopilot and ralplan gates are stricter** — Autopilot completion requires gate evidence, command-style Autopilot invocations route correctly, and ralplan remains a planning-only boundary.
- **Team and MCP routing are more robust** — lightweight team coordination protocol docs/code landed, Hermes MCP tmux bridge pane routing was fixed, and detached tmux history growth is constrained.
- **Regression coverage protects changed surfaces** — focused HUD duplicate/tmux suites and broader changed-surface tests cover the release-critical paths.

## Fixes / compatibility

- Existing HUD state and Ultragoal state remain compatible; this release tightens pane ownership and dedupe behavior.
- No compatibility-breaking CLI or package layout changes are intended.
- No separately closed GitHub issues were found for this release window; the scope is represented by the merged PR inventory.

## Merged PR inventory

#2571, #2573, #2574, #2583, #2593, #2594, #2595, #2605, #2608, #2609, #2611.

## Validation

Release readiness evidence is recorded in `docs/qa/release-readiness-0.18.7.md`.

Local gates completed before tagging:

- release workflow version-sync probe
- `npm run build`
- focused duplicate HUD/tmux regression suite
- changed-surface compiled regression suite
- `npm run lint`
- `npm run check:no-unused`
- `npm run verify:native-agents`
- `npm run verify:plugin-bundle`
- `node dist/scripts/generate-catalog-docs.js --check`
- `git diff --check`
- `npm pack --dry-run`

The GitHub release workflow remains the authoritative cross-platform native asset and npm publication gate after tag push.

## Contributors

Thanks to the contributor who landed the `v0.18.6...v0.18.7` delta:

- [@Yeachan-Heo](https://github.com/Yeachan-Heo)

**Full Changelog**: [`v0.18.6...v0.18.7`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.18.6...v0.18.7)
