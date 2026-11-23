# oh-my-codex 0.21.43

`0.21.43` is a small patch release that corrects the native process identity recovery guidance shown by `omx doctor`.

## Highlights

- **PROCESS IDENTITY RECOVERY GUIDANCE (#3971):** When the native process identity provider is unsupported or unavailable, `omx doctor` recommends `omx update` to hydrate the release-asset runtime cache. The guidance retains that session pointer recovery works without the native runtime.

## Fixes and compatibility

- Removed `omx setup` from the Process identity cache-repair hint; setup does not repair the native runtime cache. Other failure cases retain their existing reinstall/update guidance.
- No breaking API changes. Package, npm lockfile, Cargo workspace/lockfile, and plugin metadata were already synchronized to `0.21.43` by #3970; the release branch does not double-bump them.

## Known issues and exclusions

- The separate provider-unavailable report in #3968 (reporter Kevin-wenyu) remains unconfirmed; evidence was requested. This release corrects the remediation text and does not claim to fix the underlying reported provider failure.
- #3898 remains held for the owner design decision. Related PRs #3939, #3900, #3907, #3915, and #3919 remain excluded.
- #3965 is not included; changes were requested and the work is split pending. No other user-visible changes in this compare range are excluded.

## Compare-range metrics

At the release branch head, `v0.21.42..HEAD` comprises **7 commits, 12 files changed, 173 insertions(+), and 37 deletions(-)**, measured with `git log` and `git diff --shortstat`. The five merged PRs in the compare range are #3967, #3969, #3970, #3971, and #3972; the seventh commit is release preparation.

## Merged PR inventory

| PR | Author | Title | Impact |
|---|---|---|---|
| [#3967](https://github.com/Yeachan-Heo/oh-my-codex/pull/3967) | @Yeachan-Heo | docs(release): record v0.21.42 publication evidence | Carry previous-release publication evidence onto dev |
| [#3969](https://github.com/Yeachan-Heo/oh-my-codex/pull/3969) | @Yeachan-Heo | back-merge: main to dev for v0.21.42 | Synchronize dev with the previously shipped main |
| [#3970](https://github.com/Yeachan-Heo/oh-my-codex/pull/3970) | @Yeachan-Heo | chore(dev): bump version to 0.21.43 | Align release-coupled development metadata |
| [#3971](https://github.com/Yeachan-Heo/oh-my-codex/pull/3971) | @Yeachan-Heo | Fix misleading process identity doctor repair guidance | Remove the ineffective setup suggestion while retaining runtime-cache update and session-pointer guidance |
| [#3972](https://github.com/Yeachan-Heo/oh-my-codex/pull/3972) | @Yeachan-Heo | docs(release): finalize v0.21.42 readiness evidence | Finalize evidence for the previous release |

## Validation

- Pinned dev head `43d2d21f833ba6ff62d10807127b76eca8f0aea4` passed CI run [41032241638](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41032241638): CI Status and Docs Check passed; remaining source lanes, including macOS Ralplan preflights, were skipped by docs-only change detection. The preflight successes on source commit `72340934a318b9b3f0ca7c8e63d415bcc831d082` are in run [41029069165](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41029069165), Node 20 job [123974337084](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41029069165/job/123974337084) and Node 26.5.1 job [123974337061](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41029069165/job/123974337061). These earlier preflights do not substitute for release-PR, main, or back-merge gates.
- Release-branch build, typecheck, focused tests, version synchronization, and publication evidence are recorded in [release readiness](qa/release-readiness-0.21.43.md).

**Full Changelog**: [`v0.21.42...v0.21.43`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.42...v0.21.43)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
