# OMX Pure Rust Migration — Design Specification

**Date:** 2026-04-04
**Status:** Draft
**Author:** Artur Ciocanu + Claude Opus 4.6
**Approach:** Skeleton First (Approach C)

---

## 1. Goal

Rewrite oh-my-codex (OMX) from a TypeScript/Rust hybrid to a **pure Rust** implementation. OMX remains an orchestration layer that wraps external LLM CLIs (Codex, Claude) — it does not absorb the agent loop or become a standalone coding agent.

**Why:** Eliminate Node.js as a runtime dependency. Ship a single native binary with zero external runtime requirements. Improve startup time, reduce distribution complexity, and align with the Rust ecosystem (tokio, rmcp, ratatui).

**Non-goals:**
- Replacing Codex/Claude CLIs with a custom agent loop
- Building a TUI for interactive conversation (host CLIs handle that)
- Supporting Windows at launch (tmux dependency)
- Backward compatibility with the Node.js version (clean break)

---

## 2. Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Scope | Orchestration layer rewrite | OMX's value is coordination, not the agent loop |
| Distribution | `cargo install` + Homebrew + GitHub releases | Zero npm dependency, broadest reach |
| MCP servers | 5 separate Rust binaries via `rmcp` | 1:1 with current architecture, consolidate later |
| Hook/plugin system | Shell-based (executables, JSON stdin/stdout) | Composable, language-agnostic, no lock-in |
| Notifications | Hook executables (Rust binaries or shell wrappers) | Pragmatic per-target: use existing CLIs where available |
| Team mode | In v1, full leader/worker hierarchy | Flagship feature, validated architecture |
| HUD | ratatui | Standard Rust TUI, room to grow |
| LLM CLIs | Codex + Claude at launch | Primary providers, Gemini added later |
| Setup | Full parity artifact generation | Artifacts are the integration contract |
| Async runtime | tokio | Required by rmcp, enables concurrent team orchestration |
| Migration approach | Skeleton First | Holistic architecture → parallel agent implementation |

---

## 3. Crate Graph

### 3.1 Workspace Structure

```
omx-rs/
├── Cargo.toml                     # Workspace root
│
│  ── FOUNDATION LAYER ──────────────────────
├── crates/omx-types/              # Shared types, error types, constants
├── crates/omx-config/             # Config loading (TOML/JSON, env vars, precedence)
├── crates/omx-mux/                # Tmux adapter (async wrappers over tmux CLI)
│
│  ── RUNTIME LAYER ─────────────────────────
├── crates/omx-runtime-core/       # Dispatch/authority/mailbox engine (event sourcing)
├── crates/omx-hooks/              # Hook discovery, dispatch, JSON contract
├── crates/omx-state/              # File-based state I/O (atomic writes, locking)
│
│  ── SERVICE LAYER ─────────────────────────
├── crates/omx-mcp-state/          # MCP server: state read/write/clear
├── crates/omx-mcp-memory/         # MCP server: project memory + notepad
├── crates/omx-mcp-code-intel/     # MCP server: diagnostics + AST search
├── crates/omx-mcp-trace/          # MCP server: turn timeline + stats
├── crates/omx-mcp-team/           # MCP server: team job lifecycle
├── crates/omx-team/               # Team orchestration (leader/worker, phases, scaling)
├── crates/omx-sparkshell/         # Shell execution + summarization
├── crates/omx-explore/            # Sandboxed code exploration
│
│  ── PRESENTATION LAYER ────────────────────
├── crates/omx-hud/                # ratatui HUD widgets
├── crates/omx-setup/              # Setup/config generation
├── crates/omx-cli/                # CLI entry point (clap router)
│
│  ── NOTIFICATION HOOKS ────────────────────
├── crates/omx-notify-discord/     # Discord notification hook
├── crates/omx-notify-slack/       # Slack notification hook
└── crates/omx-notify-telegram/    # Telegram notification hook
```

### 3.2 Dependency Flow

```
Foundation ← Runtime ← Service ← Presentation
                                ← Notification hooks
```

Each layer depends only on layers above it. `omx-types` is the zero-dependency leaf.

### 3.3 Binary Outputs

