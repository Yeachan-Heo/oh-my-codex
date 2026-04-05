use rmcp::{tool, ServerHandler, ServiceExt};
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

#[rmcp::tool(tool_box)]
impl ServerHandler for TeamMcpServer {}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();
    let service = TeamMcpServer.serve(rmcp::transport::io::stdio()).await?;
    service.waiting().await?;
    Ok(())
}
