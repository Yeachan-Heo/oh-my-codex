use rmcp::{tool, ServerHandler, ServiceExt};
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
    async fn diagnostics_typescript(&self, #[tool(aggr)] _params: DiagnosticsParams) -> String {
        todo!("Phase 2: run diagnostics via tsc or language server")
    }

    #[tool(description = "Search code using AST patterns")]
    async fn ast_pattern_search(&self, #[tool(aggr)] _params: AstPatternSearchParams) -> String {
        todo!("Phase 2: AST pattern search via tree-sitter or similar")
    }
}

#[rmcp::tool(tool_box)]
impl ServerHandler for CodeIntelMcpServer {}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();
    let service = CodeIntelMcpServer
        .serve(rmcp::transport::io::stdio())
        .await?;
    service.waiting().await?;
    Ok(())
}
