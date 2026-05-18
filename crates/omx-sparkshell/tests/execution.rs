use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{SystemTime, UNIX_EPOCH};

fn sparkshell_bin() -> &'static str {
    env!("CARGO_BIN_EXE_omx-sparkshell")
}

fn unique_temp_dir(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let path = env::temp_dir().join(format!(
        "omx-sparkshell-{name}-{nanos}-{}",
        std::process::id()
    ));
    fs::create_dir_all(&path).expect("temp dir");
    path
}

fn write_executable(path: &Path, body: &str) {
    fs::write(path, body).expect("write script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path).expect("metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms).expect("chmod");
    }
}

fn start_api_server<F>(expected_requests: usize, mut handler: F) -> (String, JoinHandle<()>)
where
    F: FnMut(String) -> (u16, String) + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind api server");
    let address = listener.local_addr().expect("api address");
    let handle = thread::spawn(move || {
        for _ in 0..expected_requests {
            let (stream, _) = listener.accept().expect("accept api request");
            let request = read_http_request(stream.try_clone().expect("clone stream"));
            let (status, body) = handler(request);
            write_http_response(stream, status, &body);
        }
    });
    (format!("http://{}", address), handle)
}

fn read_http_request(mut stream: TcpStream) -> String {
    let mut buffer = Vec::new();
    let mut scratch = [0; 1024];
    loop {
        let count = stream.read(&mut scratch).expect("read request");
        assert!(count > 0, "connection closed before request headers");
        buffer.extend_from_slice(&scratch[..count]);
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let request = String::from_utf8_lossy(&buffer).into_owned();
    let content_length = request
        .lines()
        .find_map(|line| {
            line.strip_prefix("Content-Length:")
                .or_else(|| line.strip_prefix("content-length:"))
                .and_then(|value| value.trim().parse::<usize>().ok())
        })
        .unwrap_or(0);
    let body_start = buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("header boundary")
        + 4;
    while buffer.len() - body_start < content_length {
        let count = stream.read(&mut scratch).expect("read request body");
        assert!(count > 0, "connection closed before request body");
        buffer.extend_from_slice(&scratch[..count]);
    }
    String::from_utf8_lossy(&buffer).into_owned()
}

fn write_http_response(mut stream: TcpStream, status: u16, body: &str) {
    let reason = if (200..300).contains(&status) {
        "OK"
    } else {
        "ERROR"
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(response.as_bytes())
        .expect("write response");
}

fn response_json(text: &str) -> String {
    format!(
        "{{\"object\":\"response\",\"output_text\":\"{}\"}}",
        text.replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
    )
}

#[test]
fn raw_mode_preserves_stdout_and_stderr() {
    let output = Command::new(sparkshell_bin())
        .env("OMX_SPARKSHELL_LINES", "5")
        .arg("sh")
        .arg("-c")
        .arg("printf 'alpha\n'; printf 'warn\n' >&2")
        .output()
        .expect("run sparkshell");

    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout), "alpha\n");
    assert_eq!(String::from_utf8_lossy(&output.stderr), "warn\n");
}

#[test]
fn summary_mode_uses_local_api_and_model_override() {
    let request_log = Arc::new(Mutex::new(String::new()));
    let request_log_for_server = Arc::clone(&request_log);
    let (base_url, server) = start_api_server(1, move |request| {
        *request_log_for_server.lock().expect("request log") = request;
        (
            200,
            response_json("- summary: command produced long output\n- warnings: stderr was empty"),
        )
    });

    let output = Command::new(sparkshell_bin())
        .env("OMX_API_BASE_URL", base_url)
        .env("OMX_SPARKSHELL_LINES", "1")
        .env("OMX_SPARKSHELL_MODEL", "spark-test-model")
        .arg("sh")
        .arg("-c")
        .arg("printf 'one\ntwo\n'")
        .output()
        .expect("run sparkshell");
    server.join().expect("api server");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("- summary: command produced long output"));
    assert!(stdout.contains("- warnings: stderr was empty"));
    assert!(String::from_utf8_lossy(&output.stderr).is_empty());

    let request = request_log.lock().expect("request log");
    assert!(request.starts_with("POST /v1/responses HTTP/1.1"));
    assert!(request.contains("\"model\":\"spark-test-model\""));
    assert!(request.contains("\"reasoning\":{\"effort\":\"low\"}"));
    assert!(request.contains("Command family: generic-shell"));
    assert!(request.contains("<<<STDOUT"));
    assert!(request.contains("one\\ntwo"));
}

