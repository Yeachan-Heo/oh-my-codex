#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HudExecution {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HudError(String);

impl HudError {
    fn runtime(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl std::fmt::Display for HudError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for HudError {}

#[allow(clippy::missing_errors_doc)]
pub fn run_hud(args: &[String], help_output: &str) -> Result<HudExecution, HudError> {
    if matches!(
        args.first().map(String::as_str),
        Some("--help" | "-h" | "help")
    ) {
        return Ok(HudExecution {
            stdout: help_output.as_bytes().to_vec(),
            stderr: Vec::new(),
            exit_code: 0,
        });
    }

    Err(HudError::runtime(
        "Command \"hud\" is recognized but not yet implemented in the native Rust CLI.",
    ))
}

#[cfg(test)]
mod tests {
    use super::run_hud;

    const HELP: &str = "top-level help\n";

    #[test]
    fn prints_top_level_help_for_help_variants() {
        for args in [
            vec!["--help".to_string()],
            vec!["-h".to_string()],
            vec!["help".to_string()],
        ] {
            let result = run_hud(&args, HELP).expect("hud help");
            assert_eq!(result.stdout, HELP.as_bytes());
            assert!(result.stderr.is_empty());
            assert_eq!(result.exit_code, 0);
        }
    }

    #[test]
    fn preserves_scaffold_error_for_non_help_paths() {
        let error = run_hud(&[], HELP).expect_err("hud error");
        assert_eq!(
            error.to_string(),
            "Command \"hud\" is recognized but not yet implemented in the native Rust CLI."
        );
    }
}