| Binary | Crate | Purpose |
|--------|-------|---------|
| `omx` | omx-cli | Main CLI (all subcommands) |
| `omx-mcp-state` | omx-mcp-state | MCP server |
| `omx-mcp-memory` | omx-mcp-memory | MCP server |
| `omx-mcp-code-intel` | omx-mcp-code-intel | MCP server |
| `omx-mcp-trace` | omx-mcp-trace | MCP server |
| `omx-mcp-team` | omx-mcp-team | MCP server |
| `omx-notify-discord` | omx-notify-discord | Notification hook |
| `omx-notify-slack` | omx-notify-slack | Notification hook |
| `omx-notify-telegram` | omx-notify-telegram | Notification hook |

---

## 4. Key Traits and Type Interfaces

### 4.1 Shared Types (`omx-types`)

```rust
// CLI provider abstraction
pub enum CliProvider { Codex, Claude }

// Team primitives
pub struct WorkerId(pub String);
pub struct TaskId(pub String);
pub struct TeamName(pub String);
pub struct LeaseToken(pub String);

// Task lifecycle
pub enum TaskStatus { Pending, Blocked, InProgress, Completed, Failed }

// Dispatch lifecycle
pub enum DispatchStatus { Pending, Notified, Delivered, Failed }

// Team phases
pub enum TeamPhase { Plan, Prd, Exec, Verify, Fix }

// Hook event contract
pub struct HookEvent {
    pub schema_version: String,
    pub event: HookEventName,
    pub timestamp: String,
    pub source: HookSource,
    pub context: serde_json::Value,
    pub session_id: Option<String>,
}

pub enum HookEventName {
    SessionStart, SessionEnd, SessionIdle,
    TurnComplete, Blocked, Finished, Failed,
    PreToolUse, PostToolUse,
    PrCreated, TestStarted, TestFinished, TestFailed,
}

// Unified error type
pub enum OmxError {
    Config(String),
    Io(std::io::Error),
    Tmux(String),
    State(String),
    Team(String),
    Hook(String),
    Json(serde_json::Error),
}
```

### 4.2 Config Loading (`omx-config`)

```rust
pub struct OmxConfig {
    pub codex_home: PathBuf,
    pub models: ModelConfig,
    pub notifications: NotificationConfig,
    pub team: TeamDefaults,
    pub env: HashMap<String, String>,
}

pub struct ModelConfig {
    pub frontier: String,
    pub standard: String,
    pub spark: String,
    pub per_mode: HashMap<String, String>,
}

// Resolution: CLI arg > env var > .omx-config.json > config.toml > defaults
pub trait ConfigLoader {
    fn load(codex_home: &Path, env: &HashMap<String, String>) -> Result<OmxConfig, OmxError>;
}
```

### 4.3 Tmux Abstraction (`omx-mux`)

```rust
pub trait MuxAdapter: Send + Sync {
    fn resolve_target(&self, target: &MuxTarget) -> Result<String, OmxError>;
    fn send_input(&self, target: &str, text: &str, submit: SubmitPolicy) -> Result<(), OmxError>;
    fn capture_tail(&self, target: &str, lines: usize) -> Result<String, OmxError>;
    fn inspect_liveness(&self, target: &str) -> Result<bool, OmxError>;
    fn create_window(&self, session: &str, name: &str) -> Result<String, OmxError>;
    fn kill_window(&self, target: &str) -> Result<(), OmxError>;
    fn send_keys(&self, target: &str, keys: &str) -> Result<(), OmxError>;
}
```

### 4.4 State Store (`omx-state`)

```rust
pub trait StateStore: Send + Sync {
    async fn read<T: DeserializeOwned>(&self, path: &Path) -> Result<Option<T>, OmxError>;
    async fn write<T: Serialize>(&self, path: &Path, value: &T) -> Result<(), OmxError>;
    async fn delete(&self, path: &Path) -> Result<(), OmxError>;
    async fn list(&self, dir: &Path) -> Result<Vec<PathBuf>, OmxError>;
    async fn append_jsonl<T: Serialize>(&self, path: &Path, entry: &T) -> Result<(), OmxError>;
}
```

Implementation uses temp file + atomic rename + fs2 file locking.

### 4.5 Hook Dispatcher (`omx-hooks`)

