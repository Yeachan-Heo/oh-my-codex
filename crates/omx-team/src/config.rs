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
