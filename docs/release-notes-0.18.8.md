# oh-my-codex 0.18.8

`0.18.8` is a patch release after `0.18.7` for the post-release runtime reliability train on `dev`. It focuses on HUD/session ownership under native session drift, Autopilot replay and context-snapshot hardening, plugin hook/cache correctness, Team startup/disablement safety, and release/CI evidence improvements.

## Highlights

- **HUD ownership is more session-authoritative** — HUD panes are scoped by leader/source pane, duplicate legacy/fallback panes are deduped after prompt revive, deleted-cwd doctor panes are avoided, escaped tmux separators are parsed correctly, and native session-id drift preserves the intended HUD owner.
- **Autopilot and planning replay paths are safer** — completed terminal turns no longer reactivate Autopilot, context snapshots are seeded and hardened, task-seed provenance is clearer, and planning phases avoid editing under native session drift.
- **Plugin hooks and mirrors are stricter** — stale plugin hook cache refresh is fixed, oversized Stop semantics and JSON launcher fallback behavior are preserved, setup mode survives update refresh, and mirror sync verifies plugin hook metadata.
- **Team and native-agent behavior is clearer** — Team mode can be disabled, tmux worktree startup compatibility is fixed, native executor lanes remain leaf-only, and default native subagent routing guidance is corrected.
- **Release and CI evidence improved** — self-hosted Linux runner selection and GJC evidence lane optimization reduce avoidable broad CI churn while release readiness records all local/e2e/live gates.

## Fixes / compatibility

- Existing HUD, Autopilot, Team, plugin, and state files remain compatible; this release tightens ownership, cache, and replay behavior without intentional CLI/package layout breakage.
- The release includes README maintainer/contributor table and Discord invite updates plus state operation help.
- PR `#2685` is the maintainer CI wrapper for PR `#2682`; `#2682` is not counted as a separately merged PR in the final compare-range inventory because the shipped merge commit is `#2685`.

## Merged PR inventory

#2686, #2685, #2684, #2677, #2676, #2675, #2672, #2657, #2652, #2671, #2664, #2660, #2670, #2667, #2666, #2661, #2665, #2656, #2654, #2655, #2651, #2643, #2650, #2649, #2648, #2642, #2636, #2646, #2640, #2596.

- [#2686](https://github.com/Yeachan-Heo/oh-my-codex/pull/2686) — Show HUD late-gate status.
- [#2685](https://github.com/Yeachan-Heo/oh-my-codex/pull/2685) — Maintainer CI for PR #2682 HUD orphan reaping.
- [#2684](https://github.com/Yeachan-Heo/oh-my-codex/pull/2684) — Fix HUD dedupe across native session IDs.
- [#2677](https://github.com/Yeachan-Heo/oh-my-codex/pull/2677) — Fix stale plugin hook cache refresh.
- [#2676](https://github.com/Yeachan-Heo/oh-my-codex/pull/2676) — Scope HUD tmux splits to source panes.
- [#2675](https://github.com/Yeachan-Heo/oh-my-codex/pull/2675) — Prevent Autopilot terminal turn replay reactivation.
- [#2672](https://github.com/Yeachan-Heo/oh-my-codex/pull/2672) — Verify plugin hook metadata during mirror sync.
- [#2657](https://github.com/Yeachan-Heo/oh-my-codex/pull/2657) — ci: use gajae self-hosted linux runner.
- [#2652](https://github.com/Yeachan-Heo/oh-my-codex/pull/2652) — Fix session-authoritative HUD state.
- [#2671](https://github.com/Yeachan-Heo/oh-my-codex/pull/2671) — Clarify Autopilot task-seed provenance.
- [#2664](https://github.com/Yeachan-Heo/oh-my-codex/pull/2664) — Deduplicate legacy focused HUD panes on prompt revive.
- [#2660](https://github.com/Yeachan-Heo/oh-my-codex/pull/2660) — Prevent HUD fallback authority respawn storms.
- [#2670](https://github.com/Yeachan-Heo/oh-my-codex/pull/2670) — Seed and harden Autopilot context snapshots.
- [#2667](https://github.com/Yeachan-Heo/oh-my-codex/pull/2667) — Mirror oversized Stop semantics in plugin hook.
- [#2666](https://github.com/Yeachan-Heo/oh-my-codex/pull/2666) — Keep native executor lanes leaf-only.
- [#2661](https://github.com/Yeachan-Heo/oh-my-codex/pull/2661) — Fix plugin Stop hook launcher JSON fallback.
- [#2665](https://github.com/Yeachan-Heo/oh-my-codex/pull/2665) — Optimize CI lanes for GJC evidence artifacts.
- [#2656](https://github.com/Yeachan-Heo/oh-my-codex/pull/2656) — Scope HUD resize hooks by leader pane.
- [#2654](https://github.com/Yeachan-Heo/oh-my-codex/pull/2654) — Make Team mode disableable.
- [#2655](https://github.com/Yeachan-Heo/oh-my-codex/pull/2655) — Prevent HUD doctor panes from materializing deleted cwd.
- [#2651](https://github.com/Yeachan-Heo/oh-my-codex/pull/2651) — Clarify clean-context for code-review subagents.
- [#2643](https://github.com/Yeachan-Heo/oh-my-codex/pull/2643) — Harden UltraQA temporary harness guidance.
- [#2650](https://github.com/Yeachan-Heo/oh-my-codex/pull/2650) — Prevent planning-phase writes under native session drift.
- [#2649](https://github.com/Yeachan-Heo/oh-my-codex/pull/2649) — Preserve plugin setup mode during update refresh.
- [#2648](https://github.com/Yeachan-Heo/oh-my-codex/pull/2648) — Fix HUD duplicate pane race after prompt revive.
- [#2642](https://github.com/Yeachan-Heo/oh-my-codex/pull/2642) — Fix HUD pane detection with escaped tmux separators.
- [#2636](https://github.com/Yeachan-Heo/oh-my-codex/pull/2636) — Fix default native subagent routing guidance.
- [#2646](https://github.com/Yeachan-Heo/oh-my-codex/pull/2646) — Support state operation help.
- [#2640](https://github.com/Yeachan-Heo/oh-my-codex/pull/2640) — Fix team worker startup compatibility for tmux worktrees.
- [#2596](https://github.com/Yeachan-Heo/oh-my-codex/pull/2596) — Update README Discord invite on main.

## Issues

No separately closed GitHub issues were found for the `v0.18.7..HEAD` release range during local release prep; the release scope is represented by the merged PR inventory above.

## Validation

Release readiness evidence is recorded in `docs/qa/release-readiness-0.18.8.md`.

The planned local gates before tagging are:

- release workflow version-sync probe for `v0.18.8`
- `npm run build`
- `npm run lint`
- `npm run check:no-unused`
- `npm run verify:native-agents`
- `npm run sync:plugin` and `npm run verify:plugin-bundle`
- `node dist/scripts/generate-catalog-docs.js --check`
- full compiled test suite via `npm test` / `npm run test:ci:compiled`
- all discovered e2e/smoke/live gates from the release test spec, including Team demo e2e and Codex/OMX live smoke when prerequisites are present
- generated GitHub release body check
- `git diff --check`
- `npm pack --dry-run`

The GitHub release workflow remains the authoritative cross-platform native asset and npm publication gate after tag push.

**Full Changelog**: [`v0.18.7...v0.18.8`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.18.7...v0.18.8)