#[test]
fn summary_mode_redacts_secret_like_output_before_prompt_request() {
    let request_log = Arc::new(Mutex::new(String::new()));
    let request_log_for_server = Arc::clone(&request_log);
    let (base_url, server) = start_api_server(1, move |request| {
        *request_log_for_server.lock().expect("request log") = request;
        (200, response_json("- summary: redacted output summarized"))
    });

    let output = Command::new(sparkshell_bin())
        .env("OMX_API_BASE_URL", base_url)
        .env("OMX_SPARKSHELL_LINES", "1")
        .env("CHILD_API_TOKEN", "super-secret-token")
        .env("CHILD_BEARER", "bearer-secret-token")
        .arg("sh")
        .arg("-c")
        .arg("printf 'API_TOKEN=%s\\nline-2\\n' \"$CHILD_API_TOKEN\"; printf 'Authorization: Bearer %s\\n' \"$CHILD_BEARER\" >&2")
        .output()
        .expect("run sparkshell");
    server.join().expect("api server");

    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("redacted output summarized"));

    let request = request_log.lock().expect("request log");
    assert!(request.contains("API_TOKEN=[REDACTED]"));
    assert!(request.contains("Authorization: Bearer [REDACTED]"));
    assert!(request.contains("line-2"));
    assert!(!request.contains("super-secret-token"));
    assert!(!request.contains("bearer-secret-token"));
}

#[test]
fn summary_mode_injects_model_instructions_file_override() {
    let temp = unique_temp_dir("api-instructions-file");
    let instructions_file = temp.join("sparkshell-lightweight-AGENTS.md");
    fs::write(&instructions_file, "# sparkshell instructions\n").expect("write instructions file");

    let request_log = Arc::new(Mutex::new(String::new()));
    let request_log_for_server = Arc::clone(&request_log);
    let (base_url, server) = start_api_server(1, move |request| {
        *request_log_for_server.lock().expect("request log") = request;
        (
            200,
            response_json("- summary: command produced long output"),
        )
    });

    let output = Command::new(sparkshell_bin())
        .env("OMX_API_BASE_URL", base_url)
        .env("OMX_SPARKSHELL_LINES", "1")
        .env(
            "OMX_SPARKSHELL_MODEL_INSTRUCTIONS_FILE",
            instructions_file.display().to_string(),
        )
        .arg("sh")
        .arg("-c")
        .arg("printf 'one\ntwo\n'")
        .output()
        .expect("run sparkshell");
    server.join().expect("api server");

    assert!(output.status.success());
    let request = request_log.lock().expect("request log");
    assert!(request.contains("\"reasoning\":{\"effort\":\"low\"}"));
    assert!(request.contains("\"instructions\":\"# sparkshell instructions\\n\""));

    let _ = fs::remove_dir_all(temp);
}

#[test]
fn summary_failure_falls_back_to_raw_output_with_notice() {
    let (base_url, server) = start_api_server(1, |_request| {
        (503, "{\"error\":\"bridge failed\"}".to_string())
    });

    let output = Command::new(sparkshell_bin())
        .env("OMX_API_BASE_URL", base_url)
        .env("OMX_SPARKSHELL_LINES", "1")
        .arg("/bin/sh")
        .arg("-c")
        .arg("printf 'one\ntwo\n'; printf 'child-err\n' >&2")
        .output()
        .expect("run sparkshell");
    server.join().expect("api server");

    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout), "one\ntwo\n");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("child-err"));
    assert!(stderr.contains("summary unavailable"));
}

