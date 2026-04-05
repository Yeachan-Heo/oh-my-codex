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
    async fn claim_task(&self, worker: &WorkerId, task: &TaskId) -> Result<LeaseToken, OmxError>;
    async fn transition_task(
        &self,
        task: &TaskId,
        token: &LeaseToken,
        status: TaskStatus,
        result: Option<String>,
    ) -> Result<(), OmxError>;
    async fn shutdown(&mut self) -> Result<(), OmxError>;
}

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
