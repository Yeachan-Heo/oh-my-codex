# Pure Rust Migration — Phase 0: Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create all 16 new crates with trait definitions, type stubs, and `todo!()` bodies so the entire workspace compiles and subsequent phases can be parallelized.

**Architecture:** Skeleton-first approach — define every public trait, struct, enum, and error type across all crates. Implementation bodies use `todo!()`. Tests use `#[ignore]`. This establishes the crate graph, dependency flow, and public API surface before any real implementation begins.

**Tech Stack:** Rust 2021 edition, tokio 1.x, serde/serde_json, rmcp, clap 4.x, ratatui, thiserror 2.x, tracing, fs2

**Spec:** `docs/superpowers/specs/2026-04-04-pure-rust-migration-design.md`

**Existing crates (preserved, not modified in Phase 0):** omx-mux, omx-runtime-core, omx-runtime, omx-sparkshell, omx-explore

---

## File Structure

### New crates to create

```
crates/omx-types/
├── Cargo.toml
└── src/lib.rs                    # Shared types, error types, constants

crates/omx-config/
├── Cargo.toml
└── src/lib.rs                    # Config loading trait + OmxConfig struct

crates/omx-state/
├── Cargo.toml
└── src/lib.rs                    # StateStore trait + atomic file I/O stubs

crates/omx-hooks/
├── Cargo.toml
└── src/lib.rs                    # HookDispatcher trait + discovery stubs

crates/omx-mcp-state/
├── Cargo.toml
└── src/main.rs                   # MCP server binary: state tools

crates/omx-mcp-memory/
├── Cargo.toml
└── src/main.rs                   # MCP server binary: memory tools

crates/omx-mcp-code-intel/
├── Cargo.toml
└── src/main.rs                   # MCP server binary: diagnostics + AST

crates/omx-mcp-trace/
├── Cargo.toml
└── src/main.rs                   # MCP server binary: timeline + stats

crates/omx-mcp-team/
├── Cargo.toml
└── src/main.rs                   # MCP server binary: team lifecycle

crates/omx-team/
├── Cargo.toml
└── src/
    ├── lib.rs                    # Public API, TeamRuntime trait impl
    ├── config.rs                 # TeamConfig parsing
    ├── orchestrator.rs           # Monitor loop stubs
    ├── worker.rs                 # WorkerBootstrap trait + stubs
    ├── tmux_session.rs           # Tmux session management stubs
    ├── task_queue.rs             # Task DAG + claim protocol stubs
    ├── mailbox.rs                # Mailbox delivery stubs
    ├── dispatch.rs               # Dispatch tracking stubs
    ├── role_router.rs            # Role inference stubs
    ├── phase_controller.rs       # Phase inference stubs
    ├── worktree.rs               # Git worktree stubs
    ├── commit_hygiene.rs         # Commit tracking stubs
    ├── scaling.rs                # Dynamic scaling stubs
    └── allocation.rs             # Task allocation stubs

crates/omx-hud/
├── Cargo.toml
└── src/lib.rs                    # ratatui widget stubs

crates/omx-setup/
├── Cargo.toml
└── src/lib.rs                    # SetupGenerator trait + stubs

crates/omx-cli/
├── Cargo.toml
└── src/main.rs                   # clap router skeleton

crates/omx-notify-discord/
├── Cargo.toml
└── src/main.rs                   # Discord notification hook binary

crates/omx-notify-slack/
├── Cargo.toml
└── src/main.rs                   # Slack notification hook binary

crates/omx-notify-telegram/
├── Cargo.toml
└── src/main.rs                   # Telegram notification hook binary
```

### Modified files

```
Cargo.toml                        # Add all 16 new workspace members
```

---

## Task 1: Update Workspace Cargo.toml

**Files:**
- Modify: `Cargo.toml` (workspace root)

- [ ] **Step 1: Add all new crate members to workspace**

Replace the `[workspace]` members list in `Cargo.toml`:

```toml
[workspace]
members = [
  # Foundation layer
  "crates/omx-types",
  "crates/omx-config",
  "crates/omx-mux",
  # Runtime layer
  "crates/omx-runtime-core",
  "crates/omx-runtime",
  "crates/omx-state",
  "crates/omx-hooks",
  # Service layer
  "crates/omx-mcp-state",
  "crates/omx-mcp-memory",
  "crates/omx-mcp-code-intel",
  "crates/omx-mcp-trace",
  "crates/omx-mcp-team",
  "crates/omx-team",
  "crates/omx-sparkshell",
  "crates/omx-explore",
  # Presentation layer
  "crates/omx-hud",
  "crates/omx-setup",
  "crates/omx-cli",
  # Notification hooks
  "crates/omx-notify-discord",
  "crates/omx-notify-slack",
  "crates/omx-notify-telegram",
]
resolver = "2"
```

Add workspace-level dependency definitions after `[workspace.package]`:

```toml
[workspace.dependencies]
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
tokio = { version = "1", features = ["full"] }
thiserror = "2"
tracing = "0.1"
clap = { version = "4", features = ["derive"] }
fs2 = "0.4"
rmcp = { version = "0.1", features = ["server", "transport-io"] }
schemars = "0.8"
ratatui = "0.29"
crossterm = "0.28"
toml = "0.8"
reqwest = { version = "0.12", features = ["json"] }
insta = "1"
```

