# Release Readiness: v0.21.42

**Release Date:** 2026-10-30<br>
**Released By:** gaebal-gajae (autonomous release)<br>
**Pinned dev candidate:** `815f2a26d140cbd157e88569b8fcdc8dc7e27f44`<br>
**Range:** [`v0.21.41...v0.21.42`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.41...v0.21.42)

## Summary

This patch release makes `omx team status` observational: it no longer performs monitor maintenance, state writes, or claim recovery, and remains usable against a read-only OMX root. An omitted team name resolves only when it uniquely matches the current leader. `omx tmux-hook status` reports absent configuration without initializing it. The release also normalizes native `get_goal` response envelopes, distinguishes a missing native tool from database/schema/context errors, and allows truthful non-terminal blocked checkpoints when verification is unavailable. It includes the history-mutation guard and fixture-stability work present in the actual tag-to-candidate range.

## Compare-range metrics

The pinned source range `v0.21.41..815f2a26d140cbd157e88569b8fcdc8dc7e27f44` contains **8 commits, 30 files changed, 867 insertions(+), and 116 deletions(-)**. At the release-preparation branch head, the full tag-to-release-head range contains **9 commits, 34 files changed, 1,023 insertions(+), and 135 deletions(-)** (`git log` and `git diff --shortstat`). The six merged PRs in the pinned source range are #3959 through #3964.

## PR inventory

