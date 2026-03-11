use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use crate::setup::SetupScope;

const OMX_MCP_SERVERS: &[&str] = &["omx_state", "omx_memory", "omx_code_intel", "omx_trace"];

#[allow(clippy::struct_excessive_bools)]
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct UninstallOptions {
    pub dry_run: bool,
    pub keep_config: bool,
    pub verbose: bool,
    pub purge: bool,
    pub scope: Option<SetupScope>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UninstallExecution {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UninstallError(String);

impl UninstallError {
    fn runtime(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl std::fmt::Display for UninstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for UninstallError {}

pub const UNINSTALL_USAGE: &str = "Usage: omx uninstall [--scope <user|project>] [--dry-run] [--keep-config] [--purge] [--verbose]";

#[allow(clippy::missing_errors_doc)]
pub fn parse_uninstall_args(args: &[String]) -> Result<UninstallOptions, UninstallError> {
    let mut options = UninstallOptions::default();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--dry-run" => options.dry_run = true,
            "--keep-config" => options.keep_config = true,
            "--verbose" => options.verbose = true,
            "--purge" => options.purge = true,
            "--scope" => {
                let Some(value) = args.get(index + 1) else {
                    return Err(UninstallError::runtime(
                        "Missing uninstall scope value after --scope. Expected one of: user, project",
                    ));
                };
                options.scope = Some(parse_scope(value)?);
                index += 1;
            }
            token if token.starts_with("--scope=") => {
                options.scope = Some(parse_scope(&token["--scope=".len()..])?);
            }
            other => {
                return Err(UninstallError::runtime(format!(
                    "Unknown uninstall argument: {other}\n{UNINSTALL_USAGE}"
                )));
            }
        }
        index += 1;
    }
    Ok(options)
}

#[allow(clippy::missing_errors_doc)]
pub fn run_uninstall(
    args: &[String],
    cwd: &Path,
    env: &BTreeMap<OsString, OsString>,
) -> Result<UninstallExecution, UninstallError> {
    let options = parse_uninstall_args(args)?;
    let scope = options
        .scope
        .unwrap_or_else(|| read_persisted_setup_scope(cwd).unwrap_or(SetupScope::User));
    let dirs = resolve_scope_directories(cwd, env, scope);
    let mut stdout = String::new();
    let stderr = Vec::new();

    let _ = writeln!(stdout, "oh-my-codex uninstall");
    let _ = writeln!(stdout, "====================\n");
    let _ = writeln!(stdout, "Resolved scope: {}", scope.as_str());
    if options.dry_run {
        stdout.push_str("Running in dry-run mode. No files will be deleted.\n");
    }

    let mut removed_anything = false;
    let mut summary = UninstallSummary::default();

    if options.keep_config {
        stdout.push_str("--keep-config set: skipping config.toml cleanup.\n");
    } else {
        let config_summary = clean_config(&dirs.codex_config_file, options.dry_run)?;
        if config_summary.config_cleaned {
            removed_anything = true;
            stdout.push_str(if options.dry_run {
                "Would remove OMX configuration block from config.toml.\n"
            } else {
                "Removed OMX configuration block from config.toml.\n"
            });
        }
        summary = config_summary;
    }

    let omx_dir = cwd.join(".omx");
    let setup_scope_path = omx_dir.join("setup-scope.json");
    let hud_config_path = omx_dir.join("hud-config.json");
    if setup_scope_path.exists() {
        removed_anything = true;
        if !options.dry_run {
            let _ = fs::remove_file(&setup_scope_path);
        }
    }
    if hud_config_path.exists() {
        removed_anything = true;
        if !options.dry_run {
            let _ = fs::remove_file(&hud_config_path);
        }
    }

    if options.purge && omx_dir.exists() {
        removed_anything = true;
        if options.dry_run {
            stdout.push_str("Would remove .omx/ cache directory.\n");
        } else {
            let _ = fs::remove_dir_all(&omx_dir);
            stdout.push_str("Removed .omx/ cache directory.\n");
        }
    }

    if !removed_anything {
        stdout.push_str("Nothing to remove.\n");
    }

    stdout.push_str("\nUninstall summary\n");
    stdout.push_str("-----------------\n");
    if !options.keep_config {
        let _ = writeln!(
            stdout,
            "MCP servers: {}",
            if summary.mcp_servers_removed.is_empty() {
                "none".to_string()
            } else {
                summary.mcp_servers_removed.join(", ")
            }
        );
        let _ = writeln!(stdout, "Agent entries: {}", summary.agent_entries_removed);
        if summary.tui_section_removed {
            stdout.push_str("TUI status line section removed\n");
        }
        if summary.top_level_keys_removed {
            stdout.push_str("Top-level keys removed\n");
        }
        if summary.feature_flags_removed {
            stdout.push_str("Feature flags removed\n");
        }
    }

    Ok(UninstallExecution {
        stdout: stdout.into_bytes(),
        stderr,
        exit_code: 0,
    })
}

#[allow(clippy::struct_excessive_bools)]
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct UninstallSummary {
    config_cleaned: bool,
    mcp_servers_removed: Vec<String>,
    agent_entries_removed: usize,
    tui_section_removed: bool,
    top_level_keys_removed: bool,
    feature_flags_removed: bool,
}

fn parse_scope(value: &str) -> Result<SetupScope, UninstallError> {
    match value {
        "user" => Ok(SetupScope::User),
        "project" | "project-local" => Ok(SetupScope::Project),
        other => Err(UninstallError::runtime(format!(
            "Invalid uninstall scope: {other}. Expected one of: user, project"
        ))),
    }
}

fn resolve_scope_directories(
    cwd: &Path,
    env: &BTreeMap<OsString, OsString>,
    scope: SetupScope,
) -> ScopeDirectories {
    if scope == SetupScope::Project {
        let codex_home_dir = cwd.join(".codex");
        return ScopeDirectories {
            codex_config_file: codex_home_dir.join("config.toml"),
        };
    }
    let home_dir = env
        .get(&OsString::from("HOME"))
        .or_else(|| env.get(&OsString::from("USERPROFILE")))
        .map_or_else(|| cwd.to_path_buf(), PathBuf::from);
    let codex_home_dir = env
        .get(&OsString::from("CODEX_HOME"))
        .map_or_else(|| home_dir.join(".codex"), PathBuf::from);
    ScopeDirectories {
        codex_config_file: codex_home_dir.join("config.toml"),
    }
}

#[derive(Debug, Clone)]
struct ScopeDirectories {
    codex_config_file: PathBuf,
}

fn read_persisted_setup_scope(cwd: &Path) -> Option<SetupScope> {
    let raw = fs::read_to_string(cwd.join(".omx/setup-scope.json")).ok()?;
    match extract_json_scope(&raw).as_deref() {
        Some("project" | "project-local") => Some(SetupScope::Project),
        Some("user") => Some(SetupScope::User),
        _ => None,
    }
}

fn extract_json_scope(raw: &str) -> Option<String> {
    let key_index = raw.find("\"scope\"")?;
    let remainder = &raw[key_index + "\"scope\"".len()..];
    let colon_index = remainder.find(':')?;
    let value = remainder[colon_index + 1..].trim_start();
    if !value.starts_with('"') {
        return None;
    }
    let value = &value[1..];
    let end_index = value.find('"')?;
    Some(value[..end_index].to_owned())
}

fn clean_config(config_path: &Path, dry_run: bool) -> Result<UninstallSummary, UninstallError> {
    let mut result = UninstallSummary::default();
    if !config_path.exists() {
        return Ok(result);
    }
    let original = fs::read_to_string(config_path).map_err(|error| {
        UninstallError::runtime(format!("failed to read {}: {error}", config_path.display()))
    })?;
    for server in OMX_MCP_SERVERS {
        if original.contains(&format!("[mcp_servers.{server}]")) {
            result.mcp_servers_removed.push((*server).to_string());
        }
    }
    result.agent_entries_removed =
        original.matches("[agents.").count() + original.matches("[agents.\"").count();
    result.tui_section_removed = original.contains("[tui]");
    result.top_level_keys_removed = original.contains("notify =")
        || original.contains("model_reasoning_effort")
        || original.contains("developer_instructions");
    result.feature_flags_removed =
        original.contains("multi_agent") || original.contains("child_agents_md");

    let cleaned = strip_omx_config(&original);
    if cleaned != original {
        result.config_cleaned = true;
        if !dry_run {
            fs::write(config_path, cleaned).map_err(|error| {
                UninstallError::runtime(format!(
                    "failed to write {}: {error}",
                    config_path.display()
                ))
            })?;
        }
    }
    Ok(result)
}

fn strip_omx_config(original: &str) -> String {
    let mut output = Vec::new();
    let mut lines = original.lines().peekable();
    let mut in_omx_block = false;
    let mut in_features = false;
    let mut feature_buffer: Vec<String> = Vec::new();
    while let Some(line) = lines.next() {
        let trimmed = line.trim();
        if trimmed == "# ============================================================" {
            let next = lines.peek().copied().unwrap_or_default().trim().to_string();
            if next.contains("oh-my-codex (OMX) Configuration") {
                in_omx_block = true;
                continue;
            }
            if in_omx_block {
                in_omx_block = false;
                for candidate in lines.by_ref() {
                    if candidate.trim()
                        == "# ============================================================"
                    {
                        break;
                    }
                }
                continue;
            }
        }
        if in_omx_block {
            continue;
        }
        if trimmed == "[features]" {
            in_features = true;
            feature_buffer.clear();
            continue;
        }
        if in_features {
            if trimmed.starts_with('[') && trimmed != "[features]" {
                flush_features(&mut output, &feature_buffer);
                in_features = false;
            } else {
                if !(trimmed.starts_with("multi_agent") || trimmed.starts_with("child_agents_md")) {
                    feature_buffer.push(line.to_string());
                }
                continue;
            }
        }
        if is_top_level_omx_key(trimmed) || is_omx_table_header(trimmed) {
            continue;
        }
        output.push(line.to_string());
    }
    if in_features {
        flush_features(&mut output, &feature_buffer);
    }
    let cleaned = output.join("\n");
    cleaned
        .lines()
        .filter(|line| !line.trim().is_empty() || !cleaned.contains("\n\n\n"))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
        + "\n"
}

fn flush_features(output: &mut Vec<String>, feature_buffer: &[String]) {
    let kept = feature_buffer
        .iter()
        .filter(|line| !line.trim().is_empty())
        .count();
    if kept > 0 {
        output.push("[features]".to_string());
        output.extend(feature_buffer.iter().cloned());
    }
}

fn is_top_level_omx_key(trimmed: &str) -> bool {
    trimmed.starts_with("notify =")
        || trimmed.starts_with("model_reasoning_effort")
        || trimmed.starts_with("developer_instructions")
}

fn is_omx_table_header(trimmed: &str) -> bool {
    OMX_MCP_SERVERS
        .iter()
        .any(|name| trimmed == format!("[mcp_servers.{name}]"))
        || trimmed.starts_with("[agents.")
        || trimmed == "[tui]"
}

#[cfg(test)]
mod tests {
    use super::{UninstallOptions, parse_uninstall_args, run_uninstall, strip_omx_config};
    use std::collections::BTreeMap;
    use std::ffi::OsString;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("omx-rust-uninstall-{label}-{nanos}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn build_omx_config() -> String {
        [
            "notify = [\"node\", \"/path/to/notify-hook.js\"]",
            "model_reasoning_effort = \"high\"",
            "developer_instructions = \"You have oh-my-codex installed.\"",
            "",
            "[features]",
            "multi_agent = true",
            "child_agents_md = true",
            "web_search = true",
            "",
            "# ============================================================",
            "# oh-my-codex (OMX) Configuration",
            "# Managed by omx setup - manual edits preserved on next setup",
            "# ============================================================",
            "",
            "[mcp_servers.omx_state]",
            "command = \"node\"",
            "",
            "[mcp_servers.omx_memory]",
            "command = \"node\"",
            "",
            "[agents.executor]",
            "description = \"Code implementation\"",
            "",
            "[tui]",
            "status_line = [\"model-with-reasoning\"]",
            "",
            "# ============================================================",
            "# End oh-my-codex",
            "",
            "model = \"gpt-5.4\"",
        ]
        .join("\n")
    }

    #[test]
    fn parses_flags() {
        let parsed = parse_uninstall_args(&[
            "--dry-run".into(),
            "--keep-config".into(),
            "--purge".into(),
            "--verbose".into(),
            "--scope=project".into(),
        ])
        .expect("parse uninstall args");
        assert_eq!(
            parsed,
            UninstallOptions {
                dry_run: true,
                keep_config: true,
                verbose: true,
                purge: true,
                scope: Some(crate::setup::SetupScope::Project),
            }
        );
    }

    #[test]
    fn strips_omx_config_but_preserves_user_entries() {
        let cleaned = strip_omx_config(&build_omx_config());
        assert!(!cleaned.contains("omx_state"));
        assert!(!cleaned.contains("omx_memory"));
        assert!(!cleaned.contains("[agents.executor]"));
        assert!(!cleaned.contains("[tui]"));
        assert!(!cleaned.contains("notify ="));
        assert!(!cleaned.contains("model_reasoning_effort"));
        assert!(!cleaned.contains("developer_instructions"));
        assert!(!cleaned.contains("multi_agent"));
        assert!(!cleaned.contains("child_agents_md"));
        assert!(cleaned.contains("web_search = true"));
        assert!(cleaned.contains("model = \"gpt-5.4\""));
    }

    #[test]
    fn uninstall_cleans_config_and_reports_summary() {
        let cwd = temp_dir("summary");
        let home = cwd.join("home");
        let codex_dir = home.join(".codex");
        fs::create_dir_all(&codex_dir).expect("codex dir");
        fs::write(codex_dir.join("config.toml"), build_omx_config()).expect("config");
        let mut env = BTreeMap::new();
        env.insert(OsString::from("HOME"), home.into_os_string());
        let result = run_uninstall(&[], &cwd, &env).expect("run uninstall");
        let stdout = String::from_utf8(result.stdout).expect("stdout utf8");
        let config = fs::read_to_string(codex_dir.join("config.toml")).expect("read config");
        assert!(stdout.contains("Removed OMX configuration block from config.toml."));
        assert!(stdout.contains("Uninstall summary"));
        assert!(stdout.contains("MCP servers: omx_state, omx_memory"));
        assert!(config.contains("web_search = true"));
        assert!(!config.contains("omx_state"));
        let _ = fs::remove_dir_all(cwd);
    }

    #[test]
    fn dry_run_and_purge_do_not_delete_omx_dir() {
        let cwd = temp_dir("purge");
        let omx_dir = cwd.join(".omx");
        fs::create_dir_all(omx_dir.join("state")).expect("omx dir");
        fs::write(omx_dir.join("setup-scope.json"), "{\"scope\":\"user\"}\n").expect("scope file");
        let env = BTreeMap::new();
        let result = run_uninstall(
            &["--keep-config".into(), "--purge".into(), "--dry-run".into()],
            &cwd,
            &env,
        )
        .expect("run uninstall");
        let stdout = String::from_utf8(result.stdout).expect("stdout utf8");
        assert!(stdout.contains("dry-run mode"));
        assert!(stdout.contains("Would remove .omx/ cache directory."));
        assert!(omx_dir.exists());
        let _ = fs::remove_dir_all(cwd);
    }
}
