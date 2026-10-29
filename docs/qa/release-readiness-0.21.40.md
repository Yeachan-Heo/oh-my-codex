# Release Readiness: v0.21.40

**Release Date:** 2026-10-29<br>
**Released By:** gaebal-gajae (autonomous release)<br>
**Candidate base:** pinned dev commit `87ace943784fa5873e5f8b39edc6686d8bbadde8`<br>
**Range:** [`v0.21.39...v0.21.40`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.39...v0.21.40)

## Summary

This patch release fixes session-pointer ownership when a live `codex app-server --managed-daemon` process has been recorded as the OMX owner. A verified managed daemon no longer blocks resume or fresh launch; recovery is available through `omx session pointer recover` and doctor guidance. Live interactive OMX owners remain protected, and uncertain process identity continues to fail closed. The issue was reported by @nascyimento (#3946), and the fix landed as #3949.

The compare range also contains the test-only interleaved tmux shim-log follow-up (#3941) and the v0.21.39 release-train evidence, back-merge, and v0.21.40 development-version synchronization (#3943–#3945).

## Compare-range metrics

`git log --oneline v0.21.39..<release head>` reports **8 commits**. `git diff --stat v0.21.39..<release head>` reports **19 files changed, 777 insertions(+), 91 deletions(-)**, including the release collateral in this report.

## PR inventory

| PR | Author | Title | Impact |
|---|---|---|---|
| [#3941](https://github.com/Yeachan-Heo/oh-my-codex/pull/3941) | @Yeachan-Heo | test: keep interleaved tmux shim records | Test-only regression coverage for complete interleaved records and unfinished-tail safety |
| [#3943](https://github.com/Yeachan-Heo/oh-my-codex/pull/3943) | @Yeachan-Heo | chore(dev): bump base version to 0.21.40 | Synchronize package, lockfile, Cargo, and plugin version surfaces |
| [#3944](https://github.com/Yeachan-Heo/oh-my-codex/pull/3944) | @Yeachan-Heo | docs: record v0.21.39 publication evidence | Prior-release publication evidence on dev |
| [#3945](https://github.com/Yeachan-Heo/oh-my-codex/pull/3945) | @Yeachan-Heo | back-merge: main to dev for v0.21.39 | Internal merge from shipped main to dev |
| [#3949](https://github.com/Yeachan-Heo/oh-my-codex/pull/3949) | @Yeachan-Heo | fix(session): don't let a managed Codex daemon own the OMX session pointer | Managed-daemon pointer recognition, recovery action, and fail-closed safeguards (#3946) |

All commits from `v0.21.39` through the pinned candidate are accounted for by these PRs and release-train merge commits. PRs #3939, #3900, #3907, and #3915 are not in the compare range and remain excluded; #3898 is held for the owner design decision.

## Version synchronization

All coupled release surfaces remain at the development base `0.21.40`; this release candidate does not double-bump.

| Surface | Value / check |
|---|---|
| `package.json` | 0.21.40 |
| `package-lock.json` root package and root package entry | 0.21.40 |
| `Cargo.toml` workspace package | 0.21.40 |
| `Cargo.lock` six OMX workspace packages | 0.21.40 |
| `plugins/oh-my-codex/.codex-plugin/plugin.json` | 0.21.40 |
| `src/cli/__tests__/version-sync-contract.test.ts` | Checks package, plugin, Cargo workspace/member alignment, and lockfile format |

Remaining `0.21.39` references are historical v0.21.39 release collateral; no current package/version constant is stale.

## Local gates

- ✓ `npm ci` and `npm run build` completed successfully.
- ✓ `npm run check:no-unused` passed.
- ✓ `npm run lint` passed; Biome emitted the existing deprecation notice for `linter.rules.recommended`.
- ✓ Focused tests passed for `session.test.js`, `doctor-state-root-binding.test.js`, `launch-fallback.test.js`, `state-paths.test.js`, `version-sync-contract.test.js`, and `generate-release-body.test.js`.
- ✓ After `npm run build:runtime`, the focused native SessionStart scope test passed with `node --test --test-name-pattern='preserves canonical OMX session scope when native SessionStart arrives with a different id' dist/scripts/__tests__/codex-native-hook.test.js` (1/1).
- ✓ `npm run verify:plugin-bundle` verified 24 canonical skill directories and plugin metadata.
- ✓ `node dist/scripts/check-version-sync.js --tag v0.21.40` passed; `cargo metadata --locked --format-version 1 --no-deps` reports all six OMX packages at 0.21.40.
- ✓ `git diff --check` passed.
- The full 691-case `codex-native-hook.test.js` did not complete within the 300-second local test-runner limit after building `omx-runtime`; its initial pre-build attempt reported 42 failures because the runtime binary was unavailable. The focused native SessionStart case passed, and the pinned dev CI run is green. No full `cargo test --workspace` was run; Rust source is unchanged.

Release-body generation is run against the final merged-main commit immediately before the annotated tag is pushed, when the `v0.21.40` ref is available to the generator. Its release-body unit tests passed as part of the focused test set.

## CI gates

Pinned dev candidate: `87ace943784fa5873e5f8b39edc6686d8bbadde8`.

- Dev push CI run [40824315726](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40824315726) completed successfully. Latest-per-name checks: **18 success, 7 skipped, 0 failures, 0 pending**; all 25 check names were unique.
- macOS Ralplan preflight security passed on Node 20 (job [123283770572](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40824315726/job/123283770572)) and Node 26.5.1 (job [123283770409](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40824315726/job/123283770409)).
- CI Status passed (job [123288130258](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40824315726/job/123288130258)).

## Release PR, publication, and back-merge

Release PR [#3950](https://github.com/Yeachan-Heo/oh-my-codex/pull/3950) merged to `main` at `82cd0825f5fff6bfc3814e339d847c28af86bdb6`, the commit targeted by `v0.21.40`.

- GitHub Release [v0.21.40](https://github.com/Yeachan-Heo/oh-my-codex/releases/tag/v0.21.40) is published, not draft, with the v0.21.40 release body (published `2026-10-29T08:02:58Z`).
- Release workflow [40837914405](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40837914405) completed successfully, including native assets and smoke checks.
- npm publication CI dispatch [40841127103](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40841127103) completed successfully; the trusted-publishing job succeeded.
- Registry readback: `npm view oh-my-codex dist-tags.latest` reports `0.21.40`; `npm view oh-my-codex@0.21.40 version gitHead` reports version `0.21.40` and `gitHead` `82cd0825f5fff6bfc3814e339d847c28af86bdb6`.
- The annotated `v0.21.40` tag and npm package `gitHead` both resolve to `82cd0825f5fff6bfc3814e339d847c28af86bdb6`, the `main` commit at release.

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
