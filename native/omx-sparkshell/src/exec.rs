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
    use super::execute_command;

    #[test]
    fn rejects_missing_command() {
        let error = execute_command(&[]).unwrap_err();
        assert_eq!(
            error.to_string(),
            "usage: omx-sparkshell <command> [args...]"
        );
    }
}