| PR | Author | Title | Impact |
|---|---|---|---|
| [#3959](https://github.com/Yeachan-Heo/oh-my-codex/pull/3959) | @Yeachan-Heo | fix(history): detect same-mtime content mutations | Reject changed history content even when file size and modification time are restored |
| [#3960](https://github.com/Yeachan-Heo/oh-my-codex/pull/3960) | @Yeachan-Heo | docs: record v0.21.41 publication evidence | Carry prior-release publication evidence onto dev |
| [#3961](https://github.com/Yeachan-Heo/oh-my-codex/pull/3961) | @Yeachan-Heo | back-merge: main to dev for v0.21.41 | Back-merge the previous shipped main into dev |
| [#3962](https://github.com/Yeachan-Heo/oh-my-codex/pull/3962) | @Yeachan-Heo | chore(dev): bump version to 0.21.42 | Synchronize npm/package/plugin/Cargo development version surfaces |
| [#3963](https://github.com/Yeachan-Heo/oh-my-codex/pull/3963) | @nascyimento | fix: keep Team and tmux status commands read-only | Make status observational, resolve a unique current-leader team, and avoid initializing missing tmux-hook config; stabilize detached-launch and Windows test fixtures |
| [#3964](https://github.com/Yeachan-Heo/oh-my-codex/pull/3964) | @nascyimento | fix: handle native goal responses and unavailable tools | Normalize native goal response envelopes, classify unavailable tools, and preserve non-terminal blocked checkpoints |

The v0.21.42 candidate does not include #3965 (changes requested, split pending), nor #3939, #3900, #3907, #3915, or #3919. #3898 remains held for the owner design decision. No other user-facing changes in the exact compare range are excluded.

## Version synchronization

At tagged main commit `2fe1faf78775b8067e36a862760c4fe4b7831908`, all release-coupled version surfaces read `0.21.42`. The release branch did not double-bump the version; the subsequent dev-only `0.21.43` synchronization is kept separate from the tag.

| Surface | Verified value |
|---|---|
| `package.json` | `0.21.42` |
| `package-lock.json` root and root package entry | `0.21.42` |
| `Cargo.toml` workspace package | `0.21.42` |
| `Cargo.lock` six OMX workspace crates | `0.21.42` |
| `plugins/oh-my-codex/.codex-plugin/plugin.json` | `0.21.42` |
| `omx-capabilities.lock.json` | Does not embed a package version |
| Version constants/tests | No hard-coded `0.21.41` or `0.21.42` version constant; `src/cli/__tests__/version-sync-contract.test.ts` checks metadata alignment |

`node dist/scripts/check-version-sync.js --tag v0.21.42` passed. `cargo metadata --locked --format-version 1 --no-deps` reports `0.21.42` for all six OMX workspace crates. Remaining `0.21.41` references are historical release collateral and explicit prior-tag/compare references, not active version surfaces.

## Post-release development version

The separate dev-only version bump sets `package.json`, both npm lockfile root versions, `Cargo.toml`, all six OMX `Cargo.lock` workspace packages, and `plugins/oh-my-codex/.codex-plugin/plugin.json` to `0.21.43`. `node dist/scripts/check-version-sync.js --tag v0.21.43` and `cargo metadata --locked --format-version 1 --no-deps` passed with all six OMX crates at `0.21.43`. This is a development base version only; it does not create or move the published `v0.21.42` tag.

## Local gates

- ✓ `npm ci` completed.
- ✓ `npm run build` passed (TypeScript build/typecheck).
- ✓ `npm run build:runtime` passed; the native runtime is required by the focused state/Team tests.
- ✓ `npm run check:no-unused` passed.
- ✓ `npm run lint` passed across 898 files. Biome emitted its existing deprecation notice for `linter.rules.recommended` in `biome.json`.
- ✓ `npm run verify:generated` passed: plugin bundle, capabilities lock, prompt guidance, and generated catalog checks.
- ✓ Version sync check and locked Cargo metadata verification passed; all six OMX crates report `0.21.42`.
- ✓ Focused regressions passed across 13 compiled test files covering Team status, tmux-hook status, monitor read-only behavior, team identity, detached-launch/platform fixtures, native goal parsing, Ultragoal CLI/artifacts, and related hook contracts.
- The complete repository test suite was not run locally; the changed-surface regression matrix above is the local test gate.

## CI gates

Pinned dev candidate: `815f2a26d140cbd157e88569b8fcdc8dc7e27f44`.

- Dev push CI run [41006632881](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41006632881) completed successfully. Latest per-name results: 18 success, 7 skipped, 0 failed, 0 pending across 25 unique job names.
- macOS Ralplan preflight security passed on Node 20 (job [123902962229](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41006632881/job/123902962229)) and Node 26.5.1 (job [123902962178](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41006632881/job/123902962178)); CI Status passed (job [123908685619](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41006632881/job/123908685619)).
- The seven skipped jobs are event/path-conditional (including release publishing and platform-specific native/Rust checks); release-PR, main, Release, and npm gates were run separately below.
- Release PR [#3966](https://github.com/Yeachan-Heo/oh-my-codex/pull/3966) exact head `f6c37c9128cd2b52c1ef0a95591af4fd51d4f780` passed CI run [41010426381](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41010426381): 24 success, 1 skipped, 0 failed, 0 pending across 25 unique job names. Both macOS Ralplan preflights and CI Status passed; PR Size Label, Draft Check, and PR Base Guidance passed. Codex review completed on that exact head with no findings, and the in-thread findings gate printed `[]` immediately before merge.
- After release PR #3966 merged to main, push CI run [41012631857](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41012631857) passed: 24 success, 1 skipped, 0 failed, 0 pending across 25 unique job names. macOS Ralplan preflights passed on Node 20 (job [123921773926](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41012631857/job/123921773926)) and Node 26.5.1 (job [123921773898](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41012631857/job/123921773898)); CI Status passed (job [123927559501](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41012631857/job/123927559501)).
- Publication-evidence PR [#3967](https://github.com/Yeachan-Heo/oh-my-codex/pull/3967) merged to main at `76b85d41684fdadc4eb2360ca4d599f48104a9a7`. Its push CI run [41021786846](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41021786846) passed: 24 success, 1 skipped, 0 failed, 0 pending across 25 unique job names; both macOS Ralplan preflights and CI Status passed.
- Back-merge PR [#3969](https://github.com/Yeachan-Heo/oh-my-codex/pull/3969) exact head `1eb9f8b4ec24469c1d016730b4d9c2919e800f16` passed dispatched full CI run [41024092775](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41024092775): 24 success, 1 skipped, 0 failed, 0 pending across 25 unique job names. The path-based PR CI run skipped source lanes, so full CI was explicitly dispatched on the back-merge head; both macOS Ralplan preflights (Node 20 job [123958034166](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41024092775/job/123958034166), Node 26.5.1 job [123958034138](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41024092775/job/123958034138)) and CI Status (job [123963038974](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41024092775/job/123963038974)) passed. Codex review completed on the exact head with no findings; the in-thread findings gate printed `[]` immediately before merge.
- The main-to-dev merge commit `3234668fe86b001d797dea41522a1285a11c7ebc` has parents `815f2a26d140cbd157e88569b8fcdc8dc7e27f44` (dev) and `76b85d41684fdadc4eb2360ca4d599f48104a9a7` (main with publication evidence). Dev push CI run [41025797433](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41025797433) completed successfully: 3 success, 16 skipped, 0 failed, 0 pending across 19 unique job names. `git merge-base --is-ancestor origin/main origin/dev` passed at the back-merge commit.

## Release PR, publication, and back-merge

Release PR [#3966](https://github.com/Yeachan-Heo/oh-my-codex/pull/3966) merged to main at `2fe1faf78775b8067e36a862760c4fe4b7831908` (2026-10-30T06:11:27Z). The installed `gh pr merge` does not support `--match-head-commit`; the GitHub merge API was used with the exact head SHA pinned. Branch protection had one required approval as the only blocker; the pinned merge succeeded with the authorized credential. The findings gate printed `[]` immediately before the merge.

The annotated tag `v0.21.42` points to `2fe1faf78775b8067e36a862760c4fe4b7831908`. Tag-triggered Release workflow [41014915631](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41014915631) completed successfully (11 success, 0 skipped or failed). GitHub Release [v0.21.42](https://github.com/Yeachan-Heo/oh-my-codex/releases/tag/v0.21.42) is published, non-draft, and non-prerelease, with 57 assets including `native-release-manifest.json`. The generated body has the correct v0.21.42 title and full changelog link, and describes Team/tmux read-only status, native goal reconciliation, and history mutation protection. Its contributor line was reviewed against the GitHub compare API (merged-code identities `@clawdbot`, `@nascyimento`, and `@Yeachan-Heo`); the local shortlog-only preview was not accepted because it used display names from release-prep commits.

Trusted npm publishing was explicitly dispatched on `main` for `release_tag=v0.21.42` and full `release_sha=2fe1faf78775b8067e36a862760c4fe4b7831908`. CI run [41017238805](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41017238805) completed successfully (25 success, 0 skipped or failed); publish job [123936245266](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41017238805/job/123936245266) passed. Registry readback: `npm view oh-my-codex dist-tags.latest` → `0.21.42`; `npm view oh-my-codex@0.21.42 version gitHead` → version `0.21.42`, gitHead `2fe1faf78775b8067e36a862760c4fe4b7831908`.

Publication-evidence PR #3967 is included in the single merge-commit back-merge PR #3969. The next development base version is synchronized separately to `0.21.43` after the back-merge; that change does not move or republish the `v0.21.42` tag.

## Final publication evidence

Published version: `0.21.42`. Main/tag/npm commit: `2fe1faf78775b8067e36a862760c4fe4b7831908`. Release workflow: [41014915631](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41014915631), success. GitHub Release: [v0.21.42](https://github.com/Yeachan-Heo/oh-my-codex/releases/tag/v0.21.42), non-draft/non-prerelease, 57 assets. npm latest is `0.21.42`; package `gitHead` is `2fe1faf78775b8067e36a862760c4fe4b7831908`.

Back-merge evidence: PR [#3969](https://github.com/Yeachan-Heo/oh-my-codex/pull/3969) merged with commit `3234668fe86b001d797dea41522a1285a11c7ebc`; its exact-head findings gate was `[]`, full CI and both macOS preflights passed, and main is an ancestor of dev. The dev-only version-bump PR and final checks are recorded in that follow-up; the final ancestry check and remote release/back-merge/bump/evidence branch cleanup remain to be verified after it merges.

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
