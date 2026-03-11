use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const MANAGED_MARKER: &str = "<!-- OMX:AGENTS-INIT:MANAGED -->";
const MANUAL_START: &str = "<!-- OMX:AGENTS-INIT:MANUAL:START -->";
const MANUAL_END: &str = "<!-- OMX:AGENTS-INIT:MANUAL:END -->";
const DEFAULT_LIST_LIMIT: usize = 12;
const ROOT_MANUAL_FALLBACK: &str = "## Local Notes\n- Add repo-specific architecture notes, workflow conventions, and verification commands here.\n- This block is preserved by `omx agents-init` refreshes.";
const DIR_MANUAL_FALLBACK: &str = "## Local Notes\n- Add subtree-specific constraints, ownership notes, and test commands here.\n- Keep notes scoped to this directory and its children.";
const ROOT_TEMPLATE: &str = include_str!("../../../templates/AGENTS.md");
const AGENTS_INIT_USAGE: &str = "Usage: omx agents-init [path] [--dry-run] [--force] [--verbose]\n       omx deepinit [path] [--dry-run] [--force] [--verbose]\n\nBootstrap lightweight AGENTS.md files for the target directory and its direct child directories.\n\nOptions:\n  --dry-run   Show planned file updates without writing files\n  --force     Overwrite existing unmanaged AGENTS.md files after taking a backup\n  --verbose   Print per-file actions and skip reasons\n  --help      Show this message\n";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentsInitOptions {
    pub dry_run: bool,
    pub force: bool,
    pub verbose: bool,
    pub target_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentsInitExecution {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentsInitError {
    message: String,
}

impl AgentsInitError {
    fn runtime(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for AgentsInitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AgentsInitError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentsInitMode {
    AgentsInit,
    DeepInit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAgentsInitArgs {
    pub options: AgentsInitOptions,
    pub help: bool,
}

#[derive(Default)]
struct Summary {
    updated: usize,
    unchanged: usize,
    skipped: usize,
    backed_up: usize,
}

#[must_use]
pub fn usage() -> &'static str {
    AGENTS_INIT_USAGE
}

#[allow(clippy::missing_errors_doc)]
pub fn parse_agents_init_args(args: &[String]) -> Result<ParsedAgentsInitArgs, AgentsInitError> {
    let mut dry_run = false;
    let mut force = false;
    let mut verbose = false;
    let mut help = false;
    let mut target_path: Option<String> = None;

    for arg in args {
        match arg.as_str() {
            "--dry-run" => dry_run = true,
            "--force" => force = true,
            "--verbose" => verbose = true,
            "--help" | "-h" => help = true,
            value if value.starts_with('-') => {
                return Err(AgentsInitError::runtime(format!(
                    "unsupported agents-init flag: {value}"
                )));
            }
            value => {
                if target_path.is_some() {
                    return Err(AgentsInitError::runtime(
                        "agents-init accepts at most one target path",
                    ));
                }
                target_path = Some(value.to_string());
            }
        }
    }

    Ok(ParsedAgentsInitArgs {
        options: AgentsInitOptions {
            dry_run,
            force,
            verbose,
            target_path,
        },
        help,
    })
}

#[allow(clippy::missing_errors_doc)]
pub fn run_agents_init(
    mode: AgentsInitMode,
    args: &[String],
    cwd: &Path,
) -> Result<AgentsInitExecution, AgentsInitError> {
    let parsed = parse_agents_init_args(args)?;
    if parsed.help {
        return Ok(AgentsInitExecution {
            stdout: usage().as_bytes().to_vec(),
            stderr: Vec::new(),
            exit_code: 0,
        });
    }

    let requested = parsed.options.target_path.as_deref().unwrap_or(".");
    let target_dir = cwd.join(requested);
    let target_dir = normalize_existing_dir(&target_dir, requested)?;
    ensure_within_root(cwd, &target_dir, requested)?;

    let planned_dirs = resolve_target_directories(&target_dir).map_err(|error| {
        AgentsInitError::runtime(format!("failed to enumerate target directories: {error}"))
    })?;
    let active_session = read_session_state(cwd).map_err(|error| {
        AgentsInitError::runtime(format!("failed to read session state: {error}"))
    })?;
    let root_session_guard_active = active_session.as_ref().is_some_and(is_session_active);
    let backup_root = cwd
        .join(".omx")
        .join("backups")
        .join("agents-init")
        .join(isoish_timestamp());

    let mut output = String::new();
    let mut summary = Summary::default();
    let target_label = path_relative_to(cwd, &target_dir);
    let command_name = match mode {
        AgentsInitMode::AgentsInit => "agents-init",
        AgentsInitMode::DeepInit => "deepinit",
    };
    let _ = writeln!(output, "omx {command_name}: scanning {target_label}");

    for dir in planned_dirs {
        let destination = dir.join("AGENTS.md");
        let existing = fs::read_to_string(&destination).ok();
        let skip_reason = if dir == cwd && root_session_guard_active {
            Some("active omx session detected for project root AGENTS.md")
        } else {
            None
        };
        let content = if dir == target_dir && target_dir == cwd {
            render_root_agents(existing.as_deref())
        } else {
            render_directory_agents(
                cwd,
                &dir,
                existing.as_deref(),
                dir.parent().is_some_and(|p| p.join("AGENTS.md").exists()),
            )
            .map_err(|error| {
                AgentsInitError::runtime(format!("failed to render {}: {error}", dir.display()))
            })?
        };

        let action = sync_agents_file(
            &destination,
            &content,
            &parsed.options,
            &mut summary,
            &backup_root,
            skip_reason,
        )
        .map_err(|error| {
            AgentsInitError::runtime(format!("failed to sync {}: {error}", destination.display()))
        })?;

        if parsed.options.verbose || action != "unchanged" {
            let _ = writeln!(
                output,
                "  {action}: {}",
                path_relative_to(cwd, &destination)
            );
        }
    }

    let _ = writeln!(
        output,
        "\nSummary: {} updated, {} unchanged, {} skipped, {} backups",
        summary.updated, summary.unchanged, summary.skipped, summary.backed_up
    );
    Ok(AgentsInitExecution {
        stdout: output.into_bytes(),
        stderr: Vec::new(),
        exit_code: 0,
    })
}

fn normalize_existing_dir(path: &Path, requested: &str) -> Result<PathBuf, AgentsInitError> {
    let canonical = path.canonicalize().map_err(|_| {
        AgentsInitError::runtime(format!("agents-init target not found: {requested}"))
    })?;
    if !canonical.is_dir() {
        return Err(AgentsInitError::runtime(format!(
            "agents-init target must be a directory: {requested}"
        )));
    }
    Ok(canonical)
}

fn ensure_within_root(
    cwd: &Path,
    target_dir: &Path,
    requested: &str,
) -> Result<(), AgentsInitError> {
    let canonical_cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    if !target_dir.starts_with(&canonical_cwd) {
        return Err(AgentsInitError::runtime(format!(
            "agents-init target must stay inside the current working directory: {requested}"
        )));
    }
    Ok(())
}

fn resolve_target_directories(target_dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut directories = vec![target_dir.to_path_buf()];
    let mut children = fs::read_dir(target_dir)?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|name| !is_ignored_directory(name))
        })
        .collect::<Vec<_>>();
    children.sort();
    directories.extend(children);
    Ok(directories)
}

fn is_ignored_directory(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".omx"
            | ".codex"
            | ".agents"
            | "node_modules"
            | "dist"
            | "build"
            | "coverage"
            | ".next"
            | ".nuxt"
            | ".turbo"
            | ".cache"
            | "__pycache__"
            | "vendor"
            | "target"
            | "tmp"
            | "temp"
    )
}

