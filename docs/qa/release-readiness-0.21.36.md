# Release Readiness: v0.21.36

**Release Date:** 2026-10-25<br>
**Released By:** gaebal-gajae (autonomous release)<br>
**Baseline:** v0.21.35 (npm latest 0.21.35)<br>
**Range:** [`v0.21.35...v0.21.36`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.35...v0.21.36)

## Summary

**Patch release:** native-hook CLI error diagnostics now honor the configured OMX logs directory, fixing #3908.

- **Fix:** Route error logs through `omxLogsDir`; `OMX_ROOT` takes precedence over `OMX_STATE_ROOT`, and the existing project `.omx/logs` behavior remains unchanged when neither is configured.
- **Breaking changes:** None.
- **New dependencies:** None.

## Compare-range inventory

Previous release tag `v0.21.35` is an ancestor of the pinned dev candidate `4932ef923a15a5bf818f5b4fa2625d3259486275`.

`git log --oneline v0.21.35..4932ef923a15a5bf818f5b4fa2625d3259486275`:

```text
4932ef92 fix(native-hook): route CLI error logs through omxLogsDir (#3908) (#3909)
9fa425f6 Merge pull request #3906 from Yeachan-Heo/back-merge/v0.21.35
ace2072f chore(back-merge): v0.21.35 to dev
```

Source-range diff before release metadata/docs: 3 files changed, 206 insertions(+), 1 deletion(-). The #3906 back-merge contains no source changes.

The release candidate branch head included the release-preparation and readiness-evidence commits in addition to those three source-history commits. `git diff --stat v0.21.35..HEAD` on that head recorded 12 files changed, 373 insertions(+), and 32 deletions(-); this is the stat recorded in `CHANGELOG.md`. The final tag target is main's merge commit for PR #3910; the tag-to-tag log includes that additional merge wrapper, with no change to the diff stat.

## PR inventory

