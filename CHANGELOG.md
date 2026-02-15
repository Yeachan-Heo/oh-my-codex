# Changelog

All notable changes to this project are documented in this file.

## [0.3.8] - 2026-02-15

### Changed
- Bumped package version to `0.3.8`.

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

## [0.3.5] - 2026-02-15

### Added
- Added Windows-native process transport for `omx team` when tmux is unavailable.
- Added platform capability detection with `OMX_FORCE_TMUX_TRANSPORT` override support.
- Added worker bootstrap runner script for process workers: `scripts/team-worker-bootstrap.js`.
- Added team doctor issue code `worker_process_missing` for stale process-worker PIDs.
- Added GitHub Actions CI workflow with `ubuntu-latest`, `macos-latest`, and `windows-latest` matrix.

### Changed
- Updated team runtime to support both tmux and process transports.
- Updated Codex CLI detection in doctor to use `spawnSync('codex', ['--version'])` for cross-platform reliability.
- Updated docs to describe Windows team behavior and troubleshooting.
- Updated CLI/help copy to describe transport-neutral team execution.

### Fixed
- Fixed Windows ESM loading in `bin/omx.js` by converting import paths to `file://` URLs.

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
