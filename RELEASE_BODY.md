# oh-my-codex v0.21.49

## Summary

This release adds execution comparisons for regression detection and strengthens Team conflict handling with explicit Git conflict visibility and consistent follow-up task protocols.

## Added

- **EXECUTION COMPARISONS AND REGRESSION GATES (#3915):** Operators can now run `omx session compare <baseline-id> <candidate-id>` to inspect how execution changes after a prompt, workflow, or tool configuration change. This command produces metadata-only comparisons joined by exact tool namespace/name identity, detecting increases in per-tool failures, incomplete calls, aborted turns, and measured mean tool latency. An optional `--fail-on-regression` gate exits with status 2 for regressions and status 3 for inconclusive evidence. Documentation is available in `docs/session-compare.md`.

## Fixed

- **TEAM CONFLICT HANDLING AND PERSISTENT TASK CLAIMS (#4035):** Team now makes conflicts visible rather than silently selecting a side, and ensures follow-up task protocols are consistent with the leader's atomic preclaim. Changes include removing automatic merge side selection, admitting only successfully delivered or exactly cached unchanged worker sources into cross-rebase operations, and generating follow-up inboxes from the current persisted claim. Git history is preserved rather than choosing a content winner. Related Team audit fixes #4034 and #4036 are not part of this release.

## Compatibility

No breaking API changes. Release-coupled metadata was synchronized to `0.21.49` on dev by #4029. `package.json`, both root `package-lock.json` version entries, the Cargo workspace and six workspace crates, and plugin metadata all report `0.21.49` at the pinned source.

## Verification

- `npm ci` — passed; 172 packages installed and lifecycle hooks completed.
- `npm run build` — passed.
- `npm run lint` — passed across 904 files. Biome emitted the existing `linter.rules.recommended` deprecation notice; no lint fixes were applied.
- `npm test` — not completed locally (the run timed out). The full test suite passed in CI on dev `cd48849d` ([run 42434671997](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/42434671997)); later commits in this release (#4027, #4037) are docs-only.

**Full Changelog**: [`v0.21.48...v0.21.49`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.48...v0.21.49)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
