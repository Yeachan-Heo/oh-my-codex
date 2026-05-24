# oh-my-codex 0.18.2

`0.18.2` promotes the closed post-`0.18.1` issue train from `dev` to `main`. The release includes every currently closed, completed issue opened after `v0.18.1`, plus the Prometheus Strict planner surface and Ultragoal HUD progress display that merged during the same compare range.

## Highlights

- **Post-0.18.1 closed bug train is merged** — doctor/plugin hook diagnostics, Autopilot chain visibility, tmux/HUD/madmax regressions, team Stop leakage, notification turn-ended storms, Ultragoal goal-storage recovery, research-planning wording, and project-scope native-hook duplication are all included.
- **Prometheus Strict is available as a recipe workflow** — the planner surface now has `omx question` routing, native agent definitions, catalog entries, plugin mirrors, and dogfood docs.
- **Ultragoal progress is visible in the HUD** — active durable goal progress and review follow-up state are surfaced during long-running workflows.
- **Workflow handoffs are more explicit** — deep-interview remains a requirements boundary, Autopilot records durable phase state, ralplan consensus requires Architect/Critic evidence, and ralplan examples default to Ultragoal for durable execution.

## Fixes / compatibility

- Plugin-mode doctor checks now validate plugin hook manifests instead of looping users through ineffective `setup --force` guidance.
- Native subagents suppress quoted workflow keyword activation, and project-scope runtime `CODEX_HOME` no longer mirrors hook/config files in a way that duplicates hooks or loses trust state.
- Tmux 3.2a resize hooks, boxed `OMX_ROOT` HUD panes, per-leader HUD ownership, independent madmax detached starts, stale detached locks, and same-directory lock diagnostics are hardened.
- Team startup direct triggers require evidence, stale/foreign Team Stop state fails closed, and Codex Desktop turn-ended notify dispatch is bounded.
- Ultragoal can record unavailable Codex goal storage as recoverable blocked evidence instead of weakening final checkpoint reconciliation.

## Closed issue audit

Opened after `v0.18.1` and currently closed:

- Completed and merged to `dev`: #2429→#2431, #2430→#2432, #2433→#2434, #2435→#2436, #2438→#2439, #2440→#2442, #2443→#2447, #2445→#2448, #2449→#2450, #2451→#2452, #2453→#2455, #2456→#2457, #2460→#2461, #2462→#2463, #2466→#2467, #2468→#2469, #2470→#2471.
- Closed as not planned / not an execution-track merge: #2428 (too broad; requested narrower follow-ups) and #2465 (contribution-gate closure).

## Merged PR inventory

#2415, #2427, #2431, #2432, #2434, #2436, #2437, #2439, #2442, #2447, #2448, #2450, #2452, #2455, #2457, #2461, #2463, #2467, #2469, #2471, #2472.

## Validation

- `npm run build`
- `npm run verify:native-agents`
- `npm run verify:plugin-bundle`
- `npm run test:recent-bug-regressions:compiled`
- `node --test dist/hud/__tests__/authority.test.js dist/hooks/__tests__/notify-fallback-watcher.test.js dist/scripts/__tests__/notify-dispatcher.test.js dist/ultragoal/__tests__/artifacts.test.js dist/cli/__tests__/codex-plugin-layout.test.js dist/cli/__tests__/setup-install-mode.test.js dist/hooks/__tests__/keyword-detector.test.js dist/team/__tests__/runtime.test.js`
- `npm run sync:plugin:check`
- Tag-time release workflow/gate regenerates the release body from `RELEASE_BODY.md` after `v0.18.2` exists.
- `cargo check --workspace`

## Contributors

Thanks to everyone who reported and narrowed the post-`0.18.1` closed issue train, especially the plugin-hook, Autopilot, tmux/HUD/madmax, Team Stop, notification storm, Ultragoal recovery, and project-scope launch reports.

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.18.1...v0.18.2