```rust
pub trait HookDispatcher: Send + Sync {
    async fn dispatch(&self, event: &HookEvent) -> Vec<HookResult>;
    fn discover(&self, hooks_dir: &Path) -> Result<Vec<HookDescriptor>, OmxError>;
}

pub struct HookDescriptor {
    pub name: String,
    pub path: PathBuf,
    pub executable: bool,
}

pub struct HookResult {
    pub hook: String,
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
}
```

Contract: spawn executable, write HookEvent JSON to stdin, read JSON from stdout, enforce timeout.

### 4.6 Team Runtime (`omx-team`)

```rust
pub struct TeamConfig {
    pub name: TeamName,
    pub workers: Vec<WorkerConfig>,
    pub tasks: Vec<TeamTask>,
    pub governance: TeamGovernance,
    pub worktree_mode: WorktreeMode,
    pub dispatch_mode: DispatchMode,
}

pub trait TeamRuntime: Send + Sync {
    async fn start(&mut self, config: TeamConfig) -> Result<(), OmxError>;
    async fn monitor(&self) -> Result<TeamSnapshot, OmxError>;
    async fn send_message(&self, from: &WorkerId, to: &WorkerId, body: &str) -> Result<(), OmxError>;
    async fn broadcast(&self, from: &WorkerId, body: &str) -> Result<(), OmxError>;
    async fn claim_task(&self, worker: &WorkerId, task: &TaskId) -> Result<LeaseToken, OmxError>;
    async fn transition_task(&self, task: &TaskId, token: &LeaseToken, status: TaskStatus, result: Option<String>) -> Result<(), OmxError>;
    async fn shutdown(&mut self) -> Result<(), OmxError>;
}

pub trait WorkerBootstrap: Send + Sync {
    async fn spawn_worker(&self, config: &WorkerConfig, team: &TeamConfig) -> Result<WorkerId, OmxError>;
    async fn compose_agents_md(&self, worker: &WorkerConfig, team: &TeamConfig) -> Result<String, OmxError>;
    async fn write_inbox(&self, worker: &WorkerId, tasks: &[TeamTask]) -> Result<(), OmxError>;
}

pub trait PhaseController: Send + Sync {
    fn infer_phase(&self, tasks: &[TeamTask]) -> TeamPhase;
    fn recommend_roles(&self, phase: &TeamPhase) -> Vec<String>;
}
```

### 4.7 Setup Generator (`omx-setup`)

```rust
pub trait SetupGenerator: Send + Sync {
    fn generate_config_toml(&self, config: &OmxConfig, scope: SetupScope) -> Result<String, OmxError>;
    fn generate_agents_md(&self, config: &OmxConfig) -> Result<String, OmxError>;
    fn generate_agent_tomls(&self, agents: &[AgentDefinition]) -> Result<Vec<(String, String)>, OmxError>;
    fn sync_mcp_servers(&self, config: &OmxConfig, scope: SetupScope) -> Result<(), OmxError>;
    fn copy_prompts(&self, scope: SetupScope) -> Result<(), OmxError>;
    fn copy_skills(&self, scope: SetupScope) -> Result<(), OmxError>;
}

pub enum SetupScope { User, Project }
```

Prompts and skills are embedded in the binary at compile time via `include_str!()`.

---

## 5. MCP Server Architecture

All 5 MCP servers follow the same pattern using `rmcp`:

- Standalone binary with tokio runtime
- Stdio transport (host CLIs spawn as child processes)
- `#[tool]` proc macros for tool definition
- `schemars` for automatic JSON schema generation
- Shared `omx-state` and `omx-config` dependencies

### 5.1 Tool Surface (ported 1:1 from TypeScript)

| Binary | Tools |
|--------|-------|
| `omx-mcp-state` | `state_read`, `state_write`, `state_clear`, `state_list_active`, `state_get_status` |
| `omx-mcp-memory` | `project_memory_read`, `project_memory_write`, `project_memory_prune`, `notepad_add_note`, `notepad_add_directive` |
| `omx-mcp-code-intel` | `diagnostics_typescript`, `ast_pattern_search` |
| `omx-mcp-trace` | `trace_timeline`, `trace_summary` |
| `omx-mcp-team` | `omx_run_team_start`, `omx_run_team_status`, `omx_run_team_wait`, `omx_run_team_cleanup` |

