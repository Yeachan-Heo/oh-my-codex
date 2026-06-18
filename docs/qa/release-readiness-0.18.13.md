# Release readiness: oh-my-codex 0.18.13

## Range

- Previous tag: `v0.18.12`.
- Candidate branch during prep: `dev`.
- Frozen candidate at intake: `24294fc2` (`Improve project resume/search discovery (#2846)`) plus local release metadata/collateral updates to `0.18.13`.
- Compare range for release notes: `v0.18.12..HEAD`, with topology caveat below.
- Release tag to create after PR, dev/main promotion, and release approval: `v0.18.13`.
- Topology caveat: `v0.18.12` points at the main promotion commit (`29d03f49`), while `dev` currently shares merge-base `06baf8f4` with `origin/main`. Use `origin/main...HEAD --cherry-pick` and the release-scope review to avoid double-counting cherry-equivalent `0.18.12` prep commits as new `0.18.13` functionality.

## Evidence lifecycle

This file began as the pre-tag release-prep readiness record for the `0.18.13` candidate. `v0.18.13` has now shipped from commit `daf7c7c21f602584294f9a04ef5155b5ccfb0e96`; the post-publish evidence below is a deliberate docs-only update after the immutable release tag.

## Release scope

`0.18.13` packages the post-`0.18.12` compatibility-preserving hardening train:

- Project-scoped runtime Codex homes are included in `omx resume` and `omx session search`; `--project` and `--codex-home` provide narrower/explicit discovery controls.
- Setup preserves customized native-agent TOMLs and covers overwrite/scope behavior more thoroughly.
- Hook JSON state compatibility and native hook execution paths are hardened.
- Project Codex transcripts are preserved during cleanup.
- Ralplan and Autopilot consensus freshness, tracker-backed native reviews, and target-aware write detection are tightened.
- Sidecar Team state roots align with Team runtime behavior.
- CI workflows are moved to GitHub-hosted runners where appropriate, and dev-merge issue-close follow-up comments are best-effort.
- Geobench visibility docs/profile plus enriched profile and romanization schema fixes are included.
- Development dependencies are refreshed: `@biomejs/biome` to `2.5.0` and `@types/node` to `25.9.3`.

## Version decision

- Selected release version: `0.18.13`.
- Rejected release version: `0.19.0`.
- Rationale: release-scope review found no removed active command, package bin/engine break, incompatible public schema, or breaking public API change. The current scope is fixes, CI/docs, dependency bumps, additive setup/session discovery, geobench docs/spec, and compatibility-preserving runtime/hook/setup hardening.
- Independent review evidence: Ultragoal G001 checkpoint recorded executor QA/red-team subagent `1-ReleaseScopeQa` and architect review subagent `2-ReleaseScopeArchitectFast`, both approving `0.18.13` over `0.19.0`.

## Merged PR / commit inventory