- [ ] **Step 2: Verify workspace parses (will fail until crates exist — that's expected)**

Run: `cargo metadata --format-version=1 2>&1 | head -5`
Expected: Error about missing crates (confirms TOML syntax is valid)

- [ ] **Step 3: Commit**

```bash
git add Cargo.toml
git commit -m "chore: add all Phase 0 crate members to workspace"
```

---

## Task 2: Create omx-types Crate

**Files:**
- Create: `crates/omx-types/Cargo.toml`
- Create: `crates/omx-types/src/lib.rs`

- [ ] **Step 1: Create Cargo.toml**

```toml
[package]
name = "omx-types"
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true
description = "Shared types, error types, and constants for OMX"

[dependencies]
serde = { workspace = true }
serde_json = { workspace = true }
thiserror = { workspace = true }
```

- [ ] **Step 2: Create src/lib.rs with all shared types from spec section 4.1**

```rust
use serde::{Deserialize, Serialize};
use thiserror::Error;

// ---------------------------------------------------------------------------
// CLI provider abstraction
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CliProvider {
    Codex,
    Claude,
}

impl CliProvider {
    pub fn from_label(label: &str) -> Option<Self> {
        match label.trim().to_lowercase().as_str() {
            "codex" => Some(Self::Codex),
            "claude" => Some(Self::Claude),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Team primitives
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct WorkerId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TaskId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TeamName(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeaseToken(pub String);

// ---------------------------------------------------------------------------
// Task lifecycle
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskStatus {
    Pending,
    Blocked,
    InProgress,
    Completed,
    Failed,
}

// ---------------------------------------------------------------------------
// Dispatch lifecycle
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DispatchStatus {
    Pending,
    Notified,
    Delivered,
    Failed,
}

// ---------------------------------------------------------------------------
// Team phases
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum TeamPhase {
    Plan,
    Prd,
    Exec,
    Verify,
    Fix,
}

// ---------------------------------------------------------------------------
// Hook event contract
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookEvent {
    pub schema_version: String,
    pub event: HookEventName,
    pub timestamp: String,
    pub source: HookSource,
    pub context: serde_json::Value,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum HookEventName {
    SessionStart,
    SessionEnd,
    SessionIdle,
    TurnComplete,
    Blocked,
    Finished,
    Failed,
    PreToolUse,
    PostToolUse,
    PrCreated,
    TestStarted,
    TestFinished,
    TestFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HookSource {
    pub component: String,
    pub worker_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Unified error type
// ---------------------------------------------------------------------------

#[derive(Debug, Error)]
pub enum OmxError {
    #[error("config error: {0}")]
    Config(String),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("tmux error: {0}")]
    Tmux(String),

    #[error("state error: {0}")]
    State(String),

    #[error("team error: {0}")]
    Team(String),

    #[error("hook error: {0}")]
    Hook(String),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_provider_from_label_parses_known_providers() {
        assert_eq!(CliProvider::from_label("codex"), Some(CliProvider::Codex));
        assert_eq!(CliProvider::from_label("Claude"), Some(CliProvider::Claude));
        assert_eq!(CliProvider::from_label("gemini"), None);
    }

    #[test]
    fn task_status_serde_roundtrip() {
        let status = TaskStatus::InProgress;
        let json = serde_json::to_string(&status).unwrap();
        let parsed: TaskStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, status);
    }

    #[test]
    fn hook_event_serde_roundtrip() {
        let event = HookEvent {
            schema_version: "1".into(),
            event: HookEventName::SessionStart,
            timestamp: "2026-04-04T00:00:00Z".into(),
            source: HookSource {
                component: "omx-cli".into(),
                worker_id: None,
            },
            context: serde_json::json!({}),
            session_id: Some("sess-1".into()),
        };
        let json = serde_json::to_string(&event).unwrap();
        let parsed: HookEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.event, event.event);
    }

    #[test]
    fn omx_error_display() {
        let err = OmxError::Config("missing field".into());
        assert_eq!(err.to_string(), "config error: missing field");
    }

    #[ignore]
    #[test]
    fn team_phase_ordering_placeholder() {
        // Phase 1: implement phase ordering logic
    }
}
```

- [ ] **Step 3: Verify crate compiles**

Run: `cargo check -p omx-types`
Expected: Compiles successfully

- [ ] **Step 4: Run tests**

Run: `cargo test -p omx-types`
Expected: 4 tests pass, 1 ignored

- [ ] **Step 5: Commit**

```bash
git add crates/omx-types/
git commit -m "feat: add omx-types crate with shared types and error definitions"
```

---

## Task 3: Create omx-config Crate

**Files:**
- Create: `crates/omx-config/Cargo.toml`
- Create: `crates/omx-config/src/lib.rs`

- [ ] **Step 1: Create Cargo.toml**

```toml
[package]
name = "omx-config"
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true
description = "Configuration loading and resolution for OMX"

[dependencies]
omx-types = { path = "../omx-types" }
serde = { workspace = true }
serde_json = { workspace = true }
toml = { workspace = true }
thiserror = { workspace = true }

[dev-dependencies]
insta = { workspace = true }
```

- [ ] **Step 2: Create src/lib.rs with ConfigLoader trait and OmxConfig**

```rust
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use omx_types::OmxError;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Config structs (spec section 4.2)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OmxConfig {
    pub codex_home: PathBuf,
    pub models: ModelConfig,
    pub notifications: NotificationConfig,
    pub team: TeamDefaults,
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConfig {
    pub frontier: String,
    pub standard: String,
    pub spark: String,
    pub per_mode: HashMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NotificationConfig {
    pub discord: Option<DiscordConfig>,
    pub slack: Option<SlackConfig>,
    pub telegram: Option<TelegramConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscordConfig {
    pub webhook_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlackConfig {
    pub webhook_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramConfig {
    pub bot_token: String,
    pub chat_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamDefaults {
    pub default_workers: u8,
    pub default_model: String,
    pub worktree_mode: String,
}

// ---------------------------------------------------------------------------
// ConfigLoader trait
// Resolution: CLI arg > env var > .omx-config.json > config.toml > defaults
// ---------------------------------------------------------------------------

pub trait ConfigLoader {
    fn load(codex_home: &Path, env: &HashMap<String, String>) -> Result<OmxConfig, OmxError>;
}

// ---------------------------------------------------------------------------
// Default implementation (skeleton)
// ---------------------------------------------------------------------------

pub struct DefaultConfigLoader;

impl ConfigLoader for DefaultConfigLoader {
    fn load(_codex_home: &Path, _env: &HashMap<String, String>) -> Result<OmxConfig, OmxError> {
        todo!("Phase 1: implement config loading with precedence chain")
    }
}

/// Return the default codex home directory (~/.codex).
pub fn default_codex_home() -> PathBuf {
    dirs_next().join(".codex")
}

fn dirs_next() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_codex_home_uses_home_env() {
        let home = default_codex_home();
        assert!(home.to_str().unwrap().ends_with(".codex"));
    }

    #[ignore]
    #[test]
    fn config_loader_resolves_precedence_chain() {
        // Phase 1: test CLI arg > env var > .omx-config.json > config.toml > defaults
    }

    #[ignore]
    #[test]
    fn config_toml_deserializes_all_fields() {
        // Phase 1: snapshot test for full config deserialization
    }

    #[ignore]
    #[test]
    fn missing_config_files_produce_sensible_defaults() {
        // Phase 1: test default fallback behavior
    }
}
```

- [ ] **Step 3: Verify crate compiles**

Run: `cargo check -p omx-config`
Expected: Compiles successfully

- [ ] **Step 4: Run tests**

Run: `cargo test -p omx-config`
Expected: 1 test passes, 3 ignored

- [ ] **Step 5: Commit**

```bash
git add crates/omx-config/
git commit -m "feat: add omx-config crate with ConfigLoader trait and config structs"
```

---

## Task 4: Create omx-state Crate

**Files:**
- Create: `crates/omx-state/Cargo.toml`
- Create: `crates/omx-state/src/lib.rs`

- [ ] **Step 1: Create Cargo.toml**

```toml
[package]
name = "omx-state"
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true
description = "File-based state I/O with atomic writes and locking for OMX"

[dependencies]
omx-types = { path = "../omx-types" }
serde = { workspace = true }
serde_json = { workspace = true }
tokio = { workspace = true }
fs2 = { workspace = true }
thiserror = { workspace = true }
tracing = { workspace = true }
```

- [ ] **Step 2: Create src/lib.rs with StateStore trait**

```rust
use std::path::{Path, PathBuf};

use omx_types::OmxError;
use serde::de::DeserializeOwned;
use serde::Serialize;

// ---------------------------------------------------------------------------
// StateStore trait (spec section 4.4)
// ---------------------------------------------------------------------------

#[async_trait::async_trait]
pub trait StateStore: Send + Sync {
    async fn read<T: DeserializeOwned + Send>(&self, path: &Path) -> Result<Option<T>, OmxError>;
    async fn write<T: Serialize + Send + Sync>(&self, path: &Path, value: &T)
        -> Result<(), OmxError>;
    async fn delete(&self, path: &Path) -> Result<(), OmxError>;
    async fn list(&self, dir: &Path) -> Result<Vec<PathBuf>, OmxError>;
    async fn append_jsonl<T: Serialize + Send + Sync>(
        &self,
        path: &Path,
        entry: &T,
    ) -> Result<(), OmxError>;
}

// ---------------------------------------------------------------------------
// FileStateStore (skeleton — atomic rename + fs2 locking)
// ---------------------------------------------------------------------------

pub struct FileStateStore {
    root: PathBuf,
}

impl FileStateStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Resolve a relative path against the store root.
    pub fn resolve(&self, path: &Path) -> PathBuf {
        self.root.join(path)
    }
}

#[async_trait::async_trait]
impl StateStore for FileStateStore {
    async fn read<T: DeserializeOwned + Send>(&self, _path: &Path) -> Result<Option<T>, OmxError> {
        todo!("Phase 1: atomic read with fs2 shared lock")
    }

    async fn write<T: Serialize + Send + Sync>(
        &self,
        _path: &Path,
        _value: &T,
    ) -> Result<(), OmxError> {
        todo!("Phase 1: temp file + atomic rename with fs2 exclusive lock")
    }

    async fn delete(&self, _path: &Path) -> Result<(), OmxError> {
        todo!("Phase 1: remove file if exists")
    }

    async fn list(&self, _dir: &Path) -> Result<Vec<PathBuf>, OmxError> {
        todo!("Phase 1: list directory entries")
    }

    async fn append_jsonl<T: Serialize + Send + Sync>(
        &self,
        _path: &Path,
        _entry: &T,
    ) -> Result<(), OmxError> {
        todo!("Phase 1: append JSON line with exclusive lock")
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_state_store_resolves_paths() {
        let store = FileStateStore::new(PathBuf::from("/tmp/omx-state"));
        assert_eq!(
            store.resolve(Path::new("team/config.json")),
            PathBuf::from("/tmp/omx-state/team/config.json")
        );
    }

    #[ignore]
    #[tokio::test]
    async fn write_then_read_roundtrip() {
        // Phase 1: write a value, read it back, assert equality
    }

    #[ignore]
    #[tokio::test]
    async fn atomic_write_survives_concurrent_reads() {
        // Phase 1: spawn concurrent readers + one writer, assert no partial reads
    }

    #[ignore]
    #[tokio::test]
    async fn append_jsonl_preserves_existing_entries() {
        // Phase 1: append multiple entries, read file, assert all present
    }
}
```

Note: This crate needs `async-trait` added to workspace deps.

- [ ] **Step 3: Add async-trait to workspace dependencies**

Add to `Cargo.toml` workspace dependencies:

```toml
async-trait = "0.1"
```

Add to `crates/omx-state/Cargo.toml` dependencies:

```toml
async-trait = { workspace = true }
```

- [ ] **Step 4: Verify crate compiles**

Run: `cargo check -p omx-state`
Expected: Compiles successfully

- [ ] **Step 5: Run tests**

Run: `cargo test -p omx-state`
Expected: 1 test passes, 3 ignored

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml crates/omx-state/
git commit -m "feat: add omx-state crate with StateStore trait and FileStateStore skeleton"
```

---

## Task 5: Create omx-hooks Crate

**Files:**
- Create: `crates/omx-hooks/Cargo.toml`
- Create: `crates/omx-hooks/src/lib.rs`

- [ ] **Step 1: Create Cargo.toml**

```toml
[package]
name = "omx-hooks"
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true
description = "Hook discovery, dispatch, and JSON contract for OMX"

[dependencies]
omx-types = { path = "../omx-types" }
serde = { workspace = true }
serde_json = { workspace = true }
tokio = { workspace = true }
async-trait = { workspace = true }
tracing = { workspace = true }

[dev-dependencies]
tokio = { workspace = true }
```

- [ ] **Step 2: Create src/lib.rs with HookDispatcher trait**

```rust
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use omx_types::{HookEvent, OmxError};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Hook descriptor and result (spec section 4.5)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookDescriptor {
    pub name: String,
    pub path: PathBuf,
    pub executable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookResult {
    pub hook: String,
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
}

// ---------------------------------------------------------------------------
// HookDispatcher trait (spec section 4.5)
// ---------------------------------------------------------------------------

#[async_trait]
pub trait HookDispatcher: Send + Sync {
    async fn dispatch(&self, event: &HookEvent) -> Vec<HookResult>;
    fn discover(&self, hooks_dir: &Path) -> Result<Vec<HookDescriptor>, OmxError>;
}

// ---------------------------------------------------------------------------
// ShellHookDispatcher (skeleton)
// Contract: spawn executable, write HookEvent JSON to stdin,
//           read JSON from stdout, enforce timeout
// ---------------------------------------------------------------------------

pub struct ShellHookDispatcher {
    hooks: Vec<HookDescriptor>,
    timeout_ms: u64,
}

impl ShellHookDispatcher {
    pub fn new(timeout_ms: u64) -> Self {
        Self {
            hooks: Vec::new(),
            timeout_ms,
        }
    }

    pub fn with_hooks(mut self, hooks: Vec<HookDescriptor>) -> Self {
        self.hooks = hooks;
        self
    }

    pub fn timeout_ms(&self) -> u64 {
        self.timeout_ms
    }
}

#[async_trait]
impl HookDispatcher for ShellHookDispatcher {
    async fn dispatch(&self, _event: &HookEvent) -> Vec<HookResult> {
        todo!("Phase 2: spawn each hook executable, pipe HookEvent JSON to stdin, collect results")
    }

    fn discover(&self, _hooks_dir: &Path) -> Result<Vec<HookDescriptor>, OmxError> {
        todo!("Phase 2: scan .omx/hooks/ + bundled hooks for executables")
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_hook_dispatcher_stores_timeout() {
        let dispatcher = ShellHookDispatcher::new(5000);
        assert_eq!(dispatcher.timeout_ms(), 5000);
    }

    #[ignore]
    #[tokio::test]
    async fn dispatch_sends_hook_event_json_to_stdin() {
        // Phase 2: create a test hook script, dispatch event, verify stdin received
    }

    #[ignore]
    #[test]
    fn discover_finds_executable_files_in_hooks_dir() {
        // Phase 2: create temp dir with executable + non-executable, verify discovery
    }

    #[ignore]
    #[tokio::test]
    async fn dispatch_enforces_timeout() {
        // Phase 2: create a slow hook, verify timeout kicks in
    }
}
```

- [ ] **Step 3: Verify crate compiles**

Run: `cargo check -p omx-hooks`
Expected: Compiles successfully

- [ ] **Step 4: Run tests**

Run: `cargo test -p omx-hooks`
Expected: 1 test passes, 3 ignored

- [ ] **Step 5: Commit**

```bash
git add crates/omx-hooks/
git commit -m "feat: add omx-hooks crate with HookDispatcher trait and shell dispatcher skeleton"
```

---

## Task 6: Create 5 MCP Server Skeletons

**Files:**
- Create: `crates/omx-mcp-state/Cargo.toml`
- Create: `crates/omx-mcp-state/src/main.rs`
- Create: `crates/omx-mcp-memory/Cargo.toml`
- Create: `crates/omx-mcp-memory/src/main.rs`
- Create: `crates/omx-mcp-code-intel/Cargo.toml`
- Create: `crates/omx-mcp-code-intel/src/main.rs`
- Create: `crates/omx-mcp-trace/Cargo.toml`
- Create: `crates/omx-mcp-trace/src/main.rs`
- Create: `crates/omx-mcp-team/Cargo.toml`
- Create: `crates/omx-mcp-team/src/main.rs`

All 5 MCP servers follow the same pattern: standalone binary, tokio runtime, rmcp stdio transport.

- [ ] **Step 1: Create omx-mcp-state**

`crates/omx-mcp-state/Cargo.toml`:

```toml
[package]
name = "omx-mcp-state"
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true
description = "MCP server for OMX state read/write/clear operations"

[[bin]]
name = "omx-mcp-state"
path = "src/main.rs"

[dependencies]
omx-types = { path = "../omx-types" }
omx-state = { path = "../omx-state" }
omx-config = { path = "../omx-config" }
serde = { workspace = true }
serde_json = { workspace = true }
tokio = { workspace = true }
rmcp = { workspace = true }
schemars = { workspace = true }
tracing = { workspace = true }
```

`crates/omx-mcp-state/src/main.rs`:

```rust
use rmcp::ServiceExt;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Tool parameter types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct StateReadParams {
    pub mode: String,
    pub key: String,
    pub session_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct StateWriteParams {
    pub mode: String,
    pub key: String,
    pub value: serde_json::Value,
    pub session_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct StateClearParams {
    pub mode: String,
    pub session_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct StateListActiveParams {
    pub session_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct StateGetStatusParams {
    pub session_id: Option<String>,
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct StateMcpServer;

#[rmcp::tool(tool_box)]
impl StateMcpServer {
    #[tool(description = "Read a state value by mode and key")]
    async fn state_read(&self, #[tool(aggr)] _params: StateReadParams) -> String {
        todo!("Phase 2: read state via omx-state")
    }

    #[tool(description = "Write a state value by mode and key")]
    async fn state_write(&self, #[tool(aggr)] _params: StateWriteParams) -> String {
        todo!("Phase 2: write state via omx-state")
    }

    #[tool(description = "Clear all state for a mode")]
    async fn state_clear(&self, #[tool(aggr)] _params: StateClearParams) -> String {
        todo!("Phase 2: clear state via omx-state")
    }

    #[tool(description = "List all active state modes")]
    async fn state_list_active(&self, #[tool(aggr)] _params: StateListActiveParams) -> String {
        todo!("Phase 2: list active modes via omx-state")
    }

    #[tool(description = "Get overall state status")]
    async fn state_get_status(&self, #[tool(aggr)] _params: StateGetStatusParams) -> String {
        todo!("Phase 2: get status via omx-state")
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::init();
    let service = StateMcpServer.serve(rmcp::transport::io::stdio()).await?;
    service.waiting().await?;
    Ok(())
}
```

- [ ] **Step 2: Create omx-mcp-memory**

`crates/omx-mcp-memory/Cargo.toml`:

```toml
[package]
name = "omx-mcp-memory"
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true
description = "MCP server for OMX project memory and notepad"

[[bin]]
name = "omx-mcp-memory"
path = "src/main.rs"

[dependencies]
omx-types = { path = "../omx-types" }
omx-state = { path = "../omx-state" }
omx-config = { path = "../omx-config" }
serde = { workspace = true }
serde_json = { workspace = true }
tokio = { workspace = true }
rmcp = { workspace = true }
schemars = { workspace = true }
tracing = { workspace = true }
```

`crates/omx-mcp-memory/src/main.rs`:

```rust
use rmcp::ServiceExt;
use serde::Deserialize;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct MemoryReadParams {
    pub project: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct MemoryWriteParams {
    pub project: Option<String>,
    pub key: String,
    pub value: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct MemoryPruneParams {
    pub project: Option<String>,
    pub older_than_days: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct NotepadAddNoteParams {
    pub note: String,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct NotepadAddDirectiveParams {
    pub directive: String,
    pub priority: Option<String>,
}

#[derive(Debug, Clone)]
struct MemoryMcpServer;

#[rmcp::tool(tool_box)]
impl MemoryMcpServer {
    #[tool(description = "Read project memory entries")]
    async fn project_memory_read(&self, #[tool(aggr)] _params: MemoryReadParams) -> String {
        todo!("Phase 2: read project memory")
    }

    #[tool(description = "Write a project memory entry")]
    async fn project_memory_write(&self, #[tool(aggr)] _params: MemoryWriteParams) -> String {
        todo!("Phase 2: write project memory")
    }

    #[tool(description = "Prune old project memory entries")]
    async fn project_memory_prune(&self, #[tool(aggr)] _params: MemoryPruneParams) -> String {
        todo!("Phase 2: prune project memory")
    }

    #[tool(description = "Add a note to the notepad")]
    async fn notepad_add_note(&self, #[tool(aggr)] _params: NotepadAddNoteParams) -> String {
        todo!("Phase 2: add notepad note")
    }

    #[tool(description = "Add a directive to the notepad")]
    async fn notepad_add_directive(
        &self,
        #[tool(aggr)] _params: NotepadAddDirectiveParams,
    ) -> String {
        todo!("Phase 2: add notepad directive")
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::init();
    let service = MemoryMcpServer.serve(rmcp::transport::io::stdio()).await?;
    service.waiting().await?;
    Ok(())
}
```

- [ ] **Step 3: Create omx-mcp-code-intel**

`crates/omx-mcp-code-intel/Cargo.toml`:

```toml
[package]
name = "omx-mcp-code-intel"
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true
description = "MCP server for OMX diagnostics and AST pattern search"

[[bin]]
name = "omx-mcp-code-intel"
path = "src/main.rs"

[dependencies]
omx-types = { path = "../omx-types" }
omx-config = { path = "../omx-config" }
serde = { workspace = true }
serde_json = { workspace = true }
tokio = { workspace = true }
rmcp = { workspace = true }
schemars = { workspace = true }
tracing = { workspace = true }
```

`crates/omx-mcp-code-intel/src/main.rs`:

```rust
use rmcp::ServiceExt;
use serde::Deserialize;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct DiagnosticsParams {
    pub workspace_root: Option<String>,
    pub file_patterns: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct AstPatternSearchParams {
    pub pattern: String,
    pub language: Option<String>,
    pub workspace_root: Option<String>,
}

#[derive(Debug, Clone)]
struct CodeIntelMcpServer;

#[rmcp::tool(tool_box)]
impl CodeIntelMcpServer {
    #[tool(description = "Get TypeScript/JavaScript diagnostics for workspace files")]
    async fn diagnostics_typescript(
        &self,
        #[tool(aggr)] _params: DiagnosticsParams,
    ) -> String {
        todo!("Phase 2: run diagnostics via tsc or language server")
    }

    #[tool(description = "Search code using AST patterns")]
    async fn ast_pattern_search(
        &self,
        #[tool(aggr)] _params: AstPatternSearchParams,
    ) -> String {
        todo!("Phase 2: AST pattern search via tree-sitter or similar")
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::init();
    let service = CodeIntelMcpServer
        .serve(rmcp::transport::io::stdio())
        .await?;
    service.waiting().await?;
    Ok(())
}
```

- [ ] **Step 4: Create omx-mcp-trace**

`crates/omx-mcp-trace/Cargo.toml`:

```toml
[package]
name = "omx-mcp-trace"
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true
description = "MCP server for OMX turn timeline and stats"

[[bin]]
name = "omx-mcp-trace"
path = "src/main.rs"

[dependencies]
omx-types = { path = "../omx-types" }
omx-state = { path = "../omx-state" }
omx-config = { path = "../omx-config" }
serde = { workspace = true }
serde_json = { workspace = true }
tokio = { workspace = true }
rmcp = { workspace = true }
schemars = { workspace = true }
tracing = { workspace = true }
```

`crates/omx-mcp-trace/src/main.rs`:

```rust
use rmcp::ServiceExt;
use serde::Deserialize;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct TraceTimelineParams {
    pub session_id: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct TraceSummaryParams {
    pub session_id: Option<String>,
}

#[derive(Debug, Clone)]
struct TraceMcpServer;

#[rmcp::tool(tool_box)]
impl TraceMcpServer {
    #[tool(description = "Get turn-by-turn timeline for a session")]
    async fn trace_timeline(&self, #[tool(aggr)] _params: TraceTimelineParams) -> String {
        todo!("Phase 2: read timeline from state JSONL")
    }

    #[tool(description = "Get summary statistics for a session")]
    async fn trace_summary(&self, #[tool(aggr)] _params: TraceSummaryParams) -> String {
        todo!("Phase 2: compute summary from timeline entries")
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::init();
    let service = TraceMcpServer.serve(rmcp::transport::io::stdio()).await?;
    service.waiting().await?;
    Ok(())
}
```

- [ ] **Step 5: Create omx-mcp-team**

`crates/omx-mcp-team/Cargo.toml`:

```toml
[package]
name = "omx-mcp-team"
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true
description = "MCP server for OMX team job lifecycle"

[[bin]]
name = "omx-mcp-team"
path = "src/main.rs"

[dependencies]
omx-types = { path = "../omx-types" }
omx-state = { path = "../omx-state" }
omx-config = { path = "../omx-config" }
serde = { workspace = true }
serde_json = { workspace = true }
tokio = { workspace = true }
rmcp = { workspace = true }
schemars = { workspace = true }
tracing = { workspace = true }
```

`crates/omx-mcp-team/src/main.rs`:

```rust
use rmcp::ServiceExt;
use serde::Deserialize;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct TeamStartParams {
    pub workers: u32,
    pub role: String,
    pub task: String,
    pub model: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct TeamStatusParams {
    pub team_name: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct TeamWaitParams {
    pub team_name: String,
    pub timeout_seconds: Option<u64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct TeamCleanupParams {
    pub team_name: String,
}

#[derive(Debug, Clone)]
struct TeamMcpServer;

#[rmcp::tool(tool_box)]
impl TeamMcpServer {
    #[tool(description = "Start a new team run")]
    async fn omx_run_team_start(&self, #[tool(aggr)] _params: TeamStartParams) -> String {
        todo!("Phase 3: delegate to omx-team TeamRuntime::start")
    }

    #[tool(description = "Get current team status")]
    async fn omx_run_team_status(&self, #[tool(aggr)] _params: TeamStatusParams) -> String {
        todo!("Phase 3: delegate to omx-team TeamRuntime::monitor")
    }

    #[tool(description = "Wait for team completion")]
    async fn omx_run_team_wait(&self, #[tool(aggr)] _params: TeamWaitParams) -> String {
        todo!("Phase 3: poll TeamRuntime::monitor until done or timeout")
    }

    #[tool(description = "Clean up team resources")]
    async fn omx_run_team_cleanup(&self, #[tool(aggr)] _params: TeamCleanupParams) -> String {
        todo!("Phase 3: delegate to omx-team TeamRuntime::shutdown")
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::init();
    let service = TeamMcpServer.serve(rmcp::transport::io::stdio()).await?;
    service.waiting().await?;
    Ok(())
}
```

- [ ] **Step 6: Add tracing-subscriber to workspace dependencies**

Add to `Cargo.toml` workspace dependencies:

```toml
tracing-subscriber = "0.3"
```

Add `tracing-subscriber = { workspace = true }` to each MCP server's `Cargo.toml` dependencies.

- [ ] **Step 7: Verify all 5 MCP servers compile**

Run: `cargo check -p omx-mcp-state -p omx-mcp-memory -p omx-mcp-code-intel -p omx-mcp-trace -p omx-mcp-team`
Expected: All compile successfully

- [ ] **Step 8: Commit**

```bash
git add crates/omx-mcp-state/ crates/omx-mcp-memory/ crates/omx-mcp-code-intel/ crates/omx-mcp-trace/ crates/omx-mcp-team/ Cargo.toml
git commit -m "feat: add 5 MCP server skeleton crates with tool definitions"
```

---

## Task 7: Create omx-team Crate

**Files:**
- Create: `crates/omx-team/Cargo.toml`
- Create: `crates/omx-team/src/lib.rs`
- Create: `crates/omx-team/src/config.rs`
- Create: `crates/omx-team/src/orchestrator.rs`
- Create: `crates/omx-team/src/worker.rs`
- Create: `crates/omx-team/src/tmux_session.rs`
- Create: `crates/omx-team/src/task_queue.rs`
- Create: `crates/omx-team/src/mailbox.rs`
- Create: `crates/omx-team/src/dispatch.rs`
- Create: `crates/omx-team/src/role_router.rs`
- Create: `crates/omx-team/src/phase_controller.rs`
- Create: `crates/omx-team/src/worktree.rs`
- Create: `crates/omx-team/src/commit_hygiene.rs`
- Create: `crates/omx-team/src/scaling.rs`
- Create: `crates/omx-team/src/allocation.rs`

- [ ] **Step 1: Create Cargo.toml**

```toml
[package]
name = "omx-team"
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true
description = "Team orchestration: leader/worker hierarchy, phases, scaling"

[dependencies]
omx-types = { path = "../omx-types" }
omx-mux = { path = "../omx-mux" }
omx-state = { path = "../omx-state" }
omx-hooks = { path = "../omx-hooks" }
omx-config = { path = "../omx-config" }
serde = { workspace = true }
serde_json = { workspace = true }
tokio = { workspace = true }
async-trait = { workspace = true }
tracing = { workspace = true }
```

- [ ] **Step 2: Create src/lib.rs with TeamRuntime trait**

```rust
pub mod allocation;
pub mod commit_hygiene;
pub mod config;
pub mod dispatch;
pub mod mailbox;
pub mod orchestrator;
pub mod phase_controller;
pub mod role_router;
pub mod scaling;
pub mod task_queue;
pub mod tmux_session;
pub mod worker;
pub mod worktree;

use async_trait::async_trait;
use omx_types::{LeaseToken, OmxError, TaskId, TaskStatus, WorkerId};
use serde::{Deserialize, Serialize};

use crate::config::TeamConfig;

// ---------------------------------------------------------------------------
// TeamSnapshot — monitor loop output
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamSnapshot {
    pub team_name: String,
    pub phase: omx_types::TeamPhase,
    pub workers: Vec<WorkerSnapshot>,
    pub tasks: Vec<TaskSnapshot>,
    pub uptime_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerSnapshot {
    pub id: WorkerId,
    pub role: String,
    pub alive: bool,
    pub current_task: Option<TaskId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSnapshot {
    pub id: TaskId,
    pub status: TaskStatus,
    pub assigned_to: Option<WorkerId>,
    pub result: Option<String>,
}

// ---------------------------------------------------------------------------
// TeamRuntime trait (spec section 4.6)
// ---------------------------------------------------------------------------

#[async_trait]
pub trait TeamRuntime: Send + Sync {
    async fn start(&mut self, config: TeamConfig) -> Result<(), OmxError>;
    async fn monitor(&self) -> Result<TeamSnapshot, OmxError>;
    async fn send_message(
        &self,
        from: &WorkerId,
        to: &WorkerId,
        body: &str,
    ) -> Result<(), OmxError>;
    async fn broadcast(&self, from: &WorkerId, body: &str) -> Result<(), OmxError>;
    async fn claim_task(
        &self,
        worker: &WorkerId,
        task: &TaskId,
    ) -> Result<LeaseToken, OmxError>;
    async fn transition_task(
        &self,
        task: &TaskId,
        token: &LeaseToken,
        status: TaskStatus,
        result: Option<String>,
    ) -> Result<(), OmxError>;
    async fn shutdown(&mut self) -> Result<(), OmxError>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn team_snapshot_serde_roundtrip() {
        let snapshot = TeamSnapshot {
            team_name: "test-team".into(),
            phase: omx_types::TeamPhase::Exec,
            workers: vec![],
            tasks: vec![],
            uptime_seconds: 42,
        };
        let json = serde_json::to_string(&snapshot).unwrap();
        let parsed: TeamSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.team_name, "test-team");
    }

    #[ignore]
    #[tokio::test]
    async fn team_runtime_lifecycle_placeholder() {
        // Phase 3: test start → monitor → shutdown lifecycle
    }
}
```

- [ ] **Step 3: Create src/config.rs**

```rust
use omx_types::{TeamName, TeamPhase};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamConfig {
    pub name: TeamName,
    pub workers: Vec<WorkerConfig>,
    pub tasks: Vec<TeamTask>,
    pub governance: TeamGovernance,
    pub worktree_mode: WorktreeMode,
    pub dispatch_mode: DispatchMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerConfig {
    pub role: String,
    pub model: Option<String>,
    pub provider: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamTask {
    pub description: String,
    pub depends_on: Vec<String>,
    pub phase: Option<TeamPhase>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamGovernance {
    pub nested_teams_allowed: bool,
    pub auto_scale: bool,
    pub max_workers: u8,
}

impl Default for TeamGovernance {
    fn default() -> Self {
        Self {
            nested_teams_allowed: false,
            auto_scale: false,
            max_workers: 10,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum WorktreeMode {
    Shared,
    PerWorker,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DispatchMode {
    Tmux,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn governance_defaults_disable_nesting() {
        let gov = TeamGovernance::default();
        assert!(!gov.nested_teams_allowed);
        assert!(!gov.auto_scale);
        assert_eq!(gov.max_workers, 10);
    }
}
```

- [ ] **Step 4: Create src/task_queue.rs**

```rust
use omx_types::{LeaseToken, OmxError, TaskId, TaskStatus, WorkerId};

/// Task readiness resolver — determines which tasks can be claimed.
pub fn ready_tasks(_tasks: &[(TaskId, TaskStatus, Vec<TaskId>)]) -> Vec<TaskId> {
    todo!("Phase 3: resolve DAG dependencies, return tasks with all deps completed")
}

/// Attempt to claim a task for a worker. Returns a lease token on success.
pub fn claim(
    _task: &TaskId,
    _worker: &WorkerId,
    _current_status: &TaskStatus,
) -> Result<LeaseToken, OmxError> {
    todo!("Phase 3: generate LeaseToken, validate task is claimable")
}

/// Transition task status, verifying the lease token.
pub fn transition(
    _task: &TaskId,
    _token: &LeaseToken,
    _new_status: TaskStatus,
    _result: Option<String>,
) -> Result<(), OmxError> {
    todo!("Phase 3: verify token, update status atomically")
}

#[cfg(test)]
mod tests {
    #[ignore]
    #[test]
    fn ready_tasks_respects_dependency_dag() {
        // Phase 3: create tasks with dependencies, verify readiness
    }

    #[ignore]
    #[test]
    fn claim_rejects_non_pending_tasks() {
        // Phase 3: try to claim in-progress task, expect error
    }
}
```

- [ ] **Step 5: Create src/mailbox.rs**

```rust
use omx_types::{OmxError, WorkerId};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailboxMessage {
    pub id: String,
    pub from: WorkerId,
    pub to: WorkerId,
    pub body: String,
    pub created_at: String,
    pub delivered: bool,
}

pub fn create_message(
    _from: &WorkerId,
    _to: &WorkerId,
    _body: &str,
) -> Result<MailboxMessage, OmxError> {
    todo!("Phase 3: create mailbox message with unique ID and timestamp")
}

pub fn pending_messages(_for_worker: &WorkerId) -> Result<Vec<MailboxMessage>, OmxError> {
    todo!("Phase 3: read undelivered messages for worker")
}

pub fn mark_delivered(_message_id: &str) -> Result<(), OmxError> {
    todo!("Phase 3: mark message as delivered")
}

#[cfg(test)]
mod tests {
    #[ignore]
    #[test]
    fn message_lifecycle_placeholder() {
        // Phase 3: create → pending → deliver
    }
}
```

- [ ] **Step 6: Create src/dispatch.rs**

```rust
use omx_types::OmxError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DispatchRequest {
    pub request_id: String,
    pub target: String,
    pub body: String,
    pub transport: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DispatchReceipt {
    pub request_id: String,
    pub success: bool,
    pub reason: Option<String>,
    pub duration_ms: u64,
}

pub fn queue_dispatch(_request: DispatchRequest) -> Result<(), OmxError> {
    todo!("Phase 3: queue dispatch request for delivery")
}

pub fn process_pending() -> Result<Vec<DispatchReceipt>, OmxError> {
    todo!("Phase 3: process all pending dispatch requests")
}

#[cfg(test)]
mod tests {
    #[ignore]
    #[test]
    fn dispatch_lifecycle_placeholder() {
        // Phase 3: queue → process → receipt
    }
}
```

- [ ] **Step 7: Create src/worker.rs**

```rust
use async_trait::async_trait;
use omx_types::{OmxError, WorkerId};

use crate::config::{TeamConfig, WorkerConfig, TeamTask};

#[async_trait]
pub trait WorkerBootstrap: Send + Sync {
    async fn spawn_worker(
        &self,
        config: &WorkerConfig,
        team: &TeamConfig,
    ) -> Result<WorkerId, OmxError>;

    async fn compose_agents_md(
        &self,
        worker: &WorkerConfig,
        team: &TeamConfig,
    ) -> Result<String, OmxError>;

    async fn write_inbox(
        &self,
        worker: &WorkerId,
        tasks: &[TeamTask],
    ) -> Result<(), OmxError>;
}

pub struct DefaultWorkerBootstrap;

#[async_trait]
impl WorkerBootstrap for DefaultWorkerBootstrap {
    async fn spawn_worker(
        &self,
        _config: &WorkerConfig,
        _team: &TeamConfig,
    ) -> Result<WorkerId, OmxError> {
        todo!("Phase 3: compose AGENTS.md, spawn CLI in tmux window")
    }

    async fn compose_agents_md(
        &self,
        _worker: &WorkerConfig,
        _team: &TeamConfig,
    ) -> Result<String, OmxError> {
        todo!("Phase 3: generate AGENTS.md with role, tools, constraints")
    }

    async fn write_inbox(
        &self,
        _worker: &WorkerId,
        _tasks: &[TeamTask],
    ) -> Result<(), OmxError> {
        todo!("Phase 3: write task list to worker inbox file")
    }
}

#[cfg(test)]
mod tests {
    #[ignore]
    #[tokio::test]
    async fn spawn_worker_placeholder() {
        // Phase 3: test worker spawn + AGENTS.md generation
    }
}
```

- [ ] **Step 8: Create src/orchestrator.rs**

```rust
use omx_types::OmxError;

use crate::TeamSnapshot;

/// The monitor loop tick — called on each iteration.
pub async fn tick() -> Result<TeamSnapshot, OmxError> {
    todo!("Phase 3: snapshot state, infer phase, deliver mailbox, track dispatch, detect stalls, dispatch hooks, update HUD")
}

/// Graceful shutdown sequence.
pub async fn shutdown() -> Result<(), OmxError> {
    todo!("Phase 3: checkpoint worktrees, integrate commits, kill windows, cleanup, persist final state")
}

#[cfg(test)]
mod tests {
    #[ignore]
    #[tokio::test]
    async fn monitor_tick_placeholder() {
        // Phase 3: test single tick with mock state
    }
}
```

- [ ] **Step 9: Create remaining module stubs**

`crates/omx-team/src/tmux_session.rs`:

```rust
use omx_types::OmxError;

pub fn create_team_session(_name: &str) -> Result<String, OmxError> {
    todo!("Phase 3: create tmux session 'omx-team-{name}'")
}

pub fn create_worker_window(_session: &str, _worker_name: &str) -> Result<String, OmxError> {
    todo!("Phase 3: create tmux window for worker")
}

pub fn kill_team_session(_name: &str) -> Result<(), OmxError> {
    todo!("Phase 3: kill tmux session and all windows")
}

#[cfg(test)]
mod tests {
    #[ignore]
    #[test]
    fn tmux_session_placeholder() {}
}
```

`crates/omx-team/src/role_router.rs`:

```rust
use omx_types::TeamPhase;

/// Infer recommended roles for a given team phase.
pub fn recommend_roles(_phase: &TeamPhase) -> Vec<String> {
    todo!("Phase 3: return role recommendations based on phase")
}

/// Route a task description to the best-fit role.
pub fn route_task(_description: &str, _available_roles: &[String]) -> Option<String> {
    todo!("Phase 3: intent-based role inference")
}

#[cfg(test)]
mod tests {
    #[ignore]
    #[test]
    fn role_routing_placeholder() {}
}
```

`crates/omx-team/src/phase_controller.rs`:

```rust
use omx_types::{TaskStatus, TeamPhase};

pub trait PhaseController: Send + Sync {
    fn infer_phase(&self, tasks: &[(TaskStatus, Option<TeamPhase>)]) -> TeamPhase;
    fn recommend_roles(&self, phase: &TeamPhase) -> Vec<String>;
}

pub struct DefaultPhaseController;

impl PhaseController for DefaultPhaseController {
    fn infer_phase(&self, _tasks: &[(TaskStatus, Option<TeamPhase>)]) -> TeamPhase {
        todo!("Phase 3: count task statuses per phase, infer current phase")
    }

    fn recommend_roles(&self, _phase: &TeamPhase) -> Vec<String> {
        todo!("Phase 3: return recommended roles for phase")
    }
}

#[cfg(test)]
mod tests {
    #[ignore]
    #[test]
    fn phase_inference_placeholder() {}
}
```

`crates/omx-team/src/worktree.rs`:

```rust
use omx_types::OmxError;

pub fn provision_worktree(_team_name: &str, _worker_name: &str) -> Result<String, OmxError> {
    todo!("Phase 3: git worktree add for worker isolation")
}

pub fn cleanup_worktree(_path: &str) -> Result<(), OmxError> {
    todo!("Phase 3: git worktree remove")
}

#[cfg(test)]
mod tests {
    #[ignore]
    #[test]
    fn worktree_lifecycle_placeholder() {}
}
```

`crates/omx-team/src/commit_hygiene.rs`:

```rust
use omx_types::OmxError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitRecord {
    pub sha: String,
    pub worker: String,
    pub message: String,
    pub timestamp: String,
}

pub fn record_commit(_worker: &str, _sha: &str, _message: &str) -> Result<(), OmxError> {
    todo!("Phase 3: append commit to hygiene ledger")
}

pub fn integrate_commits(_team_name: &str) -> Result<Vec<CommitRecord>, OmxError> {
    todo!("Phase 3: merge/cherry-pick worker commits into main branch")
}

#[cfg(test)]
mod tests {
    #[ignore]
    #[test]
    fn commit_hygiene_placeholder() {}
}
```

`crates/omx-team/src/scaling.rs`:

```rust
use omx_types::OmxError;

pub fn recommend_scale(_current_workers: u8, _pending_tasks: u32, _max: u8) -> u8 {
    todo!("Phase 3: recommend worker count based on pending work")
}

pub fn scale_up(_additional: u8) -> Result<(), OmxError> {
    todo!("Phase 3: spawn additional workers")
}

pub fn scale_down(_remove: u8) -> Result<(), OmxError> {
    todo!("Phase 3: gracefully remove workers")
}

#[cfg(test)]
mod tests {
    #[ignore]
    #[test]
    fn scaling_recommendation_placeholder() {}
}
```

`crates/omx-team/src/allocation.rs`:

```rust
use omx_types::{TaskId, WorkerId};

/// Allocate tasks to workers based on role, load, and task dependencies.
pub fn allocate(
    _ready_tasks: &[TaskId],
    _available_workers: &[WorkerId],
) -> Vec<(TaskId, WorkerId)> {
    todo!("Phase 3: task allocation policy — match tasks to workers")
}

#[cfg(test)]
mod tests {
    #[ignore]
    #[test]
    fn allocation_policy_placeholder() {}
}
```

- [ ] **Step 10: Verify omx-team compiles**

Run: `cargo check -p omx-team`
Expected: Compiles successfully

- [ ] **Step 11: Run tests**

Run: `cargo test -p omx-team`
Expected: 2 tests pass (config + snapshot serde), remaining ignored

- [ ] **Step 12: Commit**

```bash
git add crates/omx-team/
git commit -m "feat: add omx-team crate with TeamRuntime trait and 13 module skeletons"
```

---

## Task 8: Create omx-hud Crate

**Files:**
- Create: `crates/omx-hud/Cargo.toml`
- Create: `crates/omx-hud/src/lib.rs`

- [ ] **Step 1: Create Cargo.toml**

```toml
[package]
name = "omx-hud"
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true
description = "ratatui HUD widgets for OMX status display"

[dependencies]
omx-types = { path = "../omx-types" }
ratatui = { workspace = true }
crossterm = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
tokio = { workspace = true }
```

- [ ] **Step 2: Create src/lib.rs with widget stubs**

```rust
use omx_types::TeamPhase;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// HUD state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HudState {
    pub session_id: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub team_phase: Option<TeamPhase>,
    pub worker_count: u32,
    pub pending_tasks: u32,
    pub completed_tasks: u32,
    pub uptime_seconds: u64,
}

impl Default for HudState {
    fn default() -> Self {
        Self {
            session_id: None,
            provider: None,
            model: None,
            team_phase: None,
            worker_count: 0,
            pending_tasks: 0,
            completed_tasks: 0,
            uptime_seconds: 0,
        }
    }
}

// ---------------------------------------------------------------------------
// HUD renderer (skeleton)
// ---------------------------------------------------------------------------

/// Render the HUD in a ratatui terminal. Blocks until shutdown signal.
pub async fn run_hud(_initial_state: HudState) -> Result<(), Box<dyn std::error::Error>> {
    todo!("Phase 4: ratatui event loop with crossterm backend, render widgets, listen for state updates via channel")
}

/// Render a single frame (for testing).
pub fn render_frame(
    _state: &HudState,
    _frame: &mut ratatui::Frame,
    _area: ratatui::layout::Rect,
) {
    todo!("Phase 4: render HUD widgets — header, team status, task list, worker grid")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hud_state_default_is_idle() {
        let state = HudState::default();
        assert!(state.session_id.is_none());
        assert_eq!(state.worker_count, 0);
    }

    #[test]
    fn hud_state_serde_roundtrip() {
        let state = HudState {
            session_id: Some("sess-1".into()),
            provider: Some("codex".into()),
            model: Some("o3".into()),
            team_phase: Some(TeamPhase::Exec),
            worker_count: 3,
            pending_tasks: 5,
            completed_tasks: 2,
            uptime_seconds: 120,
        };
        let json = serde_json::to_string(&state).unwrap();
        let parsed: HudState = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.worker_count, 3);
    }

    #[ignore]
    #[test]
    fn render_frame_placeholder() {
        // Phase 4: test render with TestBackend
    }
}
```

- [ ] **Step 3: Verify crate compiles**

Run: `cargo check -p omx-hud`
Expected: Compiles successfully

- [ ] **Step 4: Commit**

```bash
git add crates/omx-hud/
git commit -m "feat: add omx-hud crate with HudState and ratatui widget skeletons"
```

---

## Task 9: Create omx-setup Crate

**Files:**
- Create: `crates/omx-setup/Cargo.toml`
- Create: `crates/omx-setup/src/lib.rs`

- [ ] **Step 1: Create Cargo.toml**

```toml
[package]
name = "omx-setup"
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true
description = "Setup and artifact generation for OMX"

[dependencies]
omx-types = { path = "../omx-types" }
omx-config = { path = "../omx-config" }
serde = { workspace = true }
serde_json = { workspace = true }
toml = { workspace = true }
thiserror = { workspace = true }
tracing = { workspace = true }
```

- [ ] **Step 2: Create src/lib.rs with SetupGenerator trait**

```rust
use omx_config::OmxConfig;
use omx_types::OmxError;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Setup scope
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SetupScope {
    User,
    Project,
}

// ---------------------------------------------------------------------------
// Agent definition
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDefinition {
    pub name: String,
    pub description: String,
    pub model: Option<String>,
    pub tools: Vec<String>,
}

// ---------------------------------------------------------------------------
// SetupGenerator trait (spec section 4.7)
// ---------------------------------------------------------------------------

pub trait SetupGenerator: Send + Sync {
    fn generate_config_toml(
        &self,
        config: &OmxConfig,
        scope: SetupScope,
    ) -> Result<String, OmxError>;

    fn generate_agents_md(&self, config: &OmxConfig) -> Result<String, OmxError>;

    fn generate_agent_tomls(
        &self,
        agents: &[AgentDefinition],
    ) -> Result<Vec<(String, String)>, OmxError>;

    fn sync_mcp_servers(&self, config: &OmxConfig, scope: SetupScope) -> Result<(), OmxError>;

    fn copy_prompts(&self, scope: SetupScope) -> Result<(), OmxError>;

    fn copy_skills(&self, scope: SetupScope) -> Result<(), OmxError>;
}

// ---------------------------------------------------------------------------
// DefaultSetupGenerator (skeleton)
// ---------------------------------------------------------------------------

pub struct DefaultSetupGenerator;

impl SetupGenerator for DefaultSetupGenerator {
    fn generate_config_toml(
        &self,
        _config: &OmxConfig,
        _scope: SetupScope,
    ) -> Result<String, OmxError> {
        todo!("Phase 4: generate config.toml with OMX:START/OMX:END markers")
    }

    fn generate_agents_md(&self, _config: &OmxConfig) -> Result<String, OmxError> {
        todo!("Phase 4: generate AGENTS.md with all agent definitions")
    }

    fn generate_agent_tomls(
        &self,
        _agents: &[AgentDefinition],
    ) -> Result<Vec<(String, String)>, OmxError> {
        todo!("Phase 4: generate per-agent .toml files")
    }

    fn sync_mcp_servers(&self, _config: &OmxConfig, _scope: SetupScope) -> Result<(), OmxError> {
        todo!("Phase 4: register Rust MCP server binaries in config.toml")
    }

    fn copy_prompts(&self, _scope: SetupScope) -> Result<(), OmxError> {
        todo!("Phase 4: write embedded prompts to disk")
    }

    fn copy_skills(&self, _scope: SetupScope) -> Result<(), OmxError> {
        todo!("Phase 4: write embedded skills to disk")
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_scope_serde_roundtrip() {
        let scope = SetupScope::Project;
        let json = serde_json::to_string(&scope).unwrap();
        let parsed: SetupScope = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, scope);
    }

    #[ignore]
    #[test]
    fn generate_config_toml_placeholder() {
        // Phase 4: test config.toml generation with markers
    }

    #[ignore]
    #[test]
    fn generate_agents_md_placeholder() {
        // Phase 4: test AGENTS.md generation
    }
}
```

- [ ] **Step 3: Verify crate compiles**

Run: `cargo check -p omx-setup`
Expected: Compiles successfully

- [ ] **Step 4: Commit**

```bash
git add crates/omx-setup/
git commit -m "feat: add omx-setup crate with SetupGenerator trait and artifact generation skeletons"
```

---

## Task 10: Create omx-cli Crate

**Files:**
- Create: `crates/omx-cli/Cargo.toml`
- Create: `crates/omx-cli/src/main.rs`

- [ ] **Step 1: Create Cargo.toml**

```toml
[package]
name = "omx-cli"
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true
description = "CLI entry point for OMX — clap router for all subcommands"

[[bin]]
name = "omx"
path = "src/main.rs"

[dependencies]
omx-types = { path = "../omx-types" }
omx-config = { path = "../omx-config" }
omx-state = { path = "../omx-state" }
omx-hooks = { path = "../omx-hooks" }
omx-team = { path = "../omx-team" }
omx-hud = { path = "../omx-hud" }
omx-setup = { path = "../omx-setup" }
clap = { workspace = true }
tokio = { workspace = true }
serde_json = { workspace = true }
tracing = { workspace = true }
tracing-subscriber = { workspace = true }
```

- [ ] **Step 2: Create src/main.rs with clap router skeleton**

```rust
use clap::{Parser, Subcommand};

/// OMX — orchestration layer for LLM CLIs
#[derive(Debug, Parser)]
#[command(name = "omx", version, about)]
struct Cli {
    /// Model override
    #[arg(long)]
    model: Option<String>,

    /// Provider override (codex or claude)
    #[arg(long)]
    provider: Option<String>,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Generate config, agents, prompts, skills, MCP entries
    Setup {
        #[arg(long, default_value = "user")]
        scope: String,
    },

    /// Verify installation and dependencies
    Doctor,

    /// Print version
    Version,

    /// Start team with N workers
    Team {
        #[command(subcommand)]
        action: TeamAction,
    },

    /// Read-only codebase exploration
    Explore {
        /// Prompt for exploration
        #[arg(long)]
        prompt: String,
    },

    /// Shell execution + output summarization
    Sparkshell {
        /// Command to execute
        command: Vec<String>,
    },

    /// ratatui status display
    Hud {
        /// Watch mode — continuously update
        #[arg(long)]
        watch: bool,
    },

    /// Direct provider query
    Ask {
        /// Provider name
        provider: String,
        /// Prompt text
        prompt: String,
    },

    /// Cancel active modes
    Cancel,

    /// Hook management
    Hooks {
        #[command(subcommand)]
        action: HooksAction,
    },

    /// Internal callback API for hook executables
    HookApi {
        #[command(subcommand)]
        action: HookApiAction,
    },
}

#[derive(Debug, Subcommand)]
enum TeamAction {
    /// Start team: omx team start 3:executor "task"
    Start {
        /// Worker spec (e.g., "3:executor")
        spec: String,
        /// Task description
        task: String,
    },
    /// Check team health
    Status { name: String },
    /// Resume interrupted team
    Resume { name: String },
    /// Graceful cleanup
    Shutdown { name: String },
    /// Internal worker APIs
    Api {
        #[command(subcommand)]
        action: TeamApiAction,
    },
}

#[derive(Debug, Subcommand)]
enum TeamApiAction {
    ClaimTask {
        #[arg(long)]
        task_id: String,
    },
    TransitionTaskStatus {
        #[arg(long)]
        task_id: String,
        #[arg(long)]
        status: String,
    },
    ReleaseTaskClaim {
        #[arg(long)]
        task_id: String,
    },
}

#[derive(Debug, Subcommand)]
enum HooksAction {
    /// Show hook status
    Status,
    /// Validate hook configurations
    Validate,
    /// Test hook execution
    Test,
}

#[derive(Debug, Subcommand)]
enum HookApiAction {
    /// Send tmux keys
    TmuxSendKeys {
        #[arg(long)]
        target: String,
        text: String,
    },
    /// Read state
    StateRead {
        #[arg(long)]
        mode: String,
        #[arg(long)]
        key: String,
    },
    /// Write state
    StateWrite {
        #[arg(long)]
        mode: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        value: String,
    },
    /// Read session info
    SessionRead,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::init();

    let cli = Cli::parse();

    match cli.command {
        None => {
            todo!("Phase 4: default launch flow — load config, resolve policy, inject AGENTS.md, spawn provider CLI")
        }
        Some(Commands::Setup { scope: _ }) => {
            todo!("Phase 4: run setup generator")
        }
        Some(Commands::Doctor) => {
            todo!("Phase 1: verify installation — tmux, providers, MCP servers")
        }
        Some(Commands::Version) => {
            println!("omx {}", env!("CARGO_PKG_VERSION"));
            Ok(())?
        }
        Some(Commands::Team { action }) => match action {
            TeamAction::Start { spec: _, task: _ } => {
                todo!("Phase 3: parse spec, create TeamConfig, start team")
            }
            TeamAction::Status { name: _ } => {
                todo!("Phase 3: read team state, display status")
            }
            TeamAction::Resume { name: _ } => {
                todo!("Phase 3: load persisted state, resume monitor loop")
            }
            TeamAction::Shutdown { name: _ } => {
                todo!("Phase 3: graceful shutdown")
            }
            TeamAction::Api { action } => match action {
                TeamApiAction::ClaimTask { task_id: _ } => {
                    todo!("Phase 3: claim task via omx-team")
                }
                TeamApiAction::TransitionTaskStatus {
                    task_id: _,
                    status: _,
                } => {
                    todo!("Phase 3: transition task status")
                }
                TeamApiAction::ReleaseTaskClaim { task_id: _ } => {
                    todo!("Phase 3: release task claim")
                }
            },
        },
        Some(Commands::Explore { prompt: _ }) => {
            todo!("Phase 4: delegate to omx-explore")
        }
        Some(Commands::Sparkshell { command: _ }) => {
            todo!("Phase 4: delegate to omx-sparkshell")
        }
        Some(Commands::Hud { watch: _ }) => {
            todo!("Phase 4: launch ratatui HUD")
        }
        Some(Commands::Ask {
            provider: _,
            prompt: _,
        }) => {
            todo!("Phase 4: direct provider query")
        }
        Some(Commands::Cancel) => {
            todo!("Phase 4: cancel active modes")
        }
        Some(Commands::Hooks { action }) => match action {
            HooksAction::Status => todo!("Phase 2: show hook status"),
            HooksAction::Validate => todo!("Phase 2: validate hooks"),
            HooksAction::Test => todo!("Phase 2: test hooks"),
        },
        Some(Commands::HookApi { action }) => match action {
            HookApiAction::TmuxSendKeys { target: _, text: _ } => {
                todo!("Phase 2: send tmux keys via omx-mux")
            }
            HookApiAction::StateRead { mode: _, key: _ } => {
                todo!("Phase 2: read state via omx-state")
            }
            HookApiAction::StateWrite {
                mode: _,
                key: _,
                value: _,
            } => {
                todo!("Phase 2: write state via omx-state")
            }
            HookApiAction::SessionRead => {
                todo!("Phase 2: read session info")
            }
        },
    }

    Ok(())
}
```

- [ ] **Step 3: Verify crate compiles**

Run: `cargo check -p omx-cli`
Expected: Compiles successfully

- [ ] **Step 4: Verify version subcommand works**

Run: `cargo run -p omx-cli -- version`
Expected: Prints `omx 0.11.13` (or current workspace version)

- [ ] **Step 5: Verify help output shows all subcommands**

Run: `cargo run -p omx-cli -- --help`
Expected: Lists setup, doctor, version, team, explore, sparkshell, hud, ask, cancel, hooks, hook-api

- [ ] **Step 6: Commit**

```bash
git add crates/omx-cli/
git commit -m "feat: add omx-cli crate with full clap command router skeleton"
```

---

## Task 11: Create 3 Notification Hook Skeletons

**Files:**
- Create: `crates/omx-notify-discord/Cargo.toml`
- Create: `crates/omx-notify-discord/src/main.rs`
- Create: `crates/omx-notify-slack/Cargo.toml`
- Create: `crates/omx-notify-slack/src/main.rs`
- Create: `crates/omx-notify-telegram/Cargo.toml`
- Create: `crates/omx-notify-telegram/src/main.rs`

All 3 follow the same pattern: read HookEvent from stdin, send notification, write HookResult to stdout.

- [ ] **Step 1: Create omx-notify-discord**

`crates/omx-notify-discord/Cargo.toml`:

```toml
[package]
name = "omx-notify-discord"
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true
description = "Discord notification hook for OMX"

[[bin]]
name = "omx-notify-discord"
path = "src/main.rs"

[dependencies]
omx-types = { path = "../omx-types" }
serde = { workspace = true }
serde_json = { workspace = true }
reqwest = { workspace = true }
tokio = { workspace = true }
```

`crates/omx-notify-discord/src/main.rs`:

```rust
use std::io::{self, Read};
use omx_types::HookEvent;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;

    let _event: HookEvent = serde_json::from_str(&input)?;

    // Phase 5: send Discord webhook notification
    let result = serde_json::json!({
        "hook": "omx-notify-discord",
        "success": false,
        "stdout": "",
        "stderr": "not implemented",
        "duration_ms": 0
    });

    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}
```

- [ ] **Step 2: Create omx-notify-slack**

`crates/omx-notify-slack/Cargo.toml`:

```toml
[package]
name = "omx-notify-slack"
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true
description = "Slack notification hook for OMX"

[[bin]]
name = "omx-notify-slack"
path = "src/main.rs"

[dependencies]
omx-types = { path = "../omx-types" }
serde = { workspace = true }
serde_json = { workspace = true }
reqwest = { workspace = true }
tokio = { workspace = true }
```

`crates/omx-notify-slack/src/main.rs`:

```rust
use std::io::{self, Read};
use omx_types::HookEvent;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;

    let _event: HookEvent = serde_json::from_str(&input)?;

    // Phase 5: send Slack webhook notification
    let result = serde_json::json!({
        "hook": "omx-notify-slack",
        "success": false,
        "stdout": "",
        "stderr": "not implemented",
        "duration_ms": 0
    });

    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}
```

- [ ] **Step 3: Create omx-notify-telegram**

`crates/omx-notify-telegram/Cargo.toml`:

```toml
[package]
name = "omx-notify-telegram"
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true
description = "Telegram notification hook for OMX"

[[bin]]
name = "omx-notify-telegram"
path = "src/main.rs"

[dependencies]
omx-types = { path = "../omx-types" }
serde = { workspace = true }
serde_json = { workspace = true }
reqwest = { workspace = true }
tokio = { workspace = true }
```

`crates/omx-notify-telegram/src/main.rs`:

```rust
use std::io::{self, Read};
use omx_types::HookEvent;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;

    let _event: HookEvent = serde_json::from_str(&input)?;

    // Phase 5: send Telegram bot notification
    let result = serde_json::json!({
        "hook": "omx-notify-telegram",
        "success": false,
        "stdout": "",
        "stderr": "not implemented",
        "duration_ms": 0
    });

    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}
```

- [ ] **Step 4: Verify all 3 compile**

Run: `cargo check -p omx-notify-discord -p omx-notify-slack -p omx-notify-telegram`
Expected: All compile successfully

- [ ] **Step 5: Commit**

```bash
git add crates/omx-notify-discord/ crates/omx-notify-slack/ crates/omx-notify-telegram/
git commit -m "feat: add 3 notification hook skeleton crates (discord, slack, telegram)"
```

---

## Task 12: Full Workspace Compilation + CI Verification

**Files:**
- No new files — verification only

- [ ] **Step 1: Verify entire workspace compiles**

Run: `cargo check --workspace`
Expected: All 21 crates compile (5 existing + 16 new)

- [ ] **Step 2: Run all tests**

Run: `cargo test --workspace`
Expected: All non-ignored tests pass; ignored tests are listed

- [ ] **Step 3: Run clippy**

Run: `cargo clippy --workspace -- -D warnings`
Expected: No warnings

- [ ] **Step 4: Run rustfmt check**

Run: `cargo fmt --all -- --check`
Expected: All files formatted

- [ ] **Step 5: Fix any issues found in steps 1-4**

Address compiler errors, clippy lints, or formatting issues. Re-run checks.

- [ ] **Step 6: Verify binary outputs**

Run: `cargo build --workspace 2>&1 | rg "Compiling omx"`
Expected: All 9 binaries built (omx, 5 MCP servers, 3 notification hooks, omx-runtime)

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "chore: Phase 0 skeleton complete — all 21 crates compile with todo!() stubs"
```

---

## Summary

| Task | Crate(s) | Key deliverable |
|------|----------|-----------------|
| 1 | workspace | Cargo.toml with 21 members + workspace deps |
| 2 | omx-types | Shared types, enums, OmxError |
| 3 | omx-config | OmxConfig, ConfigLoader trait |
| 4 | omx-state | StateStore trait, FileStateStore skeleton |
| 5 | omx-hooks | HookDispatcher trait, ShellHookDispatcher skeleton |
| 6 | 5 MCP servers | rmcp tool definitions with todo!() bodies |
| 7 | omx-team | TeamRuntime trait + 13 module skeletons |
| 8 | omx-hud | HudState + ratatui widget stubs |
| 9 | omx-setup | SetupGenerator trait + artifact stubs |
| 10 | omx-cli | Full clap router with all subcommands |
| 11 | 3 notification hooks | stdin/stdout hook contract skeletons |
| 12 | (all) | Full workspace compilation + CI verification |