### 5.2 Security (carried forward)

- Path traversal prevention: NUL byte rejection, `..` blocking, mode segment whitelist (`^[A-Za-z0-9_-]{1,64}$`)
- Session scope resolution: explicit session > current session > root fallback
- Write serialization per file path (tokio mutex)
- Workdir root whitelist via `OMX_MCP_WORKDIR_ROOTS` env var

---

## 6. CLI Command Surface

```
omx
├── (default)                      # Launch Codex/Claude with AGENTS.md injection + HUD
├── setup [--scope user|project]   # Generate config, agents, prompts, skills, MCP entries
├── doctor                         # Verify installation and dependencies
├── version                        # Print version
├── team <N>:<role> "<task>"       # Start team with N workers
│   ├── team status <name>         # Check team health
│   ├── team resume <name>         # Resume interrupted team
│   ├── team shutdown <name>       # Graceful cleanup
│   └── team api                   # Internal worker APIs
│       ├── claim-task
│       ├── transition-task-status
│       └── release-task-claim
├── explore --prompt "..."         # Read-only codebase exploration
├── sparkshell <cmd>               # Shell execution + output summarization
├── hud [--watch]                  # ratatui status display
├── ask <provider> "<prompt>"      # Direct provider query
├── cancel                         # Cancel active modes
├── hooks                          # Hook management
│   ├── hooks status
│   ├── hooks validate
│   └── hooks test
└── hook-api                       # Callback API for hook executables
    ├── tmux send-keys
    ├── state read
    ├── state write
    └── session read
```

### 6.1 Default Launch Flow

```
omx [--model X] [--provider codex|claude] [args...]
  1. Load OmxConfig (config.toml + .omx-config.json + env vars)
  2. Resolve launch policy (inside-tmux / detached-tmux / direct)
  3. Inject AGENTS.md runtime overlay
  4. Build provider CLI args (model, reasoning effort, sandbox flags)
  5. Spawn provider CLI with stdio: inherit
  6. On exit: cleanup hooks, persist session metrics
```

---

## 7. Team Mode Architecture

### 7.1 Hierarchy

Strict two-level leader/worker model (centralized hub-and-spoke):
- Leader owns task decomposition, phase transitions, integration
- Workers are isolated executors with role specialization
- No nested teams (`nested_teams_allowed: false`)
- No peer-to-peer mesh

### 7.2 Lifecycle

```
START
  1. Parse: worker_count, role, task description
  2. Load config, resolve models
  3. Create team state dir (.omx/state/team/)
  4. Create tmux session "omx-team-{name}"
  5. Provision git worktrees (if enabled)
  6. For each worker: compose AGENTS.md, write inbox, spawn CLI, wait for ACK
  7. Launch HUD pane
  8. Enter monitor loop

MONITOR LOOP (async, tokio tasks)
  Every tick:
    1. Snapshot team state (tasks, workers)
    2. Infer phase (plan → prd → exec → verify → fix)
    3. Deliver pending mailbox messages
    4. Track dispatch receipts
    5. Detect stalled workers (heartbeat)
    6. Dispatch hook events
    7. Update HUD

SHUTDOWN
  1. Auto-checkpoint dirty worktrees
  2. Integrate worker commits (merge/cherry-pick)
  3. Record commit hygiene ledger
  4. Kill worker tmux windows
  5. Clean up worktrees
  6. Persist final state
  7. Dispatch session-end hooks
```

### 7.3 Internal Modules (`omx-team`)

```
crates/omx-team/src/
├── lib.rs               # Public API (TeamRuntime trait impl)
├── config.rs            # TeamConfig parsing and validation
├── orchestrator.rs      # Monitor loop, phase transitions
├── worker.rs            # Worker bootstrap, inbox, AGENTS.md composition
├── tmux_session.rs      # Tmux session/window/pane management
├── task_queue.rs        # Task DAG, readiness, claim protocol
├── mailbox.rs           # Point-to-point message delivery
├── dispatch.rs          # Dispatch request tracking, transport selection
├── role_router.rs       # Intent-based role inference
├── phase_controller.rs  # Phase inference from task counts
├── worktree.rs          # Git worktree provisioning, cleanup
├── commit_hygiene.rs    # Operational commit tracking, merge integration
├── scaling.rs           # Dynamic worker scale up/down
└── allocation.rs        # Task allocation policy
```

