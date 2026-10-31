# Release Readiness: v0.21.44

**Release Date:** 2026-10-31<br>
**Released By:** gaebal-gajae (autonomous release)<br>
**Pinned dev source:** `a3a1a6b6c10020c50f1c7f666b0aceabe97115d0`<br>
**Range:** [`v0.21.43...v0.21.44`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.43...v0.21.44)

## Summary

This release fixes the native runtime hydration timeout/abort path reported in #3968. Postinstall hydration now has a 120-second timeout rather than 15 seconds, timed-out failures expose sanitized diagnostic context, `omx native-runtime hydrate` retries in the foreground and reports errors, and the affected unsupported Process identity readiness hint in `omx doctor` points to that command. This is scoped to the hydration failure path and does not claim to remove unrelated causes of provider unavailability.

## Compare-range metrics

At pinned source `a3a1a6b6c10020c50f1c7f666b0aceabe97115d0`, `v0.21.43..HEAD` comprises **5 commits, 15 files changed, 367 insertions(+), and 39 deletions(-)**, measured with `git rev-list` and `git diff --shortstat`. The merged PRs are #3974–#3977; #3977 is the only product change.

## Merged PR inventory

| PR | Author | Title | Impact |
|---|---|---|---|
| [#3974](https://github.com/Yeachan-Heo/oh-my-codex/pull/3974) | @Yeachan-Heo | docs(release): record v0.21.43 publication evidence | Carry prior release publication evidence onto dev |
| [#3975](https://github.com/Yeachan-Heo/oh-my-codex/pull/3975) | @Yeachan-Heo | back-merge: main to dev for v0.21.43 | Synchronize dev with main after the prior release |
| [#3976](https://github.com/Yeachan-Heo/oh-my-codex/pull/3976) | @Yeachan-Heo | chore(dev): bump version to 0.21.44 | Align release-coupled development metadata |
| [#3977](https://github.com/Yeachan-Heo/oh-my-codex/pull/3977) | @Yeachan-Heo | fix: prevent native runtime hydration timeout abort | Extend hydration timeout, improve diagnostics, add foreground retry, and update the affected doctor hint |

## Version synchronization

The pinned dev source already reads `0.21.44` across every release-coupled version surface; the release branch does not bump these values again.

| Surface | Verified value |
|---|---|
| `package.json` | `0.21.44` |
| `package-lock.json` root and root package entry | `0.21.44` |
| `Cargo.toml` workspace package | `0.21.44` |
| `Cargo.lock` six OMX workspace crates | `0.21.44` |
| `plugins/oh-my-codex/.codex-plugin/plugin.json` | `0.21.44` |
| `node dist/scripts/check-version-sync.js --tag v0.21.44` | Passed |
| `cargo metadata --locked --format-version 1 --no-deps` | All six OMX workspace packages report `0.21.44` |

## Local gates

- `npm ci` — passed; locked install and lifecycle hooks completed.
- `npm run build` — passed.
- `npm test` — passed; full package test script completed, including the runtime build/tests, Node test suite, generated catalog check, and prompt-invariant check (29 skill cards checked).
- `npm run check:no-unused` — passed.
- `npm run lint` — passed across 900 files. Biome emitted the existing `linter.rules.recommended` deprecation notice from `biome.json`; no lint fixes were applied.
- Version synchronization checks — passed as listed above.

## Release PR and main gates

Not yet run at this readiness-document revision. Record the release PR's latest-per-name check results, macOS preflight status, in-thread review-thread gate, exact release head and merge commit, and green main-push CI run here before proceeding to tag creation.

## Publication evidence

Not yet run at this readiness-document revision. Record the annotated tag and target commit, successful tag-triggered Release run, successful trusted npm publishing dispatch, GitHub Release `publishedAt`, `npm view oh-my-codex dist-tags.latest`, and `npm view oh-my-codex@0.21.44 gitHead` here after all readbacks pass.

## Back-merge and post-release development base

Not yet run at this readiness-document revision. Record the merge-commit back-merge to dev (including this evidence commit), the subsequent dev-only `0.21.45` version bump, and the final `origin/main` ancestor check here after completion.

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
