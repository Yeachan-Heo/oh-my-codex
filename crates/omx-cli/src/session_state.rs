use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StateFileScope {
    Root,
    Session,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModeStateFileRef {
    pub mode: String,
    pub path: PathBuf,
    pub scope: StateFileScope,
}

const STATE_FILE_SUFFIX: &str = "-state.json";

#[must_use]
pub fn resolve_state_root(cwd: &Path, _env: &BTreeMap<OsString, OsString>) -> PathBuf {
    cwd.join(".omx").join("state")
}

#[must_use]
pub fn read_current_session_id(state_root: &Path) -> Option<String> {
    let raw = fs::read_to_string(state_root.join("session.json")).ok()?;
    let value = extract_json_string_field(&raw, "session_id")?;
    is_valid_session_id(&value).then_some(value)
}

#[must_use]
pub fn list_mode_state_files_with_scope_preference(state_root: &Path) -> Vec<ModeStateFileRef> {
    let mut preferred = BTreeMap::new();

    for dir in read_scoped_state_dirs(state_root).iter().rev() {
        let scope = if dir == state_root {
            StateFileScope::Root
        } else {
            StateFileScope::Session
        };
        for entry in list_mode_state_files_in_dir(dir, scope) {
            preferred.insert(entry.mode.clone(), entry);
        }
    }

    preferred.into_values().collect()
}

fn read_scoped_state_dirs(state_root: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(session_id) = read_current_session_id(state_root) {
        dirs.push(state_root.join("sessions").join(session_id));
    }
    dirs.push(state_root.to_path_buf());
    dirs
}

fn list_mode_state_files_in_dir(dir: &Path, scope: StateFileScope) -> Vec<ModeStateFileRef> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut files = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            if !file_type.is_file() {
                return None;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !is_mode_state_filename(&name) {
                return None;
            }
            Some(ModeStateFileRef {
                mode: name.trim_end_matches(STATE_FILE_SUFFIX).to_string(),
                path: entry.path(),
                scope,
            })
        })
        .collect::<Vec<_>>();

    files.sort_by(|a, b| a.mode.cmp(&b.mode));
    files
}

fn is_mode_state_filename(name: &str) -> bool {
    name.ends_with(STATE_FILE_SUFFIX) && name != "session.json"
}

#[must_use]
pub fn extract_json_string_field(raw: &str, key: &str) -> Option<String> {
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

#[must_use]
pub fn extract_json_bool_field(raw: &str, key: &str) -> Option<bool> {
    let key = format!("\"{key}\"");
    let key_start = raw.find(&key)? + key.len();
    let after_key = raw.get(key_start..)?;
    let colon_idx = after_key.find(':')?;
    let after_colon = after_key.get(colon_idx + 1..)?.trim_start();
    if after_colon.starts_with("true") {
        Some(true)
    } else if after_colon.starts_with("false") {
        Some(false)
    } else {
        None
    }
}

#[must_use]
pub fn upsert_json_string_field(raw: &str, key: &str, value: &str) -> String {
    upsert_json_field(raw, key, &format!("\"{}\"", escape_json_string(value)))
}

#[must_use]
pub fn upsert_json_bool_field(raw: &str, key: &str, value: bool) -> String {
    upsert_json_field(raw, key, if value { "true" } else { "false" })
}

fn upsert_json_field(raw: &str, key: &str, rendered_value: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "{}" {
        return format!("{{\n  \"{key}\": {rendered_value}\n}}\n");
    }

    if let Some((value_start, value_end)) = find_json_value_range(trimmed, key) {
        let mut updated = String::with_capacity(trimmed.len() + rendered_value.len());
        updated.push_str(&trimmed[..value_start]);
        updated.push_str(rendered_value);
        updated.push_str(&trimmed[value_end..]);
        updated.push('\n');
        return updated;
    }

    if let Some(insert_idx) = trimmed.rfind('}') {
        let prefix = &trimmed[..insert_idx].trim_end();
        let needs_comma = !prefix.ends_with('{');
        let separator = if needs_comma { ",\n" } else { "\n" };
        return format!("{prefix}{separator}  \"{key}\": {rendered_value}\n}}\n");
    }

    format!("{{\n  \"{key}\": {rendered_value}\n}}\n")
}

fn find_json_value_range(raw: &str, key: &str) -> Option<(usize, usize)> {
    let key = format!("\"{key}\"");
    let key_start = raw.find(&key)? + key.len();
    let after_key = raw.get(key_start..)?;
    let colon_idx = after_key.find(':')?;
    let value_start = key_start + colon_idx + 1;
    let mut idx = value_start;
    while raw.as_bytes().get(idx).is_some_and(u8::is_ascii_whitespace) {
        idx += 1;
    }

    let bytes = raw.as_bytes();
    match bytes.get(idx)? {
        b'"' => {
            idx += 1;
            let mut escaped = false;
            while let Some(byte) = bytes.get(idx) {
                if escaped {
                    escaped = false;
                } else if *byte == b'\\' {
                    escaped = true;
                } else if *byte == b'"' {
                    return Some((value_start, idx + 1));
                }
                idx += 1;
            }
            None
        }
        b't' | b'f' => {
            let end = raw[idx..]
                .find([',', '}', '\n', '\r'])
                .map_or(raw.len(), |offset| idx + offset);
            Some((value_start, end))
        }
        _ => None,
    }
}

fn escape_json_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn is_valid_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
}

