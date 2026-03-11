use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use crate::platform_command::{
    PlatformCommandSpec, SpawnErrorKind, build_platform_command_spec, classify_spawn_error,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Current,
    Windows,
    Unix,
}

impl Platform {
    #[must_use]
    pub fn detect() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Unix
        }
    }

    #[must_use]
    pub fn effective(self) -> Self {
        match self {
            Self::Current => Self::detect(),
            other => other,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlatformResolution {
    Auto,
    Literal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StdioMode {
    Inherit,
    Capture,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub cwd: Option<PathBuf>,
    pub env_additions: BTreeMap<OsString, OsString>,
    pub env_removals: Vec<OsString>,
    pub stdio_mode: StdioMode,
    pub platform_resolution: PlatformResolution,
}

impl CommandSpec {
    #[must_use]
    pub fn new(program: impl Into<OsString>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            cwd: None,
            env_additions: BTreeMap::new(),
            env_removals: Vec::new(),
            stdio_mode: StdioMode::Capture,
            platform_resolution: PlatformResolution::Auto,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessResult {
    pub status_code: Option<i32>,
    pub terminating_signal: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub spawn_error_kind: Option<SpawnErrorKind>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbedCommand {
    pub spec: PlatformCommandSpec,
    pub result: ProcessResult,
}

impl ProcessResult {
    #[must_use]
    pub fn success(&self) -> bool {
        self.status_code == Some(0) && self.spawn_error_kind.is_none()
    }
}

#[derive(Debug, Clone)]
pub struct ProcessBridge {
    platform: Platform,
    base_env: BTreeMap<OsString, OsString>,
}

impl Default for ProcessBridge {
    fn default() -> Self {
        Self {
            platform: Platform::detect(),
            base_env: std::env::vars_os().collect(),
        }
    }
}

impl ProcessBridge {
    #[must_use]
    pub fn new(platform: Platform, base_env: BTreeMap<OsString, OsString>) -> Self {
        Self {
            platform: platform.effective(),
            base_env,
        }
    }

    pub fn run(&self, spec: &CommandSpec) -> ProcessResult {
        self.run_resolved(&self.resolve_spec(spec), spec)
    }

    #[must_use]
    pub fn probe(&self, spec: &CommandSpec) -> ProbedCommand {
        let resolved = self.resolve_spec(spec);
        let result = self.run_resolved(&resolved, spec);
        ProbedCommand {
            spec: resolved,
            result,
        }
    }

    fn run_resolved(&self, resolved: &PlatformCommandSpec, spec: &CommandSpec) -> ProcessResult {
        let mut command = Command::new(&resolved.command);
        command.args(&resolved.args);
        command.env_clear();
        command.envs(&self.base_env);
        command.envs(&spec.env_additions);
        for key in &spec.env_removals {
            command.env_remove(key);
        }
        if let Some(cwd) = &spec.cwd {
            command.current_dir(cwd);
        }

        match spec.stdio_mode {
            StdioMode::Inherit => {
                command.stdin(Stdio::inherit());
                command.stdout(Stdio::inherit());
                command.stderr(Stdio::inherit());
                match command.status() {
                    Ok(status) => ProcessResult {
                        status_code: status
                            .code()
                            .or_else(|| signal_to_exit_code(status).map(|code| code.0)),
                        terminating_signal: signal_to_exit_code(status).map(|code| code.1),
                        stdout: Vec::new(),
                        stderr: Vec::new(),
                        spawn_error_kind: None,
                    },
                    Err(error) => ProcessResult {
                        status_code: None,
                        terminating_signal: None,
                        stdout: Vec::new(),
                        stderr: Vec::new(),
                        spawn_error_kind: Some(classify_spawn_error(&error)),
                    },
                }
            }
            StdioMode::Capture => match command.output() {
                Ok(output) => ProcessResult {
                    status_code: output
                        .status
                        .code()
                        .or_else(|| signal_to_exit_code(output.status).map(|code| code.0)),
                    terminating_signal: signal_to_exit_code(output.status).map(|code| code.1),
                    stdout: output.stdout,
                    stderr: output.stderr,
                    spawn_error_kind: None,
                },
                Err(error) => ProcessResult {
                    status_code: None,
                    terminating_signal: None,
                    stdout: Vec::new(),
                    stderr: Vec::new(),
                    spawn_error_kind: Some(classify_spawn_error(&error)),
                },
            },
        }
    }

    fn resolve_spec(&self, spec: &CommandSpec) -> PlatformCommandSpec {
        match spec.platform_resolution {
            PlatformResolution::Auto => {
                let mut env = self.base_env.clone();
                env.extend(spec.env_additions.clone());
                for key in &spec.env_removals {
                    env.remove(key);
                }
                build_platform_command_spec(&spec.program, &spec.args, self.platform, &env)
            }
            PlatformResolution::Literal => PlatformCommandSpec {
                command: spec.program.clone(),
                args: spec.args.clone(),
                resolved_path: None,
            },
        }
    }
}

#[cfg(unix)]
fn signal_to_exit_code(status: std::process::ExitStatus) -> Option<(i32, i32)> {
    use std::os::unix::process::ExitStatusExt;

    status.signal().map(|signal| (128 + signal, signal))
}

#[cfg(not(unix))]
fn signal_to_exit_code(_status: std::process::ExitStatus) -> Option<(i32, i32)> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    #[cfg(unix)]
    #[test]
    fn captures_output_and_exit_status() {
        let bridge = ProcessBridge::new(Platform::Unix, std::env::vars_os().collect());
        let mut spec = CommandSpec::new("sh");
        spec.args = vec![
            OsString::from("-c"),
            OsString::from("printf hello; printf error >&2; exit 7"),
        ];

        let result = bridge.run(&spec);

        assert_eq!(result.status_code, Some(7));
        assert_eq!(result.stdout, b"hello");
        assert_eq!(result.stderr, b"error");
        assert_eq!(result.spawn_error_kind, None);
    }

    #[cfg(unix)]
    #[test]
    fn applies_env_additions_and_removals_in_order() {
        let bridge = ProcessBridge::new(
            Platform::Unix,
            BTreeMap::from([
                (OsString::from("KEEP"), OsString::from("base")),
                (OsString::from("DROP"), OsString::from("base")),
            ]),
        );
        let mut spec = CommandSpec::new("sh");
        spec.args = vec![
            OsString::from("-c"),
            OsString::from("printf '%s|%s' \"$KEEP\" \"${DROP-unset}\""),
        ];
        spec.env_additions
            .insert(OsString::from("KEEP"), OsString::from("override"));
        spec.env_removals.push(OsString::from("DROP"));

        let result = bridge.run(&spec);

        assert!(result.success());
        assert_eq!(result.stdout, b"override|unset");
    }

    #[cfg(unix)]
    #[test]
    fn classifies_spawn_failures() {
        let bridge = ProcessBridge::new(Platform::Unix, std::env::vars_os().collect());
        let spec = CommandSpec::new("definitely-not-a-real-omx-command");

        let result = bridge.run(&spec);

        assert_eq!(result.spawn_error_kind, Some(SpawnErrorKind::Missing));
        assert_eq!(result.status_code, None);
    }

    #[cfg(unix)]
    #[test]
    fn probe_returns_resolved_spec_and_result() {
        let bridge = ProcessBridge::new(Platform::Unix, std::env::vars_os().collect());
        let mut spec = CommandSpec::new("sh");
        spec.args = vec![OsString::from("-c"), OsString::from("printf bridged")];

        let probed = bridge.probe(&spec);

        assert_eq!(probed.spec.command, OsString::from("sh"));
        assert_eq!(probed.spec.args, spec.args);
        assert_eq!(probed.result.stdout, b"bridged");
        assert!(probed.result.success());
    }

    #[cfg(unix)]
    #[test]
    fn probe_preserves_spawn_failure_classification() {
        let bridge = ProcessBridge::new(Platform::Unix, std::env::vars_os().collect());
        let spec = CommandSpec::new("definitely-not-a-real-omx-command");

        let probed = bridge.probe(&spec);

        assert_eq!(
            probed.spec.command,
            OsString::from("definitely-not-a-real-omx-command")
        );
        assert_eq!(
            probed.result.spawn_error_kind,
            Some(SpawnErrorKind::Missing)
        );
        assert_eq!(probed.result.status_code, None);
    }

    #[test]
    fn literal_resolution_skips_platform_rewrite() -> io::Result<()> {
        let bridge = ProcessBridge::new(
            Platform::Windows,
            BTreeMap::from([(OsString::from("PATH"), OsString::from("C:\\fake"))]),
        );
        let mut spec = CommandSpec::new("codex");
        spec.args.push(OsString::from("--version"));
        spec.platform_resolution = PlatformResolution::Literal;

        let resolved = bridge.resolve_spec(&spec);

        assert_eq!(resolved.command, OsString::from("codex"));
        assert_eq!(resolved.args, vec![OsString::from("--version")]);
        Ok(())
    }
}
