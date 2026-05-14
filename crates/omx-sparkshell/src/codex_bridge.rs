use crate::error::SparkshellError;
use crate::exec::CommandOutput;
use crate::prompt::build_summary_prompt;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{IpAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

pub const DEFAULT_SUMMARY_TIMEOUT_MS: u64 = 60_000;
pub const DEFAULT_API_BASE_URL: &str = "http://127.0.0.1:14510";
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
    match request_summary(&prompt, &model, timeout_ms) {
        Ok(stdout) => normalize_summary(&stdout).ok_or_else(|| {
            SparkshellError::SummaryBridge(
                "local API returned no valid summary sections".to_string(),
            )
        }),
        Err(primary_error) => {
            let primary_message = primary_error.to_string();
            if fallback_model != model && should_retry_with_fallback(&primary_message) {
                match request_summary(&prompt, &fallback_model, timeout_ms) {
                    Ok(fallback_stdout) => normalize_summary(&fallback_stdout).ok_or_else(|| {
                        SparkshellError::SummaryBridge(
                            "local API fallback returned no valid summary sections".to_string(),
                        )
                    }),
                    Err(fallback_error) => Err(SparkshellError::SummaryBridge(format!(
                        "local API failed for primary model `{model}` ({primary_message}) and fallback model `{fallback_model}` ({fallback_error})"
                    ))),
                }
            } else {
                Err(SparkshellError::SummaryBridge(format!(
                    "local API summary request failed: {primary_message}"
                )))
            }
        }
    }
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

fn request_summary(prompt: &str, model: &str, timeout_ms: u64) -> Result<String, SparkshellError> {
    let api_base_url = resolve_api_base_url();
    let endpoint = join_api_path(&api_base_url, "/v1/responses");
    let request = build_responses_request(prompt, model)?;
    let response_body = post_json(&endpoint, &request, timeout_ms, resolve_api_bearer())?;
    extract_output_text(&response_body).ok_or_else(|| {
        SparkshellError::SummaryBridge("local API response did not include output_text".to_string())
    })
}

fn resolve_api_base_url() -> String {
    env::var("OMX_API_BASE_URL")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            env::var("OMX_API_PORT")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .map(|port| format!("http://127.0.0.1:{port}"))
        })
        .unwrap_or_else(|| DEFAULT_API_BASE_URL.to_string())
}

fn resolve_api_bearer() -> Option<String> {
    env::var("OMX_API_LOCAL_BEARER")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            let path = env::var("OMX_API_STATE_FILE")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| {
                    env::temp_dir()
                        .join("omx-api-daemon.json")
                        .display()
                        .to_string()
                });
            fs::read_to_string(path)
                .ok()
                .and_then(|state| extract_json_string_field(&state, "local_bearer_token_file"))
                .and_then(|token_file| fs::read_to_string(token_file).ok())
                .map(|token| token.trim().to_string())
                .filter(|token| !token.is_empty())
        })
}

fn build_responses_request(prompt: &str, model: &str) -> Result<String, SparkshellError> {
    let mut fields = vec![
        format!("\"model\":{}", json_string(model)),
        format!("\"input\":{}", json_string(prompt)),
        "\"reasoning\":{\"effort\":\"low\"}".to_string(),
        "\"stream\":false".to_string(),
    ];

    if let Some(path) = resolve_instructions_file() {
        let instructions = fs::read_to_string(&path).map_err(|error| {
            SparkshellError::SummaryBridge(format!(
                "failed to read summary instructions file `{path}`: {error}"
            ))
        })?;
        fields.push(format!("\"instructions\":{}", json_string(&instructions)));
    }

    Ok(format!("{{{}}}", fields.join(",")))
}

fn join_api_path(base_url: &str, path: &str) -> String {
    format!(
        "{}{}{}",
        base_url.trim_end_matches('/'),
        if path.starts_with('/') { "" } else { "/" },
        path
    )
}

