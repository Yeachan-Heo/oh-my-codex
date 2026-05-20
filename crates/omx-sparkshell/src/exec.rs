use crate::error::SparkshellError;
#[cfg(windows)]
use std::ffi::OsStr;
#[cfg(windows)]
use std::path::Path;
use std::process::{Command, ExitStatus, Output};

#[derive(Debug, Clone)]
pub struct CommandOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl CommandOutput {
    pub fn exit_code(&self) -> i32 {
        self.status.code().unwrap_or(1)
    }

    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    pub fn stderr_text(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}

pub fn resolve_shell_argv(script: &str) -> Vec<String> {
    resolve_shell_argv_for_platform(script, current_platform(), command_exists_on_path)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShellPlatform {
    Windows,
    Posix,
}

fn current_platform() -> ShellPlatform {
    if cfg!(windows) {
        ShellPlatform::Windows
    } else {
        ShellPlatform::Posix
    }
}

fn resolve_shell_argv_for_platform(
    script: &str,
    platform: ShellPlatform,
    exists: impl Fn(&str) -> bool,
) -> Vec<String> {
    match platform {
        ShellPlatform::Posix => vec!["bash".to_string(), "-lc".to_string(), script.to_string()],
        ShellPlatform::Windows => {
            if exists("pwsh") {
                return vec![
                    "pwsh".to_string(),
                    "-NoLogo".to_string(),
                    "-NoProfile".to_string(),
                    "-Command".to_string(),
                    script.to_string(),
                ];
            }
            if exists("powershell.exe") {
                return vec![
                    "powershell.exe".to_string(),
                    "-NoLogo".to_string(),
                    "-NoProfile".to_string(),
                    "-Command".to_string(),
                    script.to_string(),
                ];
            }
            vec![
                std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string()),
                "/d".to_string(),
                "/s".to_string(),
                "/c".to_string(),
                script.to_string(),
            ]
        }
    }
}

fn command_exists_on_path(command: &str) -> bool {
    if command.contains(std::path::MAIN_SEPARATOR)
        || command.contains('/')
        || command.contains('\\')
    {
        return std::path::Path::new(command).is_file();
    }
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| {
        let candidate = dir.join(command);
        candidate.is_file()
            || if cfg!(windows) && std::path::Path::new(command).extension().is_none() {
                ["exe", "cmd", "bat", "com"]
                    .iter()
                    .any(|ext| dir.join(format!("{command}.{ext}")).is_file())
            } else {
                false
            }
    })
}

pub fn execute_command(argv: &[String]) -> Result<CommandOutput, SparkshellError> {
    if argv.is_empty() {
        return Err(SparkshellError::InvalidArgs(
            "usage: omx-sparkshell <command> [args...]".to_string(),
        ));
    }

    let mut command = build_command(&argv[0], &argv[1..]);
    let Output {
        status,
        stdout,
        stderr,
    } = command.output()?;

    Ok(CommandOutput {
        status,
        stdout,
        stderr,
    })
}

fn build_command(command_name: &str, args: &[String]) -> Command {
    #[cfg(windows)]
    {
        return build_windows_command(command_name, args);
    }

    #[cfg(not(windows))]
    {
        let mut command = Command::new(command_name);
        command.args(args);
        command
    }
}

#[cfg(windows)]
fn build_windows_command(command_name: &str, args: &[String]) -> Command {
    let extension = Path::new(command_name)
        .extension()
        .and_then(OsStr::to_str)
        .map(|value| value.to_ascii_lowercase());

    match extension.as_deref() {
        Some("cmd") | Some("bat") => {
            let mut command =
                Command::new(std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into()));
            command
                .arg("/d")
                .arg("/s")
                .arg("/c")
                .arg(command_name)
                .args(args);
            command
        }
        Some("ps1") => {
            let mut command = Command::new("powershell.exe");
            command
                .arg("-NoLogo")
                .arg("-NoProfile")
                .arg("-ExecutionPolicy")
                .arg("Bypass")
                .arg("-File")
                .arg(command_name)
                .args(args);
            command
        }
        _ => {
            let mut command = Command::new(command_name);
            command.args(args);
            command
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{execute_command, resolve_shell_argv_for_platform, ShellPlatform};

    #[test]
    fn rejects_missing_command() {
        let error = execute_command(&[]).unwrap_err();
        assert_eq!(
            error.to_string(),
            "usage: omx-sparkshell <command> [args...]"
        );
    }

    #[test]
    fn posix_shell_mode_uses_bash_lc() {
        assert_eq!(
            resolve_shell_argv_for_platform("printf ok", ShellPlatform::Posix, |_| false),
            ["bash", "-lc", "printf ok"]
        );
    }

    #[test]
    fn windows_shell_mode_prefers_pwsh() {
        assert_eq!(
            resolve_shell_argv_for_platform("Write-Output ok", ShellPlatform::Windows, |name| {
                name == "pwsh"
            }),
            [
                "pwsh",
                "-NoLogo",
                "-NoProfile",
                "-Command",
                "Write-Output ok"
            ]
        );
    }

    #[test]
    fn windows_shell_mode_falls_back_to_windows_powershell() {
        assert_eq!(
            resolve_shell_argv_for_platform("Write-Output ok", ShellPlatform::Windows, |name| {
                name == "powershell.exe"
            }),
            [
                "powershell.exe",
                "-NoLogo",
                "-NoProfile",
                "-Command",
                "Write-Output ok"
            ]
        );
    }

    #[test]
    fn windows_shell_mode_uses_minimal_cmd_fallback() {
        assert_eq!(
            resolve_shell_argv_for_platform("echo ok", ShellPlatform::Windows, |_| false),
            ["cmd.exe", "/d", "/s", "/c", "echo ok"]
        );
    }
}
