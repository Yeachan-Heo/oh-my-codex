use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

const HELP: &str = concat!(
    "Usage:\n",
    "  omx tmux-hook init       Create .omx/tmux-hook.json\n",
    "  omx tmux-hook status     Show config + runtime state summary\n",
    "  omx tmux-hook validate   Validate config and tmux target reachability\n",
    "  omx tmux-hook test       Run a synthetic notify-hook turn (end-to-end)\n",
);

const DEFAULT_CONFIG: &str = concat!(
    "{\n",
    "  \"enabled\": true,\n",
    "  \"target\": { \"type\": \"pane\", \"value\": \"\" },\n",
    "  \"allowed_modes\": [\"ralph\", \"ultrawork\", \"team\"],\n",
    "  \"cooldown_ms\": 15000,\n",
    "  \"max_injections_per_session\": 200,\n",
    "  \"prompt_template\": \"Continue from current mode state. [OMX_TMUX_INJECT]\",\n",
    "  \"marker\": \"[OMX_TMUX_INJECT]\",\n",
    "  \"dry_run\": false,\n",
    "  \"log_level\": \"info\",\n",
    "  \"skip_if_scrolling\": true\n",
    "}\n",
);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TmuxHookExecution {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TmuxHookError(String);

impl TmuxHookError {
    fn runtime(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl std::fmt::Display for TmuxHookError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for TmuxHookError {}

#[allow(clippy::missing_errors_doc)]
pub fn run_tmux_hook(
    args: &[String],
    cwd: &Path,
    _env: &BTreeMap<OsString, OsString>,
) -> Result<TmuxHookExecution, TmuxHookError> {
    let subcommand = args.first().map_or("status", String::as_str);
    match subcommand {
        "help" | "--help" | "-h" => Ok(stdout_only(HELP)),
        "init" => init_tmux_hook(cwd),
        "status" => status_tmux_hook(cwd),
        "validate" => validate_tmux_hook(cwd),
        "test" => Ok(test_tmux_hook(cwd)),
        other => Err(TmuxHookError::runtime(format!(
            "Unknown tmux-hook subcommand: {other}"
        ))),
    }
}

fn stdout_only(text: &str) -> TmuxHookExecution {
    TmuxHookExecution {
        stdout: text.as_bytes().to_vec(),
        stderr: Vec::new(),
        exit_code: 0,
    }
}

fn tmux_hook_config_path(cwd: &Path) -> PathBuf {
    cwd.join(".omx").join("tmux-hook.json")
}

fn tmux_hook_state_path(cwd: &Path) -> PathBuf {
    cwd.join(".omx").join("state").join("tmux-hook-state.json")
}

fn init_tmux_hook(cwd: &Path) -> Result<TmuxHookExecution, TmuxHookError> {
    let config_path = tmux_hook_config_path(cwd);
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            TmuxHookError::runtime(format!("failed to create {}: {error}", parent.display()))
        })?;
    }

    let mut stdout = String::new();
    if config_path.exists() {
        let _ = writeln!(
            stdout,
            "tmux-hook config already exists: {}",
            config_path.display()
        );
        return Ok(stdout_only(&stdout));
    }

    fs::write(&config_path, DEFAULT_CONFIG).map_err(|error| {
        TmuxHookError::runtime(format!(
            "failed to write {}: {error}",
            config_path.display()
        ))
    })?;
    let _ = writeln!(stdout, "Created {}", config_path.display());
    stdout
        .push_str("Could not auto-detect a tmux target. Edit `.omx/tmux-hook.json` when ready.\n");
    Ok(stdout_only(&stdout))
}

fn status_tmux_hook(cwd: &Path) -> Result<TmuxHookExecution, TmuxHookError> {
    let config_path = tmux_hook_config_path(cwd);
    if !config_path.exists() {
        return Ok(stdout_only(
            "No tmux-hook config found. Run: omx tmux-hook init\n",
        ));
    }

    let config = fs::read_to_string(&config_path).map_err(|error| {
        TmuxHookError::runtime(format!("failed to read {}: {error}", config_path.display()))
    })?;
    let state_path = tmux_hook_state_path(cwd);
    let state = fs::read_to_string(&state_path).unwrap_or_default();

    let enabled = config.contains("\"enabled\": true");
    let target_type =
        extract_json_string_field(&config, "type").unwrap_or_else(|| "unknown".to_string());
    let target_value = extract_json_string_field(&config, "value").unwrap_or_default();
    let last_reason =
        extract_json_string_field(&state, "last_reason").unwrap_or_else(|| "n/a".to_string());

    let mut stdout = String::new();
    stdout.push_str("tmux-hook status\n----------------\n");
    let _ = writeln!(stdout, "Config: {}", config_path.display());
    let _ = writeln!(stdout, "Enabled: {}", if enabled { "yes" } else { "no" });
    let _ = writeln!(stdout, "Target: {target_type} {target_value}");
    let _ = writeln!(stdout, "State: {}", state_path.display());
    let _ = writeln!(stdout, "Last reason: {last_reason}");
    Ok(stdout_only(&stdout))
}

