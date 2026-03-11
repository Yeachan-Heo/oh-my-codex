use crate::session_state::{
    extract_json_bool_field, extract_json_string_field,
    list_mode_state_files_with_scope_preference, resolve_state_root,
};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt::Write as _;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusExecution {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusError(String);

impl StatusError {
    fn runtime(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl std::fmt::Display for StatusError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for StatusError {}

#[allow(clippy::missing_errors_doc)]
pub fn run_status(
    args: &[String],
    cwd: &Path,
    env: &BTreeMap<OsString, OsString>,
) -> Result<StatusExecution, StatusError> {
    if !args.is_empty() {
        return Err(StatusError::runtime(format!(
            "unsupported status arguments: {}",
            args.join(" ")
        )));
    }

    let state_root = resolve_state_root(cwd, env);
    let refs = list_mode_state_files_with_scope_preference(&state_root);
    if refs.is_empty() {
        return Ok(StatusExecution {
            stdout: b"No active modes.\n".to_vec(),
            stderr: Vec::new(),
            exit_code: 0,
        });
    }

    let mut stdout = String::new();
    let mut stderr = String::new();
    for entry in refs {
        match fs::read_to_string(&entry.path) {
            Ok(raw) => {
                let active = extract_json_bool_field(&raw, "active") == Some(true);
                let phase = extract_json_string_field(&raw, "current_phase")
                    .unwrap_or_else(|| "n/a".to_string());
                let state_label = if active { "ACTIVE" } else { "inactive" };
                let _ = writeln!(stdout, "{}: {state_label} (phase: {phase})", entry.mode);
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

    Ok(StatusExecution {
        stdout: stdout.into_bytes(),
        stderr: stderr.into_bytes(),
        exit_code: 0,
    })
}