- [#2846](https://github.com/Yeachan-Heo/oh-my-codex/pull/2846) — Improve project resume/search discovery.
- [#2845](https://github.com/Yeachan-Heo/oh-my-codex/pull/2845) — Move CI workflows to GitHub-hosted runners.
- [#2843](https://github.com/Yeachan-Heo/oh-my-codex/pull/2843) — Fix hooks JSON state compatibility.
- [#2836](https://github.com/Yeachan-Heo/oh-my-codex/pull/2836) — Preserve project Codex transcripts on cleanup.
- [#2833](https://github.com/Yeachan-Heo/oh-my-codex/pull/2833) — Bump `@biomejs/biome` from `2.4.16` to `2.5.0`.
- [#2832](https://github.com/Yeachan-Heo/oh-my-codex/pull/2832) — Bump `@types/node` from `25.9.2` to `25.9.3`.
- [#2831](https://github.com/Yeachan-Heo/oh-my-codex/pull/2831) — Suppress child-agent lifecycle notifications before canonical session reconcile.
- [#2829](https://github.com/Yeachan-Heo/oh-my-codex/pull/2829) — Make deep-interview/RALPLAN Bash write detector target-aware.
- [#2826](https://github.com/Yeachan-Heo/oh-my-codex/pull/2826) — Make dev-merge issue-close PR follow-up comments best-effort.
- [#2824](https://github.com/Yeachan-Heo/oh-my-codex/pull/2824) — Align sidecar Team state root with Team runtime.
- [#2820](https://github.com/Yeachan-Heo/oh-my-codex/pull/2820) — Preserve customized native agent TOMLs.
- [#2821](https://github.com/Yeachan-Heo/oh-my-codex/pull/2821) — Accept tracker-backed ralplan native reviews.
- [#2817](https://github.com/Yeachan-Heo/oh-my-codex/pull/2817) — Fix Autopilot ralplan consensus freshness.
- [#2816](https://github.com/Yeachan-Heo/oh-my-codex/pull/2816) — Harden ralplan consensus freshness gates.
- `51868d56`, `a49c32dd`, `5e918a52`, `e75261d0` — Add geobench visibility spec/profile and fix geobench profile schemas.

## Issue inventory

- Open PRs at release-scope review: #2840, #2839, #2838, and draft #2828.
- Open issues at release-scope review: none.
- None of the open PRs or issues changed the `0.18.13` patch decision; the open PRs were fix/docs/warning/safety scoped.

## Version and lockfile audit

- Root `package.json` and `package-lock.json`: bumped to `0.18.13`.
- Root `Cargo.toml` workspace package version and root `Cargo.lock` workspace packages (`omx-api`, `omx-explore-harness`, `omx-mux`, `omx-runtime`, `omx-runtime-core`, `omx-sparkshell`): bumped to `0.18.13`.
- `plugins/oh-my-codex/.codex-plugin/plugin.json`: synced to `0.18.13`.
- `node dist/scripts/check-version-sync.js --tag v0.18.13`: PASS (`package=0.18.13 workspace=0.18.13 tag=v0.18.13`).

## Local validation evidence

Commands are run from `/Users/bellman/Documents/Workspace/oh-my-codex` on branch `dev`.

- [x] Release-scope review — PASS. Ultragoal G001 selected `0.18.13`; executor QA/red-team and architect review approved no-breaking patch scope.
- [x] `npm run build` — PASS.
- [x] `node dist/scripts/check-version-sync.js --tag v0.18.13` — PASS (`package=0.18.13 workspace=0.18.13 tag=v0.18.13`).
- [x] `npm run verify:native-agents` — PASS (`verified 22 installable native agents and 37 setup prompt assets`).
- [x] `npm run verify:plugin-bundle` — PASS (`verified 29 canonical skill directories and plugin metadata`).
- [x] `node dist/scripts/generate-catalog-docs.js --check` — PASS (`catalog check ok`).
- [x] Focused tests for changed release/session/setup/hook/workflow surfaces — PASS after fixing isolated session-search env leakage, `artifacts/release-0.18.13/logs/focused-release-tests.log`.
- [x] Dogfood built CLI/package surfaces — PASS for `node dist/cli/omx.js --version`, `node dist/cli/omx.js session search --help`, package metadata import, and `npm run smoke:packed-install`; evidence in `artifacts/release-0.18.13/logs/cli-dogfood.log`, `package-dogfood.log`, and `smoke-packed-install.log`. `omx doctor` dogfood also executed and surfaced an existing user-home hooks migration issue, which is environment state rather than release-candidate failure.
- [x] `npm pack --dry-run` — PASS (`oh-my-codex-0.18.13.tgz`, package size `3,978,807` bytes, unpacked size `24,892,739` bytes, `3065` files), `artifacts/release-0.18.13/logs/npm-pack-dry-run.log` and machine-readable `artifacts/release-0.18.13/logs/npm-pack-dry-run-json.log`.
- [x] `git diff --check` — PASS, `artifacts/release-0.18.13/logs/git-diff-check-final.log`.
- [x] Full compiled CI-equivalent gate — PASS on rerun: `npm run test:ci:compiled` completed native-agent verification, plugin-bundle verification, the full compiled node suite, and catalog docs check with no failures, `artifacts/release-0.18.13/logs/test-ci-compiled-rerun.log`. Earlier `test-ci-compiled.log` captured one timing-sensitive process-tree failure; `process-tree-rerun.log` shows the isolated process-tree suite passed before the full clean rerun.

## CI / publication evidence

- [x] Release-prep `dev` CI green — PASS, run `27674248675` on `b619f5a0705f86243efc28232a8d952139746164`, <https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/27674248675>.
- [x] Dev/main promotion CI green — PASS, run `27674657459` on `daf7c7c21f602584294f9a04ef5155b5ccfb0e96`, <https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/27674657459>.
- [x] Tag-triggered release workflow — PASS, run `27674982310` for `v0.18.13` on `daf7c7c21f602584294f9a04ef5155b5ccfb0e96`, <https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/27674982310>.
- [x] GitHub release proof — PASS, `gh release view v0.18.13` reports a non-draft, non-prerelease release at <https://github.com/Yeachan-Heo/oh-my-codex/releases/tag/v0.18.13> with `57` assets, including `native-release-manifest.json`.
- [x] npm proof — PASS, `npm view oh-my-codex version` returned `0.18.13` after the release workflow published with provenance.

## Current readiness verdict

`0.18.13` is shipped. The release tag points at `daf7c7c21f602584294f9a04ef5155b5ccfb0e96`; GitHub release assets are published; npm reports `oh-my-codex@0.18.13`.

## Release handoff

Release execution is complete for `0.18.13`. The following evidence forms the shipped-release bundle:

- Release collateral: `CHANGELOG.md`, `RELEASE_BODY.md`, `docs/release-notes-0.18.13.md`, and this readiness file.
- Version/package metadata: `package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`, `plugins/oh-my-codex/.codex-plugin/plugin.json`, `src/catalog/generated/public-catalog.json`, and `templates/catalog-manifest.json`.
- Local verification logs: `artifacts/release-0.18.13/logs/build.log`, `version-sync.log`, `verify-native-agents.log`, `verify-plugin-bundle.log`, `catalog-docs-check.log`, `no-unused.log`, `focused-release-tests.log`, `test-ci-compiled-rerun.log`, `npm-pack-dry-run.log`, `npm-pack-dry-run-json.log`, `git-diff-check-final.log`, `cli-dogfood.log`, `package-dogfood.log`, and `smoke-packed-install.log`.
- Remote release proof: dev CI run `27674248675`, main CI run `27674657459`, release workflow run `27674982310`, GitHub release `v0.18.13`, and npm registry version `0.18.13`.

Known gaps / pending gates: none for the shipped `v0.18.13` tag. This post-publish readiness update intentionally documents evidence after the release tag rather than moving the tag.