#[test]
fn summary_mode_retries_with_fallback_model_when_spark_is_unavailable() {
    let request_log = Arc::new(Mutex::new(Vec::new()));
    let request_log_for_server = Arc::clone(&request_log);
    let (base_url, server) = start_api_server(2, move |request| {
        request_log_for_server
            .lock()
            .expect("request log")
            .push(request.clone());
        if request.contains("\"model\":\"spark-test-model\"") {
            (
                429,
                "{\"error\":\"rate limit exceeded for spark model\"}".to_string(),
            )
        } else {
            (
                200,
                response_json("- summary: fallback model recovered summary"),
            )
        }
    });

    let output = Command::new(sparkshell_bin())
        .env("OMX_API_BASE_URL", base_url)
        .env("OMX_SPARKSHELL_LINES", "1")
        .env("OMX_SPARKSHELL_MODEL", "spark-test-model")
        .env("OMX_SPARKSHELL_FALLBACK_MODEL", "frontier-test-model")
        .arg("sh")
        .arg("-c")
        .arg("printf 'one\ntwo\n'")
        .output()
        .expect("run sparkshell");
    server.join().expect("api server");

    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("fallback model recovered summary"));
    assert!(String::from_utf8_lossy(&output.stderr).is_empty());

    let requests = request_log.lock().expect("request log");
    assert_eq!(requests.len(), 2);
    assert!(requests[0].contains("\"model\":\"spark-test-model\""));
    assert!(requests[1].contains("\"model\":\"frontier-test-model\""));
}

#[test]
fn summary_mode_reports_both_models_when_fallback_also_fails() {
    let (base_url, server) = start_api_server(2, |request| {
        if request.contains("\"model\":\"spark-test-model\"") {
            (
                429,
                "{\"error\":\"quota exhausted for spark model\"}".to_string(),
            )
        } else {
            (
                503,
                "{\"error\":\"fallback backend unavailable\"}".to_string(),
            )
        }
    });

    let output = Command::new(sparkshell_bin())
        .env("OMX_API_BASE_URL", base_url)
        .env("OMX_SPARKSHELL_LINES", "1")
        .env("OMX_SPARKSHELL_MODEL", "spark-test-model")
        .env("OMX_SPARKSHELL_FALLBACK_MODEL", "frontier-test-model")
        .arg("sh")
        .arg("-c")
        .arg("printf 'one\ntwo\n'; printf 'child-err\n' >&2")
        .output()
        .expect("run sparkshell");
    server.join().expect("api server");

    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout), "one\ntwo\n");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("child-err"));
    assert!(stderr.contains("primary model `spark-test-model`"));
    assert!(stderr.contains("fallback model `frontier-test-model`"));
}

#[test]
fn summary_mode_preserves_child_exit_code() {
    let (base_url, server) = start_api_server(1, |_request| {
        (200, response_json("- failures: command exited non-zero"))
    });

    let output = Command::new(sparkshell_bin())
        .env("OMX_API_BASE_URL", base_url)
        .env("OMX_SPARKSHELL_LINES", "1")
        .arg("sh")
        .arg("-c")
        .arg("printf 'one\ntwo\n'; exit 7")
        .output()
        .expect("run sparkshell");
    server.join().expect("api server");

    assert_eq!(output.status.code(), Some(7));
    assert!(String::from_utf8_lossy(&output.stdout).contains("- failures: command exited non-zero"));
    assert!(String::from_utf8_lossy(&output.stderr).is_empty());
}

