# oh-my-codex 0.18.12


> Release note status: pre-tag release-prep draft. The local validation summary points to `docs/qa/release-readiness-0.18.12.md`; final PR CI, tag workflow, GitHub release proof, and npm proof remain publication-stage evidence to append after those gates run.

`0.18.12` is a patch release after `0.18.11` focused on release-workflow reconciliation, safer runtime automation gates, plugin guidance preservation, Windows hook/state robustness, and HUD/session cleanup. It keeps the existing CLI/package contract while tightening release and operator edge cases discovered after `0.18.11`.

## Highlights

- **Release workflow history is reconciled for 0.18.12** — the release prep branch carries the main manual npm publishing workflow and npm auth configuration history forward while keeping the local prep boundary intact: no tag, no main merge, and no local npm publish.
- **Automation and planning gates are stricter** — Autopilot final gates, best-practice-research read-only enforcement, ralplan consensus guards, deep-interview artifact writes, and Windows-safe `omx state` input handling reduce unsafe or confusing execution paths.
- **Plugin guidance handling is safer** — persistent AGENTS guidance, setup plugin agent merge repair, developer-instruction prompt policy, setup mode inference, JSON fallback, and cleanup preservation are all hardened.
- **HUD/session behavior is more reliable** — stale HUD cleanup, dev version labels, owner matching, terminal skill-active visibility, cancel run-dir visibility, and detached history pruning are tightened.
- **Windows hook paths are safer** — hook shims preserve `Path`, emit `omx.cmd`, use absolute PowerShell hook paths, and include UTF-8 BOM handling for non-ASCII install paths.

## Fixes / compatibility

- Existing CLI, plugin, native-agent, HUD, state, hook, and package layout contracts remain compatible with `0.18.11`.
- The release keeps npm/package layout compatibility and updates root/plugin/Cargo metadata to `0.18.12`.
- Open GitHub PR and issue inventory was empty at release prep time.

## Merged PR inventory

#2760, #2762, #2765, #2766, #2768, #2771, #2773, #2774, #2776, #2798, #2800, #2801, #2802, #2805, #2806, #2810, #2812.

- [#2760](https://github.com/Yeachan-Heo/oh-my-codex/pull/2760) — fix(mcp): cap post-traffic same-parent first-party MCP siblings (#2759).
- [#2762](https://github.com/Yeachan-Heo/oh-my-codex/pull/2762) — Bump @types/node from 25.9.0 to 25.9.2.
- [#2765](https://github.com/Yeachan-Heo/oh-my-codex/pull/2765) — ci: add manual npm publish workflow.
- [#2766](https://github.com/Yeachan-Heo/oh-my-codex/pull/2766) — ci: configure npm auth for manual publish.
- [#2768](https://github.com/Yeachan-Heo/oh-my-codex/pull/2768) — Fix dev version label and stale HUD cleanup.
- [#2771](https://github.com/Yeachan-Heo/oh-my-codex/pull/2771) — Fix terminal skill-active visibility.
- [#2773](https://github.com/Yeachan-Heo/oh-my-codex/pull/2773) — fix: enforce autopilot final gates.
- [#2774](https://github.com/Yeachan-Heo/oh-my-codex/pull/2774) — Fix dev update baseline prompt loop.
- [#2776](https://github.com/Yeachan-Heo/oh-my-codex/pull/2776) — Fix HUD labels, owner matching, and consensus diagnostics.
- [#2798](https://github.com/Yeachan-Heo/oh-my-codex/pull/2798) — fix(plugin): require persistent AGENTS guidance.
- [#2800](https://github.com/Yeachan-Heo/oh-my-codex/pull/2800) — fix(best-practice-research): enforce terminal read-only boundary.
- [#2801](https://github.com/Yeachan-Heo/oh-my-codex/pull/2801) — Fix plugin AGENTS merge repair.
- [#2802](https://github.com/Yeachan-Heo/oh-my-codex/pull/2802) — Fix plugin developer_instructions prompt policy.
- [#2805](https://github.com/Yeachan-Heo/oh-my-codex/pull/2805) — fix(cli): tolerate dead leader pane in detached history prune hook.
- [#2806](https://github.com/Yeachan-Heo/oh-my-codex/pull/2806) — Fix ralplan consensus iterate guard.
- [#2810](https://github.com/Yeachan-Heo/oh-my-codex/pull/2810) — fix(hooks): allow deep-interview apply_patch artifact writes from freeform patch text (#2809).
- [#2812](https://github.com/Yeachan-Heo/oh-my-codex/pull/2812) — fix(cli): Windows-safe omx state input surface (#2811).

## Internal/no-PR commits in compare range

- `dce351fc` — fix(windows): preserve Path env, emit omx.cmd shim, absolute PowerShell hook (#2780); no resolvable merged PR was available through `gh pr view 2780` during release prep.
- `76b01687` — fix doctor plugin mode inference.
- `da00f144` — fix(windows): emit UTF-8 BOM in native-hook shim for non-ASCII install paths.
- `3ebf3c0a` — fix plugin Stop hook JSON fallback.
- `0d5d3a7c` — fix: resolve ambient OMX entry paths against startup cwd.
- `15bbe8b2` — fix: block autopilot deep-interview implementation writes.
- `d74816a5` — fix: allow ralplan planning artifact writes.
- `3e394380` — fix: infer plugin doctor mode from installed marketplace.
- `48444187` — fix: cancel hook-visible run-dir state.
- `e9c20905` — fix: preserve custom developer instructions on plugin cleanup.
- `36db1846` — Fix ralplan consensus boxed state root lookup.
- `8e81713f` — Reconcile main release workflow history for 0.18.12 prep.

## Issues

No open GitHub issues or open PRs were present at release prep time. Closed issue coverage is represented by the merged PR and direct-commit inventory above.

## Validation

Release readiness evidence is recorded in `docs/qa/release-readiness-0.18.12.md`.

Release-prep gates include build, version sync for `v0.18.12`, lint, no-unused, native-agent verification, plugin mirror/bundle checks, catalog docs check, focused hook/state tests, `npm pack --dry-run`, and `git diff --check`. Branch CI, tag-triggered release workflow, GitHub release proof, and npm publication proof remain post-PR/tag publication gates.

**Full Changelog**: [`v0.18.11...v0.18.12`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.18.11...v0.18.12)
