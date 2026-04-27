use crate::error::SparkshellError;
use crate::exec::CommandOutput;
use crate::prompt::build_summary_prompt;
use std::env;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub const DEFAULT_SUMMARY_TIMEOUT_MS: u64 = 60_000;
pub const DEFAULT_SPARK_MODEL: &str = "gpt-5.3-codex-spark";
pub const DEFAULT_STANDARD_MODEL: &str = "gpt-5.4-mini";

pub fn resolve_model() -> String {
    env::var("OMX_SPARKSHELL_MODEL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            env::var("OMX_DEFAULT_SPARK_MODEL")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .or_else(|| {
            env::var("OMX_SPARK_MODEL")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or_else(|| DEFAULT_SPARK_MODEL.to_string())
}

pub fn resolve_fallback_model() -> String {
    env::var("OMX_SPARKSHELL_FALLBACK_MODEL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            env::var("OMX_DEFAULT_STANDARD_MODEL")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or_else(|| DEFAULT_STANDARD_MODEL.to_string())
}

pub fn resolve_instructions_file() -> Option<String> {
    env::var("OMX_SPARKSHELL_MODEL_INSTRUCTIONS_FILE")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn read_summary_timeout_ms() -> u64 {
    env::var("OMX_SPARKSHELL_SUMMARY_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_SUMMARY_TIMEOUT_MS)
}

pub fn summarize_output(
    command: &[String],
    output: &CommandOutput,
) -> Result<String, SparkshellError> {
    let prompt = build_summary_prompt(command, output);
    let model = resolve_model();
    let fallback_model = resolve_fallback_model();
    let timeout_ms = read_summary_timeout_ms();
    let (stdout, stderr, status_ok) = run_codex_exec(&prompt, &model, timeout_ms)?;
    if !status_ok {
        let should_retry = fallback_model != model && should_retry_with_fallback(&stderr);
        if should_retry {
            let (fallback_stdout, fallback_stderr, fallback_ok) =
                run_codex_exec(&prompt, &fallback_model, timeout_ms)?;
            if !fallback_ok {
                let primary_message = if stderr.trim().is_empty() {
                    "codex exec exited unsuccessfully".to_string()
                } else {
                    stderr.trim().to_string()
                };
                let fallback_message = if fallback_stderr.trim().is_empty() {
                    "codex exec exited unsuccessfully".to_string()
                } else {
                    fallback_stderr.trim().to_string()
                };
                return Err(SparkshellError::SummaryBridge(format!(
                    "codex exec failed for primary model `{model}` ({primary_message}) and fallback model `{fallback_model}` ({fallback_message})"
                )));
            }
            return normalize_summary(&fallback_stdout).ok_or_else(|| {
                SparkshellError::SummaryBridge(
                    "codex exec fallback returned no valid summary sections".to_string(),
                )
            });
        }
        let message = if stderr.trim().is_empty() {
            "codex exec exited unsuccessfully".to_string()
        } else {
            format!("codex exec exited unsuccessfully: {}", stderr.trim())
        };
        return Err(SparkshellError::SummaryBridge(message));
    }
    normalize_summary(&stdout).ok_or_else(|| {
        SparkshellError::SummaryBridge("codex exec returned no valid summary sections".to_string())
    })
}

fn should_retry_with_fallback(stderr: &str) -> bool {
    let normalized = stderr.to_ascii_lowercase();
    [
        "quota",
        "rate limit",
        "429",
        "unavailable",
        "not available",
        "unknown model",
        "model not found",
        "no access",
        "capacity",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn run_codex_exec(
    prompt: &str,
    model: &str,
    timeout_ms: u64,
) -> Result<(String, String, bool), SparkshellError> {
    let mut child = Command::new("codex")
        .arg("exec")
        .arg("--model")
        .arg(model)
        .arg("--sandbox")
        .arg("read-only")
        .arg("-c")
        .arg("model_reasoning_effort=\"low\"")
        .args(resolve_instructions_file().into_iter().flat_map(|path| {
            [
                "-c".to_string(),
                format!("model_instructions_file=\"{}\"", escape_toml_string(&path)),
            ]
        }))
        .arg("--skip-git-repo-check")
        .arg("--color")
        .arg("never")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| SparkshellError::SummaryBridge("failed to open codex stdin".to_string()))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| SparkshellError::SummaryBridge("failed to open codex stdout".to_string()))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| SparkshellError::SummaryBridge("failed to open codex stderr".to_string()))?;

    let prompt_owned = prompt.to_string();
    let stdin_writer = thread::spawn(move || stdin.write_all(prompt_owned.as_bytes()));
    let stdout_reader = thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stdout.read_to_end(&mut buffer);
        buffer
    });
    let stderr_reader = thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stderr.read_to_end(&mut buffer);
        buffer
    });

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdin_writer.join();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(SparkshellError::SummaryTimeout(timeout_ms));
        }
        thread::sleep(Duration::from_millis(25));
    };

    let _ = stdin_writer.join();
    let stdout_bytes = stdout_reader
        .join()
        .map_err(|_| SparkshellError::SummaryBridge("failed reading codex stdout".to_string()))?;
    let stderr_bytes = stderr_reader
        .join()
        .map_err(|_| SparkshellError::SummaryBridge("failed reading codex stderr".to_string()))?;

    Ok((
        String::from_utf8_lossy(&stdout_bytes).into_owned(),
        String::from_utf8_lossy(&stderr_bytes).into_owned(),
        status.success(),
    ))
}

