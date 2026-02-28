# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

## [0.7.3] - 2026-02-28

55 files changed. Pipeline orchestrator, uninstall command, team dispatch hardening, and config idempotency.

### Added
- Configurable pipeline orchestrator with stage-based execution (ralph-verify, ralplan, team-exec) (#398).
- `omx uninstall` command with `--dry-run`, `--keep-config`, `--purge`, and `--scope` options (#389).
- Openclaw dispatcher passes originating channel context to webhook hooks (#387).

### Fixed
- CLI subcommand `--help` flag now shows help text instead of executing the command (#404).
- Team idle/dispatch detection parity between Claude and Codex workers (#402).
- Team dispatch lock timeout and binary path mismatch resolved (#401).
- Team dispatch retries on Codex trust prompt instead of rolling back (#395).
- Team dispatch draft consumption verified before marking notified (#392).
- Config generator prevents duplicate OMX blocks on repeated `omx setup` (#386).
- Team operator docs now clarify Claude-pane Enter (`C-m`) can queue while busy and document state-first/safe manual intervention guidance for `$team`.

### Changed
- Deprecated ultrapilot, pipeline, and ecomode modes (#399).
- Removed unused `DEPRECATED_MODE_MAP` from state-server.
- Updated pipeline test state file paths and regenerated catalog.
- Added links to CLI reference, notifications, and workflows in README.

## [0.7.2] - 2026-02-26

Hotfix: team shutdown `--force` flag was not being parsed from CLI arguments.

### Fixed
- Team shutdown `--force` flag now correctly parsed from CLI args instead of being hardcoded to `false` (`src/cli/team.ts`).
- Added `shutdown_gate_forced` audit event when force-bypass is used, closing an observability gap in the event log.

### Changed
- Updated usage string to document `[--force]` option: `omx team shutdown <team-name> [--force]`.
- Added `shutdown_gate_forced` to `TeamEventType` union and `TEAM_EVENT_TYPES` constant.

## [0.7.1] - 2026-02-26

4 files changed. Team dispatch reliability improvements — state-first routing with hook-preferred fallback.

### Changed
- Team dispatch rewritten to be state-first and hook-preferred, improving reliability when leader pane targeting varies (#379).
- Leader mailbox delivery uses hook-preferred dispatch path for consistent message routing (#378).

### Fixed
- Leader fallback parity guarded to only target real pane destinations, preventing dispatch to stale or missing panes (#379).
- Hook dispatch reliability paths hardened with additional error guards and fallback sequencing (#378).

## [0.7.0] - 2026-02-26

153 files changed, +12,852 / -1,044 lines. Major feature additions, comprehensive audit fixes, and hardened reliability.

### Added

#### Team & Scaling
- Dynamic team worker scaling — Phase 1 manual `scale_up` / `scale_down` mid-session (#363).
- Per-worker idle notification forwarded to leader pane (#335).
- Prompt-mode worker launch transport for interactive team workflows (#264).
- Worker model defaults resolved from config with `OMX_TEAM_WORKER_CLI_MAP` (#263).
- Worker hard cap raised to 20 (#343).
- Team shutdown gated on unresolved tasks to prevent premature teardown (#320, #322).
- MSYS2 / Git Bash tmux worker support (#266).
- Centralized team/state contracts module (`contracts.ts`) for shared type definitions (#319, #323).

#### Planning & Execution
- RALPLAN-DR structured deliberation for consensus planning — planner + architect + critic loop (#366).
- Ralplan-first execution gate enforced: ralph blocks implementation until `prd-*.md` and `test-spec-*.md` exist (#261).
- Task-size detector (`task-size-detector.ts`) for pre-execution scoping guidance with dedicated test suite.
- Keyword trigger registry (`keyword-registry.ts`) as canonical single source of truth for all 31 keyword triggers.

#### Notifications
- Full notification engine overhaul from OMC 4.5.x (#373): template engine, idle cooldown, hook-config types, session registry.
- Slack / Discord / Telegram env-var configuration via `buildConfigFromEnv()`.
- Reply listener per-channel gating and credential isolation for disabled channels.
- Skill-active lifecycle tracking in notify hook for auto-continuation (#262).
- Language reminder injection for non-Latin user input (#260).

#### OpenClaw
- OpenClaw gateway integration (`src/openclaw/`) for waking external automations and AI agents on hook events — config, dispatcher, and full test suite.

#### CLI & Setup
- Star-prompt CLI command (`star-prompt.ts`) for prompt management with test coverage.
- Setup simplified from 3 scopes to 2 (user, project) (#245).
- Setup prompts before overwriting existing AGENTS.md (#242).
- Setup `--force` overwrite controls for both agents and skills installation (#275).
- Repo name included in tmux session name for worktree launches (#360, #362).

#### MCP & Code Intelligence
- MCP bootstrap module (`bootstrap.ts`) with auto-start guards (#317).
- Memory validation layer (`memory-validation.ts`) for project memory writes.
- `includeDeclaration` honored in `lsp_find_references` (#299, #327).

#### HUD
- HUD watch render serialization to prevent overlapping writes (#274).
- Quota rendering (5-hour and weekly limit percentages) in focused preset.
- Session duration rendering (seconds / minutes / hours format).
- Last-activity rendering from hudNotify turn timestamps.

#### Infrastructure
- `tsconfig.no-unused.json` — dedicated config for unused-symbol CI gate (#312, #333).
- Session lifecycle hooks with archive and overlay strip on exit.
- Direct coverage for key production modules (#321, #324).
- Dedicated hooks coverage for extensibility dispatcher and loader (#316).

### Changed
- `KEYWORD_TRIGGERS` derived from `KEYWORD_TRIGGER_DEFINITIONS` — template and runtime registry always in sync, eliminating drift.
- Team/swarm keyword detection tightened with intent-aware matching to avoid false triggers on natural language (#292, #356).
- Ralph contract enforces lifecycle invariants and integer counters (#355).
- Ralph contract validation enforced in direct state writers (#296, #353).
- State writes are atomic and serialized via file locking (#354).
- Max-iteration termination enforced in notify hook (#345).
- Canonical targets enforced for alias/merged catalog entries (#318, #344).
- Doctor diagnostics downgrade unattributed tmux orphan warnings (#277).
- HUD delayed reconcile fallback reduced from 10s to 2s.
- Removed unused HUD color helper exports (#280).
- Removed dead TS fallback path from CLI entrypoint (#283).
- Removed production dead code and added unused-symbol CI gate (#312, #333).
- `packageRoot` made ESM-safe without `require()` (#310, #330).
- Tmux hook engine type declarations synced with runtime exports (#313, #328).

### Fixed
- **CI**: Resolved typecheck (6 unused imports) and 7 test failures — HUD NaN/future timestamp handling, state mode validation, slack config `deepStrictEqual`, keyword template-registry sync.
- **Team**: Deterministic prompt worker teardown (#349). Verification protocol wired into runtime completion gates (#298, #351). False prompt-mode resume readiness prevented (#352). Shutdown continues when resize hook unregister fails (#302, #347). Team path guards for explicit state root.
- **Ralph**: Exclusive lock checks fail on malformed state (#357). Lifecycle invariants enforced in direct state writers (#296, #353).
- **Notifications**: Reply config validates and honors enabled channels (#281, #287). Notifier HTTP status and timeout checks enforced (#286). Slack config omits `mention` property when undefined.
- **Hooks**: Plugin dispatch timeout resolution guaranteed (#269). Parent hook plugin import validation skipped correctly (#268). Keyword activation timestamp reset on skill switch (#290).
- **Setup**: Skill overwrite skipped unless `--force` (#275).
- **Code Intelligence**: AST-grep rewrites applied when `dryRun=false` (#295, #358).
- **Code Simplifier**: Untracked files included in selection (#308). CI test failures from `trim()` and `homedir()` resolved.
- **MCP**: Notepad `daysOld` bounds validated (#309, #334).
- **Config**: Windows MCP server paths escaped in `mergeConfig` (#307, #337).
- **Session**: PID-reuse false positives in stale detection fixed (#338).
- **Trace**: Memory usage on large JSONL histories fixed (#336).
- **Tmux**: Hook indices clamped to signed 32-bit range (#240, #241). HUD resize noise quieted on macOS. Signed 32-bit hook hash coercion enforced (#265).
- **Misc**: Lifecycle best-effort failure warnings surfaced (#315, #346). Notify-hook cross-worktree tests isolated from inherited team env.

### Security
- MCP `workingDirectory` handling hardened with validation and allowlist policy (#289).
- Path traversal prevention for state and team tool calls with mode allowlist enforcement.
- HUD dynamic text sanitized to prevent terminal escape injection (#271).

### Tests
- 1,472 tests across 308 suites — all passing.
- New test suites: `scaling.test.ts`, `task-size-detector.test.ts`, `session.test.ts`, `consensus-execution-handoff.test.ts`, `notify-hook-worker-idle.test.ts`, `template-engine.test.ts`, `hook-config.test.ts`, `idle-cooldown.test.ts`, `reply-config.test.ts`, `path-traversal.test.ts`, `memory-server.test.ts`, `memory-validation.test.ts`, `bootstrap.test.ts`, `code-intel-server.test.ts`, `openclaw/*.test.ts`, `star-prompt.test.ts`, `setup-agents-overwrite.test.ts`, `setup-skills-overwrite.test.ts`, `error-handling-warnings.test.ts`, `catalog-contract.test.ts`.
- Code-simplifier hook coverage made deterministic (#311, #348).
- Ralph persistence gate verification matrix in CI.

## [0.6.4] - 2026-02-24

### Fixed
- Team Claude worker startup now explicitly launches with `--dangerously-skip-permissions`, preventing interactive permission prompts during tmux team runs.

### Tests
- Added regression coverage for the worker CLI override path to ensure Claude launch args are translated correctly and Codex-only flags are not forwarded.

## [0.6.3] - 2026-02-24

### Added
- Client-attached HUD reconcile hook for detached-launch initial pane layout reconciliation.

### Fixed
- Hardened detached session resize hook flow to prevent race conditions when tmux windows drift.
- Hardened HUD/team resize reconciliation for consistent pane organization across attach/detach cycles.
- Reduced HUD delayed reconcile fallback from 10s to 2s for faster layout correction.
- Client-attached hook is now tracked and properly unregistered during rollback.

### Tests
- Added tmux session and CLI sequencing tests for resize/reconcile paths.

## [0.6.2] - 2026-02-24

### Fixed
- Team Claude worker launch now uses plain `claude` with no injected launch args, so local `settings.json` remains authoritative.
- Team startup resolution logging is now Claude-aware: Claude paths report `model=claude source=local-settings` and omit `thinking_level`.

### Changed
- Clarified docs for Team worker CLI behavior in README and `skills/team/SKILL.md` to reflect plain-Claude launch semantics.
- Added regression coverage to preserve Codex reasoning behavior while enforcing Claude no-args launch behavior.

## [0.6.1] - 2026-02-23

### Added
- Added a new "What's New in 0.6.0" section to the docs site homepage with highlights for mixed Codex/Claude teammates and reliability updates.

### Changed
- Clarified `skills/team/SKILL.md` docs that `N:agent-type` selects worker role prompts (not CLI choice), and documented `OMX_TEAM_WORKER_CLI` / `OMX_TEAM_WORKER_CLI_MAP` usage for launching Claude teammates.

## [0.6.0] - 2026-02-23

### Added
- Mixed team worker CLI routing via `OMX_TEAM_WORKER_CLI_MAP` so a single `$team` run can launch Codex and Claude workers together (e.g. `codex,codex,claude,claude`).
- Leader-side all-workers-idle nudge fallback for Claude teams, so leader notifications still fire even when worker-side Codex hooks are unavailable.
- Adaptive trigger submit retry guard helper and tests to reduce false-positive resend escalation.

### Changed
- Team trigger fallback now uses a safer ready-prompt + non-active-task gate before adaptive resend.
- Adaptive retry fallback behavior now uses clear-line + resend instead of interrupt escalation in auto mode.

### Fixed
- Pre-assigned worker tasks can now be claimed by their assigned owner in `pending` state, unblocking Codex worker bootstrap claim flow.
- `OMX_TEAM_WORKER_CLI_MAP` parsing now rejects empty entries and reports map-specific validation errors.
- `OMX_TEAM_WORKER_CLI_MAP=auto` now resolves from launch args/model detection and no longer inherits `OMX_TEAM_WORKER_CLI` overrides unexpectedly.
- Team leader nudge targeting now prioritizes `leader_pane_id`, improving reliability with mixed/Claude worker setups.

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
- Added setup scope-aware install modes (`user`, `project`) with persisted scope behavior.
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
