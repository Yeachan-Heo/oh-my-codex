use crate::exec::CommandOutput;

#[derive(Debug, Clone)]
pub(crate) struct RedactedOutput {
    pub(crate) output: CommandOutput,
    pub(crate) count: usize,
}

pub(crate) fn redact_output(output: &CommandOutput) -> RedactedOutput {
    let (stdout, stdout_count) = redact_bytes(&output.stdout);
    let (stderr, stderr_count) = redact_bytes(&output.stderr);
    RedactedOutput {
        output: CommandOutput {
            status: output.status,
            stdout,
            stderr,
        },
        count: stdout_count + stderr_count,
    }
}

fn redact_bytes(bytes: &[u8]) -> (Vec<u8>, usize) {
    let (text, count) = redact_text(&String::from_utf8_lossy(bytes));
    (text.into_bytes(), count)
}

fn redact_text(text: &str) -> (String, usize) {
    let mut count = 0;
    let mut lines = Vec::new();
    for line in text.lines() {
        let mut redacted = line.to_string();
        let lower = redacted.to_ascii_lowercase();
        if lower.contains("authorization: bearer ") {
            redacted = "Authorization: Bearer [REDACTED]".to_string();
            count += 1;
        }
        if let Some(eq) = redacted.find('=') {
            let key = redacted[..eq].to_ascii_lowercase();
            if key.contains("token") || key.contains("key") || key.contains("secret") {
                redacted = format!("{}=[REDACTED]", &redacted[..eq]);
                count += 1;
            }
        }
        for marker in ["sk-", "ghp_", "xoxb-"] {
            if let Some(start) = redacted.find(marker) {
                let end = redacted[start..]
                    .find(char::is_whitespace)
                    .map(|offset| start + offset)
                    .unwrap_or(redacted.len());
                redacted.replace_range(start..end, "[REDACTED]");
                count += 1;
            }
        }
        lines.push(redacted);
    }
    let mut rendered = lines.join("\n");
    if text.ends_with('\n') {
        rendered.push('\n');
    }
    (rendered, count)
}

#[cfg(test)]
mod tests {
    use super::redact_output;
    use crate::exec::CommandOutput;
    use std::process::Command;

    fn ok_status() -> std::process::ExitStatus {
        Command::new("sh")
            .arg("-c")
            .arg("exit 0")
            .status()
            .expect("status")
    }

    #[test]
    fn redacts_secret_like_stdout_and_stderr() {
        let output = CommandOutput {
            status: ok_status(),
            stdout: b"API_TOKEN=secret-value\nplain\nsk-live123\n".to_vec(),
            stderr: b"Authorization: Bearer bearer-secret\nghp_secret123\n".to_vec(),
        };

        let redacted = redact_output(&output);
        let stdout = String::from_utf8(redacted.output.stdout).expect("stdout utf8");
        let stderr = String::from_utf8(redacted.output.stderr).expect("stderr utf8");

        assert_eq!(redacted.count, 4);
        assert!(stdout.contains("API_TOKEN=[REDACTED]"));
        assert!(stdout.contains("[REDACTED]"));
        assert!(stderr.contains("Authorization: Bearer [REDACTED]"));
        assert!(!stdout.contains("secret-value"));
        assert!(!stdout.contains("sk-live123"));
        assert!(!stderr.contains("bearer-secret"));
        assert!(!stderr.contains("ghp_secret123"));
    }
}
