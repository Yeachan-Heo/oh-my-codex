# oh-my-codex 0.21.39

`0.21.39` is a patch release that recognizes GPT-6.1 Terra in the known Codex model catalog and publishes the canonical state-root identity for detached session leaders.

## Highlights

- **GPT-6.1 TERRA MODEL RECOGNITION (#3933):** Add `gpt-6.1-terra` to the known Codex model catalog and routing reference. Explicit model strings, defaults, per-role overrides, and reasoning-command boundaries are unchanged.
- **CANONICAL DETACHED-SESSION ROOTS (#3935):** Record the canonical state root already held by the leader binding so the strict session-reuse guard accepts a detached leader launched through an aliased or symlinked state root.

## Fixes and compatibility

- No breaking API changes.
- Test reliability changes do not alter runtime behavior: isolate caller HOME/USERPROFILE for each test file (#3936), wait for VSCode log stream completion before assertions (#3937), and synchronize tmux/team fixture boundaries (#3938).

## Known issues and exclusions

- #3898 remains held for the owner design decision. On Codex 0.164.0, `.omx-live-pin` files inside the plugin cache can invalidate hook approval. The workaround posted in #3898 disables the `oh-my-codex-local` plugin; related PRs #3900 and #3907 remain open and are excluded from this release.
- No other compare-range PRs or user-facing changes are excluded.

## Merged PR inventory

| PR | Author | Title | Impact |
|---|---|---|---|
| [#3933](https://github.com/Yeachan-Heo/oh-my-codex/pull/3933) | @ev78394 | feat(models): recognize GPT-6.1 Terra | Adds `gpt-6.1-terra` to the known model catalog |
| [#3935](https://github.com/Yeachan-Heo/oh-my-codex/pull/3935) | @ev78394 | fix: publish canonical detached-session state roots | Stores the canonical state root in detached leader records |
| [#3936](https://github.com/Yeachan-Heo/oh-my-codex/pull/3936) | @ev78394 | test: isolate caller homes for each test file | Isolates per-file HOME and USERPROFILE |
| [#3937](https://github.com/Yeachan-Heo/oh-my-codex/pull/3937) | @ev78394 | test: wait for VSCode log stream completion | Waits for test log stream completion before assertions |
| [#3938](https://github.com/Yeachan-Heo/oh-my-codex/pull/3938) | @ev78394 | test: synchronize tmux logs and team event fixtures | Synchronizes test fixtures without weakening safety assertions |
| [#3931](https://github.com/Yeachan-Heo/oh-my-codex/pull/3931) | @Yeachan-Heo | back-merge: main to dev for v0.21.38 | Internal back-merge; aligns dev with shipped main |

## Validation

- Pinned dev candidate `4c98c4775b0d33f78bdee02bb15ce43aa0505470` passed CI run [40715501337](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40715501337): 18 success, 7 skipped, and 0 failed latest-per-name checks.
- Both macOS Ralplan preflights passed: Node 20 (job [122912178834](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40715501337/job/122912178834)) and Node 26.5.1 (job [122912178801](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40715501337/job/122912178801)); CI Status passed (job [122922743319](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/40715501337/job/122922743319)).
- Release-branch local gates and release-PR review/CI are recorded in [release readiness](qa/release-readiness-0.21.39.md).

## Contributors

Thanks to @ev78394 for the model, detached-session, and test-reliability changes, and @Yeachan-Heo for release-train maintenance.

**Full Changelog**: [`v0.21.38...v0.21.39`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.38...v0.21.39)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
