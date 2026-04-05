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
    async fn spawn_worker_placeholder() {}
}
