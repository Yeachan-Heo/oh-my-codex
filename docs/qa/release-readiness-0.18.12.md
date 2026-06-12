# Release readiness: oh-my-codex 0.18.12

## Range

- Previous tag: `v0.18.11`.
- Candidate branch during prep: `release/0.18.12-prep`.
- Frozen candidate at intake: `8e81713f` (`Reconcile main release workflow history for 0.18.12 prep`) plus uncommitted version metadata bump to `0.18.12`.
- Compare range: `v0.18.11..HEAD`.
- Release tag to create after PR, dev/main promotion, and release approval: `v0.18.12`.
- Ancestry: `git merge-base --is-ancestor v0.18.11 HEAD` returned `0` (PASS), `.omx/release-0.18.12/logs/ancestry.log`.


## Evidence lifecycle

This file is the pre-tag release-prep readiness record for the `release/0.18.12-prep` PR. Local `.omx/release-0.18.12/logs/` paths and the open PR/issue inventory are point-in-time prep evidence. After PR CI, dev/main promotion, tag workflow, GitHub release creation, and npm publication, append or supersede the pending CI/publication checklist items rather than rewriting this local prep evidence as publication proof.

## Release scope

`0.18.12` packages the post-`0.18.11` release-prep and runtime hardening train:

- Manual npm publication workflow and auth configuration history reconciled for release prep.
- First-party MCP sibling detection narrowed after post-traffic observations.
- Autopilot, best-practice-research, ralplan, and deep-interview execution gates tightened.
- Plugin AGENTS guidance, setup plugin agent merge repair, developer-instruction prompt policy, setup mode inference, JSON fallback, and cleanup preservation hardened.
- Windows hook and state-input paths made safer, including `Path` preservation, `omx.cmd`, absolute PowerShell hook paths, UTF-8 BOM handling, and Windows-safe `omx state` input.
- HUD/session visibility and stale-state cleanup improved.

## Merged PR inventory

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

## Issue inventory

- Open PRs at release prep: none (`gh pr list --state open` returned `[]`).
- Open issues at release prep: none (`gh issue list --state open` returned `[]`).
- Closed issue coverage is represented by the merged PR and direct-commit inventory above.

## Version and lockfile audit

- Root `package.json` and `package-lock.json`: bumped to `0.18.12`.
- Root `Cargo.toml` workspace package version and root `Cargo.lock` workspace packages (`omx-api`, `omx-explore-harness`, `omx-mux`, `omx-runtime`, `omx-runtime-core`, `omx-sparkshell`): bumped to `0.18.12`.
- `plugins/oh-my-codex/.codex-plugin/plugin.json`: synced to `0.18.12`.
- `node dist/scripts/check-version-sync.js --tag v0.18.12`: PASS (`package=0.18.12 workspace=0.18.12 tag=v0.18.12`), `.omx/release-0.18.12/logs/version-sync-final.log`.

## Local validation evidence

Commands were run from `/home/bellman/Workspace/oh-my-codex-release-0.18.12` on branch `release/0.18.12-prep`.

- [x] `npm ci` — PASS, `.omx/release-0.18.12/logs/npm-ci.log` (npm audit reports 3 moderate vulnerabilities; no dependency changes were made during release prep).
- [x] `npm run build` — PASS after `npm ci`, `.omx/release-0.18.12/logs/build.log`.
- [x] `node dist/scripts/check-version-sync.js --tag v0.18.12` — PASS, `.omx/release-0.18.12/logs/version-sync-final.log` (`package=0.18.12 workspace=0.18.12 tag=v0.18.12`).
- [x] `npm run lint` — PASS, `.omx/release-0.18.12/logs/lint.log` (`Checked 702 files`; no fixes applied).
- [x] `npm run check:no-unused` — PASS, `.omx/release-0.18.12/logs/no-unused.log`.
- [x] `npm run verify:native-agents` — PASS, `.omx/release-0.18.12/logs/verify-native-agents.log` (`verified 22 installable native agents and 37 setup prompt assets`).
- [x] `npm run sync:plugin:check` — PASS, `.omx/release-0.18.12/logs/sync-plugin-check-final.log` (`verified 29 canonical skill directories and plugin metadata`).
- [x] `npm run verify:plugin-bundle` — PASS, `.omx/release-0.18.12/logs/verify-plugin-bundle.log` (`verified 29 canonical skill directories and plugin metadata`).
- [x] `node dist/scripts/generate-catalog-docs.js --check` — PASS, `.omx/release-0.18.12/logs/catalog-docs-check.log` (`catalog check ok`).
- [x] Focused hook/state tests: `node dist/scripts/run-test-files.js dist/hooks/__tests__ dist/state/__tests__` — PASS on serial rerun, `.omx/release-0.18.12/logs/focused-hook-state-tests.log`. The first parallel attempt collided with `npm pack --dry-run` rebuilding `dist` and reported missing compiled test files; rerun after pack completed exited `0`.
- [x] `npm pack --dry-run` — PASS, `.omx/release-0.18.12/logs/npm-pack-dry-run.log` (`oh-my-codex-0.18.12.tgz`, package size `4.0 MB`, unpacked size `24.6 MB`, `3061` files).
- [x] `git diff --check` — PASS, `.omx/release-0.18.12/logs/git-diff-check-final.log`.

## CI / publication evidence

- [ ] Release-prep PR CI green — pending after push/open PR.
- [ ] Dev/main promotion CI green — pending after merge/promotion.
- [ ] Tag-triggered release workflow — pending after `v0.18.12` tag push.
- [ ] GitHub release proof — pending.
- [ ] npm proof — pending.

## Current readiness verdict

Local release prep for `0.18.12` is ready for PR after the release-prep commit: version metadata is synced, release collateral is present, local gates passed, and open GitHub PR/issue inventory was empty at prep time. Release-prep PR CI, dev/main promotion, tag workflow, GitHub release proof, and npm publication proof remain post-PR/post-tag gates.
