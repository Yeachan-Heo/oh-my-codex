use crate::session_state::{
    extract_json_bool_field, extract_json_string_field,
    list_mode_state_files_with_scope_preference, resolve_state_root, upsert_json_bool_field,
    upsert_json_string_field,
};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CancelExecution {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CancelError(String);

impl CancelError {
    fn runtime(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl std::fmt::Display for CancelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CancelError {}

struct ModeStateEntry {
    path: PathBuf,
    raw: String,
}

#[allow(clippy::missing_errors_doc)]
#[allow(clippy::too_many_lines)]
pub fn run_cancel(
    args: &[String],
    cwd: &Path,
    env: &BTreeMap<OsString, OsString>,
) -> Result<CancelExecution, CancelError> {
    if !args.is_empty() {
        return Err(CancelError::runtime(format!(
            "unsupported cancel arguments: {}",
            args.join(" ")
        )));
    }

    let state_root = resolve_state_root(cwd, env);
    let now_iso = now_iso_string();
    let (mut states, stderr) = read_mode_states(&state_root);

    let mut changed = BTreeSet::new();
    let mut reported = Vec::new();
    let had_active_ralph = is_active(states.get("ralph"));

    if is_active(states.get("team")) && json_bool(states.get("team"), "linked_ralph") {
        cancel_mode(
            &mut states,
            &mut changed,
            &mut reported,
            "team",
            &now_iso,
            true,
        );
        if json_bool(states.get("ralph"), "linked_team") {
            cancel_mode(
                &mut states,
                &mut changed,
                &mut reported,
                "ralph",
                &now_iso,
                true,
            );
            if let Some(ralph) = states.get_mut("ralph") {
                ralph.raw =
                    upsert_json_string_field(&ralph.raw, "linked_team_terminal_phase", "cancelled");
                ralph.raw =
                    upsert_json_string_field(&ralph.raw, "linked_team_terminal_at", &now_iso);
                changed.insert("ralph".to_string());
            }
            if ralph_links_ultrawork(states.get("ralph")) {
                cancel_mode(
                    &mut states,
                    &mut changed,
                    &mut reported,
                    "ultrawork",
                    &now_iso,
                    true,
                );
            }
        }
    }

    if is_active(states.get("ralph")) {
        cancel_mode(
            &mut states,
            &mut changed,
            &mut reported,
            "ralph",
            &now_iso,
            true,
        );
        if ralph_links_ultrawork(states.get("ralph")) {
            cancel_mode(
                &mut states,
                &mut changed,
                &mut reported,
                "ultrawork",
                &now_iso,
                true,
            );
        }
    }

    if !had_active_ralph {
        let active_modes = states
            .iter()
            .filter_map(|(mode, entry)| is_active(Some(entry)).then_some(mode.clone()))
            .collect::<Vec<_>>();
        for mode in active_modes {
            cancel_mode(
                &mut states,
                &mut changed,
                &mut reported,
                &mode,
                &now_iso,
                true,
            );
        }
    }

    for mode in &changed {
        let Some(entry) = states.get(mode) else {
            continue;
        };
        fs::write(&entry.path, &entry.raw).map_err(|error| {
            CancelError::runtime(format!("failed to write {}: {error}", entry.path.display()))
        })?;
    }

    let mut stdout = String::new();
    if reported.is_empty() {
        stdout.push_str("No active modes to cancel.\n");
    } else {
        for mode in reported {
            let _ = writeln!(stdout, "Cancelled: {mode}");
        }
    }

    Ok(CancelExecution {
        stdout: stdout.into_bytes(),
        stderr: stderr.into_bytes(),
        exit_code: 0,
    })
}

fn read_mode_states(state_root: &Path) -> (BTreeMap<String, ModeStateEntry>, String) {
    let mut stderr = String::new();
    let mut states = BTreeMap::new();
    for entry in list_mode_state_files_with_scope_preference(state_root) {
        match fs::read_to_string(&entry.path) {
            Ok(raw) => {
                states.insert(
                    entry.mode,
                    ModeStateEntry {
                        path: entry.path,
                        raw,
                    },
                );
            }
            Err(error) => {
                let _ = writeln!(
                    stderr,
                    "[cli/index] operation failed: failed to read {}: {error}",
                    entry.path.display()
                );
            }
        }
    }
    (states, stderr)
}

fn cancel_mode(
    states: &mut BTreeMap<String, ModeStateEntry>,
    changed: &mut BTreeSet<String>,
    reported: &mut Vec<String>,
    mode: &str,
    now_iso: &str,
    report_if_was_active: bool,
) {
    let Some(entry) = states.get_mut(mode) else {
        return;
    };
    let was_active = extract_json_bool_field(&entry.raw, "active") == Some(true);
    let needs_change = extract_json_bool_field(&entry.raw, "active") != Some(false)
        || extract_json_string_field(&entry.raw, "current_phase").as_deref() != Some("cancelled")
        || extract_json_string_field(&entry.raw, "completed_at")
            .unwrap_or_default()
            .trim()
            .is_empty();
    if !needs_change {
        return;
    }

    entry.raw = upsert_json_bool_field(&entry.raw, "active", false);
    entry.raw = upsert_json_string_field(&entry.raw, "current_phase", "cancelled");
    entry.raw = upsert_json_string_field(&entry.raw, "completed_at", now_iso);
    entry.raw = upsert_json_string_field(&entry.raw, "last_turn_at", now_iso);
    changed.insert(mode.to_string());
    if report_if_was_active && was_active && !reported.iter().any(|seen| seen == mode) {
        reported.push(mode.to_string());
    }
}

fn json_bool(entry: Option<&ModeStateEntry>, key: &str) -> bool {
    entry.and_then(|entry| extract_json_bool_field(&entry.raw, key)) == Some(true)
}

fn is_active(entry: Option<&ModeStateEntry>) -> bool {
    entry.and_then(|entry| extract_json_bool_field(&entry.raw, "active")) == Some(true)
}

fn ralph_links_ultrawork(entry: Option<&ModeStateEntry>) -> bool {
    json_bool(entry, "linked_ultrawork")
        || entry
            .and_then(|entry| extract_json_string_field(&entry.raw, "linked_mode"))
            .as_deref()
            == Some("ultrawork")
}

fn now_iso_string() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format_epoch_seconds_as_iso(now)
}

fn format_epoch_seconds_as_iso(epoch_seconds: u64) -> String {
    let days = epoch_seconds / 86_400;
    let secs_of_day = epoch_seconds % 86_400;
    let hour = secs_of_day / 3_600;
    let minute = (secs_of_day % 3_600) / 60;
    let second = secs_of_day % 60;
    let days = i64::try_from(days).expect("days since epoch fit in i64");
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
