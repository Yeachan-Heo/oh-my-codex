# Release readiness: oh-my-codex 0.18.11

## Range

- Previous tag: `v0.18.10`.
- Candidate branch during prep: `origin/dev` in dedicated release worktree branch `omx-release-0.18.11`.
- Frozen dev candidate at intake: `06baf8f4e41541778835686f7696b95cd2b39316` (`fix(doctor): add Spark/model lane routing diagnostic (#2757) (#2758)`).
- Compare range: `v0.18.10..06baf8f4` (7 commits).
- Release tag to create after branch CI and main promotion: `v0.18.11`.
- Ancestry: `git merge-base --is-ancestor v0.18.10 06baf8f4` returns true.
- Dev HEAD CI evidence before release prep: GitHub Actions run `27171589905`, completed/success for `06baf8f4`.

## Release scope

`0.18.11` packages the post-`0.18.10` cleanup train:

- `omx explore` command surface hard-deprecation, including removal of remaining `omx explore` mentions from global AGENTS guidance.
- `omx doctor` Spark/model lane routing diagnostic.
- Launch-time tmux HUD split skipped in cramped existing tmux windows.
- Catalog wiki skill manifest entry.

## Merged PR inventory

- [#2746](https://github.com/Yeachan-Heo/oh-my-codex/pull/2746) — feat(explore): hard-deprecate omx explore command surface (#2744, #2745).
- [#2747](https://github.com/Yeachan-Heo/oh-my-codex/pull/2747) — chore(catalog): add wiki skill manifest entry.
- [#2750](https://github.com/Yeachan-Heo/oh-my-codex/pull/2750) — fix(agents): remove remaining omx explore mentions from global AGENTS guidance (#2749).
- [#2755](https://github.com/Yeachan-Heo/oh-my-codex/pull/2755) — fix(hud): skip launch-time HUD split in cramped existing tmux windows (#2754).
- [#2758](https://github.com/Yeachan-Heo/oh-my-codex/pull/2758) — fix(doctor): add Spark/model lane routing diagnostic (#2757).

## Internal/no-PR commits in compare range

- `0d7a3899` — docs(model): clarify Codex model-migration switching (#2748); no resolvable merged PR, direct-to-dev docs commit.
- `6567fd3b` — docs(model): revert misattributed model-switching guidance (nets to no docs change after the revert).

## Issue inventory

- Open issues at release prep: none tracked for this range.
- Closed issue coverage is represented by the merged PR inventory above.

## Version and lockfile audit

- Root `package.json` and `package-lock.json`: bumped to `0.18.11`.
- Root `Cargo.toml` workspace package version and root `Cargo.lock` workspace packages (`omx-api`, `omx-explore-harness`, `omx-mux`, `omx-runtime`, `omx-runtime-core`, `omx-sparkshell`): bumped to `0.18.11`.
- `plugins/oh-my-codex/.codex-plugin/plugin.json`: synced to `0.18.11`.
- `node dist/scripts/check-version-sync.js --tag v0.18.11`: PASS (`package=0.18.11 workspace=0.18.11 tag=v0.18.11`).

## Local validation evidence

Commands were run from the `omx-release-0.18.11` release worktree.

- [x] `npm ci` — PASS, `.omx/release-0.18.11/logs/npm-ci.log`.
- [x] `npm run build` — PASS, `.omx/release-0.18.11/logs/build.log`.
- [x] `node dist/scripts/check-version-sync.js --tag v0.18.11` — PASS, `.omx/release-0.18.11/logs/version-sync.log`.
- [x] `node dist/cli/omx.js --help` — PASS, `.omx/release-0.18.11/logs/cli-help.log`.
- [x] `node dist/cli/omx.js doctor` — PASS (13 passed, 4 environment-specific warnings, 0 failed), `.omx/release-0.18.11/logs/cli-doctor.log`.
- [x] `npm pack --dry-run` — PASS, `.omx/release-0.18.11/logs/npm-pack-dry-run.log` (`oh-my-codex-0.18.11.tgz`, package size `3.9 MB`, unpacked size `24.2 MB`, `3049` files).
- [x] `npm run smoke:packed-install` — PASS, `.omx/release-0.18.11/logs/smoke-packed-install.log`.
- [x] `git diff --check` — PASS, `.omx/release-0.18.11/logs/git-diff-check.log`.
- [x] `node dist/scripts/generate-release-body.js ... --current-tag v0.18.11 --previous-tag v0.18.10` — validated against a local annotated `v0.18.11` tag at the release-prep commit; generated body retains the full compare-range PR inventory, the `## Contributors` section, and the `**Full Changelog**: v0.18.10...v0.18.11` line.

## CI / publication evidence

- [ ] Release-prep `dev` CI green — pending after push/merge to dev.
- [ ] Main promotion CI green — pending after main fast-forward.
- [ ] Tag-triggered release workflow — pending after `v0.18.11` tag push.
- [ ] GitHub release proof — pending.
- [ ] npm proof — pending.

## Current readiness verdict

Local release prep for `0.18.11` is ready to push: version sync, build, CLI smoke (`--help`, `doctor`), package dry-run, packed-install smoke, and release-body generation all passed. Remote branch CI, main promotion, tag workflow, GitHub release proof, and npm proof remain the final publication gates.