fn render_root_agents(existing: Option<&str>) -> String {
    let manual = extract_manual_section(existing, ROOT_MANUAL_FALLBACK);
    let template = ROOT_TEMPLATE
        .replace("~/.codex", "./.codex")
        .replace("~/.agents", "./.agents");
    wrap_managed_content(&template, &manual)
}

fn render_directory_agents(
    cwd: &Path,
    dir: &Path,
    existing: Option<&str>,
    assume_parent_agents: bool,
) -> io::Result<String> {
    let snapshot = snapshot_directory(dir)?;
    let title = dir.file_name().and_then(|v| v.to_str()).unwrap_or(".");
    let relative_dir = path_relative_to(cwd, dir);
    let parent_reference = render_parent_reference(dir, assume_parent_agents);
    let files = format_list(&snapshot.0, "", DEFAULT_LIST_LIMIT);
    let directories = format_list(&snapshot.1, "/", DEFAULT_LIST_LIMIT);
    let body = format!(
        "{parent_reference}# {title}\n\nThis AGENTS.md scopes guidance to `{relative_dir}`. Parent AGENTS guidance still applies unless this file narrows it for this subtree.\n\n## Bootstrap Guardrails\n- This is a lightweight scaffold generated by `omx agents-init`.\n- Refresh updates the layout summary below and preserves the manual notes block.\n- Keep only directory-specific guidance here; do not duplicate the root orchestration brain.\n\n## Current Layout\n\n### Files\n{}\n\n### Subdirectories\n{}",
        files.join("\n"),
        directories.join("\n"),
    );
    Ok(wrap_managed_content(
        &body,
        &extract_manual_section(existing, DIR_MANUAL_FALLBACK),
    ))
}