#[test]
fn tmux_pane_mode_captures_large_tail_and_summarizes() {
    let temp = unique_temp_dir("tmux-pane-summary");
    let tmux = temp.join("tmux");
    let args_log = temp.join("tmux-args.log");
    write_executable(
        &tmux,
        &format!(
            "#!/bin/sh\nprintf '%s\n' \"$@\" > '{}'\nprintf 'line-1\nline-2\nline-3\nline-4\n'\n",
            args_log.display()
        ),
    );

    let request_log = Arc::new(Mutex::new(String::new()));
    let request_log_for_server = Arc::clone(&request_log);
    let (base_url, server) = start_api_server(1, move |request| {
        *request_log_for_server.lock().expect("request log") = request;
        (
            200,
            response_json("- summary: tmux pane summarized\n- warnings: tail captured"),
        )
    });

    let path = format!(
        "{}:{}",
        temp.display(),
        env::var("PATH").unwrap_or_default()
    );
    let output = Command::new(sparkshell_bin())
        .env("PATH", path)
        .env("OMX_API_BASE_URL", base_url)
        .env("OMX_SPARKSHELL_LINES", "1")
        .arg("--tmux-pane")
        .arg("%17")
        .arg("--tail-lines")
        .arg("400")
        .output()
        .expect("run sparkshell");
    server.join().expect("api server");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("- summary: tmux pane summarized"));
    assert!(stdout.contains("- warnings: tail captured"));

    let tmux_args = fs::read_to_string(args_log).expect("tmux args");
    assert!(tmux_args.contains("capture-pane"));
    assert!(tmux_args.contains("%17"));
    assert!(tmux_args.contains("-400"));

    let request = request_log.lock().expect("request log");
    assert!(request.contains("Command: tmux capture-pane"));
    assert!(request.contains("line-1"));

    let _ = fs::remove_dir_all(temp);
}

#[test]
fn raw_mode_keeps_boundary_output_without_summary() {
    let output = Command::new(sparkshell_bin())
        .env("OMX_SPARKSHELL_LINES", "2")
        .arg("sh")
        .arg("-c")
        .arg("printf 'one\ntwo\n'")
        .output()
        .expect("run sparkshell");

    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout), "one\ntwo\n");
}

#[test]
fn summary_mode_uses_combined_stdout_and_stderr_threshold() {
    let request_log = Arc::new(Mutex::new(String::new()));
    let request_log_for_server = Arc::clone(&request_log);
    let (base_url, server) = start_api_server(1, move |request| {
        *request_log_for_server.lock().expect("request log") = request;
        (
            200,
            response_json("- summary: combined output exceeded threshold"),
        )
    });

    let output = Command::new(sparkshell_bin())
        .env("OMX_API_BASE_URL", base_url)
        .env("OMX_SPARKSHELL_LINES", "2")
        .arg("sh")
        .arg("-c")
        .arg("printf 'one\n' && printf 'warn\nextra\n' >&2")
        .output()
        .expect("run sparkshell");
    server.join().expect("api server");

    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("combined output exceeded threshold"));
    let request = request_log.lock().expect("request log");
    assert!(request.contains("<<<STDERR"));
    assert!(request.contains("warn\\nextra"));
}

#[test]
fn summary_failure_when_api_is_missing_falls_back_to_raw_output() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("reserve port");
    let base_url = format!("http://{}", listener.local_addr().expect("address"));
    drop(listener);

    let output = Command::new(sparkshell_bin())
        .env("OMX_API_BASE_URL", base_url)
        .env("OMX_SPARKSHELL_SUMMARY_TIMEOUT_MS", "500")
        .env("OMX_SPARKSHELL_LINES", "1")
        .arg("/bin/sh")
        .arg("-c")
        .arg("printf 'one\ntwo\n'; printf 'child-err\n' >&2")
        .output()
        .expect("run sparkshell");

    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout), "one\ntwo\n");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("child-err"));
    assert!(stderr.contains("summary unavailable"));
}

#[test]
fn tmux_pane_mode_uses_default_tail_lines_when_not_overridden() {
    let temp = unique_temp_dir("tmux-default-tail");
    let tmux = temp.join("tmux");
    let args_log = temp.join("tmux-args.log");
    write_executable(
        &tmux,
        &format!(
            "#!/bin/sh\nprintf '%s\n' \"$@\" > '{}'\nprintf 'line-1\nline-2\nline-3\n'\n",
            args_log.display()
        ),
    );
    let (base_url, server) = start_api_server(1, |_request| {
        (200, response_json("- summary: used default tmux tail"))
    });

    let path = format!(
        "{}:{}",
        temp.display(),
        env::var("PATH").unwrap_or_default()
    );
    let output = Command::new(sparkshell_bin())
        .env("PATH", path)
        .env("OMX_API_BASE_URL", base_url)
        .env("OMX_SPARKSHELL_LINES", "1")
        .arg("--tmux-pane")
        .arg("%21")
        .output()
        .expect("run sparkshell");
    server.join().expect("api server");

    assert!(output.status.success());
    let tmux_args = fs::read_to_string(args_log).expect("tmux args");
    assert!(tmux_args.contains("-200"));
    assert!(String::from_utf8_lossy(&output.stdout).contains("used default tmux tail"));

    let _ = fs::remove_dir_all(temp);
}

