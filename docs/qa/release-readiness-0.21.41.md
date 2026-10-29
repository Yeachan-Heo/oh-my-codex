# Release Readiness: v0.21.41

**Release Date:** 2026-10-29<br>
**Released By:** gaebal-gajae (autonomous release)<br>
**Pinned dev candidate:** `4a0f645b898e74d381ee7d4da1ced0bf26280896`<br>
**Range:** [`v0.21.40...v0.21.41`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.40...v0.21.41)

## Summary

This patch release adds per-stage custom skill gates for `deep-interview`, `ralplan`, and `code-review`, configured through `.omx-config.json` `qualityGates`. Entries are skill names or `{ skill, mode?, model? }` objects; blocking gates supplement each stage's standard review flow, and advisory findings are recorded without blocking. Ralplan persists custom gate verdicts with its consensus evidence and sends blocking `reject`/`iterate` verdicts through the revise loop. Reserved built-in and sunset skill names are rejected. The feature implements issue #3955, requested by @iqdoctor, and landed in #3956.

The range also includes the model-selection documentation correction (#3951), v0.21.40 publication evidence (#3952), the v0.21.40 main-to-dev back-merge and `0.21.41` version synchronization (#3953), and the follow-up back-merge (#3954).

## Compare-range metrics

The pinned dev range `v0.21.40..4a0f645b898e74d381ee7d4da1ced0bf26280896` contains **6 commits, 31 files changed, 1,838 insertions(+), and 64 deletions(-)**. The corrected release-branch candidate `64ff0d22d7a7e60de92b92d0b6831bcaa9909eb0` contains **8 commits, 35 files changed, 1,998 insertions(+), and 84 deletions(-)** (`git diff --stat v0.21.40..64ff0d22d7a7e60de92b92d0b6831bcaa9909eb0`). The shipped tag range has 10 commits because main adds the #3957 release merge and #3958 fix merge; the tree remains 35 files, +1,998/−84.

## PR inventory

| PR | Author | Title | Impact |
|---|---|---|---|
| [#3951](https://github.com/Yeachan-Heo/oh-my-codex/pull/3951) | @Yeachan-Heo | docs: fix model selection documentation to match implementation | Documentation now matches the implemented model-selection precedence |
| [#3952](https://github.com/Yeachan-Heo/oh-my-codex/pull/3952) | @Yeachan-Heo | docs: record v0.21.40 publication evidence | Carry previous-release publication evidence onto dev |
| [#3953](https://github.com/Yeachan-Heo/oh-my-codex/pull/3953) | @Yeachan-Heo | chore: back-merge main (v0.21.40) to dev and bump to 0.21.41 | Back-merge shipped main and synchronize package/plugin/Cargo version surfaces |
| [#3954](https://github.com/Yeachan-Heo/oh-my-codex/pull/3954) | @Yeachan-Heo | back-merge: main to dev for v0.21.40 | Internal follow-up merge aligning main and dev |
| [#3956](https://github.com/Yeachan-Heo/oh-my-codex/pull/3956) | @Yeachan-Heo | feat(#3955): Add configurable custom quality gates via .omx-config | Add validated stage-specific gates, listing CLI, Ralplan integration, tests, and skill guidance |
| [#3958](https://github.com/Yeachan-Heo/oh-my-codex/pull/3958) | @Yeachan-Heo | fix(history): detect same-mtime content mutations during publication | Compare file change time as well as identity, size, and mtime to reject mutated history |

The release PR #3957 is an internal release-preparation merge and is intentionally omitted from the user-facing inventory. The #3959 dev-targeted fix PR is not part of the tag range. PRs #3939, #3900, #3907, #3915, and #3919 are excluded. #3898 remains held for the owner design decision.

## Version synchronization

At tagged main commit `b8cd1dec4eaf5ed1769a20ca4d264f58a2dc3c7b`, all coupled release surfaces were `0.21.41`; the post-release dev bump is tracked separately below.

| Surface | Verified value |
|---|---|
| `package.json` | `0.21.41` |
| `package-lock.json` root package and root package entry | `0.21.41` |
| `Cargo.toml` workspace package | `0.21.41` |
| `Cargo.lock` six OMX workspace packages | `0.21.41` |
| `plugins/oh-my-codex/.codex-plugin/plugin.json` | `0.21.41` |
| `omx-capabilities.lock.json` | Does not embed a package version |
| Version constants/tests | No hard-coded `0.21.40` or `0.21.41` display-version constant; `src/cli/__tests__/version-sync-contract.test.ts` checks package/plugin/Cargo alignment and lockfile format |

At tagged main commit `b8cd1dec4eaf5ed1769a20ca4d264f58a2dc3c7b`, `node dist/scripts/check-version-sync.js --tag v0.21.41` passed and `cargo metadata --locked --format-version 1 --no-deps` reported all six OMX workspace crates at `0.21.41`. The remaining `0.21.40` occurrences in that release tree are historical release collateral and references to the prior tag/PR, not active version surfaces.

## Local gates

- ✓ `npm ci` completed successfully.
- ✓ `npm run build` passed.
- ✓ `npm run check:no-unused` passed.
- ✓ `npm run lint` passed across 895 source files. Biome printed the existing deprecation notice for `linter.rules.recommended` in `biome.json`.
- ✓ `npm run build:runtime` built the native `omx-runtime` binary required by the focused Ralplan runtime tests.
- ✓ Focused tests passed: `quality-gates.test.js`, `quality-gates-cli.test.js`, `ralplan/runtime.test.js`, and `code-review-skill-contract.test.js` (all four files passed).
- ✓ `npm run verify:generated` passed: plugin bundle, capabilities lock, prompt-guidance fragments, and generated catalog all match.
- ✓ Version sync check and six-crate Cargo metadata verification passed.
- ✓ `git diff --cached --check` passed after staging release collateral.
- ✓ The same-inode/same-size/restored-mtime history mutation regression passed locally after adding `ctimeMs` to history-file version checks.

## CI gates

Pinned dev candidate: `4a0f645b898e74d381ee7d4da1ced0bf26280896`.

- Dev push CI run [40910124408](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40910124408) completed successfully. It has **24 success, 1 skipped, 0 failures, 0 pending** across **25 unique job names**.
- macOS Ralplan preflight security passed on Node 20 (job [123575656924](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40910124408/job/123575656924)) and Node 26.5.1 (job [123575656997](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40910124408/job/123575656997)).
- CI Status passed (job [123586747505](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40910124408/job/123586747505)).

## Release PR, publication, and back-merge

The initial release PR [#3957](https://github.com/Yeachan-Heo/oh-my-codex/pull/3957) merged at `b4a02c194acb0a344c7c3f7254e71740fb368932`. Its exact-head Codex review completed with zero findings, the in-thread reply gate printed `[]`, and PR CI passed (run [40922096829](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40922096829): 24 success, 1 skipped, 0 failed; both macOS preflights and CI Status passed).

Main push CI run [40924728006](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40924728006) exposed a real gap in history-mutation detection: the Windows test changed same-size content and restored mtime, while comparison omitted `ctimeMs`. Follow-up PR [#3958](https://github.com/Yeachan-Heo/oh-my-codex/pull/3958) added the missing change-time check. Its exact-head Codex review completed with zero findings, the in-thread gate printed `[]`, and CI run [40929210160](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40929210160) passed (24 success, 1 skipped, 0 failures): Windows history materialization job [123642922247](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40929210160/job/123642922247), macOS Ralplan preflights Node 20 [123642922285](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40929210160/job/123642922285) and Node 26.5.1 [123642922398](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40929210160/job/123642922398), and CI Status [123653698446](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40929210160/job/123653698446) all passed. The fix PR merged at `b8cd1dec4eaf5ed1769a20ca4d264f58a2dc3c7b`.

Main push CI after the fix, run [40932787626](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40932787626), passed with 24 success, 1 skipped, and 0 failures across 25 unique jobs. Both macOS Ralplan preflights passed (Node 26.5.1 job [123655450889](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40932787626/job/123655450889), Node 20 job [123655450981](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40932787626/job/123655450981)); CI Status job [123664532155](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40932787626/job/123664532155) passed.

Dev-targeted fix PR [#3959](https://github.com/Yeachan-Heo/oh-my-codex/pull/3959) merged at `ded70c83409aac48f7e04a8147f65c40817495e8`; its exact-head Codex review completed with zero findings and its reply gate printed `[]`. The PR CI run [40929615467](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40929615467) passed (17 success, 8 skipped), including Windows history materialization and both macOS Ralplan preflights. The subsequent dev push run [40932849072](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40932849072) had one initial failed attempt in `Test (Node 20 / cli-core-rest)` with child-process `EPIPE`/`spawn codex ENOENT` failures in `team.test.js`; the single monitor-authorized retry (attempt 2) passed. Final per-name result: 17 success, 8 skipped, 0 failures across 25 unique names; both macOS Ralplan preflights and CI Status passed. No test-fix PR was needed.

The annotated tag `v0.21.41` points to `b8cd1dec4eaf5ed1769a20ca4d264f58a2dc3c7b`. Release workflow [40937219986](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40937219986) completed successfully, including native build, manifest verification, and packed-install smoke test. GitHub Release [v0.21.41](https://github.com/Yeachan-Heo/oh-my-codex/releases/tag/v0.21.41) is published and non-draft/non-prerelease with 57 assets (published `2026-10-29T19:25:18Z`).

Trusted npm publish was dispatched with `release_tag=v0.21.41` and full `release_sha=b8cd1dec4eaf5ed1769a20ca4d264f58a2dc3c7b`. CI workflow run [40941694577](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40941694577) completed successfully (25 success, 0 skipped or failed); publish job [123686461016](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40941694577/job/123686461016) passed. Registry readback: `npm view oh-my-codex dist-tags.latest` → `0.21.41`; `npm view oh-my-codex@0.21.41 version gitHead` → version `0.21.41`, gitHead `b8cd1dec4eaf5ed1769a20ca4d264f58a2dc3c7b`.

Evidence PR [#3960](https://github.com/Yeachan-Heo/oh-my-codex/pull/3960) carried the publication proof to main and merged at `069fbd185a605df76a684028c6d4a7acf0abb156`. Main push CI after that merge, run [40948178945](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40948178945), passed with 24 success, 1 skipped, and 0 failures; both macOS Ralplan preflights (Node 20 job [123709035788](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40948178945/job/123709035788), Node 26.5.1 job [123709035808](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40948178945/job/123709035808)) and CI Status [123719007758](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40948178945/job/123719007758) passed.

The main-to-dev back-merge PR [#3961](https://github.com/Yeachan-Heo/oh-my-codex/pull/3961) merged with one merge commit, `c062b3df163559253f9eb5a9e1e373ae0f39e24d`, and includes the #3960 publication evidence. Its exact-head Codex review completed with zero findings and the in-thread gate printed `[]`. PR CI run [40951411436](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40951411436) passed its active checks. Full-suite CI dispatched against the back-merge head, run [40951633865](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40951633865), passed (24 success, 1 skipped, 0 failures), including macOS Ralplan Node 20 job [123721071611](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40951633865/job/123721071611), Node 26.5.1 job [123721071637](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40951633865/job/123721071637), and CI Status [123730494701](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40951633865/job/123730494701). Post-merge dev push CI [40954820132](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40954820132) passed its active checks; full-suite CI on the exact dev merge commit, run [40954945155](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40954945155), passed (24 success, 1 skipped, 0 failures), including both macOS preflights [123732595150](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40954945155/job/123732595150) (Node 20) and [123732595081](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40954945155/job/123732595081) (Node 26.5.1), plus CI Status [123742579134](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40954945155/job/123742579134). `origin/main` is an ancestor of `origin/dev`.

The dev-only version bump PR [#3962](https://github.com/Yeachan-Heo/oh-my-codex/pull/3962) updates `package.json`, both root package-lock versions, the Cargo workspace and six OMX lock entries, and the plugin manifest to `0.21.42`. It does not move or republish the `v0.21.41` tag.

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
