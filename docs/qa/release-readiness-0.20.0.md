# Release readiness — 0.20.0

## Compare range

- Previous released tag: `v0.19.1`
- Released tag: `v0.20.0` -> commit `456effa2afcb7967e8ba7130ee15b2835c235d72`
- Ancestry: `v0.19.1` is an ancestor of `v0.20.0`; `v0.20.0` is on `main` and `dev`.
- Full compare: `v0.19.1...v0.20.0` (21 commits)

## PR inventory

#3079, #3080, #3082, #3085, #3086, #3087, #3088, #3091, #3092, #3094, #3097, #3099, #3100, #3102, #3104

Plus the direct in-branch GPT-5.6 migration commits (no separate PRs): `3e579633` (feat: migrate model contract to GPT-5.6 sol/terra/luna), `0ac484e0` (fix: resolve migration review blockers), `51ee0c28` (fix: doctor spark source labeling + alias docs), and release-collateral commits `1ef0b8ce`, `5f5150d2`, `456effa2`.

## Local gates

- `npm run build` — pass.
- `node src/scripts/check-version-sync.ts` — pass (`package=0.20.0 workspace=0.20.0`).
- Version bump synced across `package.json`, `package-lock.json`, `Cargo.toml [workspace.package]`, `Cargo.lock`, and `plugins/oh-my-codex/.codex-plugin/plugin.json`.
- `node dist/scripts/sync-plugin-mirror.js --check` — verified 29 canonical skill directories and plugin metadata.
- Node suite: `npm test` — 370/371 test files pass. The single failure (`dist/cli/__tests__/resume.test.js`, "preserves transcript mtimes while materializing runtime history for updated sort") is a pre-existing macOS-only environment issue: the test's fake codex uses GNU `stat -c`, unavailable on BSD/macOS. Reproduced identically on the pre-migration commit `5a6c454b`; passes on Linux CI.
- Rust workspace: `cargo test` — 237/237 pass.
- Migration quality gate: three architect review rounds (BLOCK -> COMMENT -> CLEAR/APPROVE) and three executor QA/red-team rounds; evidence artifacts under `artifacts/qa-gpt56/`, `artifacts/qa-gpt56-r2/`, `artifacts/qa-gpt56-r3/`, and release QA under `artifacts/qa-release-0200/`.

## CI run IDs

- dev CI (migration + fixes, `51ee0c28`): 29066232940 — success.
- dev CI (release prep, `1ef0b8ce`): 29066522175 — failure (stale plugin manifest version), fixed by `5f5150d2`.
- dev CI (`5f5150d2`): 29066777285 — success.
- dev CI (`456effa2`): 29068579015 — success.
- main CI (`5f5150d2`): 29067030836 — success; main CI (`456effa2`): 29068657404 — success.
- Tag `v0.20.0` release workflow: 29068946855 — success (an earlier tag attempt at `5f5150d2`, run 29067574902, failed on a missing `## Contributors` release-body section and the tag was recreated at `456effa2`).

## Publication proof

- GitHub release `v0.20.0` published (non-draft) with native assets and manifest.
- npm `oh-my-codex@0.20.0` published; `npm view oh-my-codex version` returns `0.20.0` with `gitHead` `456effa2`.

## Known gaps

- The initially published changelog/release-notes understated the full compare range; corrected post-publication by the collateral-accuracy follow-up (this commit) and `gh release edit`.
