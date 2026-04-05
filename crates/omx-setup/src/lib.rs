use omx_config::OmxConfig;
use omx_types::OmxError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SetupScope {
    User,
    Project,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDefinition {
    pub name: String,
    pub description: String,
    pub model: Option<String>,
    pub tools: Vec<String>,
}

pub trait SetupGenerator: Send + Sync {
    fn generate_config_toml(
        &self,
        config: &OmxConfig,
        scope: SetupScope,
    ) -> Result<String, OmxError>;

    fn generate_agents_md(&self, config: &OmxConfig) -> Result<String, OmxError>;

    fn generate_agent_tomls(
        &self,
        agents: &[AgentDefinition],
    ) -> Result<Vec<(String, String)>, OmxError>;

    fn sync_mcp_servers(&self, config: &OmxConfig, scope: SetupScope) -> Result<(), OmxError>;

    fn copy_prompts(&self, scope: SetupScope) -> Result<(), OmxError>;

    fn copy_skills(&self, scope: SetupScope) -> Result<(), OmxError>;
}

pub struct DefaultSetupGenerator;

impl SetupGenerator for DefaultSetupGenerator {
    fn generate_config_toml(
        &self,
        _config: &OmxConfig,
        _scope: SetupScope,
    ) -> Result<String, OmxError> {
        todo!("Phase 4: generate config.toml with OMX:START/OMX:END markers")
    }

    fn generate_agents_md(&self, _config: &OmxConfig) -> Result<String, OmxError> {
        todo!("Phase 4: generate AGENTS.md with all agent definitions")
    }

    fn generate_agent_tomls(
        &self,
        _agents: &[AgentDefinition],
    ) -> Result<Vec<(String, String)>, OmxError> {
        todo!("Phase 4: generate per-agent .toml files")
    }

    fn sync_mcp_servers(&self, _config: &OmxConfig, _scope: SetupScope) -> Result<(), OmxError> {
        todo!("Phase 4: register Rust MCP server binaries in config.toml")
    }

    fn copy_prompts(&self, _scope: SetupScope) -> Result<(), OmxError> {
        todo!("Phase 4: write embedded prompts to disk")
    }

    fn copy_skills(&self, _scope: SetupScope) -> Result<(), OmxError> {
        todo!("Phase 4: write embedded skills to disk")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_scope_serde_roundtrip() {
        let scope = SetupScope::Project;
        let json = serde_json::to_string(&scope).unwrap();
        let parsed: SetupScope = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, scope);
    }

    #[ignore]
    #[test]
    fn generate_config_toml_placeholder() {
        // Phase 4: test config.toml generation with markers
    }

    #[ignore]
    #[test]
    fn generate_agents_md_placeholder() {
        // Phase 4: test AGENTS.md generation
    }
}
