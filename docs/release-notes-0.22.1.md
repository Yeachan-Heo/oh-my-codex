# oh-my-codex 0.22.1

`0.22.1` ships critical fixes for the omx question command when stdin is closed, adds readline close event handling for EOF detection, reapplies verified handoffs and safe drains after v0.22.0, accepts aliased Codex homes for external live pins, and addresses three Codex findings from the v0.22.0 release review.

## Fixed

- **ACCEPT ALIASED CODEX HOMES FOR EXTERNAL LIVE PINS (#3939):** Accept either spelling of the configured Codex home when validating live pin cache paths, enabling external Codex home links and symlinks to resolve correctly while maintaining no-follow traversal security. This fixes live pin resolution when Codex homes are aliased or redirected.
- **FIX EOF DETECTION FOR CLOSED STDIN IN OMX QUESTION --UI (#4048, #4046):** Replaced input stream listeners with readline close event for more reliable EOF detection when stdin is closed. Handle closed stdin in `omx question --ui` with proper error handling to prevent crashes when the command is invoked without stdin.
- **REAPPLY VERIFIED HANDOFFS AND SAFE DRAINS (#4034):** Reapply the reviewed 73afb142..2fd0e063 delta onto dev, preserving herdr startup and team member consistency across worker upgrades. Fixes scope root reactivation and drains that were omitted from v0.22.0.
- **ADDRESS CODEX FINDINGS FROM v0.22.0 RELEASE REVIEW (#4047):** Fixes for issues identified in Codex review of release PR #4042. Updates include: scale-up now uses persisted team worker_launch_mode instead of checking current env backend; startupReadyPromptObserved is now scoped per-worker instead of shared across concurrent startups. All 126 scaling tests and 212 runtime tests pass.

## Compatibility

No breaking API changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.1` at the pinned source.

## Included scope

The pinned source is the current `HEAD` on the `release/0.22.1` branch. The source-only diff from `v0.22.0` to the release commit includes aliased Codex home resolution for live pins (#3939), fixes for question command EOF handling (#4048, #4046), reapplied verified handoffs and drains (#4034), and three Codex finding corrections (#4047). No commits after the pinned source are included.

**Full Changelog**: [`v0.22.0...v0.22.1`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.22.0...v0.22.1)

## Validation

Local release gates and release-pipeline evidence are recorded in [release readiness](qa/release-readiness-0.22.1.md).

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
