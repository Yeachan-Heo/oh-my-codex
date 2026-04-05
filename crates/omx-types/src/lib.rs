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
