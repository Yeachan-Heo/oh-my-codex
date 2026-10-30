# Release Readiness: v0.21.43

**Release Date:** 2026-10-30<br>
**Released By:** gaebal-gajae (autonomous release)<br>
**Pinned dev candidate:** `43d2d21f833ba6ff62d10807127b76eca8f0aea4`<br>
**Range:** [`v0.21.42...v0.21.43`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.42...v0.21.43)

## Summary

This patch release removes `omx setup` from the Process identity doctor hint because setup does not repair the native runtime cache. `omx update` hydrates that cache, and the message continues to explain that session pointer recovery works without the native runtime. The separate provider-unavailable report in #3968 is unconfirmed; this release does not claim to fix its underlying cause.

## Compare-range metrics

At the release branch head, `v0.21.42..HEAD` comprises **7 commits, 12 files changed, 173 insertions(+), and 37 deletions(-)**, measured with `git log` and `git diff --shortstat`. The five merged PRs in the compare range are #3967, #3969, #3970, #3971, and #3972; the seventh commit is release preparation.

## Merged PR inventory

| PR | Author | Title | Impact |
|---|---|---|---|
| [#3967](https://github.com/Yeachan-Heo/oh-my-codex/pull/3967) | @Yeachan-Heo | docs(release): record v0.21.42 publication evidence | Carry previous-release publication evidence onto dev |
| [#3969](https://github.com/Yeachan-Heo/oh-my-codex/pull/3969) | @Yeachan-Heo | back-merge: main to dev for v0.21.42 | Synchronize dev with the previously shipped main |
| [#3970](https://github.com/Yeachan-Heo/oh-my-codex/pull/3970) | @Yeachan-Heo | chore(dev): bump version to 0.21.43 | Align release-coupled development metadata |
| [#3971](https://github.com/Yeachan-Heo/oh-my-codex/pull/3971) | @Yeachan-Heo | Fix misleading process identity doctor repair guidance | Remove the ineffective setup suggestion; preserve the runtime-cache update and session-pointer guidance |
| [#3972](https://github.com/Yeachan-Heo/oh-my-codex/pull/3972) | @Yeachan-Heo | docs(release): finalize v0.21.42 readiness evidence | Finalize evidence for the previous release |

## Version synchronization

Release-coupled version surfaces already read `0.21.43` on the pinned dev candidate, from #3970. This release branch must not bump them again.

| Surface | Verified value |
|---|---|
| `package.json` | `0.21.43` |
| `package-lock.json` root and root package entry | `0.21.43` |
| `Cargo.toml` workspace package | `0.21.43` |
| `Cargo.lock` six OMX workspace crates | `0.21.43` |
| `plugins/oh-my-codex/.codex-plugin/plugin.json` | `0.21.43` |
| `omx-capabilities.lock.json` | Does not embed a package version |
| Version constants/tests | No hard-coded `0.21.42`/`0.21.43` version constant; `src/cli/__tests__/version-sync-contract.test.ts` checks metadata alignment |

## CI evidence

- Pinned dev candidate `43d2d21f833ba6ff62d10807127b76eca8f0aea4` CI run [41032241638](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41032241638) completed successfully: CI Status and Docs Check passed; source lanes and both macOS Ralplan preflights were skipped by docs-only change detection.
- On the source fix commit `72340934a318b9b3f0ca7c8e63d415bcc831d082`, dev CI run [41029069165](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41029069165) completed with 17 success, 8 skipped, and 0 failed jobs. CI Status passed (job [123981741521](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41029069165/job/123981741521)); both macOS Ralplan preflights passed: Node 20 (job [123974337084](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41029069165/job/123974337084)) and Node 26.5.1 (job [123974337061](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41029069165/job/123974337061)).
- The prior fix-commit preflights are evidence for that source commit only; skipped preflights do not count as release gates.

## Release PR and main gates

- Release PR [#3973](https://github.com/Yeachan-Heo/oh-my-codex/pull/3973) exact head `2a401a143ee07d00e4ccf780e05edcfee0878364` merged to main at `4697129bddfc706410fdd6001a7cfb9d7393fb8b`. Its exact-head Codex review completed with no findings (summary comment [6520585826](https://github.com/Yeachan-Heo/oh-my-codex/pull/3973#issuecomment-6520585826)); the in-thread findings gate printed `[]` immediately before merge.
- Release PR CI run [41041519971](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41041519971) completed with 24 success, 1 skipped, and 0 failed across 25 unique job names; the skipped job was npm publishing, which runs separately after the Release workflow. Both macOS Ralplan preflights passed on the exact release head: Node 20 (job [124015295477](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41041519971/job/124015295477)) and Node 26.5.1 (job [124015295591](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41041519971/job/124015295591)); CI Status passed (job [124021232195](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41041519971/job/124021232195)). PR checks run [41041521080](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41041521080) passed.
- Main push CI run [41043799480](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41043799480) on `4697129bddfc706410fdd6001a7cfb9d7393fb8b` completed with 24 success, 1 skipped, and 0 failed across 25 unique job names. Both macOS Ralplan preflights ran and passed: Node 20 (job [124022859401](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41043799480/job/124022859401)) and Node 26.5.1 (job [124022859397](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41043799480/job/124022859397)); CI Status passed (job [124030945726](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41043799480/job/124030945726)).

## Publication evidence

- Annotated tag `v0.21.43` points to `4697129bddfc706410fdd6001a7cfb9d7393fb8b`.
- Tag-triggered Release workflow [41046960455](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41046960455) completed successfully (11 success, 0 skipped or failed). GitHub Release [v0.21.43](https://github.com/Yeachan-Heo/oh-my-codex/releases/tag/v0.21.43) is published, non-draft/non-prerelease, with 57 assets including `native-release-manifest.json`.
- Trusted npm publishing was dispatched on `main` for `release_tag=v0.21.43` and full `release_sha=4697129bddfc706410fdd6001a7cfb9d7393fb8b`. CI run [41050820969](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41050820969) completed successfully (25 success, 0 skipped or failed); publish job [124046135386](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/41050820969/job/124046135386) passed, including its registry-visibility verification.
- Registry readback: `npm view oh-my-codex dist-tags.latest` → `0.21.43`; `npm view oh-my-codex@0.21.43 version gitHead` → version `0.21.43`, gitHead `4697129bddfc706410fdd6001a7cfb9d7393fb8b`.
- The published release body has the correct v0.21.43 title and full changelog link. Its contributor sentence was reviewed against GitHub compare contributors (`@clawdbot` and `@Yeachan-Heo`), not the shortlog-only preview.

## Known issues and exclusions

- #3968 is a separate report by Kevin-wenyu about `provider unavailable`; its underlying cause remains unconfirmed and evidence was requested. #3971 corrects the doctor's remedy text only.
- #3898 remains held for the owner design decision. Related PRs #3939, #3900, #3907, #3915, and #3919 remain excluded.
- #3965 is not included; changes were requested and the work is split pending.

## Local gates

- `npm ci` completed (172 packages; its prepare hook built the TypeScript source).
- `npm run build` passed.
- `npm run check:no-unused` passed.
- `npm run lint` passed across 898 files; Biome emitted the existing `linter.rules.recommended` deprecation notice from `biome.json`.
- Focused `doctor-process-identity-readiness` regression test passed: 6 tests, 0 failures.
- `node dist/scripts/check-version-sync.js --tag v0.21.43` passed.
- `cargo metadata --locked --format-version 1 --no-deps` reports all six OMX workspace crates at `0.21.43`.
- The complete repository test suite was not run; the local test gate covered the changed doctor behavior.

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
