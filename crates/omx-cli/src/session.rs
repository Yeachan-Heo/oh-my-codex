#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionExecution {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionError(String);

impl SessionError {
    fn runtime(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SessionError {}

#[allow(clippy::missing_errors_doc)]
pub fn run_session(args: &[String], help_output: &str) -> Result<SessionExecution, SessionError> {
    if matches!(
        args.first().map(String::as_str),
        Some("--help" | "-h" | "help")
    ) {
        return Ok(SessionExecution {
            stdout: help_output.as_bytes().to_vec(),
            stderr: Vec::new(),
            exit_code: 0,
        });
    }

    if args.is_empty() {
        return Ok(unknown_session(help_output));
    }

    Err(SessionError::runtime(format!(
        "unsupported session arguments: {}",
        args.join(" ")
    )))
}

fn unknown_session(help_output: &str) -> SessionExecution {
    SessionExecution {
        stdout: help_output.as_bytes().to_vec(),
        stderr: b"Unknown command: session\n".to_vec(),
        exit_code: 1,
    }
}

#[cfg(test)]
mod tests {
    use super::run_session;

    const HELP: &str = "top-level help\n";

    #[test]
    fn prints_top_level_help_for_help_variants() {
        for args in [
            vec!["--help".to_string()],
            vec!["-h".to_string()],
            vec!["help".to_string()],
        ] {
            let result = run_session(&args, HELP).expect("session help");
            assert_eq!(result.stdout, HELP.as_bytes());
            assert!(result.stderr.is_empty());
            assert_eq!(result.exit_code, 0);
        }
    }

    #[test]
    fn matches_unknown_command_shape_for_empty_args() {
        let result = run_session(&[], HELP).expect("session unknown");
        assert_eq!(result.stdout, HELP.as_bytes());
        assert_eq!(result.stderr, b"Unknown command: session\n");
        assert_eq!(result.exit_code, 1);
    }

    #[test]
    fn rejects_passthrough_args_until_implemented() {
        let error = run_session(&["list".to_string()], HELP).expect_err("session error");
        assert_eq!(error.to_string(), "unsupported session arguments: list");
    }
}
