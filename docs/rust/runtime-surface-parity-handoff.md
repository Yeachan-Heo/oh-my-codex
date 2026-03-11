# Runtime Surface Parity Handoff

## Purpose

This handoff captures the current TypeScript runtime/orchestration surface that still sits behind the Rust CLI parity plan. It is scoped to the high-complexity command families deferred to Phase 5 in `.omx/plans/prd-rust-cli-parity-port.md` and `.omx/plans/test-spec-rust-cli-parity-port.md`.

The goal is to make the next runtime-facing Rust work reviewable by separating:

1. low-flake API/help/status contracts,
2. shared process/tmux substrate requirements,
3. live runtime behaviors that still require bounded smoke verification.

## Current authority boundary

The branch has moved past the original advertised-vs-implemented gap. `crates/omx-cli/src/main.rs` now dispatches the full top-level command family through Rust modules, including:

- `launch`
- `setup`
- `agents-init` / `deepinit`
- `uninstall`
- `doctor`
- `ask`
- `session`
- `team`
- `ralph`
- `tmux-hook`
- `hooks`
- `hud`
- `status`
- `cancel`
- `reasoning`
- `help` / `version`

The remaining cutover risk is therefore no longer top-level command visibility. It is the **product-authority boundary** and the depth of operational behavior behind those commands:

- `package.json` now ships `bin.omx = bin/omx`
- `package.json` now uses `cargo build` as the primary build step and keeps `build:js` only for transitional JS test flows
- `README.md` now explicitly distinguishes the Rust-native bundle path from the temporary npm transition path, but final wording must still be confirmed once worker-1 lands the shipped launcher/binary contract
- `release/native-transition.md` correctly describes the intended native-only release contract, but that contract is not yet reflected in the shipped package metadata
- deeper runtime semantics still need validation against the TypeScript source-of-truth in `src/cli/**` and `src/team/**`

So the active review target is no longer “can Rust parse these commands?” but “does the shipped product and the deeper runtime behavior actually make Rust the authority?”

## Runtime surface inventory

### 1. Team CLI surface

Primary contracts:

- `src/cli/team.ts`
- `src/cli/__tests__/team.test.ts`
- `src/cli/__tests__/team-decompose.test.ts`
- `src/team/runtime.ts`
- `src/team/runtime-cli.ts`
- `src/team/state/monitor.ts`

Observed surface areas:

- `omx team --help` / `omx team help`
- `omx team status <team-name>`
- `omx team await <team-name> [--timeout-ms] [--after-event-id] [--json]`
- `omx team resume <team-name>`
- `omx team shutdown <team-name> [--force] [--ralph]`
- `omx team api <operation> --input <json> [--json]`
- task decomposition heuristics and role routing
- stable JSON envelopes for CLI interop operations
- monitor snapshots, event streams, task summaries, and shutdown fallback behavior

Low-flake parity slice:

- help text
- API operation parsing/help
- CLI interop envelope shape
- `team status` phase/task/worker summary lines from state snapshots

Higher-flake/live slice:

- tmux session bootstrap
- worker readiness handshakes
- pane liveness / force-shutdown cleanup
- dispatch nudges and runtime monitoring loops

### 2. Ralph runtime surface

Primary contracts:

- `src/cli/ralph.ts`
- `src/cli/__tests__/ralph.test.ts`
- `src/cli/__tests__/ralph-prd-deep-interview.test.ts`
- `skills/ralph/SKILL.md`

Observed surface areas:

- help text and flag normalization
- `--prd` normalization into task text
- filtering OMX-only args before Codex launch
- persistence bootstrap into `.omx/`
- staffing-plan metadata emission before launch
- PRD-mode deep-interview gate requirement in skill contract

Low-flake parity slice:

- help text
- `extractRalphTaskDescription`
- `normalizeRalphCliArgs`
- `filterRalphCodexArgs`
- persistence/gating contract assertions

Higher-flake/live slice:

- actual Codex/HUD launch after mode-state updates
- integration with runtime launch arguments and tmux/HUD environment propagation

### 3. Hooks surface

Primary contracts:

- `src/cli/hooks.ts`
- hook extensibility modules under `src/hooks/extensibility/**`

Observed surface areas:

- `omx hooks init|status|validate|test`
- sample plugin scaffold creation
- plugin discovery and enablement status reporting
- export validation for `onHookEvent(event, sdk)`
- synthetic dispatch for `turn-complete`
- result normalization and log-path reporting

Low-flake parity slice:

- subcommand parsing/help
- deterministic scaffold/status/validation output
- normalized result formatting for synthetic dispatch

Higher-flake/live slice:

- plugin execution against real hook events inside active sessions
- interactions with runtime logs and state side effects

### 4. tmux-hook surface

Primary contracts:

- `src/cli/tmux-hook.ts`
- state/config files under `.omx/tmux-hook.json` and `.omx/state/tmux-hook-state.json`

Observed surface areas:

- `omx tmux-hook init|status|validate|test`
- config creation and target auto-detection
- config validation rules
- tmux reachability checks
- synthetic end-to-end notify-hook turn test
- deterministic status/log-path output

Low-flake parity slice:

- config schema validation
- deterministic init/status/validate output in controlled fixtures
- tmux target resolution error handling

