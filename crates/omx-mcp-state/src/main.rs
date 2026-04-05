use rmcp::{tool, ServerHandler, ServiceExt};
use serde::Deserialize;

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

#[rmcp::tool(tool_box)]
impl ServerHandler for StateMcpServer {}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();
    let service = StateMcpServer.serve(rmcp::transport::io::stdio()).await?;
    service.waiting().await?;
    Ok(())
}
