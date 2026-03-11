use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::process_bridge::Platform;

const WINDOWS_DEFAULT_PATHEXT: &[&str] = &[".com", ".exe", ".bat", ".cmd", ".ps1"];
const WINDOWS_EXTENSION_PRIORITY: &[&str] = &[".exe", ".com", ".ps1", ".cmd", ".bat"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpawnErrorKind {
    Missing,
    Blocked,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowsCommandKind {
    Direct,
    Cmd,
    PowerShell,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformCommandSpec {
    pub command: OsString,
    pub args: Vec<OsString>,
    pub resolved_path: Option<PathBuf>,
}

pub fn classify_spawn_error(error: &io::Error) -> SpawnErrorKind {
    match error.kind() {
        io::ErrorKind::NotFound => SpawnErrorKind::Missing,
        io::ErrorKind::PermissionDenied => SpawnErrorKind::Blocked,
        _ => SpawnErrorKind::Error,
    }
}

pub fn resolve_command_path_for_platform(
    command: impl AsRef<OsStr>,
    platform: Platform,
    env: &BTreeMap<OsString, OsString>,
) -> Option<PathBuf> {
    if platform != Platform::Windows {
        return Some(PathBuf::from(command.as_ref()));
    }

    resolve_windows_command_path(command.as_ref(), env, &|candidate| {
        fs::metadata(candidate).is_ok()
    })
}

pub fn build_platform_command_spec(
    command: impl AsRef<OsStr>,
    args: &[OsString],
    platform: Platform,
    env: &BTreeMap<OsString, OsString>,
) -> PlatformCommandSpec {
    build_platform_command_spec_with_exists(command.as_ref(), args, platform, env, &|candidate| {
        fs::metadata(candidate).is_ok()
    })
}

pub(crate) fn build_platform_command_spec_with_exists(
    command: &OsStr,
    args: &[OsString],
    platform: Platform,
    env: &BTreeMap<OsString, OsString>,
    exists: &dyn Fn(&Path) -> bool,
) -> PlatformCommandSpec {
    if platform != Platform::Windows {
        return PlatformCommandSpec {
            command: command.to_os_string(),
            args: args.to_vec(),
            resolved_path: None,
        };
    }

    let Some(resolved_path) = resolve_windows_command_path(command, env, exists) else {
        return PlatformCommandSpec {
            command: command.to_os_string(),
            args: args.to_vec(),
            resolved_path: None,
        };
    };

    match classify_windows_command_path(&resolved_path) {
        WindowsCommandKind::Direct => PlatformCommandSpec {
            command: resolved_path.clone().into_os_string(),
            args: args.to_vec(),
            resolved_path: Some(resolved_path),
        },
        WindowsCommandKind::Cmd => build_cmd_launch(&resolved_path, args, env),
        WindowsCommandKind::PowerShell => PlatformCommandSpec {
            command: resolve_powershell_executable(env, exists).into_os_string(),
            args: [
                OsString::from("-NoLogo"),
                OsString::from("-NoProfile"),
                OsString::from("-ExecutionPolicy"),
                OsString::from("Bypass"),
                OsString::from("-File"),
                resolved_path.clone().into_os_string(),
            ]
            .into_iter()
            .chain(args.iter().cloned())
            .collect(),
            resolved_path: Some(resolved_path),
        },
    }
}

pub(crate) fn resolve_windows_command_path(
    command: &OsStr,
    env: &BTreeMap<OsString, OsString>,
    exists: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let command_path = PathBuf::from(command);
    let extension = command_path
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy().to_ascii_lowercase()))
        .unwrap_or_default();
    let pathext = normalize_windows_pathext(env);
    let mut candidates = Vec::new();

    let mut add_candidates_for_base = |base: PathBuf| {
        if !extension.is_empty() {
            candidates.push(base);
            return;
        }

        for ext in &pathext {
            let mut as_string = base.as_os_str().to_os_string();
            as_string.push(ext);
            candidates.push(PathBuf::from(as_string));
        }
        candidates.push(base);
    };

    if is_windows_path_like(&command_path) {
        add_candidates_for_base(command_path);
    } else {
        for entry in split_windows_path_entries(env) {
            add_candidates_for_base(entry.join(&command_path));
        }
    }

    candidates.into_iter().find(|candidate| exists(candidate))
}

fn build_cmd_launch(
    command_path: &Path,
    args: &[OsString],
    env: &BTreeMap<OsString, OsString>,
) -> PlatformCommandSpec {
    let command_line = std::iter::once(command_path.as_os_str())
        .chain(args.iter().map(OsString::as_os_str))
        .map(quote_for_cmd)
        .collect::<Vec<_>>()
        .join(" ");

    PlatformCommandSpec {
        command: get_env_case_insensitive(env, "ComSpec")
            .unwrap_or_else(|| OsString::from("cmd.exe")),
        args: vec![
            OsString::from("/d"),
            OsString::from("/s"),
            OsString::from("/c"),
            OsString::from(command_line),
        ],
        resolved_path: Some(command_path.to_path_buf()),
    }
}

fn resolve_powershell_executable(
    env: &BTreeMap<OsString, OsString>,
    exists: &dyn Fn(&Path) -> bool,
) -> PathBuf {
    resolve_windows_command_path(OsStr::new("powershell"), env, exists)
        .unwrap_or_else(|| PathBuf::from("powershell.exe"))
}

fn quote_for_cmd(value: &OsStr) -> String {
    let rendered = value.to_string_lossy().replace('"', "\"\"");
    format!("\"{rendered}\"")
}

fn classify_windows_command_path(path: &Path) -> WindowsCommandKind {
    match lower_extension(path).as_deref() {
        Some(".cmd") | Some(".bat") => WindowsCommandKind::Cmd,
        Some(".ps1") => WindowsCommandKind::PowerShell,
        _ => WindowsCommandKind::Direct,
    }
}

fn normalize_windows_pathext(env: &BTreeMap<OsString, OsString>) -> Vec<String> {
    let raw = get_env_case_insensitive(env, "PATHEXT")
        .map(|value| value.to_string_lossy().trim().to_string())
        .unwrap_or_default();
    let entries: Vec<String> = if raw.is_empty() {
        WINDOWS_DEFAULT_PATHEXT
            .iter()
            .map(|value| (*value).to_string())
            .collect()
    } else {
        raw.split(';')
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .collect()
    };

    let mut ordered = Vec::new();
    for ext in WINDOWS_EXTENSION_PRIORITY
        .iter()
        .map(|value| (*value).to_string())
        .chain(entries)
    {
        if !ordered.contains(&ext) {
            ordered.push(ext);
        }
    }
    ordered
}

fn split_windows_path_entries(env: &BTreeMap<OsString, OsString>) -> Vec<PathBuf> {
    get_env_case_insensitive(env, "PATH")
        .map(|value| {
            value
                .to_string_lossy()
                .split(';')
                .filter(|entry| !entry.trim().is_empty())
                .map(|entry| PathBuf::from(entry.trim()))
                .collect()
        })
        .unwrap_or_default()
}

fn get_env_case_insensitive(env: &BTreeMap<OsString, OsString>, key: &str) -> Option<OsString> {
    env.iter()
        .find(|(candidate, _)| candidate.to_string_lossy().eq_ignore_ascii_case(key))
        .map(|(_, value)| value.clone())
}

fn is_windows_path_like(path: &Path) -> bool {
    let rendered = path.to_string_lossy();
    (rendered.len() >= 2 && rendered.as_bytes()[1] == b':')
        || rendered.contains('\\')
        || rendered.contains('/')
}

fn lower_extension(path: &Path) -> Option<String> {
    path.extension()
        .map(|value| format!(".{}", value.to_string_lossy().to_ascii_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs::File;
    use std::io;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tempdir(prefix: &str) -> io::Result<PathBuf> {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let path = env::temp_dir().join(format!("{prefix}-{unique}"));
        fs::create_dir_all(&path)?;
        Ok(path)
    }

    fn touch(path: &Path) -> io::Result<()> {
        File::create(path).map(|_| ())
    }

    #[test]
    fn wraps_cmd_shims_through_comspec_on_windows() -> io::Result<()> {
        let fake_bin = tempdir("omx-platform-cmd")?;
        let cmd_path = fake_bin.join("codex.cmd");
        touch(&cmd_path)?;
        let env = BTreeMap::from([
            (OsString::from("PATH"), fake_bin.as_os_str().to_os_string()),
            (OsString::from("PATHEXT"), OsString::from(".EXE;.CMD;.PS1")),
            (
                OsString::from("ComSpec"),
                OsString::from("C:\\Windows\\System32\\cmd.exe"),
            ),
        ]);

        let spec = build_platform_command_spec_with_exists(
            OsStr::new("codex"),
            &[OsString::from("--version")],
            Platform::Windows,
            &env,
            &|candidate| candidate == cmd_path,
        );

        assert_eq!(
            spec.command,
            OsString::from("C:\\Windows\\System32\\cmd.exe")
        );
        assert_eq!(
            &spec.args[..3],
            [
                OsString::from("/d"),
                OsString::from("/s"),
                OsString::from("/c")
            ]
        );
        assert!(spec.args[3].to_string_lossy().contains("codex.cmd"));
        assert!(spec.args[3].to_string_lossy().contains("--version"));
        assert_eq!(spec.resolved_path, Some(cmd_path));
        Ok(())
    }

    #[test]
    fn launches_exe_binaries_directly_on_windows() -> io::Result<()> {
        let fake_bin = tempdir("omx-platform-exe")?;
        let exe_path = fake_bin.join("tmux.exe");
        touch(&exe_path)?;
        let env = BTreeMap::from([
            (OsString::from("PATH"), fake_bin.as_os_str().to_os_string()),
            (OsString::from("PATHEXT"), OsString::from(".EXE;.CMD;.PS1")),
        ]);

        let spec = build_platform_command_spec_with_exists(
            OsStr::new("tmux"),
            &[OsString::from("-V")],
            Platform::Windows,
            &env,
            &|candidate| candidate == exe_path,
        );

        assert_eq!(spec.command, exe_path.clone().into_os_string());
        assert_eq!(spec.args, vec![OsString::from("-V")]);
        assert_eq!(spec.resolved_path, Some(exe_path));
        Ok(())
    }

    #[test]
    fn prefers_powershell_shims_over_cmd_shims_when_both_exist() -> io::Result<()> {
        let fake_bin = tempdir("omx-platform-ps1")?;
        let ps1_path = fake_bin.join("codex.ps1");
        let cmd_path = fake_bin.join("codex.cmd");
        touch(&ps1_path)?;
        touch(&cmd_path)?;
        let env = BTreeMap::from([
            (OsString::from("PATH"), fake_bin.as_os_str().to_os_string()),
            (OsString::from("PATHEXT"), OsString::from(".EXE;.CMD;.PS1")),
        ]);

        let spec = build_platform_command_spec_with_exists(
            OsStr::new("codex"),
            &[OsString::from("--version")],
            Platform::Windows,
            &env,
            &|candidate| candidate == ps1_path || candidate == cmd_path,
        );

        assert!(spec.command.to_string_lossy().ends_with("powershell.exe"));
        assert_eq!(
            &spec.args[..5],
            [
                OsString::from("-NoLogo"),
                OsString::from("-NoProfile"),
                OsString::from("-ExecutionPolicy"),
                OsString::from("Bypass"),
                OsString::from("-File"),
            ]
        );
        assert_eq!(spec.args[5], ps1_path.clone().into_os_string());
        Ok(())
    }

    #[test]
    fn prefers_pathext_candidates_on_windows() -> io::Result<()> {
        let fake_bin = tempdir("omx-platform-path")?;
        let exe_path = fake_bin.join("tmux.exe");
        touch(&exe_path)?;
        let env = BTreeMap::from([
            (OsString::from("Path"), fake_bin.as_os_str().to_os_string()),
            (OsString::from("PATHEXT"), OsString::from(".EXE;.CMD")),
        ]);

        let resolved = resolve_windows_command_path(OsStr::new("tmux"), &env, &|candidate| {
            candidate == exe_path
        });

        assert_eq!(resolved, Some(exe_path));
        Ok(())
    }

    #[test]
    fn classifies_spawn_errors() {
        assert_eq!(
            classify_spawn_error(&io::Error::from(io::ErrorKind::NotFound)),
            SpawnErrorKind::Missing
        );
        assert_eq!(
            classify_spawn_error(&io::Error::from(io::ErrorKind::PermissionDenied)),
            SpawnErrorKind::Blocked
        );
        assert_eq!(
            classify_spawn_error(&io::Error::other("boom")),
            SpawnErrorKind::Error
        );
    }
}
