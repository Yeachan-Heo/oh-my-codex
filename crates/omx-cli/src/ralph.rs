use crate::session_state::{extract_json_string_field, read_current_session_id};
use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RalphExecution {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RalphError(String);

impl RalphError {
    fn runtime(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl std::fmt::Display for RalphError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for RalphError {}

pub const RALPH_HELP: &str = "omx ralph - Launch Codex with ralph persistence mode active\n\nUsage:\n  omx ralph [task text...]\n  omx ralph --prd \"<task text>\"\n  omx ralph [ralph-options] [codex-args...] [task text...]\n\nOptions:\n  --help, -h           Show this help message\n  --prd <task text>    PRD mode shortcut: mark the task text explicitly\n  --prd=<task text>    Same as --prd \"<task text>\"\n\nPRD mode:\n  Ralph initializes persistence artifacts in .omx/ so PRD and progress\n  state can survive across Codex sessions. Provide task text either as\n  positional words or with --prd.\n\nCommon patterns:\n  omx ralph \"Fix flaky notify-hook tests\"\n  omx ralph --prd \"Ship release checklist automation\"\n  omx ralph --model gpt-5 \"Refactor state hydration\"\n  omx ralph -- --task-with-leading-dash\n\n";

const VALUE_TAKING_FLAGS: &[&str] = &[
    "--model",
    "--provider",
    "--config",
    "-c",
    "-i",
    "--images-dir",
];
const DEFAULT_RALPH_TASK: &str = "ralph-cli-launch";
const DEFAULT_PRIMARY_ROLE: &str = "executor";
const DEFAULT_QUALITY_ROLE: &str = "test-engineer";
const DEFAULT_SIGNOFF_ROLE: &str = "architect";

#[must_use]
pub fn extract_ralph_task_description(args: &[String]) -> String {
    let mut words = Vec::new();
    let mut i = 0usize;
    while i < args.len() {
        let token = &args[i];
        if token == "--" {
            words.extend(args.iter().skip(i + 1).cloned());
            break;
        }
        if token.starts_with("--") && token.contains('=') {
            i += 1;
            continue;
        }
        if token.starts_with('-') && VALUE_TAKING_FLAGS.contains(&token.as_str()) {
            i += 2;
            continue;
        }
        if token.starts_with('-') {
            i += 1;
            continue;
        }
        words.push(token.clone());
        i += 1;
    }
    if words.is_empty() {
        DEFAULT_RALPH_TASK.to_string()
    } else {
        words.join(" ")
    }
}

#[must_use]
pub fn normalize_ralph_cli_args(args: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();
    let mut i = 0usize;
    while i < args.len() {
        let token = &args[i];
        if token == "--prd" {
            match args.get(i + 1) {
                Some(next) if next != "--" && !next.starts_with('-') => {
                    normalized.push(next.clone());
                    i += 2;
                    continue;
                }
                _ => {
                    i += 1;
                    continue;
                }
            }
        }
        if let Some(value) = token.strip_prefix("--prd=") {
            if !value.is_empty() {
                normalized.push(value.to_string());
            }
            i += 1;
            continue;
        }
        normalized.push(token.clone());
        i += 1;
    }
    normalized
}

#[must_use]
pub fn filter_ralph_codex_args(args: &[String]) -> Vec<String> {
    args.iter()
        .filter(|token| !token.eq_ignore_ascii_case("--prd"))
        .cloned()
        .collect()
}

#[allow(clippy::missing_errors_doc)]
pub fn run_ralph(args: &[String], cwd: &Path) -> Result<RalphExecution, RalphError> {
    let normalized = normalize_ralph_cli_args(args);
    if matches!(
        normalized.first().map(String::as_str),
        Some("--help" | "-h")
    ) {
        return Ok(RalphExecution {
            stdout: RALPH_HELP.as_bytes().to_vec(),
            stderr: Vec::new(),
            exit_code: 0,
        });
    }

    let task = extract_ralph_task_description(&normalized);
    let scope_dir = resolve_ralph_scope_dir(cwd);
    fs::create_dir_all(&scope_dir).map_err(|error| {
        RalphError::runtime(format!("failed to create {}: {error}", scope_dir.display()))
    })?;

    let canonical_prd_path = ensure_canonical_prd(cwd)?;
    let progress = ensure_canonical_progress(cwd, &scope_dir)?;
    let staffing = build_staffing_plan(&resolve_available_agent_types(cwd));
    write_ralph_state(
        &scope_dir,
        &task,
        canonical_prd_path.as_deref(),
        &progress.path,
        &staffing,
    )?;

    let mut stdout = String::new();
    if progress.migrated_prd {
        let _ = writeln!(
            stdout,
            "[ralph] Migrated legacy PRD -> {}",
            canonical_prd_path.as_deref().unwrap_or_default()
        );
    }
    if progress.migrated_progress {
        let _ = writeln!(
            stdout,
            "[ralph] Migrated legacy progress -> {}",
            progress.path.display()
        );
    }
    stdout.push_str("[ralph] Ralph persistence mode active. Launching Codex...\n");
    let _ = writeln!(
        stdout,
        "[ralph] available_agent_types: {}",
        staffing.roster_summary
    );
    let _ = writeln!(
        stdout,
        "[ralph] staffing_plan: {}",
        staffing.staffing_summary
    );

    Ok(RalphExecution {
        stdout: stdout.into_bytes(),
        stderr: Vec::new(),
        exit_code: 0,
    })
}

struct ProgressResult {
    path: PathBuf,
    migrated_prd: bool,
    migrated_progress: bool,
}

struct StaffingPlan {
    available_agent_types: Vec<String>,
    roster_summary: String,
    staffing_summary: String,
}

fn resolve_ralph_scope_dir(cwd: &Path) -> PathBuf {
    let state_root = cwd.join(".omx").join("state");
    match read_current_session_id(&state_root) {
        Some(session_id) => state_root.join("sessions").join(session_id),
        None => state_root,
    }
}

fn ensure_canonical_prd(cwd: &Path) -> Result<Option<String>, RalphError> {
    let plans_dir = cwd.join(".omx").join("plans");
    fs::create_dir_all(&plans_dir).map_err(|error| {
        RalphError::runtime(format!("failed to create {}: {error}", plans_dir.display()))
    })?;

    let mut canonical = list_canonical_prds(&plans_dir)?;
    if let Some(existing) = canonical.pop() {
        return Ok(Some(existing));
    }

    let legacy_path = cwd.join(".omx").join("prd.json");
    if !legacy_path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(&legacy_path).map_err(|error| {
        RalphError::runtime(format!("failed to read {}: {error}", legacy_path.display()))
    })?;
    let title = legacy_prd_title(&raw);
    let slug = slugify(&title);
    let canonical_path = plans_dir.join(format!("prd-{slug}.md"));
    let markdown = format!(
        "# {title}\n\n> Migrated from legacy `.omx/prd.json`.\n\n## Legacy Snapshot\n```json\n{raw}\n```\n"
    );
    fs::write(&canonical_path, markdown).map_err(|error| {
        RalphError::runtime(format!(
            "failed to write {}: {error}",
            canonical_path.display()
        ))
    })?;
    Ok(Some(canonical_path.display().to_string()))
}

fn list_canonical_prds(plans_dir: &Path) -> Result<Vec<String>, RalphError> {
    let entries = match fs::read_dir(plans_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(RalphError::runtime(format!(
                "failed to read {}: {error}",
                plans_dir.display()
            )));
        }
    };

    let mut files = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            (name.starts_with("prd-") && name.ends_with(".md"))
                .then(|| entry.path().display().to_string())
        })
        .collect::<Vec<_>>();
    files.sort();
    Ok(files)
}

