# oh-my-codex 0.21.41

`0.21.41` is a patch release adding configurable custom quality gates to the deep-interview, Ralplan, and code-review stages.

## Highlights

- **CONFIGURABLE CUSTOM QUALITY GATES (#3956; requested in #3955 by @iqdoctor):** Configure additional skill-based reviewers in `.omx-config.json` under `qualityGates.deep-interview`, `qualityGates.ralplan`, and `qualityGates.code-review`. Entries may be plain skill names or objects with `skill`, optional `mode` (`blocking` or `advisory`), and optional `model`; plain strings default to blocking. `omx quality-gates list --stage ...` reports normalized gate configuration. The gates supplement the existing built-in review flow. In Ralplan, a blocking `reject` or `iterate` result feeds the revise loop, while advisory verdicts are recorded without blocking consensus. A gate that cannot run is represented as unavailable rather than as an approval. Names must be kebab-case and reserved built-in or sunset skills are rejected.

## Fixes and compatibility

- Model-selection documentation now matches the implementation (#3951).
- Include file change time in history-artifact version validation so same-inode content mutations that restore size and modification time are discarded before project-launch publication (#3958).
- No breaking API changes.
- Development package metadata remains synchronized at `0.21.41`; this release does not double-bump the version (#3953).

## Known issues and exclusions

- #3898 remains held for the owner design decision.
- PRs #3939, #3900, #3907, #3915, and #3919 are excluded from this release range; the related held work is not included in this release.
- No other user-visible changes in the compare range are excluded.

## Merged PR inventory

| PR | Author | Title | Impact |
|---|---|---|---|
| [#3951](https://github.com/Yeachan-Heo/oh-my-codex/pull/3951) | @Yeachan-Heo | docs: fix model selection documentation to match implementation | Align model-selection guidance with the implemented precedence rules |
| [#3952](https://github.com/Yeachan-Heo/oh-my-codex/pull/3952) | @Yeachan-Heo | docs: record v0.21.40 publication evidence | Preserve the prior release's publication evidence on dev |
| [#3953](https://github.com/Yeachan-Heo/oh-my-codex/pull/3953) | @Yeachan-Heo | chore: back-merge main (v0.21.40) to dev and bump to 0.21.41 | Align dev with shipped main and synchronize development version metadata |
| [#3954](https://github.com/Yeachan-Heo/oh-my-codex/pull/3954) | @Yeachan-Heo | back-merge: main to dev for v0.21.40 | Internal follow-up merge aligning main and dev |
| [#3956](https://github.com/Yeachan-Heo/oh-my-codex/pull/3956) | @Yeachan-Heo | feat(#3955): Add configurable custom quality gates via .omx-config | Add stage-specific configuration, listing CLI, Ralplan integration, tests, and workflow guidance |
| [#3958](https://github.com/Yeachan-Heo/oh-my-codex/pull/3958) | @Yeachan-Heo | fix(history): detect same-mtime content mutations during publication | Reject changed history bytes when file size and modification time are restored |

## Validation evidence

- Pinned dev candidate `4a0f645b898e74d381ee7d4da1ced0bf26280896` passed CI run [40910124408](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40910124408): 24 jobs succeeded, 1 publish job was skipped, 0 failed or pending, and all 25 job names were unique.
- Both macOS Ralplan preflights passed: Node 20 (job [123575656924](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40910124408/job/123575656924)) and Node 26.5.1 (job [123575656997](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40910124408/job/123575656997)); CI Status passed (job [123586747505](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40910124408/job/123586747505)).
- Release-branch build, typecheck, lint, focused tests, version synchronization, release review, and publication evidence are recorded in [release readiness](qa/release-readiness-0.21.41.md).

**Full Changelog**: [`v0.21.40...v0.21.41`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.40...v0.21.41)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