#[test]
fn summary_module_does_not_shell_out_to_codex() {
    let source =
        fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/codex_bridge.rs"))
            .expect("source");
    assert!(!source.contains("Command::new(\"codex\")"));
    assert!(!source.contains(".arg(\"exec\")"));
    assert!(!source.contains("codex exec"));
}

#[test]
fn json_mode_emits_machine_readable_contract() {
    let output = Command::new(sparkshell_bin())
        .arg("--json")
        .arg("sh")
        .arg("-c")
        .arg("printf 'ok\n'")
        .output()
        .expect("run sparkshell");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("\"ok\": true"));
    assert!(stdout.contains("\"mode\": \"command\""));
    assert!(stdout.contains("\"status\": \"ok\""));
    assert!(stdout.contains("\"summary\":"));
    assert!(stdout.contains("\"evidence\":"));
    assert!(stdout.contains("\"raw_hash\":"));
}

#[test]
fn json_mode_reports_failed_command_details() {
    let output = Command::new(sparkshell_bin())
        .arg("--json")
        .arg("sh")
        .arg("-c")
        .arg("printf 'bad\n' >&2; exit 9")
        .output()
        .expect("run sparkshell");

    assert_eq!(output.status.code(), Some(9));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("\"ok\": false"));
    assert!(stdout.contains("\"status\": \"failed\""));
    assert!(stdout.contains("\"exit_code\": 9"));
    assert!(stdout.contains("bad"));
}

#[test]
fn json_mode_classifies_auth_errors() {
    let output = Command::new(sparkshell_bin())
        .arg("--json")
        .arg("sh")
        .arg("-c")
        .arg("printf 'Authorization failed\n' >&2; exit 1")
        .output()
        .expect("run sparkshell");

    assert_eq!(output.status.code(), Some(1));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("\"classification\": \"auth_error\""));
    assert!(stdout.contains("authentication-like error"));
}

#[test]
fn direct_command_preserves_child_json_flag() {
    let temp = unique_temp_dir("child-json-flag");
    let script = temp.join("echo-argv");
    write_executable(
        &script,
        r#"#!/usr/bin/env bash
printf '%s\n' "$@"
"#,
    );

    let output = Command::new(sparkshell_bin())
        .arg(script)
        .arg("--json")
        .arg("value")
        .output()
        .expect("run sparkshell");

    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout), "--json\nvalue\n");
    let _ = fs::remove_dir_all(temp);
}

#[test]
fn team_diagnostics_reads_last_turn_at_heartbeat() {
    let temp = unique_temp_dir("last-turn-heartbeat");
    let worker_dir = temp.join("team/demo/workers/worker-1");
    fs::create_dir_all(&worker_dir).expect("worker dir");
    fs::write(
        worker_dir.join("heartbeat.json"),
        r#"{"last_turn_at":"1970-01-01T00:00:00.000Z"}"#,
    )
    .expect("heartbeat");

    let output = Command::new(sparkshell_bin())
        .env("OMX_TEAM_STATE_ROOT", temp.display().to_string())
        .arg("--json")
        .arg("--team")
        .arg("demo")
        .arg("--worker")
        .arg("worker-1")
        .arg("printf")
        .arg("ok\n")
        .output()
        .expect("run sparkshell");

    assert!(output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("\"classification\": \"stale_heartbeat\"")
    );
    let _ = fs::remove_dir_all(temp);
}

