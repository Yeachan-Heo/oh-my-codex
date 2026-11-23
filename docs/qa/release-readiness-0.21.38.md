# Release Readiness: v0.21.38

**Release Date:** 2026-10-27<br>
**Released By:** gaebal-gajae (autonomous release)<br>
**Baseline:** v0.21.37 (npm latest 0.21.37; tag commit `e03812664f1609d2e21654822ef5334819e13a90`)<br>
**Candidate:** pinned dev commit `b58d0ff78a9bef6f39f063fa6e40873643b2c0c2`<br>
**Range:** [`v0.21.37...v0.21.38`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.37...v0.21.38)

## Summary

**Patch release:** setup refresh now retires stale trust hashes from canonical OMX plugin-scoped Codex hook trust records after a plugin cache rebuild, rather than failing with `managed_trust_key_conflict` (#3924; fixes #3918). Third-party and malformed trust state remains fail-closed. No breaking API changes.

## Compare-range inventory

Previous released tag `v0.21.37` (commit `e03812664f1609d2e21654822ef5334819e13a90`) is an ancestor of the pinned dev candidate. The required merge of `origin/main` into the release branch was a no-op because `origin/main` (`2ade39d3ea71ddd6101e9c5750c89c729980b825`) is already an ancestor of the candidate.

`git log --reverse --format='%h %s' v0.21.37..b58d0ff78a9bef6f39f063fa6e40873643b2c0c2`:

```text
9d656883 fix(setup): self-heal stale OMX-owned plugin hook trust keys (#3918) (#3924)
73a504cc Merge remote-tracking branch 'origin/main' into back-merge/v0.21.37
70f6c942 Merge pull request #3926 from Yeachan-Heo/back-merge/v0.21.37
29c1d1c1 docs(release): record v0.21.37 publication evidence
2ade39d3 Merge pull request #3927 from Yeachan-Heo/release-evidence/0.21.37
ef4a172f Merge remote-tracking branch 'origin/main' into back-merge/main-to-dev-0.21.37
8e820833 Merge pull request #3928 from Yeachan-Heo/back-merge/main-to-dev-0.21.37
b58d0ff7 chore(dev): bump base version to 0.21.38 (#3929)
```

The exact candidate range is **8 commits**. `git diff --stat v0.21.37..b58d0ff78a9bef6f39f063fa6e40873643b2c0c2` reports **9 files changed, 279 insertions(+), 23 deletions(-)**. This includes the setup change and tests, synchronized 0.21.38 version metadata, and the previous release-readiness evidence update.

## PR inventory

| PR | Author | Title | Status / scope |
|---|---|---|---|
| [#3924](https://github.com/Yeachan-Heo/oh-my-codex/pull/3924) | @Yeachan-Heo | fix(setup): self-heal stale OMX-owned plugin hook trust keys (#3918) | Merged; fixes #3918 |
| [#3929](https://github.com/Yeachan-Heo/oh-my-codex/pull/3929) | @Yeachan-Heo | chore(dev): bump base version to 0.21.38 | Merged; development version metadata |
| [#3928](https://github.com/Yeachan-Heo/oh-my-codex/pull/3928) | @Yeachan-Heo | back-merge: main to dev for v0.21.37 | Merged; internal back-merge |
| [#3927](https://github.com/Yeachan-Heo/oh-my-codex/pull/3927) | @Yeachan-Heo | docs(release): record v0.21.37 publication evidence | Merged; internal release evidence |
| [#3926](https://github.com/Yeachan-Heo/oh-my-codex/pull/3926) | @Yeachan-Heo | back-merge: main to dev for v0.21.37 | Merged; internal back-merge |

PR #3925 (release v0.21.37) is the baseline tag commit and is excluded from this compare range.

## Known gaps

- #3898 (live-pin fix) remains blocked on an owner design decision; #3900 and #3907 are open drafts. On Codex 0.164.0, `.omx-live-pin` files in the plugin cache can invalidate hook approval. The workaround posted in #3898 disables the `oh-my-codex-local` plugin.
- No other compare-range PRs or user-facing changes are excluded.

## Version synchronization

All coupled version surfaces read `0.21.38`; no release-preparation version bump was added.

| Surface | Value / check |
|---|---|
| `package.json` | 0.21.38 |
| `package-lock.json` root package and root package entry | 0.21.38 |
| `Cargo.toml` workspace package | 0.21.38 |
| `Cargo.lock` OMX workspace packages | 0.21.38 |
| `plugins/oh-my-codex/.codex-plugin/plugin.json` | 0.21.38 |
| `src/cli/__tests__/version-sync-contract.test.ts` | Verifies package, plugin, and Cargo workspace alignment |

No stale `0.21.37` values remain in package, Cargo, plugin metadata, source version constants, or tests. Remaining `0.21.37` references in release collateral are intentional baseline/history references.

## Local gates

All commands below passed on the release branch at candidate `b58d0ff78a9bef6f39f063fa6e40873643b2c0c2`:

- ✓ `npm ci` (the prepare script build completed).
- ✓ `npm run build`.
- ✓ `npm run check:no-unused`.
- ✓ `npm run lint` (890 source files checked, no violations; Biome emitted its existing `linter.recommended` deprecation warning).
- ✓ `cargo check --workspace --locked`.
- ✓ `npm run build:runtime`.
- ✓ `npm run verify:plugin-bundle` (24 canonical skill directories and plugin metadata verified).
- ✓ Focused compiled tests: `setup-install-mode.test.js`, `doctor-warning-copy.test.js`, `version-sync-contract.test.js`, and `generate-release-body.test.js` via `node dist/scripts/run-test-files.js`; command exited successfully.

## CI gates

Pinned dev candidate: `b58d0ff78a9bef6f39f063fa6e40873643b2c0c2`.

- Dev push CI run [40581639661](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40581639661) completed successfully. Latest-per-name check runs, grouped by check name and selected by greatest check-run ID: **24 success, 1 skipped, 0 failures, 0 pending**.
- macOS Ralplan preflight security passed on Node 20 (job [122462383482](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40581639661/job/122462383482)) and Node 26.5.1 (job [122462383670](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40581639661/job/122462383670)).
- CI Status passed (job [122471807456](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40581639661/job/122471807456)).

## Release PR, publication, and back-merge

Release PR review/CI, main CI, tag/release workflow, npm registry readback, back-merge PR/CI, and release-branch cleanup evidence will be recorded in the publication-evidence update after each gate is complete. The back-merge to `dev` must be the final merge so that `origin/main` remains an ancestor of `origin/dev`.

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