fn snapshot_directory(dir: &Path) -> io::Result<(Vec<String>, Vec<String>)> {
    let mut files = Vec::new();
    let mut directories = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == "AGENTS.md" {
            continue;
        }
        let metadata = entry.file_type()?;
        if metadata.is_dir() {
            if !is_ignored_directory(&name) {
                directories.push(name.to_string());
            }
        } else if metadata.is_file() {
            files.push(name.to_string());
        }
    }
    files.sort();
    directories.sort();
    Ok((files, directories))
}

fn format_list(items: &[String], suffix: &str, limit: usize) -> Vec<String> {
    if items.is_empty() {
        return vec!["- None".to_string()];
    }
    let mut lines = items
        .iter()
        .take(limit)
        .map(|item| format!("- `{item}{suffix}`"))
        .collect::<Vec<_>>();
    if items.len() > limit {
        lines.push(format!("- ...and {} more", items.len() - limit));
    }
    lines
}

fn render_parent_reference(dir: &Path, assume_parent_agents: bool) -> String {
    let Some(parent) = dir.parent() else {
        return String::new();
    };
    let parent_agents = parent.join("AGENTS.md");
    if !assume_parent_agents && !parent_agents.exists() {
        return String::new();
    }
    let rel = path_relative_to(dir, &parent_agents);
    format!("<!-- Parent: {rel} -->\n")
}

fn extract_manual_section(existing: Option<&str>, fallback: &str) -> String {
    let Some(existing) = existing else {
        return fallback.trim().to_string();
    };
    let Some(start) = existing.find(MANUAL_START) else {
        return fallback.trim().to_string();
    };
    let Some(end) = existing.find(MANUAL_END) else {
        return fallback.trim().to_string();
    };
    if end < start {
        return fallback.trim().to_string();
    }
    let section = existing[start + MANUAL_START.len()..end].trim();
    if section.is_empty() {
        fallback.trim().to_string()
    } else {
        section.to_string()
    }
}

fn wrap_managed_content(body: &str, manual_body: &str) -> String {
    format!(
        "{MANAGED_MARKER}\n{}\n\n{MANUAL_START}\n{}\n{MANUAL_END}\n",
        body.trim_end(),
        manual_body.trim()
    )
}

fn is_managed_agents_init_file(content: &str) -> bool {
    content.contains(MANAGED_MARKER)
}

fn sync_agents_file(
    destination: &Path,
    content: &str,
    options: &AgentsInitOptions,
    summary: &mut Summary,
    backup_root: &Path,
    skip_reason: Option<&str>,
) -> io::Result<&'static str> {
    if skip_reason.is_some() {
        summary.skipped += 1;
        return Ok("skipped");
    }

    match fs::read_to_string(destination) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            if !options.dry_run {
                if let Some(parent) = destination.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::write(destination, content)?;
            }
            summary.updated += 1;
            Ok("updated")
        }
        Err(err) => Err(err),
        Ok(existing) => {
            if existing == content {
                summary.unchanged += 1;
                return Ok("unchanged");
            }
            if !is_managed_agents_init_file(&existing) && !options.force {
                summary.skipped += 1;
                return Ok("skipped");
            }
            if !options.dry_run {
                ensure_backup(destination, backup_root)?;
                if let Some(parent) = destination.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::write(destination, content)?;
            } else if destination.exists() {
                summary.backed_up += 1;
            }
            if destination.exists() && !options.dry_run {
                summary.backed_up += 1;
            }
            summary.updated += 1;
            Ok("updated")
        }
    }
}