#[test]
fn json_mode_reads_team_state_from_env_root() {
    let temp = unique_temp_dir("team-state");
    let worker_dir = temp.join("team/demo/workers/worker-1");
    fs::create_dir_all(&worker_dir).expect("worker dir");
    fs::write(
        worker_dir.join("status.json"),
        r#"{"state":"busy","task":"in_progress"}"#,
    )
    .expect("status");

    let output = Command::new(sparkshell_bin())
        .env("OMX_TEAM_STATE_ROOT", temp.display().to_string())
        .arg("--json")
        .arg("--team")
        .arg("demo")
        .arg("--worker")
        .arg("worker-1")
        .arg("sh")
        .arg("-c")
        .arg("printf 'quiet\n'")
        .output()
        .expect("run sparkshell");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("\"classification\": \"busy_processing\""));
    assert!(stdout.contains("do not shutdown yet"));

    let _ = fs::remove_dir_all(temp);
}

#[test]
fn pane_json_cache_reports_hits_and_since_last_changes() {
    let temp = unique_temp_dir("pane-cache");
    let tmux = temp.join("tmux");
    let cache = temp.join("cache");
    let pane = temp.join("pane.txt");
    fs::write(&pane, "line-1\nline-2\n").expect("pane");
    write_executable(&tmux, &format!("#!/bin/sh\ncat {}\n", pane.display()));
    let path = format!(
        "{}:{}",
        temp.display(),
        env::var("PATH").unwrap_or_default()
    );

    let first = Command::new(sparkshell_bin())
        .env("PATH", &path)
        .env("OMX_SPARKSHELL_CACHE_DIR", cache.display().to_string())
        .arg("--json")
        .arg("--tmux-pane")
        .arg("%31")
        .output()
        .expect("first");
    assert!(first.status.success());
    assert!(String::from_utf8_lossy(&first.stdout).contains("\"cache_hit\":false"));

    let second = Command::new(sparkshell_bin())
        .env("PATH", &path)
        .env("OMX_SPARKSHELL_CACHE_DIR", cache.display().to_string())
        .arg("--json")
        .arg("--tmux-pane")
        .arg("%31")
        .output()
        .expect("second");
    assert!(second.status.success());
    assert!(String::from_utf8_lossy(&second.stdout).contains("\"cache_hit\":true"));

    fs::write(&pane, "line-1\nline-2\nline-3\n").expect("pane update");
    let third = Command::new(sparkshell_bin())
        .env("PATH", &path)
        .env("OMX_SPARKSHELL_CACHE_DIR", cache.display().to_string())
        .arg("--json")
        .arg("--since-last")
        .arg("--tmux-pane")
        .arg("%31")
        .output()
        .expect("third");
    assert!(third.status.success());
    let stdout = String::from_utf8_lossy(&third.stdout);
    assert!(stdout.contains("\"changed_line_ranges\":[\"3-3\"]"));
    assert!(stdout.contains("new findings since last observation"));
    assert!(stdout.contains("line-3"));

    let _ = fs::remove_dir_all(temp);
}

#[test]
fn raw_mode_preserves_non_utf8_bytes() {
    let temp = unique_temp_dir("raw-non-utf8");
    let script = temp.join("raw-bytes");
    write_executable(
        &script,
        r#"#!/usr/bin/env bash
printf '\xff\xfe\n'
"#,
    );

    let output = Command::new(sparkshell_bin())
        .arg(script)
        .output()
        .expect("run sparkshell");

    assert!(output.status.success());
    assert_eq!(output.stdout, vec![0xff, 0xfe, b'\n']);
    let _ = fs::remove_dir_all(temp);
}

#[test]
fn shell_mode_executes_explicit_shell_and_redacts_json_output() {
    let output = Command::new(sparkshell_bin())
        .arg("--json")
        .arg("--shell")
        .arg("printf 'left && right\n'; printf 'Authorization: Bearer secret-token\n' >&2")
        .output()
        .expect("run sparkshell");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("\"mode\": \"shell\""));
    assert!(stdout.contains("left && right"));
    assert!(stdout.contains("Authorization: Bearer [REDACTED]"));
    assert!(stdout.contains("\"redactions\": {\"count\": 1}"));
}
