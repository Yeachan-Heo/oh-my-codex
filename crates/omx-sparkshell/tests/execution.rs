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