fn escape_toml_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn normalize_summary(raw: &str) -> Option<String> {
    let mut summary = Vec::new();
    let mut failures = Vec::new();
    let mut warnings = Vec::new();
    let mut current: Option<&mut Vec<String>> = None;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let normalized = trimmed
            .trim_start_matches(['-', '*'])
            .trim_start()
            .to_ascii_lowercase();

        if let Some(rest) = normalized.strip_prefix("summary:") {
            summary.push(rest.trim().to_string());
            current = Some(&mut summary);
            continue;
        }
        if let Some(rest) = normalized.strip_prefix("failures:") {
            failures.push(rest.trim().to_string());
            current = Some(&mut failures);
            continue;
        }
        if let Some(rest) = normalized.strip_prefix("warnings:") {
            warnings.push(rest.trim().to_string());
            current = Some(&mut warnings);
            continue;
        }

        if trimmed.contains(':') && !line.starts_with(' ') && !line.starts_with('\t') {
            current = None;
            continue;
        }

        if let Some(section) = current.as_deref_mut() {
            section.push(trimmed.to_string());
        }
    }

    let mut rendered = Vec::new();
    if !summary.is_empty() {
        rendered.push(render_section("summary", &summary));
    }
    if !failures.is_empty() {
        rendered.push(render_section("failures", &failures));
    }
    if !warnings.is_empty() {
        rendered.push(render_section("warnings", &warnings));
    }

    if rendered.is_empty() {
        None
    } else {
        Some(rendered.join("\n"))
    }
}

fn render_section(name: &str, entries: &[String]) -> String {
    let head = entries
        .first()
        .map(|entry| entry.trim())
        .filter(|entry| !entry.is_empty())
        .unwrap_or("");
    let mut lines = vec![format!("- {name}: {head}")];
    for entry in entries.iter().skip(1) {
        let trimmed = entry.trim();
        if !trimmed.is_empty() {
            lines.push(format!("  - {trimmed}"));
        }
    }
    lines.join("\n")
}

#[cfg(test)]
#[allow(unused_unsafe)]
mod tests {
    use super::{
        normalize_summary, read_summary_timeout_ms, resolve_fallback_model,
        resolve_instructions_file, resolve_model, DEFAULT_SPARK_MODEL, DEFAULT_STANDARD_MODEL,
        DEFAULT_SUMMARY_TIMEOUT_MS,
    };
    use crate::test_support::env_lock;
    use std::env;

    #[test]
    fn model_resolution_prefers_sparkshell_override() {
        let _guard = env_lock();
        unsafe {
            env::set_var("OMX_SPARKSHELL_MODEL", "spark-a");
            env::set_var("OMX_DEFAULT_SPARK_MODEL", "spark-b");
        }
        assert_eq!(resolve_model(), "spark-a");
        unsafe {
            env::remove_var("OMX_SPARKSHELL_MODEL");
            env::remove_var("OMX_DEFAULT_SPARK_MODEL");
            env::remove_var("OMX_SPARK_MODEL");
        }
    }

    #[test]
    fn fallback_model_resolution_prefers_override_then_default_standard() {
        let _guard = env_lock();
        unsafe {
            env::remove_var("OMX_SPARKSHELL_FALLBACK_MODEL");
            env::remove_var("OMX_DEFAULT_STANDARD_MODEL");
        }
        assert_eq!(resolve_fallback_model(), DEFAULT_STANDARD_MODEL);

        unsafe {
            env::set_var("OMX_DEFAULT_STANDARD_MODEL", "standard-a");
        }
        assert_eq!(resolve_fallback_model(), "standard-a");

        unsafe {
            env::set_var("OMX_SPARKSHELL_FALLBACK_MODEL", "standard-b");
        }
        assert_eq!(resolve_fallback_model(), "standard-b");
    }