Higher-flake/live slice:

- interaction with actual tmux targets
- synthetic injection into live panes
- coupling to notify-hook/runtime state

## Documentation / release gaps to close during cutover review

1. **Install docs must stay aligned with the landing artifact.** `README.md` now distinguishes native-bundle install from the pre-cutover npm flow, but translated READMEs and release notes will need the same treatment once the launcher contract is final.
2. **Package metadata still keeps a transitional wrapper in the shipped path today.** The runtime authority has moved off `dist/cli/index.js`, but npm/package flows still rely on a launcher wrapper and JS-based dev/test flows.
3. **Release docs need a strict wording contract.** `release/native-transition.md` now spells out that install/update docs must treat npm as a shim only during transition, but those rules still need to be reflected in release notes and setup/update guidance.
4. **Runtime handoff docs must distinguish dispatch coverage from operational parity.** Rust owns the top-level command routing, while deeper runtime semantics still require validation against the TypeScript source-of-truth.

## Rust substrate already available

The current Rust worktree already includes reusable process/tmux building blocks in `crates/omx-process/**`:

- `process_bridge.rs` — platform-aware command execution, stdio modes, spawn classification, signal mapping
- `process_plan.rs` — ordered step execution with rollback support
- `tmux_commands.rs` — stable tmux command builders (probe/capture/send-keys/kill)
- `tmux_shell.rs` — pane shell command assembly, shell normalization, rc sourcing, env prefix generation

These are necessary but **not sufficient** for runtime parity. They cover subprocess mechanics, while the remaining parity gap lives in:

- CLI command parsing/help and JSON envelope behavior
- state-root/session/team-state semantics
- monitor/task/mailbox lifecycle rules
- bounded tmux startup/shutdown orchestration semantics

## Recommended Rust phase split inside Phase 5

### Stage 5A — deterministic runtime contracts first

Port only the runtime surfaces that are stable without live tmux orchestration:

1. `team` help and CLI API/help parsing
2. `team status` and state-snapshot summaries
3. Ralph arg normalization + PRD gating helpers
4. hooks/tmux-hook help + deterministic config/status/validation paths

Suggested Rust modules to introduce or expand:

- `crates/omx-cli/src/team.rs`
- `crates/omx-cli/src/ralph.rs`
- `crates/omx-cli/src/hooks.rs`
- `crates/omx-cli/src/tmux_hook.rs`
- shared state readers alongside future `status`/`cancel` helpers

### Stage 5B — monitor/state-backed runtime operations

After Stage 5A is green, widen into operations that still avoid full live launch cutover:

1. `team api` read/list/summary/status-style operations
2. state-backed task/event/mailbox inspection
3. bounded shutdown/status flows driven by persisted state

This stage should reuse the same state-root and session helpers already needed for setup/doctor/status/cancel parity.

### Stage 5C — live tmux/runtime orchestration last

Port only after deterministic and state-backed slices are proven:

1. tmux session bootstrap / teardown
2. worker launch specs and pane commands
3. readiness waiting, nudge delivery, force cleanup
4. HUD/watch-pane lifecycle
5. live hooks/tmux-hook runtime injection flows

Required evidence here must stay mixed-mode:

- deterministic Rust tests for step planning / command construction / parsing
- bounded manual smoke for live tmux startup/shutdown only

## Verification gate for any runtime slice

Before advancing from one runtime slice to the next, keep these checks green:

- `cargo test -p omx-cli`
- `cargo test -p omx-process`
- `cargo build`
- `npm run test:compat:rust`

This preserves the current rule from the PRD: do not claim runtime cutover parity early, and do not advance while baseline Rust/pass-through compatibility is broken.

## Concrete implementation risks

### 1. Team help/API parity without runtime semantics

Risk: landing a Rust `team` parser that prints help but silently diverges from the stable CLI interop envelope.

Mitigation: treat `src/cli/__tests__/team.test.ts` API/help assertions as the first Rust contract, before any tmux orchestration work.

### 2. State semantics fork between status/cancel and runtime/team

Risk: runtime commands reading different roots/sessions than the already-planned status/cancel implementation.

Mitigation: reuse shared state/session helpers; do not create a runtime-only path resolver.

### 3. Ralph cutover without gating parity

Risk: Rust normalizes args correctly but loses the PRD/deep-interview gate enforced by the current skill + tests.

Mitigation: keep the gating contract explicit and tested separately from launch behavior.

### 4. tmux-hook and hooks overreach

Risk: porting live injection/plugin execution first would create hard-to-review flakes and mask lower-level output/config drift.

Mitigation: port deterministic init/status/validate/test-path formatting first; defer live event/pane interaction.

### 5. Process-substrate confidence mistaken for full runtime parity

Risk: `crates/omx-process` being green may encourage premature claims that `team`/`launch` are ready.

Mitigation: keep process/tmux crates positioned as enabling infrastructure only; require command-family evidence above them.

## Handoff recommendation

The next owner should treat runtime parity as three sub-slices, not one cutover:

1. deterministic CLI/runtime contract port,
2. state-backed monitor/API/status operations,
3. live tmux/HUD/runtime orchestration.

Do not merge a Rust runtime slice as "team parity" unless it explicitly states which of those three layers it covers.
