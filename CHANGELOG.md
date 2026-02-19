# Changelog

All notable changes to this project are documented in this file.

## [0.4.4] - 2026-02-19

### Added
- Added code-simplifier stop hook for automatic refactoring.
- Registered OMX agents as Codex native multi-agent agent roles.

### Fixed
- Fixed team mode notification spam with runtime tests.
- Removed deprecated `collab` flag from generated config.
- Fixed tmux session name handling.

## [0.4.2] - 2026-02-18

### Added
- Added broader auto-nudge stall detection patterns (for example: "next I can", "say go", and "keep driving") with a focused last-lines hot zone.
- Added worker-idle aggregation notifications so team leaders are alerted when all workers are idle/done (with cooldown and event logging).
- Added automatic tmux mouse scrolling for team sessions (opt-out via `OMX_TEAM_MOUSE=0`).

### Fixed
- Fixed worker message submission reliability by adding settle/delay timing before and during submit key rounds.
- Fixed CLI exit behavior by awaiting `main(...)` in `bin/omx.js` so `/exit` terminates cleanly.
- Replaced deprecated `collab` feature references with `multi_agent` across generator logic, docs, and tests.

### Tests
- Added coverage for `all workers idle` notify-hook behavior and expanded auto-nudge pattern tests.
- Added new unit suites for hook extensibility runtime, HUD rendering/types/colors, verifier, and utility helpers.
- Added tests for tmux mouse-mode enablement behavior.

## [0.4.0] - 2026-02-17

### Added
- Added hook extensibility runtime with CLI integration.
- Added example-event test coverage for hook extensions.

### Fixed
- Standardized tmux `send-keys` submission to `C-m` across the codebase.

## [0.3.9] - 2026-02-15

### Changed
- Updated planner handoff guidance to use actionable `$ralph` / `$team` commands instead of the removed `/oh-my-codex:start-work` command.
- Updated team skill docs to describe team-scoped `worker-agents.md` composition (no project `AGENTS.md` mutation).

### Fixed
- Preserved and restored pre-existing `OMX_MODEL_INSTRUCTIONS_FILE` values during team start rollback/shutdown to avoid clobbering leader config.

## [0.3.8] - 2026-02-15

### Fixed
- Fixed `omx` not launching tmux session when run outside of tmux (regression in 0.3.7).

## [0.3.7] - 2026-02-15

### Added
- Added guidance schema documentation for AGENTS surfaces in `docs/guidance-schema.md`.
- Added stronger overlay safety coverage for worker/runtime AGENTS marker interactions.
- Added broader hook and worker bootstrap test coverage for session-scoped behavior.

### Changed
- Defaulted low-complexity team workers to `gpt-5.3-codex-spark`.
- Improved `omx` CLI behavior for session-scoped `model_instructions_file` handling.
- Hardened worker bootstrap/orchestrator guidance flow and executor prompt migration.
- Improved HUD pane dedupe and `--help` launch behavior in tmux workflows.

### Fixed
- Fixed noisy git-branch detection behavior in non-git directories for HUD state tests.
- Fixed merge-order risk by integrating overlapping PR branches conservatively into `dev`.

## [0.2.2] - 2026-02-13

### Added
- Added pane-canonical tmux hook routing tests for heal/fallback behavior.
- Added shared mode runtime context wrapper to capture mode tmux pane metadata.
- Added tmux session name generation in `omx-<directory>-<branch>-<sessionid>` format.

### Changed
- Switched tmux hook targeting to pane-canonical behavior with migration from legacy session targets.
- Improved tmux key injection reliability by sending both `C-m` and `Enter` submit keys.
- Updated `tmux-hook` CLI status output to focus on pane tracking with legacy session visibility.
- Bumped package version to `0.2.2`.