fn ensure_backup(destination: &Path, backup_root: &Path) -> io::Result<()> {
    if !destination.exists() {
        return Ok(());
    }
    let rel = destination
        .strip_prefix(std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
        .unwrap_or(destination);
    let backup_path = backup_root.join(rel);
    if let Some(parent) = backup_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(destination, backup_path)?;
    Ok(())
}

#[derive(Debug)]
struct SessionState {
    pid: i32,
    pid_start_ticks: Option<u64>,
}

fn read_session_state(cwd: &Path) -> io::Result<Option<SessionState>> {
    let path = cwd.join(".omx").join("state").join("session.json");
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err),
    };
    let pid = extract_json_number(&content, "pid")
        .and_then(|v| i32::try_from(v).ok())
        .unwrap_or_default();
    let pid_start_ticks = extract_json_number(&content, "pid_start_ticks");
    Ok(Some(SessionState {
        pid,
        pid_start_ticks,
    }))
}

fn extract_json_number(content: &str, key: &str) -> Option<u64> {
    let pattern = format!("\"{key}\"");
    let idx = content.find(&pattern)?;
    let rest = &content[idx + pattern.len()..];
    let colon = rest.find(':')?;
    let mut value = String::new();
    for ch in rest[colon + 1..].chars() {
        if ch.is_ascii_digit() {
            value.push(ch);
        } else if !value.is_empty() {
            break;
        }
    }
    value.parse().ok()
}

fn is_session_active(state: &SessionState) -> bool {
    if state.pid <= 0 {
        return false;
    }
    #[cfg(unix)]
    {
        let proc_stat = format!("/proc/{}/stat", state.pid);
        let Ok(stat) = fs::read_to_string(proc_stat) else {
            return false;
        };
        let live_start_ticks = parse_linux_proc_start_ticks(&stat);
        state.pid_start_ticks.is_some() && live_start_ticks == state.pid_start_ticks
    }
    #[cfg(not(unix))]
    {
        false
    }
}

fn parse_linux_proc_start_ticks(stat_content: &str) -> Option<u64> {
    let command_end = stat_content.rfind(')')?;
    let fields = stat_content[command_end + 1..]
        .split_whitespace()
        .collect::<Vec<_>>();
    fields.get(19)?.parse().ok()
}

fn path_relative_to(base: &Path, target: &Path) -> String {
    diff_paths(target, base)
        .to_string_lossy()
        .replace('\\', "/")
        .if_empty_then_dot()
}

trait DotPath {
    fn if_empty_then_dot(self) -> String;
}

impl DotPath for String {
    fn if_empty_then_dot(self) -> String {
        if self.is_empty() {
            ".".to_string()
        } else {
            self
        }
    }
}

fn diff_paths(path: &Path, base: &Path) -> PathBuf {
    let path = path.components().collect::<Vec<_>>();
    let base = base.components().collect::<Vec<_>>();
    let common = path.iter().zip(&base).take_while(|(a, b)| a == b).count();
    let mut result = PathBuf::new();
    for _ in common..base.len() {
        result.push("..");
    }
    for component in &path[common..] {
        result.push(component.as_os_str());
    }
    result
}

