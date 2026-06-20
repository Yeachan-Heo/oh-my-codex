# Release readiness: oh-my-codex 0.18.14

## Range

- Previous tag: `v0.18.13`.
- Candidate branch during prep: `release-0.18.14` from `origin/dev`.
- Frozen candidate at intake: `c437fcab` (`fix: bundle skill agent tier references (#2912)`) plus local release metadata/collateral updates to `0.18.14`.
- Compare range for release notes: `origin/main..origin/dev` as requested for this release candidate.
- Release tag to create after PR, dev/main promotion, and release approval: `v0.18.14`.
- Explicit release boundary: open PRs #2902, #2856, #2840, #2839, and #2838 are excluded unless already in `origin/dev`; `gh pr view` confirmed each is open with `mergeStateStatus: BEHIND` on base `dev` during prep.

## Evidence lifecycle

This file is the pre-tag release-prep readiness record for the `0.18.14` candidate. PR CI, dev/main promotion, tag-triggered release workflow, GitHub release proof, and npm proof remain owner/final release gates after this branch is reviewed and merged.

## Release scope

`0.18.14` packages the post-`0.18.13` compatibility-preserving hardening train:

- Per-agent model overrides and model-routing launch diagnostics improve operator visibility into role/model selection.
- Ultragoal, Ralplan, Autopilot, completed-goal cleanup, transition diagnostics, and Beads planning metadata handling are tightened.
- Plugin bundle, plugin AGENTS policy preservation, dev plugin cache diagnostics, native hook null-output success, PreToolUse stdout/schema handling, and Windows hook command launching are hardened.
- HUD state/reporting/display behavior, tmux paste-buffer cleanup, Team worker AGENTS guidance preservation, and HUD pane ownership on shutdown are safer.
- Doctor detects root-owned repo artifacts, and resume search discovers madmax run histories.
- Workflow docs clarify goal and skill guidance.

## Version decision

- Selected release version: `0.18.14`.
- Rejected release version: `0.19.0`.
- Rationale: release-scope review found no removed active command, package bin/engine break, incompatible public schema, or breaking public API change. The current scope is fixes, diagnostics, docs, additive configuration visibility, and compatibility-preserving runtime/hook/setup/plugin/HUD/Team hardening.

## Merged PR / commit inventory

