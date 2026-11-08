# oh-my-codex 0.22.0

`0.22.0` ships the Herdr team runtime backend Phase 2 with worker capacity management and task claim renewal, improves conflict handling in team operations, and adds session execution comparisons and regression gates for reliable task tracking.

## Added

- **SESSION EXECUTION COMPARISONS AND REGRESSION GATES (#3915):** Capture execution snapshots during session transitions, compare sessions against baselines, and gate further work when regressions are detected. This enables robust regression detection during multi-agent workflows and task execution validation.

## Fixed

- **HERDR TEAM RUNTIME BACKEND PHASE 2 (#4006):** Implement the Herdr team runtime backend continuation, including native session pane coordination, detached-launch design notes, and improved tmux integration patterns. This solidifies the team runtime foundation with enhanced reliability and design clarity.
- **RESERVE WORKER CAPACITY, RENEW TASK CLAIMS, AND GATE DELIVERY COMPLETION (#4036):** Fix followup bounds, implement claim renewal, gate delivery success, close lease gaps, recover pending receipts, bound lease shutdown, surface renewal errors, and recognize terminal handoffs. Support system Bash and renewal on tool activity; fix scope root reactivation to delivery debt and renew leases despite heartbeat persistence failures. Reserve worker capacity before assignment and compare persisted assignment snapshots for validation.
- **FAIL CLOSED ON GIT CONFLICTS AND HAND OFF PERSISTED TASK CLAIMS (#4035):** Remove automatic conflict resolution strategies (-X theirs/-X ours), make conflicts visible and require manual resolution, preserve conflict state during integration retries, align task assignment protocol with leader's atomic preclaim, and expand conflict-scenario test coverage.

## Compatibility

No breaking API changes. Release-coupled metadata (`package.json`, `package-lock.json`, Cargo workspace, and plugin metadata) all report `0.22.0` at the pinned source.

## Included scope

The pinned source is the current `HEAD` on the `release/0.22.0` branch. The source-only diff from `v0.21.48` to the release commit includes Herdr backend Phase 2 (#4006), worker capacity and claim management (#4036), conflict handling improvements (#4035), and session execution comparisons (#3915). No commits after the pinned source are included. PR #4034 is excluded from this release as requested.

**Full Changelog**: [`v0.21.48...v0.22.0`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.48...v0.22.0)

## Validation

Local release gates and release-pipeline evidence are recorded in [release readiness](qa/release-readiness-0.22.0.md).

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