fn legacy_prd_title(raw: &str) -> String {
    ["project", "title", "branchName", "description"]
        .into_iter()
        .find_map(|key| extract_json_string_field(raw, key))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Legacy Ralph PRD".to_string())
}

fn slugify(raw: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;
    for ch in raw.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    slug.trim_matches('-')
        .chars()
        .take(48)
        .collect::<String>()
        .if_empty("legacy")
}

fn ensure_canonical_progress(cwd: &Path, scope_dir: &Path) -> Result<ProgressResult, RalphError> {
    let progress_path = scope_dir.join("ralph-progress.json");
    if progress_path.exists() {
        return Ok(ProgressResult {
            path: progress_path,
            migrated_prd: cwd.join(".omx").join("prd.json").exists()
                && list_canonical_prds(&cwd.join(".omx").join("plans"))?.len() == 1,
            migrated_progress: false,
        });
    }

    let legacy_progress = cwd.join(".omx").join("progress.txt");
    let mut migrated_progress = false;
    let payload = if legacy_progress.exists() {
        migrated_progress = true;
        let raw = fs::read_to_string(&legacy_progress).map_err(|error| {
            RalphError::runtime(format!(
                "failed to read {}: {error}",
                legacy_progress.display()
            ))
        })?;
        let entries = raw
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .enumerate()
            .map(|(idx, text)| {
                format!(
                    "    {{ \"index\": {}, \"text\": {} }}",
                    idx + 1,
                    json_string(text)
                )
            })
            .collect::<Vec<_>>()
            .join(",\n");
        format!(
            "{{\n  \"schema_version\": 2,\n  \"source\": \".omx/progress.txt\",\n  \"created_at\": {now},\n  \"updated_at\": {now},\n  \"entries\": [\n{entries}\n  ],\n  \"visual_feedback\": []\n}}\n",
            now = json_string(&now_iso_string())
        )
    } else {
        let now = json_string(&now_iso_string());
        format!(
            "{{\n  \"schema_version\": 2,\n  \"created_at\": {now},\n  \"updated_at\": {now},\n  \"entries\": [],\n  \"visual_feedback\": []\n}}\n"
        )
    };
    fs::write(&progress_path, payload).map_err(|error| {
        RalphError::runtime(format!(
            "failed to write {}: {error}",
            progress_path.display()
        ))
    })?;

    Ok(ProgressResult {
        path: progress_path,
        migrated_prd: cwd.join(".omx").join("prd.json").exists()
            && list_canonical_prds(&cwd.join(".omx").join("plans"))?.len() == 1,
        migrated_progress,
    })
}

