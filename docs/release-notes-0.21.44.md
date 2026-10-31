# oh-my-codex 0.21.44

`0.21.44` fixes the native runtime hydration timeout/abort path reported in #3968.

## Highlights

- **NATIVE RUNTIME HYDRATION (#3977):** Increase postinstall hydration's timeout from 15 seconds to 120 seconds. Timed-out hydration now reports an explicit timeout and underlying error context, with diagnostic URLs redacted.
- **FOREGROUND RECOVERY:** Add `omx native-runtime hydrate` to retry hydration in the foreground and report failures. For the affected unsupported Process identity readiness state, `omx doctor` now points to this command and retains the note that session-pointer recovery works without the native runtime.
- **ACTIONABLE ASSET ERRORS:** Include sanitized manifest and archive URLs and underlying fetch/read errors in native asset hydration diagnostics.

## Fixes and compatibility

- The change targets the runtime hydration timeout/abort failure described by #3968. It does not claim that every possible cause of native Process identity provider unavailability is resolved.
- No breaking API changes. `package.json`, both npm lockfile version entries, the Cargo workspace and six workspace crates, and plugin metadata were already synchronized to `0.21.44` by #3976; the release branch does not bump them again.

## Known issues and exclusions

- Only the native runtime hydration timeout/abort fix in #3977 is a product change in this release. The other commits since `v0.21.43` carry prior release evidence, back-merge main into dev, and synchronize the development version.
- No unrelated changes merged to dev after the pinned source commit `a3a1a6b6c10020c50f1c7f666b0aceabe97115d0` are included.

## Compare-range metrics

At the pinned source commit, `v0.21.43..a3a1a6b6c10020c50f1c7f666b0aceabe97115d0` comprises **5 commits, 15 files changed, 367 insertions(+), and 39 deletions(-)**. The merged PRs in that range are #3974–#3977; #3977 is the only product change in this release.

## Merged PR inventory

| PR | Author | Title | Impact |
|---|---|---|---|
| [#3974](https://github.com/Yeachan-Heo/oh-my-codex/pull/3974) | @Yeachan-Heo | docs(release): record v0.21.43 publication evidence | Carry the prior release's publication evidence onto dev |
| [#3975](https://github.com/Yeachan-Heo/oh-my-codex/pull/3975) | @Yeachan-Heo | back-merge: main to dev for v0.21.43 | Synchronize dev with main after the prior release |
| [#3976](https://github.com/Yeachan-Heo/oh-my-codex/pull/3976) | @Yeachan-Heo | chore(dev): bump version to 0.21.44 | Align release-coupled development metadata |
| [#3977](https://github.com/Yeachan-Heo/oh-my-codex/pull/3977) | @Yeachan-Heo | fix: prevent native runtime hydration timeout abort | Extend hydration timeout, improve diagnostics, add foreground retry, and update the affected doctor hint |

## Validation

Local release gates and release-pipeline evidence are recorded in [release readiness](qa/release-readiness-0.21.44.md).

**Full Changelog**: [`v0.21.43...v0.21.44`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.43...v0.21.44)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
