use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use crate::install_paths::{
    InstallScope, ScopeSource, resolve_install_paths, resolve_scope_from_persisted,
};

use omx_process::{CommandSpec, Platform, ProcessBridge, SpawnErrorKind};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DoctorOptions {
    pub team: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DoctorExecution {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DoctorError {
    message: String,
}

impl DoctorError {
    fn runtime(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for DoctorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for DoctorError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedDoctorArgs {
    pub options: DoctorOptions,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Check {
    name: &'static str,
    status: CheckStatus,
    message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CheckStatus {
    Pass,
    Warn,
    Fail,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DoctorScopeResolution {
    scope: InstallScope,
    source: ScopeSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CatalogExpectations {
    prompt_min: usize,
    skill_min: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TeamDoctorIssue {
    code: &'static str,
    message: String,
    severity: CheckStatus,
}

#[allow(clippy::missing_errors_doc)]
pub fn parse_doctor_args(args: &[String]) -> Result<ParsedDoctorArgs, DoctorError> {
    let mut team = false;
    for arg in args {
        match arg.as_str() {
            "--team" => team = true,
            other => {
                return Err(DoctorError::runtime(format!(
                    "unsupported doctor flag: {other}"
                )));
            }
        }
    }

    Ok(ParsedDoctorArgs {
        options: DoctorOptions { team },
    })
}

#[allow(clippy::missing_errors_doc)]
pub fn run_doctor(
    args: &[String],
    cwd: &Path,
    env: &BTreeMap<OsString, OsString>,
) -> Result<DoctorExecution, DoctorError> {
    let parsed = parse_doctor_args(args)?;
    if parsed.options.team {
        run_team_doctor(cwd, env)
    } else {
        run_install_doctor(cwd, env)
    }
}

fn run_install_doctor(
    cwd: &Path,
    env: &BTreeMap<OsString, OsString>,
) -> Result<DoctorExecution, DoctorError> {
    let scope_resolution = resolve_doctor_scope(cwd);
    let paths = resolve_install_paths(cwd, env, scope_resolution.scope);
    let catalog = get_catalog_expectations();

    let mut output = String::new();
    output.push_str("oh-my-codex doctor\n");
    output.push_str("==================\n\n");
    let _ = writeln!(
        output,
        "Resolved setup scope: {}{}\n",
        scope_resolution.scope.as_str(),
        if scope_resolution.source == ScopeSource::Persisted {
            " (from .omx/setup-scope.json)"
        } else {
            ""
        }
    );

    let checks = vec![
        check_codex_cli(env),
        check_node_version(env),
        check_directory("Codex home", &paths.codex_home_dir),
        check_config(&paths.codex_config_file)?,
        check_prompts(&paths.prompts_dir, catalog.prompt_min)?,
        check_skills(&paths.skills_dir, catalog.skill_min)?,
        check_agents_md(cwd, scope_resolution.scope),
        check_directory("State dir", &paths.state_dir),
        check_mcp_servers(&paths.codex_config_file)?,
    ];

    let mut pass_count = 0;
    let mut warn_count = 0;
    let mut fail_count = 0;
    for check in &checks {
        let icon = match check.status {
            CheckStatus::Pass => "[OK]",
            CheckStatus::Warn => "[!!]",
            CheckStatus::Fail => "[XX]",
        };
        let _ = writeln!(output, "  {icon} {}: {}", check.name, check.message);
        match check.status {
            CheckStatus::Pass => pass_count += 1,
            CheckStatus::Warn => warn_count += 1,
            CheckStatus::Fail => fail_count += 1,
        }
    }

    let _ = writeln!(
        output,
        "\nResults: {pass_count} passed, {warn_count} warnings, {fail_count} failed"
    );
    if fail_count > 0 {
        output.push_str("\nRun \"omx setup\" to fix installation issues.\n");
    } else if warn_count > 0 {
        output.push_str("\nRun \"omx setup --force\" to refresh all components.\n");
    } else {
        output.push_str("\nAll checks passed! oh-my-codex is ready.\n");
    }

    Ok(DoctorExecution {
        stdout: output.into_bytes(),
        stderr: Vec::new(),
        exit_code: i32::from(fail_count > 0),
    })
}

fn run_team_doctor(
    cwd: &Path,
    env: &BTreeMap<OsString, OsString>,
) -> Result<DoctorExecution, DoctorError> {
    let mut output = String::new();
    output.push_str("oh-my-codex doctor --team\n");
    output.push_str("=========================\n\n");

    let issues = collect_team_doctor_issues(cwd, env)?;
    if issues.is_empty() {
        output.push_str("  [OK] team diagnostics: no issues\n");
        output.push_str("\nAll team checks passed.\n");
        return Ok(DoctorExecution {
            stdout: output.into_bytes(),
            stderr: Vec::new(),
            exit_code: 0,
        });
    }

    let failure_count = issues
        .iter()
        .filter(|issue| issue.severity == CheckStatus::Fail)
        .count();
    let warning_count = issues.len() - failure_count;

    for issue in &issues {
        let icon = if issue.severity == CheckStatus::Warn {
            "[!!]"
        } else {
            "[XX]"
        };
        let _ = writeln!(output, "  {icon} {}: {}", issue.code, issue.message);
    }

    let _ = writeln!(
        output,
        "\nResults: {warning_count} warnings, {failure_count} failed"
    );

    Ok(DoctorExecution {
        stdout: output.into_bytes(),
        stderr: Vec::new(),
        exit_code: i32::from(failure_count > 0),
    })
}

fn resolve_doctor_scope(cwd: &Path) -> DoctorScopeResolution {
    let resolved = resolve_scope_from_persisted(cwd, None);
    DoctorScopeResolution {
        scope: resolved.scope,
        source: resolved.source,
    }
}

fn get_catalog_expectations() -> CatalogExpectations {
    let workspace_root = workspace_root();
    let manifest_path = if workspace_root
        .join("templates/catalog-manifest.json")
        .exists()
    {
        workspace_root.join("templates/catalog-manifest.json")
    } else {
        workspace_root.join("src/catalog/manifest.json")
    };

    let mut expectations = CatalogExpectations {
        prompt_min: 25,
        skill_min: 30,
    };

    if let Ok(raw) = fs::read_to_string(manifest_path) {
        let prompt_count = count_installable_entries(&raw, "agents");
        let skill_count = count_installable_entries(&raw, "skills");
        if prompt_count > 0 {
            expectations.prompt_min = usize::max(1, prompt_count.saturating_sub(2));
        }
        if skill_count > 0 {
            expectations.skill_min = usize::max(1, skill_count.saturating_sub(2));
        }
    }

    expectations
}

fn check_codex_cli(env: &BTreeMap<OsString, OsString>) -> Check {
    let bridge = ProcessBridge::new(Platform::detect(), env.clone());
    let mut spec = CommandSpec::new("codex");
    spec.args = vec![OsString::from("--version")];
    let result = bridge.run(&spec);

    if let Some(kind) = result.spawn_error_kind {
        let message = match kind {
            SpawnErrorKind::Missing => {
                "not found - install from https://github.com/openai/codex".to_string()
            }
            SpawnErrorKind::Blocked => {
                "found but could not be executed in this environment (blocked)".to_string()
            }
            SpawnErrorKind::Error => "probe failed".to_string(),
        };
        return Check {
            name: "Codex CLI",
            status: CheckStatus::Fail,
            message,
        };
    }

    if result.status_code == Some(0) {
        let version = String::from_utf8_lossy(&result.stdout).trim().to_string();
        return Check {
            name: "Codex CLI",
            status: CheckStatus::Pass,
            message: format!("installed ({version})"),
        };
    }

    let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
    Check {
        name: "Codex CLI",
        status: CheckStatus::Fail,
        message: if stderr.is_empty() {
            format!(
                "probe failed with exit {}",
                result.status_code.unwrap_or_default()
            )
        } else {
            format!("probe failed - {stderr}")
        },
    }
}

fn check_node_version(env: &BTreeMap<OsString, OsString>) -> Check {
    let bridge = ProcessBridge::new(Platform::detect(), env.clone());
    let mut spec = CommandSpec::new("node");
    spec.args = vec![OsString::from("--version")];
    let result = bridge.run(&spec);

    if result.status_code != Some(0) {
        return Check {
            name: "Node.js",
            status: CheckStatus::Fail,
            message: "not found (need >= 20)".to_string(),
        };
    }

    let version = String::from_utf8_lossy(&result.stdout).trim().to_string();
    let major = version
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|value| value.parse::<u32>().ok());

    match major {
        Some(value) if value >= 20 => Check {
            name: "Node.js",
            status: CheckStatus::Pass,
            message: version,
        },
        Some(_) => Check {
            name: "Node.js",
            status: CheckStatus::Fail,
            message: format!("{version} (need >= 20)"),
        },
        None => Check {
            name: "Node.js",
            status: CheckStatus::Fail,
            message: format!("{version} (unable to parse major version)"),
        },
    }
}

fn check_directory(name: &'static str, path: &Path) -> Check {
    if path.exists() {
        Check {
            name,
            status: CheckStatus::Pass,
            message: path.display().to_string(),
        }
    } else {
        Check {
            name,
            status: CheckStatus::Warn,
            message: format!("{} (not created yet)", path.display()),
        }
    }
}

fn check_config(config_path: &Path) -> Result<Check, DoctorError> {
    if !config_path.exists() {
        return Ok(Check {
            name: "Config",
            status: CheckStatus::Warn,
            message: "config.toml not found".to_string(),
        });
    }

    let content = fs::read_to_string(config_path)
        .map_err(|_| DoctorError::runtime("cannot read config.toml"))?;
    if content.contains("omx_") || content.contains("oh-my-codex") {
        return Ok(Check {
            name: "Config",
            status: CheckStatus::Pass,
            message: "config.toml has OMX entries".to_string(),
        });
    }

    Ok(Check {
        name: "Config",
        status: CheckStatus::Warn,
        message: "config.toml exists but no OMX entries yet (expected before first setup; run \"omx setup --force\" once)".to_string(),
    })
}

fn check_prompts(dir: &Path, prompt_min: usize) -> Result<Check, DoctorError> {
    if !dir.exists() {
        return Ok(Check {
            name: "Prompts",
            status: CheckStatus::Warn,
            message: "prompts directory not found".to_string(),
        });
    }

    let count = fs::read_dir(dir)
        .map_err(|_| DoctorError::runtime("cannot read prompts directory"))?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "md"))
        .count();

    if count >= prompt_min {
        Ok(Check {
            name: "Prompts",
            status: CheckStatus::Pass,
            message: format!("{count} agent prompts installed"),
        })
    } else {
        Ok(Check {
            name: "Prompts",
            status: CheckStatus::Warn,
            message: format!("{count} prompts (expected >= {prompt_min})"),
        })
    }
}

fn check_skills(dir: &Path, skill_min: usize) -> Result<Check, DoctorError> {
    if !dir.exists() {
        return Ok(Check {
            name: "Skills",
            status: CheckStatus::Warn,
            message: "skills directory not found".to_string(),
        });
    }

    let count = fs::read_dir(dir)
        .map_err(|_| DoctorError::runtime("cannot read skills directory"))?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .count();

    if count >= skill_min {
        Ok(Check {
            name: "Skills",
            status: CheckStatus::Pass,
            message: format!("{count} skills installed"),
        })
    } else {
        Ok(Check {
            name: "Skills",
            status: CheckStatus::Warn,
            message: format!("{count} skills (expected >= {skill_min})"),
        })
    }
}

fn check_agents_md(cwd: &Path, scope: InstallScope) -> Check {
    let agents_md = cwd.join("AGENTS.md");
    if agents_md.exists() {
        return Check {
            name: "AGENTS.md",
            status: CheckStatus::Pass,
            message: "found in project root".to_string(),
        };
    }

    if scope == InstallScope::User {
        return Check {
            name: "AGENTS.md",
            status: CheckStatus::Pass,
            message: "user scope leaves project AGENTS.md unchanged".to_string(),
        };
    }

    Check {
        name: "AGENTS.md",
        status: CheckStatus::Warn,
        message: "not found in project root (run omx agents-init . or omx setup --scope project)"
            .to_string(),
    }
}

fn check_mcp_servers(config_path: &Path) -> Result<Check, DoctorError> {
    if !config_path.exists() {
        return Ok(Check {
            name: "MCP Servers",
            status: CheckStatus::Warn,
            message: "config.toml not found".to_string(),
        });
    }

    let content = fs::read_to_string(config_path)
        .map_err(|_| DoctorError::runtime("cannot read config.toml"))?;
    let mcp_count = content.matches("[mcp_servers.").count();
    if mcp_count == 0 {
        return Ok(Check {
            name: "MCP Servers",
            status: CheckStatus::Warn,
            message: "no MCP servers configured".to_string(),
        });
    }

    if content.contains("omx_state") || content.contains("omx_memory") {
        return Ok(Check {
            name: "MCP Servers",
            status: CheckStatus::Pass,
            message: format!("{mcp_count} servers configured (OMX present)"),
        });
    }

    Ok(Check {
        name: "MCP Servers",
        status: CheckStatus::Warn,
        message: format!(
            "{mcp_count} servers but no OMX servers yet (expected before first setup; run \"omx setup --force\" once)"
        ),
    })
}

#[allow(clippy::too_many_lines)]
fn collect_team_doctor_issues(
    cwd: &Path,
    env: &BTreeMap<OsString, OsString>,
) -> Result<Vec<TeamDoctorIssue>, DoctorError> {
    let state_dir = cwd.join(".omx/state");
    let teams_root = state_dir.join("team");
    let now_ms = now_millis();
    let lag_threshold_ms = 60_000;
    let shutdown_threshold_ms = 30_000;
    let leader_stale_threshold_ms = 180_000;

    let team_dirs = if teams_root.exists() {
        fs::read_dir(&teams_root)
            .map_err(|error| DoctorError::runtime(format!("failed to read team state: {error}")))?
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_dir())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };

    let tmux_sessions_opt = list_team_tmux_sessions(env);
    let tmux_unavailable = tmux_sessions_opt.is_none();
    let tmux_sessions = tmux_sessions_opt.unwrap_or_default();
    let mut known_team_sessions = BTreeSet::new();
    let mut issues = Vec::new();

    for team_name in &team_dirs {
        let team_dir = teams_root.join(team_name);
        let tmux_session =
            read_team_tmux_session(&team_dir).unwrap_or_else(|| format!("omx-team-{team_name}"));
        known_team_sessions.insert(tmux_session.clone());

        if !tmux_unavailable && !tmux_sessions.contains(&tmux_session) {
            issues.push(TeamDoctorIssue {
                code: "resume_blocker",
                message: format!("{team_name} references missing tmux session {tmux_session}"),
                severity: CheckStatus::Fail,
            });
        }

        let workers_root = team_dir.join("workers");
        if !workers_root.exists() {
            continue;
        }

        let workers = fs::read_dir(&workers_root)
            .map_err(|error| DoctorError::runtime(format!("failed to read workers: {error}")))?;
        for worker in workers
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_dir())
        {
            let worker_dir = worker.path();
            let worker_name = worker.file_name().to_string_lossy().to_string();
            let status_path = worker_dir.join("status.json");
            let heartbeat_path = worker_dir.join("heartbeat.json");
            let shutdown_req_path = worker_dir.join("shutdown-request.json");
            let shutdown_ack_path = worker_dir.join("shutdown-ack.json");

            if status_path.exists() && heartbeat_path.exists() {
                let status_raw = fs::read_to_string(&status_path).unwrap_or_default();
                let heartbeat_raw = fs::read_to_string(&heartbeat_path).unwrap_or_default();
                let state = extract_json_string_field(&status_raw, "state").unwrap_or_default();
                let last_turn_ms = extract_json_string_field(&heartbeat_raw, "last_turn_at")
                    .and_then(|value| parse_iso_to_millis(&value));
                if state == "working"
                    && last_turn_ms
                        .is_some_and(|millis| now_ms.saturating_sub(millis) > lag_threshold_ms)
                {
                    issues.push(TeamDoctorIssue {
                        code: "delayed_status_lag",
                        message: format!("{team_name}/{worker_name} working with stale heartbeat"),
                        severity: CheckStatus::Fail,
                    });
                }
            }

            if shutdown_req_path.exists() && !shutdown_ack_path.exists() {
                let request_raw = fs::read_to_string(&shutdown_req_path).unwrap_or_default();
                let request_ms = extract_json_string_field(&request_raw, "requested_at")
                    .and_then(|value| parse_iso_to_millis(&value));
                if request_ms
                    .is_some_and(|millis| now_ms.saturating_sub(millis) > shutdown_threshold_ms)
                {
                    issues.push(TeamDoctorIssue {
                        code: "slow_shutdown",
                        message: format!(
                            "{team_name}/{worker_name} has stale shutdown request without ack"
                        ),
                        severity: CheckStatus::Fail,
                    });
                }
            }
        }
    }

    let hud_state_path = state_dir.join("hud-state.json");
    if hud_state_path.exists() && !team_dirs.is_empty() {
        let hud_raw = fs::read_to_string(&hud_state_path).unwrap_or_default();
        let leader_is_stale = extract_json_string_field(&hud_raw, "last_turn_at")
            .and_then(|value| parse_iso_to_millis(&value))
            .is_none_or(|millis| now_ms.saturating_sub(millis) > leader_stale_threshold_ms);

        if leader_is_stale && !tmux_unavailable {
            for team_name in &team_dirs {
                let default_session = format!("omx-team-{team_name}");
                let session = if known_team_sessions.contains(&default_session) {
                    Some(default_session)
                } else {
                    known_team_sessions
                        .iter()
                        .find(|session| session.contains(team_name))
                        .cloned()
                };

                if let Some(session) = session
                    && tmux_sessions.contains(&session)
                {
                    issues.push(TeamDoctorIssue {
                        code: "stale_leader",
                        message: format!(
                            "{team_name} has active tmux session but leader has no recent activity"
                        ),
                        severity: CheckStatus::Fail,
                    });
                }
            }
        }
    }

    if !tmux_unavailable {
        for session in tmux_sessions {
            if !known_team_sessions.contains(&session) {
                issues.push(TeamDoctorIssue {
                    code: "orphan_tmux_session",
                    message: format!(
                        "{session} exists without matching team state (possibly external project)"
                    ),
                    severity: CheckStatus::Warn,
                });
            }
        }
    }

    Ok(dedupe_issues(issues))
}

fn list_team_tmux_sessions(env: &BTreeMap<OsString, OsString>) -> Option<BTreeSet<String>> {
    let bridge = ProcessBridge::new(Platform::detect(), env.clone());
    let mut spec = CommandSpec::new("tmux");
    spec.args = vec![
        OsString::from("list-sessions"),
        OsString::from("-F"),
        OsString::from("#{session_name}"),
    ];
    let result = bridge.run(&spec);

    if result.spawn_error_kind.is_some() {
        return None;
    }

    if result.status_code != Some(0) {
        let stderr = String::from_utf8_lossy(&result.stderr).to_ascii_lowercase();
        if stderr.contains("no server running") || stderr.contains("failed to connect to server") {
            return Some(BTreeSet::new());
        }
        return None;
    }

    Some(
        String::from_utf8_lossy(&result.stdout)
            .lines()
            .map(str::trim)
            .filter(|line| line.starts_with("omx-team-"))
            .map(ToOwned::to_owned)
            .collect(),
    )
}

fn read_team_tmux_session(team_dir: &Path) -> Option<String> {
    for file_name in ["manifest.v2.json", "config.json"] {
        let path = team_dir.join(file_name);
        if !path.exists() {
            continue;
        }
        if let Ok(raw) = fs::read_to_string(path)
            && let Some(value) = extract_json_string_field(&raw, "tmux_session")
            && !value.trim().is_empty()
        {
            return Some(value);
        }
    }
    None
}

fn dedupe_issues(issues: Vec<TeamDoctorIssue>) -> Vec<TeamDoctorIssue> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for issue in issues {
        let key = format!("{}:{}", issue.code, issue.message);
        if seen.insert(key) {
            out.push(issue);
        }
    }
    out
}

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("workspace root")
        .to_path_buf()
}

fn count_installable_entries(raw: &str, section: &str) -> usize {
    let Some(section_idx) = raw.find(&format!("\"{section}\"")) else {
        return 0;
    };
    let Some(array_start_rel) = raw[section_idx..].find('[') else {
        return 0;
    };
    let array_start = section_idx + array_start_rel;
    let Some(array_end) = find_matching_bracket(raw, array_start) else {
        return 0;
    };
    let section_raw = &raw[array_start..=array_end];

    section_raw
        .split("\"name\"")
        .skip(1)
        .filter(|entry| {
            extract_json_string_field(entry, "status")
                .is_some_and(|status| matches!(status.as_str(), "active" | "internal"))
        })
        .count()
}

fn find_matching_bracket(raw: &str, start: usize) -> Option<usize> {
    let mut depth = 0usize;
    for (idx, byte) in raw.as_bytes().iter().enumerate().skip(start) {
        match byte {
            b'[' => depth += 1,
            b']' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(idx);
                }
            }
            _ => {}
        }
    }
    None
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

fn parse_iso_to_millis(value: &str) -> Option<u64> {
    let trimmed = value.strip_suffix('Z').unwrap_or(value);
    let (date, time_with_zone) = trimmed.split_once('T')?;
    let (clock, zone) = split_timezone(time_with_zone);

    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i32>().ok()?;
    let month = date_parts.next()?.parse::<u32>().ok()?;
    let day = date_parts.next()?.parse::<u32>().ok()?;

    let mut time_parts = clock.split(':');
    let hour = time_parts.next()?.parse::<u32>().ok()?;
    let minute = time_parts.next()?.parse::<u32>().ok()?;
    let second_part = time_parts.next()?;
    let (second_str, millis_str) = second_part.split_once('.').unwrap_or((second_part, "0"));
    let second = second_str.parse::<u32>().ok()?;
    let millis = parse_millis(millis_str)?;
    let days = days_from_civil(year, month, day)?;
    let zone_offset_seconds = parse_timezone_offset_seconds(zone)?;

    let epoch_seconds = days
        .checked_mul(86_400)?
        .checked_add(i64::from(hour) * 3_600)?
        .checked_add(i64::from(minute) * 60)?
        .checked_add(i64::from(second))?
        .checked_sub(i64::from(zone_offset_seconds))?;
    let epoch_millis = epoch_seconds
        .checked_mul(1_000)?
        .checked_add(i64::from(millis))?;
    u64::try_from(epoch_millis).ok()
}

fn split_timezone(time: &str) -> (&str, &str) {
    if let Some(idx) = time.rfind(['+', '-']) {
        let zone = &time[idx..];
        if zone.len() == 6 && zone.as_bytes()[3] == b':' {
            return (&time[..idx], zone);
        }
    }
    (time, "Z")
}

fn parse_millis(raw: &str) -> Option<u32> {
    let digits = raw.chars().take(3).collect::<String>();
    let width = digits.len();
    let value = if digits.is_empty() {
        0
    } else {
        digits.parse::<u32>().ok()?
    };
    Some(match width {
        0 => 0,
        1 => value * 100,
        2 => value * 10,
        _ => value,
    })
}

fn parse_timezone_offset_seconds(raw: &str) -> Option<i32> {
    if raw == "Z" {
        return Some(0);
    }

    let sign = match raw.as_bytes().first().copied()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let hours = raw.get(1..3)?.parse::<i32>().ok()?;
    let minutes = raw.get(4..6)?.parse::<i32>().ok()?;
    Some(sign * (hours * 3_600 + minutes * 60))
}

fn days_from_civil(year: i32, month: u32, day: u32) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let year = i64::from(year) - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = i64::from(month);
    let day = i64::from(day);
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

fn now_millis() -> u64 {
    u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("omx-rust-doctor-{label}-{nanos}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn env_map(extra: &[(&str, &str)]) -> BTreeMap<OsString, OsString> {
        let mut env = std::env::vars_os().collect::<BTreeMap<_, _>>();
        for (key, value) in extra {
            env.insert(OsString::from(key), OsString::from(value));
        }
        env
    }

    fn make_executable(path: &Path) {
        Command::new("chmod")
            .arg("+x")
            .arg(path)
            .status()
            .expect("chmod stub");
    }

    fn iso_timestamp_seconds_ago(seconds: u64) -> String {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_secs();
        let target = now.saturating_sub(seconds);
        let days = i64::try_from(target / 86_400).expect("days fit i64");
        let secs_of_day = target % 86_400;
        let (year, month, day) = civil_from_days(days);
        let hour = secs_of_day / 3_600;
        let minute = (secs_of_day % 3_600) / 60;
        let second = secs_of_day % 60;
        format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
    }

    fn iso_timestamp_minutes_ago(minutes: u64) -> String {
        iso_timestamp_seconds_ago(minutes * 60)
    }

    fn civil_from_days(days: i64) -> (i64, i64, i64) {
        let z = days + 719_468;
        let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = doy - (153 * mp + 2) / 5 + 1;
        let month = mp + if mp < 10 { 3 } else { -9 };
        let year = y + i64::from(month <= 2);
        (year, month, day)
    }

    #[test]
    fn parses_doctor_team_flag() {
        let parsed = parse_doctor_args(&["--team".to_string()]).expect("parse team");
        assert!(parsed.options.team);
    }

    #[test]
    fn rejects_unknown_doctor_flag() {
        let error = parse_doctor_args(&["--verbose".to_string()]).expect_err("reject flag");
        assert_eq!(error.to_string(), "unsupported doctor flag: --verbose");
    }

    #[test]
    fn explains_first_setup_expectation_for_config_and_mcp_onboarding_warnings() {
        let wd = temp_dir("copy");
        let home = wd.join("home");
        let codex_dir = home.join(".codex");
        fs::create_dir_all(&codex_dir).expect("create codex dir");
        fs::write(
            codex_dir.join("config.toml"),
            "[mcp_servers.non_omx]\ncommand = \"node\"\n",
        )
        .expect("write config");

        let execution = run_doctor(
            &[],
            &wd,
            &env_map(&[
                ("HOME", home.to_string_lossy().as_ref()),
                ("CODEX_HOME", codex_dir.to_string_lossy().as_ref()),
            ]),
        )
        .expect("run doctor");
        let stdout = String::from_utf8(execution.stdout).expect("utf8 stdout");
        assert_eq!(execution.exit_code, 0);
        assert!(stdout.contains(
            "Config: config.toml exists but no OMX entries yet (expected before first setup; run \"omx setup --force\" once)"
        ));
        assert!(stdout.contains(
            "MCP Servers: 1 servers but no OMX servers yet (expected before first setup; run \"omx setup --force\" once)"
        ));
    }

    #[test]
    fn emits_resume_blocker_when_team_state_references_missing_tmux_session() {
        let wd = temp_dir("resume-blocker");
        let team_root = wd.join(".omx/state/team/alpha");
        fs::create_dir_all(team_root.join("workers/worker-1")).expect("worker dir");
        fs::write(
            team_root.join("config.json"),
            r#"{"name":"alpha","tmux_session":"omx-team-alpha"}"#,
        )
        .expect("write config");

        let fake_bin = wd.join("bin");
        fs::create_dir_all(&fake_bin).expect("fake bin");
        let tmux_path = fake_bin.join("tmux");
        fs::write(&tmux_path, "#!/bin/sh\nexit 0\n").expect("write tmux stub");
        make_executable(&tmux_path);

        let path = format!(
            "{}:{}",
            fake_bin.display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let execution = run_doctor(&["--team".to_string()], &wd, &env_map(&[("PATH", &path)]))
            .expect("run doctor");
        let stdout = String::from_utf8(execution.stdout).expect("utf8 stdout");
        assert_eq!(execution.exit_code, 1);
        assert!(stdout.contains("resume_blocker"));
    }

    #[test]
    fn omits_resume_blocker_when_tmux_is_unavailable() {
        let wd = temp_dir("tmux-unavailable");
        let team_root = wd.join(".omx/state/team/alpha");
        fs::create_dir_all(team_root.join("workers/worker-1")).expect("worker dir");
        fs::write(
            team_root.join("config.json"),
            r#"{"name":"alpha","tmux_session":"omx-team-alpha"}"#,
        )
        .expect("write config");

        let execution = run_doctor(&["--team".to_string()], &wd, &env_map(&[("PATH", "")]))
            .expect("run doctor");
        let stdout = String::from_utf8(execution.stdout).expect("utf8 stdout");
        assert_eq!(execution.exit_code, 0);
        assert!(!stdout.contains("resume_blocker"));
    }

    #[test]
    fn emits_slow_shutdown_when_shutdown_request_is_stale_and_ack_missing() {
        let wd = temp_dir("slow-shutdown");
        let worker_dir = wd.join(".omx/state/team/beta/workers/worker-1");
        fs::create_dir_all(&worker_dir).expect("worker dir");
        fs::write(
            wd.join(".omx/state/team/beta/config.json"),
            r#"{"name":"beta","tmux_session":"omx-team-beta"}"#,
        )
        .expect("write config");
        fs::write(
            worker_dir.join("shutdown-request.json"),
            format!(r#"{{"requested_at":"{}"}}"#, iso_timestamp_minutes_ago(1)),
        )
        .expect("write shutdown request");

        let execution =
            run_doctor(&["--team".to_string()], &wd, &env_map(&[])).expect("run doctor");
        let stdout = String::from_utf8(execution.stdout).expect("utf8 stdout");
        assert_eq!(execution.exit_code, 1);
        assert!(stdout.contains("slow_shutdown"));
    }

    #[test]
    fn emits_delayed_status_lag_when_worker_is_working_and_heartbeat_is_stale() {
        let wd = temp_dir("delayed-status");
        let worker_dir = wd.join(".omx/state/team/gamma/workers/worker-1");
        fs::create_dir_all(&worker_dir).expect("worker dir");
        fs::write(
            wd.join(".omx/state/team/gamma/config.json"),
            r#"{"name":"gamma","tmux_session":"omx-team-gamma"}"#,
        )
        .expect("write config");
        fs::write(
            worker_dir.join("status.json"),
            format!(
                r#"{{"state":"working","updated_at":"{}"}}"#,
                iso_timestamp_seconds_ago(0)
            ),
        )
        .expect("write status");
        fs::write(
            worker_dir.join("heartbeat.json"),
            format!(
                r#"{{"pid":123,"last_turn_at":"{}","turn_count":10,"alive":true}}"#,
                iso_timestamp_minutes_ago(2)
            ),
        )
        .expect("write heartbeat");

        let execution =
            run_doctor(&["--team".to_string()], &wd, &env_map(&[])).expect("run doctor");
        let stdout = String::from_utf8(execution.stdout).expect("utf8 stdout");
        assert_eq!(execution.exit_code, 1);
        assert!(stdout.contains("delayed_status_lag"));
    }

    #[test]
    fn emits_orphan_tmux_session_as_warning_when_tmux_session_cannot_be_attributed() {
        let wd = temp_dir("orphan-tmux");
        let fake_bin = wd.join("bin");
        fs::create_dir_all(&fake_bin).expect("fake bin");
        let tmux_path = fake_bin.join("tmux");
        fs::write(
            &tmux_path,
            "#!/bin/sh\nif [ \"$1\" = \"list-sessions\" ]; then echo \"omx-team-orphan\"; exit 0; fi\nexit 0\n",
        )
        .expect("write tmux stub");
        make_executable(&tmux_path);

        let path = format!(
            "{}:{}",
            fake_bin.display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let execution = run_doctor(&["--team".to_string()], &wd, &env_map(&[("PATH", &path)]))
            .expect("run doctor");
        let stdout = String::from_utf8(execution.stdout).expect("utf8 stdout");
        assert_eq!(execution.exit_code, 0);
        assert!(stdout.contains("orphan_tmux_session"));
        assert!(stdout.contains("possibly external project"));
    }

    #[test]
    fn emits_stale_leader_when_hud_state_is_old_and_team_tmux_session_is_active() {
        let wd = temp_dir("stale-leader");
        let team_root = wd.join(".omx/state/team/epsilon");
        fs::create_dir_all(team_root.join("workers/worker-1")).expect("worker dir");
        fs::write(
            team_root.join("config.json"),
            r#"{"name":"epsilon","tmux_session":"omx-team-epsilon"}"#,
        )
        .expect("write config");
        fs::write(
            wd.join(".omx/state/hud-state.json"),
            format!(
                r#"{{"last_turn_at":"{}","turn_count":5}}"#,
                iso_timestamp_minutes_ago(5)
            ),
        )
        .expect("write hud");

        let fake_bin = wd.join("bin");
        fs::create_dir_all(&fake_bin).expect("fake bin");
        let tmux_path = fake_bin.join("tmux");
        fs::write(
            &tmux_path,
            "#!/bin/sh\nif [ \"$1\" = \"list-sessions\" ]; then echo \"omx-team-epsilon\"; exit 0; fi\nexit 0\n",
        )
        .expect("write tmux stub");
        make_executable(&tmux_path);

        let path = format!(
            "{}:{}",
            fake_bin.display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let execution = run_doctor(&["--team".to_string()], &wd, &env_map(&[("PATH", &path)]))
            .expect("run doctor");
        let stdout = String::from_utf8(execution.stdout).expect("utf8 stdout");
        assert_eq!(execution.exit_code, 1);
        assert!(stdout.contains("stale_leader"));
    }

    #[test]
    fn does_not_emit_stale_leader_when_hud_state_is_fresh() {
        let wd = temp_dir("fresh-leader");
        let team_root = wd.join(".omx/state/team/zeta");
        fs::create_dir_all(team_root.join("workers/worker-1")).expect("worker dir");
        fs::write(
            team_root.join("config.json"),
            r#"{"name":"zeta","tmux_session":"omx-team-zeta"}"#,
        )
        .expect("write config");
        fs::write(
            wd.join(".omx/state/hud-state.json"),
            format!(
                r#"{{"last_turn_at":"{}","turn_count":20}}"#,
                iso_timestamp_seconds_ago(10)
            ),
        )
        .expect("write hud");

        let fake_bin = wd.join("bin");
        fs::create_dir_all(&fake_bin).expect("fake bin");
        let tmux_path = fake_bin.join("tmux");
        fs::write(
            &tmux_path,
            "#!/bin/sh\nif [ \"$1\" = \"list-sessions\" ]; then echo \"omx-team-zeta\"; exit 0; fi\nexit 0\n",
        )
        .expect("write tmux stub");
        make_executable(&tmux_path);

        let path = format!(
            "{}:{}",
            fake_bin.display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let execution = run_doctor(&["--team".to_string()], &wd, &env_map(&[("PATH", &path)]))
            .expect("run doctor");
        let stdout = String::from_utf8(execution.stdout).expect("utf8 stdout");
        assert!(!stdout.contains("stale_leader"));
    }

    #[test]
    fn does_not_emit_orphan_tmux_session_when_tmux_reports_no_server_running() {
        let wd = temp_dir("no-server");
        let fake_bin = wd.join("bin");
        fs::create_dir_all(&fake_bin).expect("fake bin");
        let tmux_path = fake_bin.join("tmux");
        fs::write(
            &tmux_path,
            "#!/bin/sh\nif [ \"$1\" = \"list-sessions\" ]; then echo \"no server running on /tmp/tmux-1000/default\" 1>&2; exit 1; fi\nexit 0\n",
        )
        .expect("write tmux stub");
        make_executable(&tmux_path);

        let path = format!(
            "{}:{}",
            fake_bin.display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let execution = run_doctor(&["--team".to_string()], &wd, &env_map(&[("PATH", &path)]))
            .expect("run doctor");
        let stdout = String::from_utf8(execution.stdout).expect("utf8 stdout");
        assert_eq!(execution.exit_code, 0);
        assert!(!stdout.contains("orphan_tmux_session"));
    }

    #[test]
    fn reads_catalog_expectations_from_workspace_manifest() {
        let expectations = get_catalog_expectations();
        assert!(expectations.prompt_min > 0);
        assert!(expectations.skill_min > 0);
    }
}
