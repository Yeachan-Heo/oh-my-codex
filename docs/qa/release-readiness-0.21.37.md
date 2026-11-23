# Release Readiness: v0.21.37

**Release Date:** 2026-10-27<br>
**Released By:** gaebal-gajae (autonomous release)<br>
**Baseline:** v0.21.36 (npm latest 0.21.36; tag commit `fe09b80e76e85105c10840730bdca5397247a9e4`)<br>
**Range:** [`v0.21.36...v0.21.37`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.36...v0.21.37)

## Summary

**Patch release:** npm global-install ownership detection now handles a custom global prefix, and plugin-cache diagnostics distinguish malformed completion markers from marker-version and claim-digest mismatches.

- **Fix:** Recognize npm-managed global installs when npm's global prefix differs from the active Node runtime path, while keeping ownership validation fail-closed (#3922; fixes #3920).
- **Fix:** Report malformed plugin-cache completion markers, marker-version mismatches, and claim-digest mismatches separately in setup/doctor; provenance semantics are unchanged (#3923; fixes #3921).
- **Dependencies:** @modelcontextprotocol/sdk 1.32.1 → 1.32.2 (runtime, #3917); @biomejs/biome 2.5.15 → 2.6.2 (development only, #3916).
- **Breaking changes:** None.

## Compare-range inventory

Previous released tag `v0.21.36` is an ancestor of pinned dev candidate `18963b5604aa296d4fe8a019651d0ddef9584106`. `origin/main` (`6b1c110ec06b45a5644ceb6ee60788f7ccae6c46`) is already an ancestor of the candidate, so merging it into the release branch was a no-op.

`git log --oneline --decorate v0.21.36..18963b5604aa296d4fe8a019651d0ddef9584106`:

```text
18963b56 fix(plugin-cache): distinguish claim digest diagnostics (#3921) (#3923)
ed1606dd fix(update): detect npm ownership with custom global prefix (#3922)
f68a3b2f chore(deps-dev): bump @biomejs/biome from 2.5.15 to 2.6.2
fd36388a chore(deps): bump @modelcontextprotocol/sdk from 1.32.1 to 1.32.2
f6c7696a Merge pull request #3914 from Yeachan-Heo/back-merge/0.21.36-readiness
6b1c110e Merge pull request #3913 from Yeachan-Heo/release-evidence/0.21.36
d39ae34d docs(release): record v0.21.36 publication evidence
6194ce4f Merge pull request #3912 from Yeachan-Heo/version-bump/0.21.37
632119d4 chore(dev): bump base version to 0.21.37
53dc9e1b Merge pull request #3911 from Yeachan-Heo/back-merge/v0.21.36
```

At the pinned source candidate, `git diff --stat v0.21.36..18963b5604aa296d4fe8a019651d0ddef9584106` reports **11 files changed, 423 insertions(+), 58 deletions(-)**. The diff includes the new behavior/tests, dependency lock updates, 0.21.37 metadata, and an update to the previous release's readiness evidence. This is the pinned source-range stat; release collateral on the release branch is tracked separately in the final PR evidence below.

The initial release-collateral branch head contained 12 commits in `v0.21.36..HEAD`; `git diff --stat v0.21.36..HEAD` reported **15 files changed, 621 insertions(+), 73 deletions(-)**, including the four release-collateral files. Release PR and later readiness evidence are recorded separately below and will be included in the final PR-head range stat.

At the final tag target `e03812664f1609d2e21654822ef5334819e13a90`, `git log v0.21.36..e03812664f1609d2e21654822ef5334819e13a90` contains **15 commits** and `git diff --stat` reports **15 files changed, 625 insertions(+), 73 deletions(-)**. This is the exact released tag-target range, including release collateral and the release PR merge commit.

## PR inventory

| PR | Author | Title | Status / scope |
|---|---|---|---|
| [#3923](https://github.com/Yeachan-Heo/oh-my-codex/pull/3923) | @Yeachan-Heo | fix(plugin-cache): distinguish claim-digest mismatch from malformed marker | Merged; fixes #3921 |
| [#3922](https://github.com/Yeachan-Heo/oh-my-codex/pull/3922) | @Yeachan-Heo | fix(update): detect npm ownership with a custom global prefix | Merged; fixes #3920 |
| [#3917](https://github.com/Yeachan-Heo/oh-my-codex/pull/3917) | @dependabot | chore(deps): bump @modelcontextprotocol/sdk from 1.32.1 to 1.32.2 | Merged; runtime dependency |
| [#3916](https://github.com/Yeachan-Heo/oh-my-codex/pull/3916) | @dependabot | chore(deps-dev): bump @biomejs/biome from 2.5.15 to 2.6.2 | Merged; development dependency |
| [#3914](https://github.com/Yeachan-Heo/oh-my-codex/pull/3914) | @Yeachan-Heo | chore(back-merge): v0.21.36 readiness evidence to dev | Merged; internal back-merge |
| [#3913](https://github.com/Yeachan-Heo/oh-my-codex/pull/3913) | @Yeachan-Heo | docs(release): record v0.21.36 publication evidence | Merged; internal release evidence |
| [#3912](https://github.com/Yeachan-Heo/oh-my-codex/pull/3912) | @Yeachan-Heo | chore(dev): bump base version to 0.21.37 | Merged; development version metadata |
| [#3911](https://github.com/Yeachan-Heo/oh-my-codex/pull/3911) | @Yeachan-Heo | chore(back-merge): v0.21.36 to dev | Merged; internal back-merge, no content changes |

## Not included / known gaps

- #3924 (fix for #3918) remains in its separate review and is not included in this release; it is planned for a later release. It was not pulled into the release branch.
- #3898 (live-pin fix) remains blocked on an owner design decision; #3900 and #3907 are open drafts. On Codex 0.164.0, `.omx-live-pin` files in the plugin cache can invalidate hook approval. The workaround posted in #3898 disables the `oh-my-codex-local` plugin.

## Version synchronization

All coupled version surfaces already read `0.21.37`; no version bump was added during release preparation.

| Surface | Value |
|---|---|
| `package.json` | 0.21.37 |
| `package-lock.json` root package and package entry | 0.21.37 |
| `Cargo.toml` workspace package | 0.21.37 |
| `Cargo.lock` OMX workspace packages | 0.21.37 |
| `plugins/oh-my-codex/.codex-plugin/plugin.json` | 0.21.37 |
| `src/cli/__tests__/version-sync-contract.test.ts` | verifies package/plugin/Cargo workspace alignment |

No stale `0.21.36` values remain in package, Cargo, plugin metadata, source version constants, or tests; references in historical release records and this release's baseline/compare range are intentional.

## Local gates

All local gates below passed on the release branch at source candidate `18963b5604aa296d4fe8a019651d0ddef9584106`:

- ✓ `npm ci` (172 packages; the `prepare` script's build completed).
- ✓ `npm run build`.
- ✓ `npm run check:no-unused`.
- ✓ `npm run lint` (890 files, no violations; Biome printed a deprecation warning for the existing `linter.recommended` config field).
- ✓ `cargo check --workspace --locked`.
- ✓ `npm run build:runtime`.
- ✓ `npm run verify:plugin-bundle` (24 canonical skill directories and plugin metadata).
- ✓ Focused compiled tests: `update.test.js`, `plugin-cache-symlink-provenance-3552.test.js`, `doctor-warning-copy.test.js`, `version-sync-contract.test.js`, and `generate-release-body.test.js` via `node dist/scripts/run-test-files.js`; all test files exited successfully.
- ✓ After the first release-PR CI run failed one pre-existing real-tmux assertion, the entire `launch-fallback.test.js` file passed locally (39 tests, 0 failures), including the specific detached-HUD restoration test.
- ✓ `git diff --check`.
- ✓ Ran `node dist/scripts/generate-release-body.js` before pushing the tag; the generated body contained the correct `v0.21.36...v0.21.37` compare link and release highlights. Local generation used the shortlog fallback. Contributors were checked against merged PR authors, and the published GitHub Release body was corrected to the curated sentence in `RELEASE_BODY.md`; this notes-only update did not move the tag or change the npm package.

## CI gates

Pinned dev candidate: `18963b5604aa296d4fe8a019651d0ddef9584106`.

- Dev push CI run [40535642484](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40535642484) completed successfully. Latest-per-name check runs: **17 success, 8 skipped, 0 failures**.
- macOS Ralplan preflight security passed on Node 20 (job [122300847593](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40535642484/job/122300847593)) and Node 26.5.1 (job [122300847597](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40535642484/job/122300847597)).
- CI Status check passed (job [122309452327](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40535642484/job/122309452327)).
- Latest-per-name totals were computed from the commit checks endpoint by grouping check runs by name and selecting the greatest check-run ID; no failures or pending checks remained.

## Release PR, merge, and publication

- Release PR [#3925](https://github.com/Yeachan-Heo/oh-my-codex/pull/3925), initial head `9d95e0789ff62b82e19c0b7256975decc4adb609`.
- Initial PR CI run [40542865035](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40542865035) had 25 success, 1 skipped, and 1 failure. The sole failed job was `Test (Node 20 / cli-core-rest)` (job [122325983906](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40542865035/job/122325983906)); one unrelated existing tmux test in `launch-fallback.test.js` observed HUD height 7 instead of the expected 2. That test file is unchanged by this release diff; the pinned dev candidate's CI was green, and the same full file passed locally after the failure. This run was not treated as green; the later exact-head run below passed before merge.
- Final PR head `8d99e2250064f6f6586edae75c9fde16109c224a` passed CI run [40551755557](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40551755557): latest-per-name checks were **27 success, 1 skipped, 0 failures**; CI Status passed (job [122368153435](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40551755557/job/122368153435)). Both release-PR macOS Ralplan preflights passed: Node 20 (job [122357194659](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40551755557/job/122357194659)) and Node 26.5.1 (job [122357194857](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40551755557/job/122357194857)).
- Codex code review completed on exact PR head `8d99e2250064f6f6586edae75c9fde16109c224a` with no findings. Immediately before merge, the required inline-thread gate printed `[]`.
- PR #3925 merged with merge commit `e03812664f1609d2e21654822ef5334819e13a90` (also the release tag target).
- Main CI run [40556340874](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40556340874) completed successfully: latest-per-name checks were **24 success, 1 skipped, 0 failures**; CI Status passed (job [122384310835](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40556340874/job/122384310835)). Both macOS Ralplan preflights passed: Node 20 (job [122373400548](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40556340874/job/122373400548)) and Node 26.5.1 (job [122373400618](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40556340874/job/122373400618)).
- Annotated tag `v0.21.37` peels to `e03812664f1609d2e21654822ef5334819e13a90`; it is published on main.
- Release workflow [40560295624](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40560295624) completed successfully. GitHub Release [v0.21.37](https://github.com/Yeachan-Heo/oh-my-codex/releases/tag/v0.21.37) was published at `2026-10-27T18:41:28Z`, is non-draft/non-prerelease, and has 57 assets including `native-release-manifest.json`.
- Trusted npm workflow run [40564569702](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40564569702) completed successfully; `Publish npm (trusted publishing)` job [122402270471](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40564569702/job/122402270471) passed.
- Registry readback: `npm view oh-my-codex dist-tags.latest` returned `0.21.37`; `npm view oh-my-codex@0.21.37 gitHead` returned `e03812664f1609d2e21654822ef5334819e13a90`, matching `v0.21.37^{commit}` and `main`.

## Back-merge and cleanup

- Back-merge PR from `main` to `dev` using a merge commit: pending.
- Back-merge CI and inline-thread gate: pending.
- Release branch cleanup: pending.

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
