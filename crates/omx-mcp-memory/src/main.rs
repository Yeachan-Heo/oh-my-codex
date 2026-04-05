use rmcp::{ServerHandler, ServiceExt, tool};
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

#[rmcp::tool(tool_box)]
impl ServerHandler for MemoryMcpServer {}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();
    let service = MemoryMcpServer.serve(rmcp::transport::io::stdio()).await?;
    service.waiting().await?;
    Ok(())
}