    #[test]
    fn model_resolution_falls_back_to_default() {
        let _guard = env_lock();
        unsafe {
            env::remove_var("OMX_SPARKSHELL_MODEL");
            env::remove_var("OMX_DEFAULT_SPARK_MODEL");
            env::remove_var("OMX_SPARK_MODEL");
        }
        assert_eq!(resolve_model(), DEFAULT_SPARK_MODEL);
    }

    #[test]
    fn timeout_defaults_when_unset() {
        let _guard = env_lock();
        unsafe {
            env::remove_var("OMX_SPARKSHELL_SUMMARY_TIMEOUT_MS");
        }
        assert_eq!(read_summary_timeout_ms(), 60_000);
    }

    #[test]
    fn model_resolution_ignores_blank_override_and_uses_secondary_env() {
        let _guard = env_lock();
        unsafe {
            env::set_var("OMX_SPARKSHELL_MODEL", "   ");
            env::set_var("OMX_DEFAULT_SPARK_MODEL", "spark-b");
        }
        assert_eq!(resolve_model(), "spark-b");
        unsafe {
            env::remove_var("OMX_SPARKSHELL_MODEL");
            env::remove_var("OMX_DEFAULT_SPARK_MODEL");
            env::remove_var("OMX_SPARK_MODEL");
        }
    }

    #[test]
    fn instructions_file_resolution_prefers_override_and_ignores_blank() {
        let _guard = env_lock();
        unsafe {
            env::remove_var("OMX_SPARKSHELL_MODEL_INSTRUCTIONS_FILE");
        }
        assert_eq!(resolve_instructions_file(), None);

        unsafe {
            env::set_var(
                "OMX_SPARKSHELL_MODEL_INSTRUCTIONS_FILE",
                " /tmp/sparkshell-agents.md ",
            );
        }
        assert_eq!(
            resolve_instructions_file(),
            Some("/tmp/sparkshell-agents.md".to_string())
        );

        unsafe {
            env::set_var("OMX_SPARKSHELL_MODEL_INSTRUCTIONS_FILE", "   ");
        }
        assert_eq!(resolve_instructions_file(), None);

        unsafe {
            env::remove_var("OMX_SPARKSHELL_MODEL_INSTRUCTIONS_FILE");
        }
    }

    #[test]
    fn timeout_defaults_for_zero_and_invalid_values() {
        let _guard = env_lock();
        unsafe {
            env::set_var("OMX_SPARKSHELL_SUMMARY_TIMEOUT_MS", "0");
        }
        assert_eq!(read_summary_timeout_ms(), DEFAULT_SUMMARY_TIMEOUT_MS);

        unsafe {
            env::set_var("OMX_SPARKSHELL_SUMMARY_TIMEOUT_MS", "bogus");
        }
        assert_eq!(read_summary_timeout_ms(), DEFAULT_SUMMARY_TIMEOUT_MS);

        unsafe {
            env::remove_var("OMX_SPARKSHELL_SUMMARY_TIMEOUT_MS");
        }
    }

    #[test]
    fn normalizes_allowed_sections_only() {
        let summary = normalize_summary(
            "summary: command ran\nextra detail\nfailures: one test failed\nwarnings: cache miss\nnext step: do a thing",
        )
        .expect("normalized summary");
        assert!(summary.contains("- summary: command ran"));
        assert!(summary.contains("- failures: one test failed"));
        assert!(summary.contains("- warnings: cache miss"));
        assert!(!summary.contains("next step"));
    }

    #[test]
    fn normalizes_indented_follow_up_bullets() {
        let summary = normalize_summary(
            "summary: command ran
  second detail
* failures: first failure
  * nested detail
warnings: caution
",
        )
        .expect("normalized summary");
        assert!(summary.contains("- summary: command ran"));
        assert!(summary.contains("  - second detail"));
        assert!(summary.contains("- failures: first failure"));
        assert!(summary.contains("nested detail"));
        assert!(summary.contains("- warnings: caution"));
    }

    #[test]
    fn normalize_summary_returns_none_without_allowed_sections() {
        assert!(normalize_summary(
            "next steps: do a thing
notes: nope"
        )
        .is_none());
    }
}
