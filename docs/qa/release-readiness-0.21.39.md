# Release Readiness: v0.21.39

**Release Date:** 2026-10-28<br>
**Released By:** gaebal-gajae (autonomous release)<br>
**Baseline:** v0.21.38 (npm latest 0.21.38; tag commit `4bd3b7dc707ab51da9e41c448fb5f36103685442`)<br>
**Candidate base:** pinned dev commit `4c98c4775b0d33f78bdee02bb15ce43aa0505470`<br>
**Range:** [`v0.21.38...v0.21.39`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.38...v0.21.39)

## Summary

**Patch release:** recognizes GPT-6.1 Terra in the known Codex model catalog (#3933) and records canonical detached-session state roots so aliased-root leaders pass strict reuse checks (#3935). No breaking API changes. PRs #3936–#3938 improve test isolation and fixture synchronization only.

## Compare-range inventory

The previous released tag `v0.21.38` (commit `4bd3b7dc707ab51da9e41c448fb5f36103685442`) is an ancestor of the pinned dev candidate. The required merge of `origin/main` into the release branch was a no-op because `origin/main` at `4bd3b7dc707ab51da9e41c448fb5f36103685442` is already an ancestor of the candidate.

Source PR inventory from `git log --format='%h %s' v0.21.38..4c98c4775b0d33f78bdee02bb15ce43aa0505470`:

```text
4c98c477 feat(models): recognize GPT-6.1 Terra (#3933)
57c791a1 test: synchronize tmux logs and team event fixtures (#3938)
56231d3e test: wait for VSCode log stream completion (#3937)
4a17a328 test: isolate caller homes for each test file (#3936)
b1ec6bbc fix: publish canonical detached-session state roots (#3935)
cbcdc399 Merge pull request #3931 from Yeachan-Heo/back-merge/v0.21.38
```

The release candidate range contains **7 commits**: the six source commits above plus one release-preparation commit with synchronized 0.21.39 metadata and release collateral. `git diff --stat v0.21.38..<release head>` reports **25 files changed, 628 insertions(+), 99 deletions(-)**.

## PR inventory

| PR | Author | Title | Status / scope |
|---|---|---|---|
| [#3933](https://github.com/Yeachan-Heo/oh-my-codex/pull/3933) | @ev78394 | feat(models): recognize GPT-6.1 Terra | Merged; model catalog support |
| [#3935](https://github.com/Yeachan-Heo/oh-my-codex/pull/3935) | @ev78394 | fix: publish canonical detached-session state roots | Merged; canonical active-record root |
| [#3936](https://github.com/Yeachan-Heo/oh-my-codex/pull/3936) | @ev78394 | test: isolate caller homes for each test file | Merged; test-only home isolation |
| [#3937](https://github.com/Yeachan-Heo/oh-my-codex/pull/3937) | @ev78394 | test: wait for VSCode log stream completion | Merged; test-only write completion synchronization |
| [#3938](https://github.com/Yeachan-Heo/oh-my-codex/pull/3938) | @ev78394 | test: synchronize tmux logs and team event fixtures | Merged; test-only fixture synchronization |
| [#3931](https://github.com/Yeachan-Heo/oh-my-codex/pull/3931) | @Yeachan-Heo | back-merge: main to dev for v0.21.38 | Merged; internal back-merge |

The release PR for v0.21.38 (#3930) is the baseline tag commit and is excluded from this compare range. #3939 and #3900/#3907 are excluded: #3939 remains held for the #3898 design decision, and #3900/#3907 remain open.

## Known gaps

- #3898 remains held for the owner's design decision. On Codex 0.164.0, `.omx-live-pin` files inside the plugin cache can invalidate hook approval. The workaround posted in #3898 disables the `oh-my-codex-local` plugin.
- No other compare-range PRs or user-facing changes are excluded.

## Version synchronization

All coupled package surfaces are set to `0.21.39`.

| Surface | Value / check |
|---|---|
| `package.json` | 0.21.39 |
| `package-lock.json` root package and root package entry | 0.21.39 |
| `Cargo.toml` workspace package | 0.21.39 |
| `Cargo.lock` OMX workspace packages | 0.21.39 |
| `plugins/oh-my-codex/.codex-plugin/plugin.json` | 0.21.39 |
| `src/cli/__tests__/version-sync-contract.test.ts` | Verifies package, plugin, and Cargo workspace alignment |

Remaining `0.21.38` references are intentional baseline, historical, or prior-release collateral.

## Local gates

All commands below passed on the release branch after synchronizing package versions:

- ✓ `npm ci` (including the repository prepare step).
- ✓ `npm run build`.
- ✓ `npm run check:no-unused`.
- ✓ `npm run verify:plugin-bundle` (24 canonical skill directories and plugin metadata verified).
- ✓ `node dist/scripts/run-test-files.js dist/cli/__tests__/version-sync-contract.test.js dist/scripts/__tests__/generate-release-body.test.js` (2 version-sync tests and 6 release-body tests passed).
- ✓ `cargo metadata --locked --format-version 1 --no-deps` (all OMX workspace package versions report 0.21.39).
- ✓ `cargo test --locked --workspace` (285 tests passed across 14 suites).
- ✓ `git diff --check`.

## CI gates

Pinned dev candidate: `4c98c4775b0d33f78bdee02bb15ce43aa0505470`.

- Dev push CI run [40715501337](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40715501337) completed successfully. Latest-per-name jobs: **18 success, 7 skipped, 0 failures, 0 pending**.
- macOS Ralplan preflight security passed on Node 20 (job [122912178834](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40715501337/job/122912178834)) and Node 26.5.1 (job [122912178801](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40715501337/job/122912178801)).
- CI Status passed (job [122922743319](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40715501337/job/122922743319)).

## Release PR, publication, and back-merge

Release PR [#3942](https://github.com/Yeachan-Heo/oh-my-codex/pull/3942) merged to `main` at `8ca56c0634e6abd90284d54978b35559a7ac39df`, the commit targeted by `v0.21.39`.

- GitHub release [v0.21.39](https://github.com/Yeachan-Heo/oh-my-codex/releases/tag/v0.21.39) is published (not draft), at `2026-10-28T17:41:38Z`.
- Release workflow [40734711722](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40734711722) for tag `v0.21.39` completed successfully.
- npm publication workflow [40739996063](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40739996063) completed successfully.
- Registry readback: `oh-my-codex@0.21.39` reports version `0.21.39` and `gitHead` `8ca56c0634e6abd90284d54978b35559a7ac39df`; `npm view oh-my-codex dist-tags` reports `latest: 0.21.39`. The package `gitHead`, `v0.21.39^{commit}`, and `main` all resolve to the same commit.

The back-merge to `dev` must be a merge commit; the subsequent dev version bump is a separate squash PR. The final invariant is `git merge-base --is-ancestor origin/main origin/dev`.

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
