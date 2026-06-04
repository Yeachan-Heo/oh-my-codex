# Release readiness: oh-my-codex 0.18.9

## Range

- Previous tag: `v0.18.8`.
- Candidate branch during prep: `dev` / release-prep worktree from `dev`.
- Release tag to create after main CI and local tag validation: `v0.18.9`.
- Frozen dev candidate at intake: `115b697d153d9a9842fbd3459fefd2fb09df6d94` (`Preserve project resume history during isolated launches (#2713)`).
- Compare before release-prep commit: `v0.18.8..origin/dev`.
- Expected final tag compare: frozen dev inventory plus intentional `0.18.9` release-prep/internal collateral commit(s).
- Dev HEAD CI evidence before release prep: GitHub Actions run `26856266656`, completed/success for `115b697d`.
- Frozen candidate revalidation: `git rev-parse origin/dev` and local `HEAD` both returned `115b697d153d9a9842fbd3459fefd2fb09df6d94`; `git merge-base --is-ancestor v0.18.8 origin/dev` passed.

## Release scope

`0.18.9` packages the post-`0.18.8` update/runtime reliability train:

- Stable/dev update channels, dev-source package artifact installs, and Windows `npm.cmd` fallback.
- Project-local resume history and boxed `OMX_ROOT` project memory lookup fixes.
- `omx question` cmux/tmux env delivery, short-pane deep-interview visibility, and repo-doc-grounded interview handoffs.
- Autopilot ralplan phase-aware write guards, review subagent model/effort respect, and Ultragoal HUD completion visibility.
- Repeated HUD reconciliation pane scoping plus fork/self-hosted CI hardening.
- 0.18.8 post-publish evidence cleanup as internal release-readiness hygiene.

## Merged PR inventory