- [#2912](https://github.com/Yeachan-Heo/oh-my-codex/pull/2912) — Bundle skill agent tier references.
- [#2906](https://github.com/Yeachan-Heo/oh-my-codex/pull/2906) — Fix HUD stale Autopilot reporting.
- [#2905](https://github.com/Yeachan-Heo/oh-my-codex/pull/2905) — Clarify goal and skill workflow guidance.
- [#2900](https://github.com/Yeachan-Heo/oh-my-codex/pull/2900) — Add model routing launch diagnostics.
- [#2899](https://github.com/Yeachan-Heo/oh-my-codex/pull/2899) — Preserve AGENTS guidance in Team worker worktrees.
- [#2897](https://github.com/Yeachan-Heo/oh-my-codex/pull/2897) — Detect root-owned repo artifacts in doctor.
- [#2896](https://github.com/Yeachan-Heo/oh-my-codex/pull/2896) — Fix HUD cramped guard and tmux buffer cleanup.
- [#2895](https://github.com/Yeachan-Heo/oh-my-codex/pull/2895) — Preserve PreToolUse planning guard output.
- [#2894](https://github.com/Yeachan-Heo/oh-my-codex/pull/2894) — Make completed Codex goal cleanup explicit.
- [#2889](https://github.com/Yeachan-Heo/oh-my-codex/pull/2889) — Harden dev plugin cache diagnostics.
- [#2888](https://github.com/Yeachan-Heo/oh-my-codex/pull/2888) — Fix PreToolUse native hook stdout schema.
- [#2884](https://github.com/Yeachan-Heo/oh-my-codex/pull/2884) — Fix Ralplan consensus gate approval and freshness checks.
- [#2879](https://github.com/Yeachan-Heo/oh-my-codex/pull/2879) — Fix Ralplan guard and HUD phase authority.
- [#2878](https://github.com/Yeachan-Heo/oh-my-codex/pull/2878) — Fix stale Autopilot stop state.
- [#2877](https://github.com/Yeachan-Heo/oh-my-codex/pull/2877) — Preserve plugin AGENTS policy blocks during setup.
- [#2875](https://github.com/Yeachan-Heo/oh-my-codex/pull/2875) — Allow Beads tracker metadata during planning.
- [#2874](https://github.com/Yeachan-Heo/oh-my-codex/pull/2874) — Keep native hooks successful on null output.
- [#2873](https://github.com/Yeachan-Heo/oh-my-codex/pull/2873) — Harden tmux supervisor paste buffers.
- [#2861](https://github.com/Yeachan-Heo/oh-my-codex/pull/2861) — Keep standalone pane-scoped HUD stable.
- [#2859](https://github.com/Yeachan-Heo/oh-my-codex/pull/2859) — Avoid shell-wrapping Windows native hook node.
- [#2852](https://github.com/Yeachan-Heo/oh-my-codex/pull/2852) — Discover madmax run histories for resume search.
- [#2850](https://github.com/Yeachan-Heo/oh-my-codex/pull/2850) — Add per-agent model overrides.
- [#2848](https://github.com/Yeachan-Heo/oh-my-codex/pull/2848) — Add Ultragoal architecture invariant gate.
- [#2828](https://github.com/Yeachan-Heo/oh-my-codex/pull/2828) — Preserve HUD pane ownership on shutdown.
- `6917f59f` — Explain Ralplan transition validator diagnostics.
- `e392a190` — Add supervised Autopilot review rework phase.

## Held PR inventory

- [#2902](https://github.com/Yeachan-Heo/oh-my-codex/pull/2902) — open, base `dev`, `BEHIND`; excluded.
- [#2856](https://github.com/Yeachan-Heo/oh-my-codex/pull/2856) — open, base `dev`, `BEHIND`; excluded.
- [#2840](https://github.com/Yeachan-Heo/oh-my-codex/pull/2840) — open, base `dev`, `BEHIND`; excluded.
- [#2839](https://github.com/Yeachan-Heo/oh-my-codex/pull/2839) — open, base `dev`, `BEHIND`; excluded.
- [#2838](https://github.com/Yeachan-Heo/oh-my-codex/pull/2838) — open, base `dev`, `BEHIND`; excluded.

## Version and lockfile audit

- Root `package.json` and `package-lock.json`: bumped to `0.18.14`.
- Root `Cargo.toml` workspace package version and root `Cargo.lock` workspace packages (`omx-api`, `omx-explore-harness`, `omx-mux`, `omx-runtime`, `omx-runtime-core`, `omx-sparkshell`): bumped to `0.18.14`.
- `plugins/oh-my-codex/.codex-plugin/plugin.json`: synced to `0.18.14`.
- `node dist/scripts/check-version-sync.js --tag v0.18.14`: local release-prep gate.

## Local validation evidence

Commands are run from `/home/bellman/Workspace/oh-my-codex-release-0.18.14` on branch `release-0.18.14`.

- [x] `npm run build` — PASS.
- [x] `node dist/scripts/check-version-sync.js --tag v0.18.14` — PASS (`package=0.18.14 workspace=0.18.14 tag=v0.18.14`).
- [x] `npm run verify:native-agents` — PASS (`verified 22 installable native agents and 37 setup prompt assets`).
- [x] `npm run verify:plugin-bundle` — PASS (`verified 29 canonical skill directories and plugin metadata`).
- [x] `node dist/scripts/generate-catalog-docs.js --check` — PASS (`catalog check ok`).
- [x] `npm pack --dry-run` — PASS (`oh-my-codex-0.18.14.tgz`, package size `4.1 MB`, unpacked size `25.5 MB`, `3072` files).
- [x] `node dist/cli/omx.js --version` — PASS (`oh-my-codex v0.18.14`).
- [x] `node dist/cli/omx.js --help` — PASS (help rendered successfully).
- [x] `git diff --check` — PASS.

## CI / publication evidence

- [ ] Release-prep PR CI — pending after PR creation.
- [ ] Dev/main promotion CI — pending after owner merge/promotion.
- [ ] Tag-triggered release workflow — owner/final release gate; not run locally.
- [ ] GitHub release proof — owner/final release gate; not run locally.
- [ ] npm proof — owner/final release gate; not run locally.

## Current readiness verdict

`RELEASE_PREP_READY`: local release-prep verification passed. PR CI, dev/main promotion, tag-triggered release workflow, GitHub release proof, and npm publication proof remain intentionally unexecuted owner/final release gates.

## Release handoff

Release-prep branch should hand off:

- Release collateral: `CHANGELOG.md`, `RELEASE_BODY.md`, `docs/release-notes-0.18.14.md`, and this readiness file.
- Version/package metadata: `package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`, and `plugins/oh-my-codex/.codex-plugin/plugin.json`.
- Concise local verification PASS results from the required release-prep gates above.

Known gaps / pending gates: PR CI, dev/main promotion, tag-triggered release workflow, GitHub release proof, and npm publication proof remain intentionally unexecuted until owner/final release approval.
