# Release readiness: oh-my-codex 0.18.17

## Scope

- Previous released tag: `v0.18.16`.
- Candidate branch during prep: `dev` / `origin/dev`.
- Candidate head at intake: `a0c834522` (`fix: recover ultragoal null get_goal loops (#3020)`).
- Selected release version: `0.18.17`.
- Release tag: `v0.18.17`.

## Release summary

`0.18.17` packages the post-`0.18.16` patch train:

- Ultragoal null-goal loop recovery (#3020).
- MSYS Team worker startup script path fixes (#3017).
- Ralplan terminal session state fix (#3015).
- Planning-gate state-write guard hardening (#3004/#3003 train).
- Windows psmux question renderer fix (#3014).
- Profile mention fallback, stop-keyword path, dependency maintenance, and related runtime reliability fixes.

Open PRs #3018 and #3010 are excluded from this release candidate because they remain blocked/dirty/draft at prep time.

## Compare-range inventory

Exact compare range used for release notes:

```sh
git log --oneline v0.18.16..origin/dev
```

Inventory at release prep:

- `a0c834522` — fix: recover ultragoal null get_goal loops (#3020)
- `f0d3d6167` — Fix MSYS team worker startup script paths (#3017)
- `10aa1b0d8` — Fix ralplan terminal session state (#3015)
- `437030a15` — [codex] Tighten planning gate state-write guards (#3004)
- `8131a2579` — Fix Windows psmux question renderer (#3014)
- `f8f847da0` — chore(deps-dev): bump @biomejs/biome from 2.5.0 to 2.5.1 (#3011)
- `4ce08fcc4` — chore(deps-dev): bump @types/node from 26.0.0 to 26.0.1 (#3012)
- `92e2152ab` — Fix profile Discord mention env fallback (#3009)
- `b0ca6d97b` — Fix stop keyword path false positive (#3008)
- `40db45c75` — [codex] fix ralplan gate fail (#3006)
- plus the planning/exact-role/runtime guard train between #2979 and #3003.

## Version metadata

- Root `package.json` and `package-lock.json`: bumped to `0.18.17`.
- Root `Cargo.toml` workspace package version and root `Cargo.lock` workspace packages: bumped to `0.18.17`.
- `plugins/oh-my-codex/.codex-plugin/plugin.json`: synced to `0.18.17`.
- Expected tag: `v0.18.17`.

## Local validation

Commands are run from the release prep checkout on branch `dev`.

- [x] `node src/scripts/check-version-sync.ts --tag v0.18.17` — PASS (`package=0.18.17 workspace=0.18.17 tag=v0.18.17`).
- [x] `npm run build` — PASS.
- [x] `npm run verify:native-agents` — PASS (`22` installable native agents, `37` setup prompt assets).
- [x] `npm run sync:plugin` — PASS (`29` canonical skill directories and plugin metadata synced).
- [x] `npm run verify:plugin-bundle` — PASS.
- [x] `node dist/scripts/generate-catalog-docs.js --check` — PASS (`catalog check ok`).
- [x] targeted runtime/cross-platform regression tests — PASS (`node dist/scripts/run-test-files.js dist/scripts/__tests__/codex-native-hook.test.js dist/ralplan/__tests__/runtime.test.js dist/cli/__tests__/team.test.js dist/cli/__tests__/ralph-goal-mode-contract.test.js dist/ultragoal/__tests__/artifacts.test.js`; 616 tests passed across targeted files).
- [x] `npm pack --dry-run` — PASS (`oh-my-codex-0.18.17.tgz`, package size `4.2 MB`, unpacked size `26.9 MB`, `3133` files).
- [x] `git diff --check` — PASS.

## Publication-stage validation

- [ ] `dev` CI is green for the release-prep commit.
- [ ] `main` CI is green after promotion.
- [ ] Annotated tag `v0.18.17` points to the intended shipped commit.
- [ ] Tag-triggered release workflow succeeds.
- [ ] GitHub release `v0.18.17` exists and is non-draft/non-prerelease.
- [ ] Native assets and manifest are attached.
- [ ] `npm view oh-my-codex version` returns `0.18.17` and `latest` points to `0.18.17`.

## Release collateral

- `CHANGELOG.md`
- `RELEASE_BODY.md`
- `docs/release-notes-0.18.17.md`
- `docs/qa/release-readiness-0.18.17.md`
