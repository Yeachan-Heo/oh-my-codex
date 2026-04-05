use std::collections::HashMap;
use std::path::{Path, PathBuf};

use omx_types::OmxError;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Config structs (spec section 4.2)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OmxConfig {
    pub codex_home: PathBuf,
    pub models: ModelConfig,
    pub notifications: NotificationConfig,
    pub team: TeamDefaults,
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConfig {
    pub frontier: String,
    pub standard: String,
    pub spark: String,
    pub per_mode: HashMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NotificationConfig {
    pub discord: Option<DiscordConfig>,
    pub slack: Option<SlackConfig>,
    pub telegram: Option<TelegramConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscordConfig {
    pub webhook_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlackConfig {
    pub webhook_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramConfig {
    pub bot_token: String,
    pub chat_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamDefaults {
    pub default_workers: u8,
    pub default_model: String,
    pub worktree_mode: String,
}

// ---------------------------------------------------------------------------
// ConfigLoader trait
// Resolution: CLI arg > env var > .omx-config.json > config.toml > defaults
// ---------------------------------------------------------------------------

pub trait ConfigLoader {
    fn load(codex_home: &Path, env: &HashMap<String, String>) -> Result<OmxConfig, OmxError>;
}

// ---------------------------------------------------------------------------
// Default implementation (skeleton)
// ---------------------------------------------------------------------------

pub struct DefaultConfigLoader;

impl ConfigLoader for DefaultConfigLoader {
    fn load(_codex_home: &Path, _env: &HashMap<String, String>) -> Result<OmxConfig, OmxError> {
        todo!("Phase 1: implement config loading with precedence chain")
    }
}

/// Return the default codex home directory (~/.codex).
pub fn default_codex_home() -> PathBuf {
    dirs_next().join(".codex")
}

fn dirs_next() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_codex_home_uses_home_env() {
        let home = default_codex_home();
        assert!(home.to_str().unwrap().ends_with(".codex"));
    }

    #[ignore]
    #[test]
    fn config_loader_resolves_precedence_chain() {
        // Phase 1: test CLI arg > env var > .omx-config.json > config.toml > defaults
    }

    #[ignore]
    #[test]
    fn config_toml_deserializes_all_fields() {
        // Phase 1: snapshot test for full config deserialization
    }

    #[ignore]
    #[test]
    fn missing_config_files_produce_sensible_defaults() {
        // Phase 1: test default fallback behavior
    }
}