fn post_json(
    url: &str,
    body: &str,
    timeout_ms: u64,
    bearer: Option<String>,
) -> Result<String, SparkshellError> {
    let parsed = parse_http_url(url)?;
    let timeout = Duration::from_millis(timeout_ms);
    let mut addrs = (parsed.host.as_str(), parsed.port)
        .to_socket_addrs()
        .map_err(|error| {
            SparkshellError::SummaryBridge(format!(
                "failed to resolve local API host `{}`: {error}",
                parsed.host
            ))
        })?;
    let addr = addrs.next().ok_or_else(|| {
        SparkshellError::SummaryBridge(format!(
            "failed to resolve local API host `{}`",
            parsed.host
        ))
    })?;
    let mut stream = TcpStream::connect_timeout(&addr, timeout)
        .map_err(|error| map_api_io_error(error, timeout_ms, "local API connection failed"))?;
    stream.set_read_timeout(Some(timeout)).map_err(|error| {
        map_api_io_error(error, timeout_ms, "local API read timeout setup failed")
    })?;
    stream.set_write_timeout(Some(timeout)).map_err(|error| {
        map_api_io_error(error, timeout_ms, "local API write timeout setup failed")
    })?;

    let host_header = if parsed.explicit_port {
        format!("{}:{}", parsed.host, parsed.port)
    } else {
        parsed.host.clone()
    };
    let auth_header = bearer
        .as_deref()
        .map(|token| format!("Authorization: Bearer {token}\r\n"))
        .unwrap_or_default();
    let request = format!(
        "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nAccept: application/json\r\n{}Connection: close\r\nContent-Length: {}\r\n\r\n{}",
        parsed.path, host_header, auth_header, body.len(), body
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| map_api_io_error(error, timeout_ms, "local API write failed"))?;
    stream
        .flush()
        .map_err(|error| map_api_io_error(error, timeout_ms, "local API flush failed"))?;

    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|error| map_api_io_error(error, timeout_ms, "local API read failed"))?;
    let response = String::from_utf8_lossy(&raw);
    let (head, response_body) = response.split_once("\r\n\r\n").ok_or_else(|| {
        SparkshellError::SummaryBridge("local API returned malformed HTTP response".to_string())
    })?;
    let status_line = head.lines().next().unwrap_or_default();
    let status_code = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| {
            SparkshellError::SummaryBridge("local API returned malformed HTTP status".to_string())
        })?;
    if !(200..300).contains(&status_code) {
        return Err(SparkshellError::SummaryBridge(format!(
            "local API returned HTTP {status_code}: {}",
            response_body.trim()
        )));
    }
    Ok(response_body.to_string())
}

fn map_api_io_error(error: std::io::Error, timeout_ms: u64, context: &str) -> SparkshellError {
    if matches!(
        error.kind(),
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
    ) {
        SparkshellError::SummaryTimeout(timeout_ms)
    } else {
        SparkshellError::SummaryBridge(format!("{context}: {error}"))
    }
}

#[derive(Debug)]
struct HttpUrl {
    host: String,
    port: u16,
    path: String,
    explicit_port: bool,
}

fn parse_http_url(url: &str) -> Result<HttpUrl, SparkshellError> {
    let rest = url.strip_prefix("http://").ok_or_else(|| {
        SparkshellError::SummaryBridge(format!("local API URL must use http://, got `{url}`"))
    })?;
    let (authority, path) = match rest.split_once('/') {
        Some((authority, path)) => (authority, format!("/{path}")),
        None => (rest, "/".to_string()),
    };
    let (host, port, explicit_port) = if let Some((host, port)) = authority.rsplit_once(':') {
        let port = port.parse::<u16>().map_err(|_| {
            SparkshellError::SummaryBridge(format!("local API URL has invalid port in `{url}`"))
        })?;
        (host.to_string(), port, true)
    } else {
        (authority.to_string(), 80, false)
    };
    if host.is_empty() {
        return Err(SparkshellError::SummaryBridge(format!(
            "local API URL has empty host in `{url}`"
        )));
    }
    if !is_loopback_host(&host) && std::env::var_os("OMX_API_ALLOW_UNSAFE_BASE_URL").is_none() {
        return Err(SparkshellError::SummaryBridge(format!(
            "local API URL host `{host}` is not loopback; set OMX_API_ALLOW_UNSAFE_BASE_URL=1 only for trusted development"
        )));
    }
    Ok(HttpUrl {
        host,
        port,
        path,
        explicit_port,
    })
}