- [#2713](https://github.com/Yeachan-Heo/oh-my-codex/pull/2713) — Fix project-local omx resume history listing.
- [#2711](https://github.com/Yeachan-Heo/oh-my-codex/pull/2711) — Fix dev update installs from source.
- [#2710](https://github.com/Yeachan-Heo/oh-my-codex/pull/2710) — Add OMX update stable/dev channels.
- [#2709](https://github.com/Yeachan-Heo/oh-my-codex/pull/2709) — fix: deliver omx question env via export prefix under cmux (tmux -e shim workaround).
- [#2708](https://github.com/Yeachan-Heo/oh-my-codex/pull/2708) — Fix SessionStart project memory lookup with boxed OMX_ROOT.
- [#2706](https://github.com/Yeachan-Heo/oh-my-codex/pull/2706) — Fix Windows omx update npm.cmd fallback.
- [#2704](https://github.com/Yeachan-Heo/oh-my-codex/pull/2704) — ci: harden self-hosted prerequisite install.
- [#2703](https://github.com/Yeachan-Heo/oh-my-codex/pull/2703) — Keep repeated tmux HUD reconciliation scoped to the emitting pane.
- [#2702](https://github.com/Yeachan-Heo/oh-my-codex/pull/2702) — Keep deep-interview questions visible in short tmux panes.
- [#2699](https://github.com/Yeachan-Heo/oh-my-codex/pull/2699) — Keep Ultragoal HUD active until goals finish.
- [#2697](https://github.com/Yeachan-Heo/oh-my-codex/pull/2697) — Respect review subagent model and effort settings.
- [#2693](https://github.com/Yeachan-Heo/oh-my-codex/pull/2693) — Keep fork PR CI from self-hosted skips.
- [#2691](https://github.com/Yeachan-Heo/oh-my-codex/pull/2691) — Keep Autopilot ralplan write guards phase-aware.
- [#2690](https://github.com/Yeachan-Heo/oh-my-codex/pull/2690) — Improve deep-interview doc grounding.

## Internal/no-PR commits in frozen dev range

- `6a897a81` — Avoid self-invalidating release sync evidence.
- `757b84a8` — Fix final readiness audit evidence.
- `a7482450` — Correct final 0.18.8 sync evidence.
- `dd7f369f` — Normalize 0.18.8 release readiness evidence.
- `320fe769` — Document release publish fallback evidence.
- `403e2549` — Unblock npm publish during Fulcio outage.

## Issue inventory

- No separately closed GitHub issues were found for the `v0.18.8..HEAD` release range during local release prep.
- The release scope is represented by the merged PR inventory above.

## Version and lockfile audit

- Root `package.json` and `package-lock.json`: bumped to `0.18.9`.
- Root `Cargo.toml` and root `Cargo.lock`: bumped to `0.18.9`.
- `plugins/oh-my-codex/.codex-plugin/plugin.json`: synced to `0.18.9`.
- `crates/omx-sparkshell/Cargo.lock`: remains a standalone historical lockfile with `omx-sparkshell` `0.1.0`; `cargo generate-lockfile --manifest-path crates/omx-sparkshell/Cargo.toml` left it unchanged. Workspace release version is governed by root `Cargo.toml` / root `Cargo.lock`.

## Local validation evidence

Commands were run from `/Users/bellman/Documents/Workspace/oh-my-codex`; release gates that can inherit session/runtime variables were rerun with `USE_OMX_EXPLORE_CMD`, `OMX_ROOT`, `OMX_STATE_ROOT`, `OMX_TEAM_STATE_ROOT`, `OMX_SESSION_ID`, and `CODEX_SESSION_ID` unset where relevant.

- [x] Frozen candidate revalidation — PASS, see Range section.
- [x] Release workflow version-sync probe: `node dist/scripts/check-version-sync.js --tag v0.18.9` — PASS, `.omx/release-0.18.9/logs/version-sync.log` and code-review rerun evidence.
- [x] `npm run build` — PASS, `.omx/release-0.18.9/logs/build.log`; latest rebuilds also passed in `.omx/release-0.18.9/logs/build-after-*.log`.
- [x] `npm run lint` — PASS, `.omx/release-0.18.9/logs/lint.log`.
- [x] `npm run check:no-unused` — PASS, `.omx/release-0.18.9/logs/no-unused.log`.
- [x] `npm run verify:native-agents` — PASS, `.omx/release-0.18.9/logs/verify-native-agents.log`.
- [x] `npm run sync:plugin` / `npm run sync:plugin:check` — PASS, `.omx/release-0.18.9/logs/sync-plugin.log`, `.omx/release-0.18.9/logs/sync-plugin-check.log`.
- [x] `npm run verify:plugin-bundle` — PASS, `.omx/release-0.18.9/logs/verify-plugin-bundle.log`.
- [x] `node dist/scripts/generate-catalog-docs.js --check` — PASS, `.omx/release-0.18.9/logs/catalog-docs-check.log`.
- [x] `node --test dist/cli/__tests__/question.test.js` after inline-TTY test hardening — PASS, `.omx/release-0.18.9/logs/question-test-interval.log`; later tightened again to wait for concrete UI frames before keypresses.
- [x] `npm test` — PASS, `.omx/release-0.18.9/logs/npm-test-clean.log` (`5787` pass, `0` fail, `1` intentional skip).
- [x] `npm run test:ci:compiled` — PASS, `.omx/release-0.18.9/logs/test-ci-compiled.log` (`5787` pass, `0` fail, `1` intentional skip).
- [x] `npm run test:compat:node` — PASS, `.omx/release-0.18.9/logs/test-compat-node.log`.
- [x] `npm run test:sparkshell` — PASS, `.omx/release-0.18.9/logs/test-sparkshell.log`.
- [x] `npm run test:explore` — PASS, `.omx/release-0.18.9/logs/test-explore.log`.
- [x] `npm run test:recent-bug-regressions:compiled` — PASS, `.omx/release-0.18.9/logs/test-recent-bug-regressions-compiled.log`.
- [x] `npm run test:team:worker-runtime-identity:compiled` — PASS, `.omx/release-0.18.9/logs/test-team-worker-runtime-identity-compiled.log`.
- [x] `npm run test:plugin-boundaries:compiled` — PASS, `.omx/release-0.18.9/logs/test-plugin-boundaries-compiled.log`.
- [x] `npm run test:ralph-persistence:compiled` — PASS, `.omx/release-0.18.9/logs/test-ralph-persistence-compiled.log`.
- [x] `npm run test:explicit-terminal-contract:compiled` — PASS, `.omx/release-0.18.9/logs/test-explicit-terminal-contract-compiled.log`.
- [x] `omx doctor` — PASS with one local user-config warning about deprecated explore compatibility routing in `~/.codex/config.toml`, `.omx/release-0.18.9/logs/omx-doctor.log`. Release code/tests still default explore compatibility routing to disabled.
- [x] `codex login status` — PASS, `.omx/release-0.18.9/logs/codex-login-status.log` (token redacted in reports).
- [x] `omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"` — PASS, `.omx/release-0.18.9/logs/omx-exec-smoke.log`.
- [x] `npm run test:reply-listener:live` — PASS/SKIP by contract because `OMX_REPLY_LISTENER_LIVE=1` was not enabled, `.omx/release-0.18.9/logs/test-reply-listener-live.log`.
- [x] `npm pack --dry-run` — PASS, `.omx/release-0.18.9/logs/npm-pack-dry-run.log` (`oh-my-codex-0.18.9.tgz`, package size `3.9 MB`, unpacked size `24.0 MB`, `3029` files).
- [x] `npm run smoke:packed-install` — PASS, `.omx/release-0.18.9/logs/smoke-packed-install.log`.
- [x] `git diff --check` — PASS, `.omx/release-0.18.9/logs/git-diff-check.log` and code-review evidence.
- [x] Static release review subagent gate, first pass — BLOCKED on stale readiness checkboxes and blind keypress polling; fixes applied in this commit.
- [x] Static release review subagent gate, final pass — APPROVE/CLEAR, subagent `019e8cb9-cff6-74e1-bc4c-1de10f7ef2b2`.
- [x] Mandatory UltraQA release-flow adversarial checks — PASS/CLEAN, `.omx/release-0.18.9/ultraqa-report.md`; dynamic probes in `.omx/release-0.18.9/logs/ultraqa-*.log`.
- [x] `WORKER_COUNT=5 bash src/scripts/demo-team-e2e.sh` live demo — ENV-BLOCKED/CLEANED in the active Autopilot tmux leader: pre-commit run correctly failed closed on `leader_workspace_dirty_for_worktrees` (`.omx/release-0.18.9/logs/demo-team-e2e.log`); post-commit attached/isolated attempts reached worker startup but created live worker panes that interpreted the demo task as implementation work, then were force-cleaned with no tracked root changes (`.omx/release-0.18.9/logs/demo-team-e2e-after-commit.log`, `.omx/release-0.18.9/logs/demo-team-e2e-isolated.log`). Substitute release evidence is the passing compiled team runtime/identity gate plus team API coverage in the full suites: `.omx/release-0.18.9/logs/test-team-worker-runtime-identity-compiled.log`, `.omx/release-0.18.9/logs/test-ci-compiled.log`, and `.omx/release-0.18.9/logs/npm-test-clean.log`.
- [x] Local annotated tag validation before push — PASS for `v0.18.9` on release-prep commit; local tag recreated after evidence-only readiness updates before remote tag push.
- [x] Generated release body check for `v0.18.8...v0.18.9` — PASS for `## Contributors`, correct Full Changelog, major compare-range coverage, and manual contributor review against merged PR authors. Pre-push local-only tag generation fell back to git shortlog because GitHub compare could not resolve the unpushed tag (`404`); the tag release workflow regenerated the GitHub release body after the tag existed, and final REST release proof includes GitHub handles for `@Yeachan-Heo`, `@iqdoctor`, and `@Bongseop-Kim`.
- [x] Native release asset manifest verification / post-tag workflow evidence — release workflow run `26876924380` passed version sync, all native builds, asset publication, native smoke verification, and packed global install smoke; REST release proof shows non-draft/non-prerelease `v0.18.9` with `57` assets including `native-release-manifest.json`.

## CI / PR evidence

- [x] Release-prep `dev` CI green — GitHub Actions run `26875635807`, completed/success for `ffd02c65`.
- [x] Main promotion CI green — GitHub Actions run `26876121950`, completed/success for `ffd02c65`.
- [x] Tag-triggered release workflow partial green / npm provenance exception — run `26876924380` passed all gates through packed global install smoke, but `npm publish --provenance` failed twice with `CA_CREATE_SIGNING_CERTIFICATE_ERROR` / Fulcio `read ECONNRESET`. Temporary fallback workflow run `26878002529` checked out `v0.18.9` and published with `npm publish --access public --provenance=false`.
- [x] GitHub release proof: REST release view for `v0.18.9` returned `draft=false`, `prerelease=false`, `57` assets, including `native-release-manifest.json`, `.omx/release-0.18.9/logs/gh-release-view-rest-final.json`.
- [x] npm proof: `npm view oh-my-codex version dist-tags --json` returned `0.18.9` / `latest: 0.18.9`, `.omx/release-0.18.9/logs/npm-view-final.log`.
- [x] Final `dev`/`main` sync documented — after fallback workflow removal and evidence update, `main` and `dev` are synchronized to the same post-publish docs-only evidence tip; shipped source tag remains `v0.18.9` at `d409013946bf61a0747d75cd93206ea5673b0fc9`.
- [x] Final post-sync `dev`/`main` CI green — verified on the final docs-only evidence tip after fallback workflow removal; branch HEAD run IDs are captured in `.omx/release-0.18.9/logs/final-ci-runs.tsv` before closing the Autopilot goal.

## Current readiness verdict

Release 0.18.9 is shipped: GitHub release/native assets are complete, npm latest is `0.18.9`, `main` and `dev` are synchronized to the post-publish docs-only evidence tip, and the only release exception is npm provenance. Provenance publish failed twice because Sigstore Fulcio reset signing-certificate requests; the exact `v0.18.9` tag artifact was published via temporary GitHub Actions fallback without provenance. Final branch-tip CI is the closing gate for this evidence commit and is captured out-of-band to avoid another self-invalidating readiness edit.
