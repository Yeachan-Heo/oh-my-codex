# oh-my-codex 0.21.49

`0.21.49` adds execution comparisons for regression detection and strengthens Team conflict handling with explicit Git conflict visibility and consistent follow-up task protocols. Operators can inspect how execution changes after prompt, workflow, or tool configuration changes using the new `omx session compare` command. Team now preserves Git history and makes conflicts visible rather than silently resolving them, ensuring task protocols remain consistent with atomic preclaims.

## Added

- **EXECUTION COMPARISONS AND REGRESSION GATES (#3915):** Operators can now run `omx session compare <baseline-id> <candidate-id>` to inspect how execution changes after a prompt, workflow, or tool configuration change. This command produces metadata-only comparisons joined by exact tool namespace/name identity, detecting increases in per-tool failures, incomplete calls, aborted turns, and measured mean tool latency. An optional `--fail-on-regression` gate exits with status 2 for regressions and status 3 for inconclusive evidence. Documentation is available in `docs/session-compare.md`.

## Fixed

- **TEAM CONFLICT HANDLING AND PERSISTENT TASK CLAIMS (#4035):** Team now makes conflicts visible rather than silently selecting a side, and ensures follow-up task protocols are consistent with the leader's atomic preclaim. Changes include removing automatic merge side selection, admitting only successfully delivered or exactly cached unchanged worker sources into cross-rebase operations, and generating follow-up inboxes from the current persisted claim. Git history is preserved rather than choosing a content winner. Companion PRs #4034 and #4036 address related Team safety audit findings.

## Compatibility

No breaking API changes. Release-coupled metadata was synchronized to `0.21.49` on dev by #4029, so the release branch does not bump those values again. `package.json`, both root `package-lock.json` version entries, the Cargo workspace and six workspace crates, and plugin metadata all report `0.21.49` at the pinned source.

## Included scope

The pinned source is `73afb14298d45c327edf2df2d0c3bedb8dcd98a3` (tag v0.21.49). The source-only diff from `v0.21.48` to that commit includes the execution comparison feature (#3915), Team conflict handling fixes (#4035), version bump (#4029), back-merge of 0.21.48 corrections (#4028, #4037), and documentation of 0.21.48 release evidence (#4027). No commits after the pinned source are included.

**Full Changelog**: [`v0.21.48...v0.21.49`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.48...v0.21.49)

## Validation

Local release gates and release-pipeline evidence are recorded in [release readiness](qa/release-readiness-0.21.49.md).

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
