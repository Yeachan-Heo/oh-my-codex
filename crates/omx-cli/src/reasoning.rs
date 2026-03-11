use std::env;
use std::fs;
use std::path::PathBuf;

pub const REASONING_KEY: &str = "model_reasoning_effort";
pub const REASONING_USAGE: &str = "Usage: omx reasoning <low|medium|high|xhigh>";
const REASONING_MODES: &[&str] = &["low", "medium", "high", "xhigh"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReasoningError(String);

impl ReasoningError {
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl std::fmt::Display for ReasoningError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ReasoningError {}

#[allow(clippy::missing_errors_doc)]
pub fn run_reasoning_command(args: &[String], help_output: &str) -> Result<String, ReasoningError> {
    let Some(mode) = args.first().map(String::as_str) else {
        let config_path = codex_config_path();
        if !config_path.exists() {
            return Ok(format!(
                "{REASONING_KEY} is not set ({} does not exist).\n{REASONING_USAGE}\n",
                config_path.display()
            ));
        }

        let content = fs::read_to_string(&config_path).map_err(|error| {
            ReasoningError::new(format!("failed to read {}: {error}", config_path.display()))
        })?;
        if let Some(current) = read_top_level_toml_string(&content, REASONING_KEY) {
            return Ok(format!("Current {REASONING_KEY}: {current}\n"));
        }

        return Ok(format!(
            "{REASONING_KEY} is not set in {}.\n{REASONING_USAGE}\n",
            config_path.display()
        ));
    };

    if matches!(mode, "help" | "--help" | "-h") {
        return Ok(help_output.to_owned());
    }

    if !REASONING_MODES.contains(&mode) {
        return Err(ReasoningError::new(format!(
            "Invalid reasoning mode \"{mode}\". Expected one of: {}.\n{REASONING_USAGE}",
            REASONING_MODES.join(", ")
        )));
    }

    let config_path = codex_config_path();
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            ReasoningError::new(format!(
                "failed to create config directory {}: {error}",
                parent.display()
            ))
        })?;
    }

    let existing = if config_path.exists() {
        fs::read_to_string(&config_path).map_err(|error| {
            ReasoningError::new(format!("failed to read {}: {error}", config_path.display()))
        })?
    } else {
        String::new()
    };
    let updated = upsert_top_level_toml_string(&existing, REASONING_KEY, mode);
    fs::write(&config_path, updated).map_err(|error| {
        ReasoningError::new(format!(
            "failed to write {}: {error}",
            config_path.display()
        ))
    })?;

    Ok(format!(
        "Set {REASONING_KEY}=\"{mode}\" in {}\n",
        config_path.display()
    ))
}

fn codex_config_path() -> PathBuf {
    if let Some(codex_home) = env::var_os("CODEX_HOME")
        && !codex_home.is_empty()
    {
        return PathBuf::from(codex_home).join("config.toml");
    }

    resolve_home_dir().join(".codex").join("config.toml")
}

fn resolve_home_dir() -> PathBuf {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map_or_else(|| PathBuf::from("."), PathBuf::from)
}

fn read_top_level_toml_string(content: &str, key: &str) -> Option<String> {
    let mut in_top_level = true;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if is_table_line(trimmed) {
            in_top_level = false;
            continue;
        }
        if !in_top_level {
            continue;
        }

        let Some((found_key, raw_value)) = line.split_once('=') else {
            continue;
        };
        if found_key.trim() != key {
            continue;
        }
        return Some(parse_toml_string_value(raw_value));
    }
    None
}

fn upsert_top_level_toml_string(content: &str, key: &str, value: &str) -> String {
    let eol = if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let assignment = format!("{key} = \"{}\"", escape_toml_string(value));

    if content.trim().is_empty() {
        return assignment + eol;
    }

    let mut lines = content.lines().map(ToOwned::to_owned).collect::<Vec<_>>();
    let mut replaced = false;
    let mut in_top_level = true;

    for line in &mut lines {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if is_table_line(trimmed) {
            in_top_level = false;
            continue;
        }
        if !in_top_level {
            continue;
        }
        let Some((found_key, _)) = line.split_once('=') else {
            continue;
        };
        if found_key.trim() == key {
            line.clone_from(&assignment);
            replaced = true;
            break;
        }
    }

    if !replaced {
        if let Some(first_table_index) = lines.iter().position(|line| is_table_line(line.trim())) {
            lines.insert(first_table_index, assignment);
        } else {
            lines.push(assignment);
        }
    }

    let mut out = lines.join(eol);
    if !out.ends_with(eol) {
        out.push_str(eol);
    }
    out
}

fn is_table_line(trimmed: &str) -> bool {
    trimmed.starts_with('[') && trimmed.ends_with(']')
}

fn parse_toml_string_value(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() >= 2
        && ((trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\'')))
    {
        return trimmed[1..trimmed.len() - 1].to_owned();
    }
    trimmed.to_owned()
}

fn escape_toml_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::{
        REASONING_KEY, parse_toml_string_value, read_top_level_toml_string,
        upsert_top_level_toml_string,
    };

    #[test]
    fn reads_top_level_string() {
        let content = "model_reasoning_effort = \"high\"\n[mcp_servers.test]\nmodel_reasoning_effort = \"low\"\n";
        assert_eq!(
            read_top_level_toml_string(content, REASONING_KEY).as_deref(),
            Some("high")
        );
    }

    #[test]
    fn upserts_top_level_string() {
        let content = "[tui]\nstatus_line = []\n";
        assert_eq!(
            upsert_top_level_toml_string(content, REASONING_KEY, "xhigh"),
            "model_reasoning_effort = \"xhigh\"\n[tui]\nstatus_line = []\n"
        );
    }

    #[test]
    fn parses_toml_string_value() {
        assert_eq!(parse_toml_string_value("\"high\""), "high");
        assert_eq!(parse_toml_string_value("'low'"), "low");
        assert_eq!(parse_toml_string_value("xhigh"), "xhigh");
    }
}