#[cfg(test)]
mod tests {
    use super::{
        StateFileScope, extract_json_bool_field, extract_json_string_field,
        list_mode_state_files_with_scope_preference, read_current_session_id, resolve_state_root,
        upsert_json_bool_field, upsert_json_string_field,
    };
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::Path;

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("omx-session-state-{label}-{nanos}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn resolves_workspace_state_root() {
        let cwd = Path::new("/tmp/demo");
        assert_eq!(
            resolve_state_root(cwd, &BTreeMap::new()),
            cwd.join(".omx/state")
        );
    }

    #[test]
    fn reads_current_session_id_from_state_root() {
        let cwd = temp_dir("session-id");
        let state_root = cwd.join(".omx/state");
        fs::create_dir_all(&state_root).expect("create state root");
        fs::write(
            state_root.join("session.json"),
            "{\"session_id\":\"sess1\"}",
        )
        .expect("write session");

        assert_eq!(
            read_current_session_id(&state_root).as_deref(),
            Some("sess1")
        );
    }

    #[test]
    fn prefers_session_scoped_state_files_over_root_files() {
        let cwd = temp_dir("prefer-session");
        let state_root = cwd.join(".omx/state");
        let session_dir = state_root.join("sessions/sess1");
        fs::create_dir_all(&session_dir).expect("create session dir");
        fs::write(
            state_root.join("session.json"),
            "{\"session_id\":\"sess1\"}",
        )
        .expect("write session");
        fs::write(state_root.join("team-state.json"), "{\"active\":false}")
            .expect("write root state");
        fs::write(session_dir.join("team-state.json"), "{\"active\":true}")
            .expect("write session state");
        fs::write(state_root.join("ralph-state.json"), "{\"active\":true}")
            .expect("write root-only state");

        let refs = list_mode_state_files_with_scope_preference(&state_root);
        assert_eq!(refs.len(), 2);
        assert_eq!(refs[0].mode, "ralph");
        assert_eq!(refs[0].scope, StateFileScope::Root);
        assert_eq!(refs[1].mode, "team");
        assert_eq!(refs[1].scope, StateFileScope::Session);
    }

    #[test]
    fn extracts_json_fields() {
        let raw = r#"{"active": true, "current_phase": "exec"}"#;
        assert_eq!(extract_json_bool_field(raw, "active"), Some(true));
        assert_eq!(
            extract_json_string_field(raw, "current_phase").as_deref(),
            Some("exec")
        );
    }

    #[test]
    fn upserts_json_fields() {
        let raw = "{\n  \"active\": true\n}\n";
        let updated = upsert_json_bool_field(raw, "active", false);
        let updated = upsert_json_string_field(&updated, "current_phase", "cancelled");
        assert_eq!(extract_json_bool_field(&updated, "active"), Some(false));
        assert_eq!(
            extract_json_string_field(&updated, "current_phase").as_deref(),
            Some("cancelled")
        );
    }
}