fn isoish_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}-{}", now.as_secs(), now.subsec_nanos())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("{name}-{suffix}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parses_help_and_flags() {
        let parsed = parse_agents_init_args(&[
            "src".into(),
            "--dry-run".into(),
            "--force".into(),
            "--verbose".into(),
        ])
        .unwrap();
        assert_eq!(parsed.options.target_path.as_deref(), Some("src"));
        assert!(parsed.options.dry_run);
        assert!(parsed.options.force);
        assert!(parsed.options.verbose);
        assert!(!parsed.help);
    }

    #[test]
    fn creates_root_and_child_agents() {
        let cwd = temp_dir("omx-agents-init-rs");
        fs::create_dir_all(cwd.join("src")).unwrap();
        fs::create_dir_all(cwd.join("docs")).unwrap();
        fs::create_dir_all(cwd.join("node_modules").join("dep")).unwrap();
        fs::write(
            cwd.join("src").join("index.ts"),
            "export const value = 1;\n",
        )
        .unwrap();
        fs::write(cwd.join("docs").join("guide.md"), "# guide\n").unwrap();

        let result = run_agents_init(AgentsInitMode::AgentsInit, &[], &cwd).unwrap();
        assert_eq!(result.exit_code, 0);

        let root = fs::read_to_string(cwd.join("AGENTS.md")).unwrap();
        let src = fs::read_to_string(cwd.join("src").join("AGENTS.md")).unwrap();
        let docs = fs::read_to_string(cwd.join("docs").join("AGENTS.md")).unwrap();
        assert!(root.contains(MANAGED_MARKER));
        assert!(root.contains("# oh-my-codex - Intelligent Multi-Agent Orchestration"));
        assert!(root.contains("./.codex"));
        assert!(src.contains("<!-- Parent: ../AGENTS.md -->"));
        assert!(src.contains("`index.ts`"));
        assert!(docs.contains("`guide.md`"));
        assert!(!cwd.join("node_modules").join("AGENTS.md").exists());

        let _ = fs::remove_dir_all(cwd);
    }

    #[test]
    fn preserves_manual_notes_on_refresh() {
        let cwd = temp_dir("omx-agents-init-refresh");
        fs::create_dir_all(cwd.join("src").join("lib")).unwrap();
        fs::write(
            cwd.join("src").join("index.ts"),
            "export const index = true;\n",
        )
        .unwrap();
        run_agents_init(AgentsInitMode::AgentsInit, &["src".into()], &cwd).unwrap();
        let path = cwd.join("src").join("AGENTS.md");
        let initial = fs::read_to_string(&path).unwrap();
        fs::write(
            &path,
            initial.replace(
                "- Add subtree-specific constraints, ownership notes, and test commands here.",
                "- Preserve this custom manual note.",
            ),
        )
        .unwrap();
        fs::write(
            cwd.join("src").join("new-file.ts"),
            "export const newer = true;\n",
        )
        .unwrap();
        run_agents_init(AgentsInitMode::AgentsInit, &["src".into()], &cwd).unwrap();
        let refreshed = fs::read_to_string(&path).unwrap();
        assert!(refreshed.contains("Preserve this custom manual note."));
        assert!(refreshed.contains("`new-file.ts`"));
        assert!(cwd.join("src").join("lib").join("AGENTS.md").exists());
        let _ = fs::remove_dir_all(cwd);
    }

    #[test]
    fn protects_root_agents_during_active_session() {
        let cwd = temp_dir("omx-agents-init-session");
        fs::create_dir_all(cwd.join(".omx").join("state")).unwrap();
        fs::create_dir_all(cwd.join("src")).unwrap();
        fs::write(cwd.join("AGENTS.md"), "# unmanaged\n").unwrap();
        fs::write(cwd.join("src").join("index.ts"), "export const x = 1;\n").unwrap();
        let pid = std::process::id();
        let stat = fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
        let ticks = parse_linux_proc_start_ticks(&stat).unwrap();
        fs::write(cwd.join(".omx").join("state").join("session.json"), format!("{{\n  \"session_id\": \"session-1\",\n  \"started_at\": \"2026-03-11T00:00:00.000Z\",\n  \"cwd\": \"{}\",\n  \"pid\": {pid},\n  \"pid_start_ticks\": {ticks}\n}}", cwd.display())).unwrap();

        run_agents_init(AgentsInitMode::AgentsInit, &["--force".into()], &cwd).unwrap();
        assert_eq!(
            fs::read_to_string(cwd.join("AGENTS.md")).unwrap(),
            "# unmanaged\n"
        );
        assert!(cwd.join("src").join("AGENTS.md").exists());
        let _ = fs::remove_dir_all(cwd);
    }
}
