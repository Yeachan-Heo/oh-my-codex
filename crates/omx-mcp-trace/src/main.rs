use rmcp::{tool, ServerHandler, ServiceExt};
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

#[rmcp::tool(tool_box)]
impl ServerHandler for TraceMcpServer {}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();
    let service = TraceMcpServer.serve(rmcp::transport::io::stdio()).await?;
    service.waiting().await?;
    Ok(())
}