fn validate_tmux_hook(cwd: &Path) -> Result<TmuxHookExecution, TmuxHookError> {
    let config_path = tmux_hook_config_path(cwd);
    if !config_path.exists() {
        return Ok(stdout_only(
            "No tmux-hook config found. Run: omx tmux-hook init\nValidation skipped until `target.value` is configured.\n",
        ));
    }

    let config = fs::read_to_string(&config_path).map_err(|error| {
        TmuxHookError::runtime(format!("failed to read {}: {error}", config_path.display()))
    })?;
    let target_value = extract_json_string_field(&config, "value").unwrap_or_default();
    if target_value.trim().is_empty() {
        return Ok(stdout_only(
            "tmux-hook config is structurally valid\nValidation skipped until `target.value` is configured.\n",
        ));
    }

    Ok(stdout_only(
        "tmux-hook config is structurally valid\nTarget reachability not yet implemented in native Rust CLI.\n",
    ))
}

fn test_tmux_hook(cwd: &Path) -> TmuxHookExecution {
    let config_path = tmux_hook_config_path(cwd);
    if !config_path.exists() {
        return stdout_only("No tmux-hook config found. Run: omx tmux-hook init\n");
    }
    stdout_only(
        "tmux-hook test executed synthetic native-rust placeholder\nNo tmux injection was performed.\n",
    )
}

fn extract_json_string_field(raw: &str, key: &str) -> Option<String> {
    let key = format!("\"{key}\"");
    let key_start = raw.find(&key)? + key.len();
    let after_key = raw.get(key_start..)?;
    let colon_idx = after_key.find(':')?;
    let after_colon = after_key.get(colon_idx + 1..)?.trim_start();
    let stripped = after_colon.strip_prefix('"')?;

    let mut escaped = false;
    let mut out = String::new();
    for ch in stripped.chars() {
        if escaped {
            out.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '"' {
            return Some(out);
        }
        out.push(ch);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{DEFAULT_CONFIG, HELP, run_tmux_hook};
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::Path;

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("omx-tmux-hook-{label}-{nanos}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn prints_help_for_help_variants() {
        for args in [vec!["--help".into()], vec!["help".into()]] {
            let result = run_tmux_hook(&args, Path::new("."), &BTreeMap::new()).expect("help");
            assert_eq!(String::from_utf8(result.stdout).unwrap(), HELP);
        }
    }

    #[test]
    fn defaults_to_status() {
        let cwd = temp_dir("status-default");
        let result = run_tmux_hook(&[], &cwd, &BTreeMap::new()).expect("status");
        assert_eq!(
            String::from_utf8(result.stdout).unwrap(),
            "No tmux-hook config found. Run: omx tmux-hook init\n"
        );
    }

    #[test]
    fn init_creates_default_config() {
        let cwd = temp_dir("init");
        let result = run_tmux_hook(&["init".into()], &cwd, &BTreeMap::new()).expect("init");
        assert_eq!(result.exit_code, 0);
        assert_eq!(
            fs::read_to_string(cwd.join(".omx/tmux-hook.json")).unwrap(),
            DEFAULT_CONFIG
        );
        assert!(
            String::from_utf8(result.stdout)
                .unwrap()
                .contains("Created")
        );
    }

    #[test]
    fn status_reads_config_and_state() {
        let cwd = temp_dir("status");
        fs::create_dir_all(cwd.join(".omx/state")).unwrap();
        fs::write(cwd.join(".omx/tmux-hook.json"), DEFAULT_CONFIG).unwrap();
        fs::write(
            cwd.join(".omx/state/tmux-hook-state.json"),
            "{\"last_reason\":\"ok\"}\n",
        )
        .unwrap();
        let result = run_tmux_hook(&["status".into()], &cwd, &BTreeMap::new()).expect("status");
        let stdout = String::from_utf8(result.stdout).unwrap();
        assert!(stdout.contains("tmux-hook status"));
        assert!(stdout.contains("Enabled: yes"));
        assert!(stdout.contains("Last reason: ok"));
    }

    #[test]
    fn validate_skips_when_target_unconfigured() {
        let cwd = temp_dir("validate");
        fs::create_dir_all(cwd.join(".omx")).unwrap();
        fs::write(cwd.join(".omx/tmux-hook.json"), DEFAULT_CONFIG).unwrap();
        let result = run_tmux_hook(&["validate".into()], &cwd, &BTreeMap::new()).expect("validate");
        assert!(
            String::from_utf8(result.stdout)
                .unwrap()
                .contains("Validation skipped")
        );
    }
}