| PR | Author | Title | Status / scope |
|---|---|---|---|
| [#3909](https://github.com/Yeachan-Heo/oh-my-codex/pull/3909) | @Yeachan-Heo | fix(native-hook): route CLI error logs through omxLogsDir | Merged; fixes #3908 |
| [#3906](https://github.com/Yeachan-Heo/oh-my-codex/pull/3906) | @Yeachan-Heo | chore(back-merge): v0.21.35 to dev | Merged; internal back-merge, no content changes |

**Not included:** #3900 and #3907 are open drafts for #3898 (live-pin fix), blocked on an owner design decision. On Codex 0.164.0, `.omx-live-pin` files in the plugin cache can invalidate hook approval. The workaround posted in #3898 disables the `oh-my-codex-local` plugin.

## Local gates

Pinned source candidate: `4932ef923a15a5bf818f5b4fa2625d3259486275`; release-candidate tree has package/plugin/Cargo version `0.21.36`.

- ✓ `npm ci` (including its prepare build).
- ✓ `npm run build`.
- ✓ `npm run check:no-unused`.
- ✓ `npm run lint` (890 files; no violations).
- ✓ `cargo check --workspace --locked`.
- ✓ `npm run build:runtime`.
- ✓ `npm run verify:plugin-bundle` (24 canonical skill directories and plugin metadata).
- ✓ Focused native-hook log routing cases: 2 passed (OMX_ROOT and OMX_STATE_ROOT/precedence/cwd default).
- ✓ `dist/utils/__tests__/paths.test.js`: 39 passed, 1 skipped.
- ✓ `dist/cli/__tests__/version-sync-contract.test.js`: 2 passed.
- **Scope note:** The full `codex-native-hook.test.ts` file was not completed locally: the initial combined invocation lacked the built `omx-runtime`; after building it, the full-file runner exceeded the 300-second command timeout. The two release-specific native-hook cases passed separately with `target/debug` on `PATH`.

## CI gates

- Dev push CI for pinned source candidate, run [40160210335](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40160210335): latest-per-name checks 17 success, 8 skipped, 0 failures.
- macOS Ralplan preflight security (Node 20): PASSED, job 121070025433.
- macOS Ralplan preflight security (Node 26.5.1): PASSED, job 121070025331.
- Release PR [#3910](https://github.com/Yeachan-Heo/oh-my-codex/pull/3910), initial head `70de0bda3777cdee72358a870e771d2b2994e9de`, CI run [40162593104](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40162593104): latest-per-name checks 27 success, 1 skipped, 0 failures; CI Status passed (job 121080070861).
- Release-PR macOS Ralplan preflight security passed on Node 20 (job 121077109386) and Node 26.5.1 (job 121077109442).
- Release PR final head `d6ac201fe012a3bfbe977570ceb13900b4f56c47`, CI run [40164235209](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40164235209): latest-per-name checks 27 success, 1 skipped, 0 failures. Both macOS Ralplan preflights passed (Node 20 job 121081921230; Node 26.5.1 job 121081921174).
- Main merge-commit CI run [40165998238](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40165998238): 24 success, 1 skipped, 0 failures; both macOS Ralplan preflights passed (Node 20 job 121087083948; Node 26.5.1 job 121087083973).
- Tag-triggered Release workflow [40167751532](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40167751532) completed successfully; all 36 latest-per-name checks succeeded, and all 57 release assets including `native-release-manifest.json` were uploaded and smoke-verified.

## Release and back-merge gates

Release PR #3910's final Codex code review completed without findings on exact head `d6ac201fe012a3bfbe977570ceb13900b4f56c47`. Immediately before merge, the required inline-thread `jq` gate printed `[]`; the PR was merged as main commit `fe09b80e76e85105c10840730bdca5397247a9e4` using the exact pinned head SHA.

### Publication proof

- Annotated tag `v0.21.36` peels to `fe09b80e76e85105c10840730bdca5397247a9e4` (also the main merge commit).
- Trusted npm publishing workflow [40167766168](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40167766168) completed successfully, including tokenless OIDC publication and post-publish verification.
- Registry readback: `npm view oh-my-codex dist-tags.latest` returned `0.21.36`; `npm view oh-my-codex@0.21.36 gitHead` returned `fe09b80e76e85105c10840730bdca5397247a9e4`.
- GitHub Release [v0.21.36](https://github.com/Yeachan-Heo/oh-my-codex/releases/tag/v0.21.36) is non-draft and non-prerelease, with 57 assets including the native release manifest.
- The tag workflow's generated contributor line included release-preparation commit authors. After checking the merged PR authors, the published body was corrected to thank @Yeachan-Heo, matching the curated `RELEASE_BODY.md` contributor sentence. The tag and npm artifact were unchanged.

### Back-merge and development base

- Back-merge PR [#3911](https://github.com/Yeachan-Heo/oh-my-codex/pull/3911) merged with a merge commit, `53dc9e1b8bc3dfa899e650ca206dac88d57f76d7`, preserving `main` ancestry in `dev`.
- Back-merge PR CI run [40169875584](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40169875584): 37 success, 2 skipped, 0 failures; Ralplan preflights passed on Node 20 (job 121098397807) and Node 26.5.1 (job 121098397815). The inline-thread `jq` gate printed `[]` before merge.
- The Codex summary remained `running` on exact back-merge head `fe09b80e76e85105c10840730bdca5397247a9e4` after a manual review request; no inline comments or findings were returned. The merge proceeded after the exact-head gate remained clear and all checks were green.
- Post-back-merge dev CI run [40173275610](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40173275610): 24 success, 1 skipped, 0 failures; both macOS Ralplan preflights passed (Node 20 job 121108504328; Node 26.5.1 job 121108504217).
- Development base was bumped through PR [#3912](https://github.com/Yeachan-Heo/oh-my-codex/pull/3912), merge commit `6194ce4f2b524194a3f7d5f2ea8f25744de323dd`, to `0.21.37` across package, Cargo, and plugin metadata. Final dev CI run [40176539065](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40176539065): 24 success, 1 skipped, 0 failures.
- Release branch `release/omx-0.21.36` was deleted after publication and back-merge.

## Release notes

- Full Changelog link: [`v0.21.35...v0.21.36`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.35...v0.21.36)
- `RELEASE_BODY.md`: updated for 0.21.36.
- `docs/release-notes-0.21.36.md`: created from the full compare-range inventory.

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
