# oh-my-codex 0.18.6

`0.18.6` is a patch release after `0.18.5` for the Ultragoal/HUD rendering follow-up that landed on `dev`. It focuses on keeping the runtime HUD compact without hiding the active Ultragoal context: non-Ultragoal sessions stay at the smaller line budget, active Ultragoal sessions can use up to three lines, tmux panes are resized from the same policy, and the current Ultragoal receives a distinct accent.

## Highlights

- **Ultragoal HUD line budget is adaptive** — the HUD keeps the compact default for ordinary sessions while allowing active Ultragoal state to use the larger, bounded display.
- **tmux HUD pane sizing follows render policy** — pane reconcile and resize behavior now derives from the same Ultragoal-aware line-budget helper used by rendering.
- **Current Ultragoal context is clearer** — the active Ultragoal is highlighted with a magenta accent, and compact HUD output drops lower-priority next-goal text to avoid mixed summaries.
- **ANSI and watch-mode rendering are safer** — constrained-width truncation preserves ANSI styling, and watch mode avoids extra-row output.
- **Regression coverage protects the HUD contract** — render, watch, reconcile, live tmux resize, and terminal row-budget tests cover the adaptive behavior.

## Fixes / compatibility

- Existing Ultragoal aggregate plans and HUD state files remain compatible; this release changes rendering and pane sizing behavior only.
- No separately closed GitHub issues were found for this release window; the scope is represented by the merged PR inventory.

## Merged PR inventory

#2555.

## Validation

Release readiness evidence is recorded in `docs/qa/release-readiness-0.18.6.md`.

Local gates completed before tagging:

- release workflow version-sync probe
- `npm run build`
- `node --test dist/hud/__tests__/render.test.js dist/hud/__tests__/index.test.js dist/hud/__tests__/reconcile.test.js dist/hud/__tests__/hud-tmux-injection.test.js`
- `npm run lint`
- `npm run check:no-unused`
- `npm run verify:native-agents`
- `npm run sync:plugin`
- `npm run verify:plugin-bundle`
- `node dist/scripts/generate-catalog-docs.js --check`
- `git diff --check`
- `npm pack --dry-run`

The GitHub release workflow remains the authoritative cross-platform native asset and npm publication gate after tag push.

## Contributors

Thanks to the contributor who landed the `v0.18.5...v0.18.6` delta:

- [@Yeachan-Heo](https://github.com/Yeachan-Heo) — #2555

**Full Changelog**: [`v0.18.5...v0.18.6`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.18.5...v0.18.6)
