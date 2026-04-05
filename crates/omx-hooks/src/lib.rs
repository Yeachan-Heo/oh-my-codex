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