fn resolve_available_agent_types(cwd: &Path) -> Vec<String> {
    let mut roles = BTreeSet::new();
    for dir in [cwd.join("prompts"), cwd.join(".codex").join("prompts")] {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
                roles.insert(stem.to_string());
            }
        }
    }
    if roles.is_empty() {
        roles.insert(DEFAULT_PRIMARY_ROLE.to_string());
        roles.insert(DEFAULT_QUALITY_ROLE.to_string());
        roles.insert(DEFAULT_SIGNOFF_ROLE.to_string());
    }
    roles.into_iter().collect()
}

fn build_staffing_plan(available_agent_types: &[String]) -> StaffingPlan {
    let primary = choose_role(
        available_agent_types,
        &[DEFAULT_PRIMARY_ROLE],
        DEFAULT_PRIMARY_ROLE,
    );
    let quality = choose_role(
        available_agent_types,
        &[DEFAULT_QUALITY_ROLE, "verifier"],
        primary,
    );
    let signoff = choose_role(
        available_agent_types,
        &[DEFAULT_SIGNOFF_ROLE, "critic", "verifier"],
        quality,
    );
    let staffing_summary = format!(
        "{primary} x1 (primary implementation lane); {quality} x1 (evidence + regression checks); {signoff} x1 (final architecture / completion sign-off)"
    );
    StaffingPlan {
        available_agent_types: available_agent_types.to_vec(),
        roster_summary: available_agent_types.join(", "),
        staffing_summary,
    }
}

fn choose_role<'a>(available: &'a [String], preferred: &[&str], fallback: &'a str) -> &'a str {
    preferred
        .iter()
        .find_map(|candidate| {
            available
                .iter()
                .find(|role| role.as_str() == *candidate)
                .map(String::as_str)
        })
        .unwrap_or(fallback)
}