### 7.4 Concurrency Model

```
Main thread (tokio runtime)
├── Monitor loop task (tokio::spawn)
│   ├── State snapshot (file reads via omx-state)
│   ├── Mailbox delivery (tmux send-keys or hook dispatch)
│   └── HUD update (channel to HUD task)
├── HUD render task (tokio::spawn)
│   └── ratatui event loop (crossterm + state channel)
├── Hook dispatch tasks (tokio::spawn per hook)
│   └── Child process with timeout (tokio::process::Command)
└── Signal handler (tokio::signal)
    └── Triggers graceful shutdown
```

### 7.5 Task Claim Protocol

```
Worker                          State File
  ├── read task (status=pending)
  ├── claim-task(task_id)
  │   ├── generate LeaseToken
  │   ├── atomic write with token
  │   └── return token or conflict
  ├── execute work...
  ├── transition(task_id, token, Completed, result)
  │   ├── verify token matches
  │   └── atomic write new status
```

---

## 8. Hook System

### 8.1 Contract

```
omx discovers hooks → on event → spawns each executable →
  writes HookEvent JSON to stdin → reads HookResult JSON from stdout →
  enforces timeout → logs result
```

### 8.2 Discovery

- Scan `.omx/hooks/` for executable files
- Scan bundled hooks installed by `omx setup`
- Order: bundled first, user hooks second

### 8.3 Hook API (callback subcommands)

For hooks that need to call back into OMX:

```
omx hook-api tmux send-keys --target <pane> "<text>"
omx hook-api state read --mode <mode> --key <key>
omx hook-api state write --mode <mode> --key <key> --value <json>
omx hook-api session read
```

Replaces the in-process JavaScript SDK with subprocess calls.

### 8.4 Logging

All dispatch results written to `.omx/logs/hooks-YYYY-MM-DD.jsonl`.

---

## 9. Setup and Artifact Generation

### 9.1 Generated Artifacts

```
~/.codex/
├── config.toml         # Model defaults, MCP entries, notify hooks
├── AGENTS.md           # 30 agents, 40 skills, delegation rules
├── agents/*.toml       # Per-agent config (30 files)
├── prompts/*.md        # Role prompts (30+ files)
└── skills/*/           # Skill directories (40 skills)
```

### 9.2 MCP Entries (Rust binaries on PATH)

```toml
[mcp_servers.omx_state]
command = "omx-mcp-state"
args = []
enabled = true
startup_timeout_sec = 5
```

### 9.3 Embedded Assets

Prompts, skills, and agent definitions are compiled into the `omx` binary via `include_str!()`. No runtime file resolution needed.

### 9.4 Idempotency

OMX-managed sections in config files are delimited by `# OMX:START` / `# OMX:END` markers. User customizations outside these markers are preserved.

---

## 10. Build, Distribution, and Testing

### 10.1 Cross-Compilation Targets

| Platform | Target |
|----------|--------|
| macOS ARM | `aarch64-apple-darwin` |
| macOS Intel | `x86_64-apple-darwin` |
| Linux GNU x64 | `x86_64-unknown-linux-gnu` |
| Linux GNU ARM | `aarch64-unknown-linux-gnu` |
| Linux musl x64 | `x86_64-unknown-linux-musl` |
| Linux musl ARM | `aarch64-unknown-linux-musl` |

Windows deferred (tmux dependency).

### 10.2 Distribution Channels

- `cargo install omx` (crates.io)
- `brew install omx` (Homebrew tap)
- GitHub releases (cargo-dist archives + checksums)

Homebrew formula installs all binaries (main CLI + MCP servers + notification hooks).

### 10.3 CI Pipeline

```
ci.yml:
  rustfmt → clippy → test → coverage → build → integration

release.yml (on tag):
  version-sync → build-matrix (6 targets) → smoke-test →
  github-release → crates-io → homebrew-tap
```

### 10.4 Testing Strategy

