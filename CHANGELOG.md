# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

## [0.5.1] - 2026-02-23

### Added
- **Native worktree orchestration for team mode**: Workers now launch in git worktrees with canonical state-root metadata, enabling true isolation for parallel team workstreams.
- **Cross-worktree team state resolution**: MCP state tools and the notify hook resolve team state across worktrees, so the leader always sees the correct shared state regardless of which worktree a worker is running in.
- **`omx ralph` CLI subcommand**: `omx ralph "<task>"` starts a ralph persistence loop directly from the command line, removing the need to manually invoke the skill inside a session (closes #153).
- **Scoped ralph state with canonical persistence migration**: Ralph state is now scoped per session/worktree and migrated from legacy flat paths to the canonical `.omx/state/sessions/` layout automatically.
- **Claim-safe team transition tool for MCP interop**: New `team_transition_task` MCP tool applies state transitions atomically with claim-token verification, preventing race conditions between concurrent workers.
- **Clean tmux pane output before notifications**: Notification content is sanitized (ANSI escapes, tmux artifacts stripped) before being sent to notification integrations, eliminating garbled messages.
- **Startup codebase map injection hook**: Session start injects a lightweight file-tree snapshot into the agent context so workers have structural awareness of the project without extra exploration turns (closes #136).

### Changed
- **`notify-hook.js` refactored into layered sub-modules**: The monolithic hook script is split into focused modules (event routing, tmux integration, notification dispatch) for maintainability and easier extension (closes #177).
- **`ralplan` defaults to non-interactive consensus mode**: The planning loop no longer pauses for interactive prompts by default; pass `--interactive` to restore the prompt-gated flow (closes #144).
- **Removed `/research` skill**: The `$research` skill has been fully removed. Use `$scientist` for data/analysis tasks or `$external-context` for web searches (closes #148).

### Fixed

#### Security
- **Command injection in `capturePaneContent`** prevented by switching from string shell interpolation to a safe argument array (closes #156).
- **Command injection in notifier** fixed by replacing `exec` string interpolation with `execFile` + args array (closes #157).
- **Stale/reused PID risk in reply-listener**: The process-kill path now verifies process identity before sending signals, preventing an unrelated process from being killed if a PID is recycled (closes #158).
- **Path traversal in MCP state/team tool identifiers**: Tool inputs are validated and normalized to prevent `../` escapes from reaching the filesystem (closes #159).
- **Untracked files excluded from codebase map** to prevent accidental filename leakage of unintended files into agent context.

#### Team / Claim Lifecycle
- Claim lease expiry enforced in task transition and release flows — expired claims are rejected before any state mutation (closes #176).
- Duplicate `task_completed` events from `monitorTeam` eliminated; events are deduplicated at the source (closes #161).
- `claimTask` returns `task_not_found` (not a generic error) for missing task IDs, improving worker error handling (closes #167).
- Claims on already-completed or already-failed tasks are rejected upfront (closes #160).
- Ghost worker IDs (workers that no longer exist) are rejected in `claimTask` (closes #179).
- Terminal → non-terminal status regressions in `transitionTaskStatus` are blocked; once a task reaches `completed`/`failed`, its status cannot be unwound.
- In-progress claim takeover prevented when `expected_version` is omitted from the request (closes #173).
- `releaseTaskClaim` no longer reopens a terminal task — release on a completed/failed task is a no-op (closes #174).
- `task_failed` event is now emitted instead of the misleading `worker_stopped` event on task failure (closes #171).
- `team_update_task` rejects lifecycle field mutations (`status`, `claimed_by`) that arrive without a valid claim token (closes #172).
- `updateTask` payload validation added to prevent partial/corrupted task objects from being persisted (closes #163).
- `team_leader_nudge` added to the `team_append_event` MCP schema enum so the nudge event passes schema validation (closes #175).
- Canonical session names used consistently in `getTeamTmuxSessions` (closes #170).

#### Worktree / CLI
- `--worktree <name>` space-separated argument form is now consumed correctly; previously the branch name was silently dropped (closes #203).
- Orphan `--model` flag dropped from worker argv to prevent duplicate flags causing Codex CLI parse errors (closes #162).
- `spawnSync` sleep replaced with `Atomics.wait` so timing delays work reliably even when the `sleep` binary is absent (closes #164).

#### Hooks / tmux
- Copy-mode scroll and clipboard copy re-enabled in `xhigh`/`madmax` tmux sessions (closes #206).
- Thin orchestrator restored in `notify-hook.js` after refactor inadvertently removed it (closes #205).

#### Dependencies
- `ajv` pinned to `>=8.18.0` and `hono` to `>=4.11.10` via npm `overrides` to resolve transitive vulnerability advisories.

### Performance
- `listTasks` file reads parallelized with `Promise.all`, reducing task-list latency for teams with many tasks (closes #168).

## [0.5.0] - 2026-02-21

### Added
- Consolidated the prompt/skill catalog and hardened team runtime contracts after the mainline merge (PR #137).
- Added setup scope-aware install modes (`user`, `project-local`, `project`) with persisted scope behavior.
- Added spark worker routing via `--spark` / `--madmax-spark` so team workers can use `gpt-5.3-codex-spark` without forcing the leader model.
- Added notifier verbosity levels for CCNotifier output control.

### Changed
- Updated setup and docs references to match the consolidated catalog and current supported prompt/skill surfaces.

### Fixed
- Hardened tmux runtime behavior, including pane targeting and input submission reliability.
- Hardened tmux pane capture input handling (post-review fix).
- Removed stale references to removed `scientist` prompt and `pipeline` skill (post-review fix).

### Removed
- Removed deprecated prompts: `deep-executor`, `scientist`.
- Removed deprecated skills: `deepinit`, `learn-about-omx`, `learner`, `pipeline`, `project-session-manager`, `psm`, `release`, `ultrapilot`, `writer-memory`.

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
