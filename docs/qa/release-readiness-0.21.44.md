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

## Review follow-up mirrored to dev

- The #3978 Codex P2 on foreground manifest HTTP errors was fixed in release commit `8c4b137d9718178fe1ead553b7f0624db6880614`: strict runtime hydration now surfaces the HTTP status and sanitized URL, while the install/update wrapper remains non-fatal. Regression coverage verifies a 503 response, URL-query redaction, and non-fatal continuation; the focused postinstall suite passed with 11 tests on both the release and dev branches.
- The same fix was cherry-picked to dev as `4ca88bd708b12899cbf52a79ca6aa712a866ea67` and merged through [#3979](https://github.com/Yeachan-Heo/oh-my-codex/pull/3979) at `71190daf4dd5a7da5103951c4a50fe5a28ed0710`.

## Release PR and main gates

- Release PR [#3978](https://github.com/Yeachan-Heo/oh-my-codex/pull/3978) head `8c4b137d9718178fe1ead553b7f0624db6880614` passed CI run [41196352882](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41196352882): 24 success, 1 skipped, 0 failed across 25 jobs. The skipped job was `Publish npm (trusted publishing)`, which was run separately after tag publication. PR Check run [41196350843](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41196350843) passed. Both macOS Ralplan preflights passed on the exact release head: Node 20 (job [124523227537](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41196352882/job/124523227537)) and Node 26.5.1 (job [124523227562](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41196352882/job/124523227562)). The exact-head Codex review completed with no findings. Review thread [4431474382](https://github.com/Yeachan-Heo/oh-my-codex/pull/3978#discussion_r4431474382) was answered in-thread; the required unanswered-thread gate printed `[]` immediately before merge.
- PR #3978 merged by squash at `46a277224a93fb610de83bee7f0c28dfd52f129c`.
- Main push CI run [41198130682](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41198130682) on that merge commit passed: 24 success, 1 skipped, 0 failed across 25 jobs. Both macOS Ralplan preflights ran and passed: Node 20 (job [124528391129](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41198130682/job/124528391129)) and Node 26.5.1 (job [124528391041](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41198130682/job/124528391041)). The skipped job was the separately dispatched npm publisher.

## Publication evidence

- Annotated tag `v0.21.44` points to `46a277224a93fb610de83bee7f0c28dfd52f129c`.
- Tag-triggered Release workflow [41199218868](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41199218868) succeeded: 11/11 jobs passed, including all seven native build targets, manifest verification, native asset smoke verification, and packed global-install smoke test.
- GitHub Release [v0.21.44](https://github.com/Yeachan-Heo/oh-my-codex/releases/tag/v0.21.44) is non-draft with `publishedAt` `2026-10-31T12:15:10Z`. Its generated body is titled `# oh-my-codex v0.21.44` and contains the foreground command, 120-second timeout, sanitized diagnostics, and `v0.21.43...v0.21.44` compare link.
- Trusted npm publishing was dispatched on `main` with `release_tag=v0.21.44` and full `release_sha=46a277224a93fb610de83bee7f0c28dfd52f129c`. CI run [41200976209](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41200976209), publish job [124536552163](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41200976209/job/124536552163), passed, including registry-visibility verification.
- Registry readbacks: `npm view oh-my-codex dist-tags.latest` → `0.21.44`; `npm view oh-my-codex@0.21.44 gitHead` → `46a277224a93fb610de83bee7f0c28dfd52f129c`.

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