fn write_ralph_state(
    scope_dir: &Path,
    task: &str,
    canonical_prd_path: Option<&str>,
    canonical_progress_path: &Path,
    staffing: &StaffingPlan,
) -> Result<(), RalphError> {
    let started_at = now_iso_string();
    let mut raw = String::new();
    raw.push_str("{\n");
    raw.push_str("  \"active\": true,\n");
    raw.push_str("  \"mode\": \"ralph\",\n");
    raw.push_str("  \"iteration\": 0,\n");
    raw.push_str("  \"max_iterations\": 50,\n");
    raw.push_str("  \"current_phase\": \"starting\",\n");
    let _ = writeln!(raw, "  \"task_description\": {},", json_string(task));
    let _ = writeln!(raw, "  \"started_at\": {},", json_string(&started_at));
    let _ = writeln!(
        raw,
        "  \"canonical_progress_path\": {},",
        json_string(&canonical_progress_path.display().to_string())
    );
    raw.push_str("  \"available_agent_types\": [");
    for (idx, role) in staffing.available_agent_types.iter().enumerate() {
        if idx > 0 {
            raw.push_str(", ");
        }
        raw.push_str(&json_string(role));
    }
    raw.push_str("],\n");
    let _ = writeln!(
        raw,
        "  \"staffing_summary\": {},",
        json_string(&staffing.staffing_summary)
    );
    if let Some(path) = canonical_prd_path {
        let _ = writeln!(raw, "  \"canonical_prd_path\": {},", json_string(path));
    }
    raw.push_str("  \"staffing_allocations\": []\n");
    raw.push_str("}\n");
    let state_path = scope_dir.join("ralph-state.json");
    fs::write(&state_path, raw).map_err(|error| {
        RalphError::runtime(format!("failed to write {}: {error}", state_path.display()))
    })
}

fn json_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn now_iso_string() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format_epoch_seconds_as_iso(now)
}

fn format_epoch_seconds_as_iso(epoch_seconds: u64) -> String {
    let days = i64::try_from(epoch_seconds / 86_400).expect("days since epoch fit in i64");
    let secs_of_day = epoch_seconds % 86_400;
    let hour = secs_of_day / 3_600;
    let minute = (secs_of_day % 3_600) / 60;
    let second = secs_of_day % 60;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.000Z")
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    y += i64::from(m <= 2);
    (
        i32::try_from(y).expect("civil year fits in i32"),
        u32::try_from(m).expect("civil month fits in u32"),
        u32::try_from(d).expect("civil day fits in u32"),
    )
}

trait StringExt {
    fn if_empty(self, fallback: &str) -> String;
}

