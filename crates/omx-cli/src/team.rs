use crate::session_state::extract_json_string_field;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt::Write as _;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamExecution {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamError(String);

impl TeamError {
    fn runtime(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl std::fmt::Display for TeamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for TeamError {}

const TEAM_HELP: &str = concat!(
    "Usage: omx team [ralph] [N:agent-type] \"<task description>\"\n",
    "       omx team status <team-name>\n",
    "       omx team await <team-name> [--timeout-ms <ms>] [--after-event-id <id>] [--json]\n",
    "       omx team resume <team-name>\n",
    "       omx team shutdown <team-name> [--force] [--ralph]\n",
    "       omx team api <operation> [--input <json>] [--json]\n",
    "       omx team api --help\n",
    "\n",
    "Examples:\n",
    "  omx team 3:executor \"fix failing tests\"\n",
    "  omx team status my-team\n",
    "  omx team api send-message --input '{\"team_name\":\"my-team\",\"from_worker\":\"worker-1\",\"to_worker\":\"leader-fixed\",\"body\":\"ACK\"}' --json\n",
);

const TEAM_API_HELP: &str = concat!(
    "Usage: omx team api <operation> [--input <json>] [--json]\n",
    "       omx team api <operation> --help\n",
    "\n",
    "Supported operations:\n",
    "  send-message\n",
    "  broadcast\n",
    "  mailbox-list\n",
    "  mailbox-mark-delivered\n",
    "  mailbox-mark-notified\n",
    "  create-task\n",
    "  read-task\n",
    "  list-tasks\n",
    "  update-task\n",
    "  claim-task\n",
    "  transition-task-status\n",
    "  release-task-claim\n",
    "  read-config\n",
    "  read-manifest\n",
    "  read-worker-status\n",
    "  read-worker-heartbeat\n",
    "  update-worker-heartbeat\n",
    "  write-worker-inbox\n",
    "  write-worker-identity\n",
    "  append-event\n",
    "  read-events\n",
    "  await-event\n",
    "  get-summary\n",
    "  cleanup\n",
    "  write-shutdown-request\n",
    "  read-shutdown-ack\n",
    "  read-monitor-snapshot\n",
    "  write-monitor-snapshot\n",
    "  read-task-approval\n",
    "  write-task-approval\n",
    "\n",
    "Examples:\n",
    "  omx team api list-tasks --input '{\"team_name\":\"my-team\"}' --json\n",
    "  omx team api claim-task --input '{\"team_name\":\"my-team\",\"task_id\":\"1\",\"worker\":\"worker-1\",\"expected_version\":1}' --json\n",
);

#[allow(clippy::missing_errors_doc)]
pub fn run_team(
    args: &[String],
    cwd: &Path,
    _env: &BTreeMap<OsString, OsString>,
) -> Result<TeamExecution, TeamError> {
    if args.is_empty() || matches!(args[0].as_str(), "--help" | "-h" | "help") {
        return Ok(stdout_only(TEAM_HELP));
    }

    if args[0] == "api" {
        if args.len() == 1 || matches!(args[1].as_str(), "--help" | "-h" | "help") {
            return Ok(stdout_only(TEAM_API_HELP));
        }
        return Err(TeamError::runtime(format!(
            "Command \"team api {}\" is recognized but not yet implemented in the native Rust CLI.",
            args[1]
        )));
    }

    if args[0] == "status" {
        let Some(team_name) = args.get(1) else {
            return Err(TeamError::runtime("Usage: omx team status <team-name>"));
        };
        return run_team_status(team_name, cwd);
    }

    Err(TeamError::runtime(format!(
        "Command \"team {}\" is recognized but not yet implemented in the native Rust CLI.",
        args.join(" ")
    )))
}

fn stdout_only(text: &str) -> TeamExecution {
    TeamExecution {
        stdout: text.as_bytes().to_vec(),
        stderr: Vec::new(),
        exit_code: 0,
    }
}

fn run_team_status(team_name: &str, cwd: &Path) -> Result<TeamExecution, TeamError> {
    let team_root = cwd.join(".omx").join("state").join("team").join(team_name);
    if !team_root.exists() {
        return Ok(stdout_only(&format!(
            "No team state found for {team_name}\n"
        )));
    }

    let manifest_path = team_root.join("manifest.v2.json");
    let config_path = team_root.join("config.json");
    let manifest_raw = fs::read_to_string(&manifest_path)
        .or_else(|_| fs::read_to_string(&config_path))
        .map_err(|error| TeamError::runtime(format!("failed to read team config: {error}")))?;
    let snapshot_raw =
        fs::read_to_string(team_root.join("monitor-snapshot.json")).unwrap_or_default();
    let phase_raw = fs::read_to_string(team_root.join("phase.json")).unwrap_or_default();

    let resolved_team_name =
        extract_json_string_field(&manifest_raw, "name").unwrap_or_else(|| team_name.to_string());
    let phase = extract_json_string_field(&phase_raw, "current_phase")
        .unwrap_or_else(|| "unknown".to_string());
    let workers_total = count_worker_names(&manifest_raw);
    let dead_workers = count_false_entries(&snapshot_raw, "workerAliveByName");
    let non_reporting_workers = count_string_entries(&snapshot_raw, "workerStateByName", "unknown");
    let tasks = summarize_tasks(&team_root.join("tasks"))?;

    let mut stdout = String::new();
    let _ = writeln!(stdout, "team={resolved_team_name} phase={phase}");
    let _ = writeln!(
        stdout,
        "workers: total={workers_total} dead={dead_workers} non_reporting={non_reporting_workers}"
    );
    let _ = writeln!(
        stdout,
        "tasks: total={} pending={} blocked={} in_progress={} completed={} failed={}",
        tasks.total, tasks.pending, tasks.blocked, tasks.in_progress, tasks.completed, tasks.failed
    );

    Ok(stdout_only(&stdout))
}

#[derive(Default)]
struct TaskSummary {
    total: usize,
    pending: usize,
    blocked: usize,
    in_progress: usize,
    completed: usize,
    failed: usize,
}

fn summarize_tasks(tasks_dir: &Path) -> Result<TaskSummary, TeamError> {
    let mut summary = TaskSummary::default();
    let entries = match fs::read_dir(tasks_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(summary),
        Err(error) => {
            return Err(TeamError::runtime(format!(
                "failed to read {}: {error}",
                tasks_dir.display()
            )));
        }
    };

    for entry in entries {
        let entry = entry
            .map_err(|error| TeamError::runtime(format!("failed to enumerate tasks: {error}")))?;
        if !entry
            .file_type()
            .map(|kind| kind.is_file())
            .unwrap_or(false)
        {
            continue;
        }
        let raw = fs::read_to_string(entry.path()).map_err(|error| {
            TeamError::runtime(format!(
                "failed to read {}: {error}",
                entry.path().display()
            ))
        })?;
        summary.total += 1;
        match extract_json_string_field(&raw, "status").as_deref() {
            Some("pending") => summary.pending += 1,
            Some("blocked") => summary.blocked += 1,
            Some("in_progress") => summary.in_progress += 1,
            Some("completed") => summary.completed += 1,
            Some("failed") => summary.failed += 1,
            _ => {}
        }
    }

    Ok(summary)
}

fn count_worker_names(raw: &str) -> usize {
    raw.matches("\"name\": \"worker-").count()
}

fn count_false_entries(raw: &str, key: &str) -> usize {
    count_map_entries(raw, key, "false")
}

fn count_string_entries(raw: &str, key: &str, value: &str) -> usize {
    count_map_entries(raw, key, &format!("\"{value}\""))
}

fn count_map_entries(raw: &str, key: &str, expected_value: &str) -> usize {
    let Some(section) = extract_object_contents(raw, key) else {
        return 0;
    };
    section
        .lines()
        .filter(|line| line.contains(expected_value))
        .count()
}

fn extract_object_contents<'a>(raw: &'a str, key: &str) -> Option<&'a str> {
    let start = format!("\"{key}\": {{");
    let start_idx = raw.find(&start)? + start.len();
    let rest = raw.get(start_idx..)?;
    let mut depth = 1usize;
    for (idx, ch) in rest.char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return rest.get(..idx);
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{TEAM_API_HELP, TEAM_HELP, run_team};
    use std::collections::BTreeMap;
    use std::fs;

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("omx-team-{label}-{nanos}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn prints_team_help_for_help_variants() {
        for args in [vec![], vec!["--help".to_string()], vec!["help".to_string()]] {
            let result =
                run_team(&args, std::path::Path::new("."), &BTreeMap::new()).expect("team help");
            assert_eq!(String::from_utf8(result.stdout).expect("utf8"), TEAM_HELP);
            assert!(result.stderr.is_empty());
            assert_eq!(result.exit_code, 0);
        }
    }

    #[test]
    fn prints_team_api_help_for_help_variants() {
        for args in [
            vec!["api".to_string()],
            vec!["api".to_string(), "--help".to_string()],
            vec!["api".to_string(), "help".to_string()],
        ] {
            let result = run_team(&args, std::path::Path::new("."), &BTreeMap::new())
                .expect("team api help");
            assert_eq!(
                String::from_utf8(result.stdout).expect("utf8"),
                TEAM_API_HELP
            );
            assert!(result.stderr.is_empty());
            assert_eq!(result.exit_code, 0);
        }
    }

    #[test]
    fn prints_missing_team_message_when_status_state_is_absent() {
        let cwd = temp_dir("missing");
        let result = run_team(
            &["status".to_string(), "missing-team".to_string()],
            &cwd,
            &BTreeMap::new(),
        )
        .expect("team status");
        assert_eq!(
            String::from_utf8(result.stdout).expect("utf8"),
            "No team state found for missing-team\n"
        );
    }

    #[test]
    fn prints_team_status_summary_from_state_snapshots() {
        let cwd = temp_dir("status");
        let team_root = cwd.join(".omx/state/team/fixture-team");
        fs::create_dir_all(team_root.join("tasks")).expect("create task dir");
        fs::write(
            team_root.join("manifest.v2.json"),
            r#"{
  "name": "fixture-team",
  "workers": [
    { "name": "worker-1" },
    { "name": "worker-2" },
    { "name": "worker-3" }
  ]
}
"#,
        )
        .expect("write manifest");
        fs::write(
            team_root.join("phase.json"),
            r#"{
  "current_phase": "team-exec"
}
"#,
        )
        .expect("write phase");
        fs::write(
            team_root.join("monitor-snapshot.json"),
            r#"{
  "workerAliveByName": {
    "worker-1": true,
    "worker-2": false,
    "worker-3": true
  },
  "workerStateByName": {
    "worker-1": "idle",
    "worker-2": "unknown",
    "worker-3": "working"
  }
}
"#,
        )
        .expect("write snapshot");
        fs::write(
            team_root.join("tasks/task-1.json"),
            "{\"status\":\"pending\"}\n",
        )
        .expect("task 1");
        fs::write(
            team_root.join("tasks/task-2.json"),
            "{\"status\":\"in_progress\"}\n",
        )
        .expect("task 2");
        fs::write(
            team_root.join("tasks/task-3.json"),
            "{\"status\":\"completed\"}\n",
        )
        .expect("task 3");
        fs::write(
            team_root.join("tasks/task-4.json"),
            "{\"status\":\"failed\"}\n",
        )
        .expect("task 4");

        let result = run_team(
            &["status".to_string(), "fixture-team".to_string()],
            &cwd,
            &BTreeMap::new(),
        )
        .expect("team status");
        assert_eq!(
            String::from_utf8(result.stdout).expect("utf8"),
            concat!(
                "team=fixture-team phase=team-exec\n",
                "workers: total=3 dead=1 non_reporting=1\n",
                "tasks: total=4 pending=1 blocked=0 in_progress=1 completed=1 failed=1\n",
            )
        );
    }
}