fn is_loopback_host(host: &str) -> bool {
    if host == "localhost" {
        return true;
    }
    let trimmed = host.trim_matches(['[', ']']);
    trimmed
        .parse::<IpAddr>()
        .map(|addr| addr.is_loopback())
        .unwrap_or(false)
}

fn json_string(value: &str) -> String {
    let mut rendered = String::from("\"");
    for ch in value.chars() {
        match ch {
            '\\' => rendered.push_str("\\\\"),
            '"' => rendered.push_str("\\\""),
            '\n' => rendered.push_str("\\n"),
            '\r' => rendered.push_str("\\r"),
            '\t' => rendered.push_str("\\t"),
            ch if ch.is_control() => rendered.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => rendered.push(ch),
        }
    }
    rendered.push('"');
    rendered
}

fn extract_output_text(body: &str) -> Option<String> {
    extract_json_string_field(body, "output_text")
}

fn extract_json_string_field(body: &str, field: &str) -> Option<String> {
    let bytes = body.as_bytes();
    let field_pattern = format!("\"{field}\"");
    let mut search_start = 0;
    while let Some(relative_index) = body[search_start..].find(&field_pattern) {
        let mut index = search_start + relative_index + field_pattern.len();
        while matches!(bytes.get(index), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            index += 1;
        }
        if bytes.get(index) != Some(&b':') {
            search_start = index;
            continue;
        }
        index += 1;
        while matches!(bytes.get(index), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            index += 1;
        }
        if bytes.get(index) != Some(&b'"') {
            search_start = index;
            continue;
        }
        return parse_json_string_at(body, index);
    }
    None
}

fn parse_json_string_at(body: &str, quote_index: usize) -> Option<String> {
    let mut chars = body[quote_index + 1..].chars();
    let mut rendered = String::new();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => return Some(rendered),
            '\\' => match chars.next()? {
                '"' => rendered.push('"'),
                '\\' => rendered.push('\\'),
                '/' => rendered.push('/'),
                'b' => rendered.push('\u{0008}'),
                'f' => rendered.push('\u{000c}'),
                'n' => rendered.push('\n'),
                'r' => rendered.push('\r'),
                't' => rendered.push('\t'),
                'u' => {
                    let mut hex = String::new();
                    for _ in 0..4 {
                        hex.push(chars.next()?);
                    }
                    let value = u16::from_str_radix(&hex, 16).ok()?;
                    rendered.push(char::from_u32(value as u32)?);
                }
                _ => return None,
            },
            ch => rendered.push(ch),
        }
    }
    None
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
        normalize_summary, parse_http_url, read_summary_timeout_ms, resolve_fallback_model,
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

    #[test]
    fn api_base_url_parser_rejects_non_loopback_hosts_by_default() {
        let _guard = env_lock();
        unsafe {
            env::remove_var("OMX_API_ALLOW_UNSAFE_BASE_URL");
        }

        assert!(parse_http_url("http://127.0.0.1:14510/v1/responses").is_ok());
        assert!(parse_http_url("http://localhost:14510/v1/responses").is_ok());
        assert!(parse_http_url("http://example.com:14510/v1/responses")
            .expect_err("non-loopback host should be rejected")
            .to_string()
            .contains("not loopback"));
        assert!(parse_http_url("http://127.0.0.1.evil:14510/v1/responses")
            .expect_err("prefix spoof host should be rejected")
            .to_string()
            .contains("not loopback"));
    }
}