**Layer 1: Unit tests** — per-crate `#[test]` and `#[tokio::test]`, mock traits, snapshot tests (insta).

**Layer 2: Integration tests** — cross-crate: MCP tool calls, team lifecycle, setup artifact verification.

**Layer 3: Comparison tests** (temporary, deleted when TS retired) — run same inputs through both TS and Rust implementations, diff outputs. Covers: config loading, state operations, setup generation, team task claiming.

---

## 11. Migration Execution Plan

### Phase 0: Skeleton
- Define all traits, types, error types across all crates
- Set up workspace, CI, rustfmt, clippy
- All crates compile with `todo!()` bodies
- All tests are `#[ignore]` placeholders

### Phase 1: Foundation
- `omx-types` — shared types
- `omx-config` — config loading
- `omx-state` — atomic file I/O
- `omx-mux` — refactor existing crate, add async
- **Milestone: `omx doctor` works**

### Phase 2: Services (5 crates parallelizable)
- `omx-mcp-state`, `omx-mcp-memory`, `omx-mcp-code-intel`, `omx-mcp-trace` — 4 MCP servers
- `omx-hooks` — discovery, dispatch, timeout
- **Milestone: `omx setup` registers Rust MCP servers, they work with Codex/Claude**

### Phase 3: Team Runtime (sequential)
- task_queue → mailbox → dispatch → worker → tmux_session → orchestrator → phase_controller → role_router → worktree → commit_hygiene → scaling
- **Milestone: `omx team 3:executor "task"` works end-to-end**

### Phase 4: Presentation (3 crates parallelizable)
- `omx-hud` — ratatui widgets
- `omx-setup` — artifact generation
- `omx-cli` — clap router, all subcommands
- Refactor existing `omx-sparkshell` and `omx-explore`
- **Milestone: full `omx` binary replaces Node.js version**

### Phase 5: Notification Hooks + Polish (3 crates parallelizable)
- `omx-notify-discord`, `omx-notify-slack`, `omx-notify-telegram`
- End-to-end integration tests
- Delete all TypeScript
- **Milestone: v1.0.0 release**

### Parallelism Map

```
Phase 0:  [skeleton]
Phase 1:  [omx-types] → [omx-config | omx-state | omx-mux]         (3 parallel)
Phase 2:  [mcp-state | mcp-memory | mcp-code-intel | mcp-trace | hooks]  (5 parallel)
Phase 3:  [task_queue → mailbox → dispatch → worker → ... ]         (sequential)
Phase 4:  [omx-hud | omx-setup | omx-cli]                          (3 parallel)
Phase 5:  [notify-discord | notify-slack | notify-telegram]          (3 parallel)
```

---

## 12. Key External Dependencies

| Crate | Version | Purpose |
|-------|---------|---------|
| `tokio` | 1.x | Async runtime |
| `serde` + `serde_json` | 1.0 | Serialization |
| `rmcp` | latest | MCP server/client SDK |
| `clap` | 4.x | CLI argument parsing |
| `ratatui` | 0.29+ | Terminal UI |
| `crossterm` | 0.28+ | Terminal backend |
| `toml` | 0.8+ | TOML config parsing |
| `fs2` | 0.4 | File locking |
| `reqwest` | 0.12+ | HTTP (notification hooks) |
| `schemars` | latest | JSON schema generation (MCP tools) |
| `thiserror` | 2.x | Error derive macros |
| `tracing` | 0.1 | Structured logging |
| `insta` | latest | Snapshot testing |

---

## 13. Open Questions (to resolve during implementation)

1. **Embedded DB vs files:** Should team state move from JSON files to SQLite (via rusqlite) for better concurrency? Defer to Phase 3 — start with files for parity, evaluate if contention is a problem.

2. **MCP server consolidation:** When to merge 5 binaries into one? Defer to post-v1 — separate binaries are simpler to debug and deploy initially.

3. **Gemini support:** When to add as third CLI provider? Post-v1, driven by demand.

4. **WASM hooks:** Should the hook system support WASM plugins for richer extensibility? Post-v1, evaluate after shell hooks prove out.

5. **Config format migration:** Should `.omx-config.json` become TOML for consistency with `config.toml`? Decide during Phase 1.
