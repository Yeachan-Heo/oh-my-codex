# oh-my-codex 0.18.14

> Release note status: pre-tag release-prep draft. Local validation evidence is tracked in `docs/qa/release-readiness-0.18.14.md`; final PR CI, dev/main promotion, tag workflow, GitHub release proof, and npm proof remain publication-stage evidence to append after those gates run.

`0.18.14` is a patch release after `0.18.13` focused on safer workflow orchestration, clearer agent/model routing diagnostics, sturdier plugin/HUD/team behavior, and release-candidate hygiene from the current `origin/dev` delta. It preserves the existing CLI/package contract while tightening setup, hook, HUD, Team, Ralplan, Autopilot, Ultragoal, and plugin-bundle edge cases discovered after `0.18.13`.

## Highlights

- **Agent/model routing is more transparent** — per-agent model overrides and model-routing launch diagnostics make selected roles, tiers, and launch arguments easier to inspect without changing the default operator contract.
- **Planning and goal workflows are safer** — Ultragoal architecture invariants, completed Codex goal cleanup guidance, Ralplan freshness/approval checks, transition diagnostics, and supervised Autopilot review rework reduce stale or ambiguous workflow handoffs.
- **Hooks and plugin packaging are sturdier** — native hook success handling, PreToolUse stdout/schema behavior, Windows hook command wrapping, dev plugin cache diagnostics, plugin AGENTS policy preservation, and bundled skill agent tier references are tightened.
- **HUD and Team runtime behavior is cleaner** — stale Autopilot HUD reporting, cramped guard display, standalone pane-scoped HUD state, tmux paste-buffer cleanup, supervisor paste-buffer handling, worker AGENTS guidance preservation, and HUD pane ownership on shutdown are hardened.
- **Doctor and resume discovery catch more local edge cases** — doctor detects root-owned repo artifacts, and resume search discovers madmax run histories.

## Fixes / compatibility

- Existing CLI, plugin, native-agent, HUD, state, hook, package layout, and runtime contracts remain compatible with `0.18.13`.
- The release keeps npm/package layout compatibility and updates root/plugin/Cargo metadata to `0.18.14`.
- Open PRs #2902, #2856, #2840, #2839, and #2838 are deliberately excluded from this candidate unless already present in `origin/dev`; release prep confirmed they remain open and `BEHIND` on `dev`.

## Merged PR / commit inventory

Primary merged PR and commit evidence in the current `origin/main..origin/dev` candidate includes:

- #2912 — Bundle skill agent tier references.
- #2906 — Fix HUD stale Autopilot reporting.
- #2905 — Clarify goal and skill workflow guidance.
- #2900 — Add model routing launch diagnostics.
- #2899 — Preserve AGENTS guidance in Team worker worktrees.
- #2897 — Detect root-owned repo artifacts in doctor.
- #2896 — Fix HUD cramped guard and tmux buffer cleanup.
- #2895 — Preserve PreToolUse planning guard output.
- #2894 — Make completed Codex goal cleanup explicit.
- #2889 — Harden dev plugin cache diagnostics.
- #2888 — Fix PreToolUse native hook stdout schema.
- #2884 — Fix Ralplan consensus gate approval and freshness checks.
- #2879 — Fix Ralplan guard and HUD phase authority.
- #2878 — Fix stale Autopilot stop state.
- #2877 — Preserve plugin AGENTS policy blocks during setup.
- #2875 — Allow Beads tracker metadata during planning.
- #2874 — Keep native hooks successful on null output.
- #2873 — Harden tmux supervisor paste buffers.
- #2861 — Keep standalone pane-scoped HUD stable.
- #2859 — Avoid shell-wrapping Windows native hook node.
- #2852 — Discover madmax run histories for resume search.
- #2850 — Add per-agent model overrides.
- #2848 — Add Ultragoal architecture invariant gate.
- #2828 — Preserve HUD pane ownership on shutdown.
- Direct commits — explain Ralplan transition validator diagnostics and add supervised Autopilot review rework phase.

## Issues

Held open PRs #2902, #2856, #2840, #2839, and #2838 remain outside this release candidate. They are behind `dev` and are treated as owner-confirmation/user-facing contract holds rather than `0.18.14` release blockers.

## Validation

Release readiness evidence is recorded in `docs/qa/release-readiness-0.18.14.md`.

Release-prep gates include version sync for `v0.18.14`, build, native-agent verification, plugin mirror/bundle checks, catalog docs check, dogfooding of built CLI surfaces, `npm pack --dry-run`, and `git diff --check`. Branch CI, dev/main promotion, tag-triggered release workflow, GitHub release proof, and npm publication proof remain publication-stage gates.

**Full Changelog**: [`v0.18.13...v0.18.14`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.18.13...v0.18.14)