impl StringExt for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        RALPH_HELP, extract_ralph_task_description, filter_ralph_codex_args,
        normalize_ralph_cli_args, run_ralph,
    };
    use std::fs;

    #[test]
    fn extracts_plain_task_text() {
        assert_eq!(
            extract_ralph_task_description(&["fix".into(), "the".into(), "bug".into()]),
            "fix the bug"
        );
    }

    #[test]
    fn extracts_default_task_text_when_empty() {
        assert_eq!(extract_ralph_task_description(&[]), "ralph-cli-launch");
    }

    #[test]
    fn excludes_model_value_from_task_text() {
        assert_eq!(
            extract_ralph_task_description(&[
                "--model".into(),
                "gpt-5".into(),
                "fix".into(),
                "the".into(),
                "bug".into(),
            ]),
            "fix the bug"
        );
    }

    #[test]
    fn supports_separator_in_task_text() {
        assert_eq!(
            extract_ralph_task_description(&[
                "--model".into(),
                "gpt-5".into(),
                "--".into(),
                "fix".into(),
                "--weird-name".into(),
            ]),
            "fix --weird-name"
        );
    }

    #[test]
    fn normalizes_prd_flag_to_positional_text() {
        assert_eq!(
            normalize_ralph_cli_args(&["--prd".into(), "ship release checklist".into()]),
            vec!["ship release checklist".to_string()]
        );
    }

    #[test]
    fn normalizes_inline_prd_flag() {
        assert_eq!(
            normalize_ralph_cli_args(&["--prd=fix the bug".into()]),
            vec!["fix the bug".to_string()]
        );
    }

    #[test]
    fn preserves_other_flags_during_normalization() {
        assert_eq!(
            normalize_ralph_cli_args(&[
                "--model".into(),
                "gpt-5".into(),
                "--prd".into(),
                "fix it".into(),
            ]),
            vec![
                "--model".to_string(),
                "gpt-5".to_string(),
                "fix it".to_string()
            ]
        );
    }

    #[test]
    fn filters_prd_flag_from_codex_args() {
        assert_eq!(
            filter_ralph_codex_args(
                &["--prd".into(), "build".into(), "todo".into(), "app".into(),]
            ),
            vec!["build".to_string(), "todo".to_string(), "app".to_string()]
        );
    }

    #[test]
    fn filters_prd_flag_case_insensitively() {
        assert_eq!(
            filter_ralph_codex_args(&["--PRD".into(), "--model".into(), "gpt-5".into()]),
            vec!["--model".to_string(), "gpt-5".to_string()]
        );
    }

    #[test]
    fn preserves_non_omx_flags_when_filtering() {
        assert_eq!(
            filter_ralph_codex_args(&[
                "--model".into(),
                "gpt-5".into(),
                "--yolo".into(),
                "fix".into(),
                "it".into(),
            ]),
            vec![
                "--model".to_string(),
                "gpt-5".to_string(),
                "--yolo".to_string(),
                "fix".to_string(),
                "it".to_string()
            ]
        );
    }

    #[test]
    fn prints_ralph_help() {
        let cwd = std::env::temp_dir();
        let result = run_ralph(&["--help".into()], &cwd).expect("ralph help");
        assert_eq!(String::from_utf8(result.stdout).expect("utf8"), RALPH_HELP);
        assert!(result.stderr.is_empty());
        assert_eq!(result.exit_code, 0);
    }

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("omx-ralph-{label}-{nanos}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn runs_non_help_ralph_and_writes_state() {
        let cwd = temp_dir("run");
        let prompts_dir = cwd.join(".codex/prompts");
        fs::create_dir_all(&prompts_dir).expect("create prompts dir");
        fs::write(prompts_dir.join("executor.md"), "# executor\n").expect("write prompt");

        let result = run_ralph(&["--prd".into(), "ship release".into()], &cwd).expect("run ralph");
        let stdout = String::from_utf8(result.stdout).expect("utf8");
        assert!(stdout.contains("[ralph] Ralph persistence mode active. Launching Codex..."));
        assert!(stdout.contains("[ralph] available_agent_types: executor"));
        assert_eq!(result.exit_code, 0);

        let state =
            fs::read_to_string(cwd.join(".omx/state/ralph-state.json")).expect("read state");
        assert!(state.contains("\"active\": true"));
        assert!(state.contains("\"mode\": \"ralph\""));
        assert!(state.contains("\"task_description\": \"ship release\""));

        let progress =
            fs::read_to_string(cwd.join(".omx/state/ralph-progress.json")).expect("read progress");
        assert!(progress.contains("\"schema_version\": 2"));
    }

    #[test]
    fn migrates_legacy_prd_and_progress() {
        let cwd = temp_dir("migrate");
        fs::create_dir_all(cwd.join(".omx")).expect("create .omx");
        fs::write(
            cwd.join(".omx/prd.json"),
            "{ \"title\": \"Ship Release Checklist\" }\n",
        )
        .expect("write prd");
        fs::write(cwd.join(".omx/progress.txt"), "first\nsecond\n").expect("write progress");

        let result = run_ralph(&["ship".into(), "it".into()], &cwd).expect("run ralph");
        let stdout = String::from_utf8(result.stdout).expect("utf8");
        assert!(stdout.contains("[ralph] Migrated legacy PRD ->"));
        assert!(stdout.contains("[ralph] Migrated legacy progress ->"));

        let plans = fs::read_dir(cwd.join(".omx/plans"))
            .expect("read plans")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert!(
            plans
                .iter()
                .any(|name| name.starts_with("prd-ship-release-checklist"))
        );

        let progress =
            fs::read_to_string(cwd.join(".omx/state/ralph-progress.json")).expect("read progress");
        assert!(progress.contains("\"source\": \".omx/progress.txt\""));
        assert!(progress.contains("\"text\": \"first\""));
    }
}
