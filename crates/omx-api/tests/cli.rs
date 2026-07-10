use omx_api::{http_request, http_request_with_bearer, read_daemon_state};
use serde_json::Value;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn temp_state_file(name: &str) -> std::path::PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "omx-api-{name}-{}-{nanos}-{counter}.json",
        std::process::id()
    ))
}

fn read_http_request_raw(stream: &mut std::net::TcpStream) -> String {
    let mut raw_bytes = Vec::new();
    let mut buffer = [0_u8; 1024];
    let header_end = loop {
        let read = stream.read(&mut buffer).expect("read request");
        assert!(read > 0, "request closed before headers");
        raw_bytes.extend_from_slice(&buffer[..read]);
        if let Some(index) = raw_bytes.windows(4).position(|chunk| chunk == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let head = String::from_utf8_lossy(&raw_bytes[..header_end]).to_string();
    let content_length = head
        .lines()
        .find_map(|line| line.strip_prefix("Content-Length: "))
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(0);
    while raw_bytes.len() < header_end + content_length {
        let read = stream.read(&mut buffer).expect("read body");
        assert!(read > 0, "request closed before body");
        raw_bytes.extend_from_slice(&buffer[..read]);
    }
    String::from_utf8_lossy(&raw_bytes).to_string()
}

fn fake_sse_text_response(text: &str) -> String {
    format!(
        "event: response.output_text.delta\ndata: {{\"type\":\"response.output_text.delta\",\"delta\":\"{text}\"}}\n\ndata: [DONE]\n\n"
    )
}

fn real_private_once_request(
    path: &str,
    body: Value,
    upstream_sse_body: String,
) -> (String, String) {
    let bin = env!("CARGO_BIN_EXE_omx-api");
    let backend = TcpListener::bind(("127.0.0.1", 0)).expect("bind fake upstream");
    let backend_port = backend.local_addr().expect("fake upstream addr").port();
    let backend_handle = thread::spawn(move || {
        let (mut stream, _) = backend.accept().expect("accept fake upstream request");
        let raw = read_http_request_raw(&mut stream);
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            upstream_sse_body.len(),
            upstream_sse_body,
        )
        .expect("write fake upstream response");
        raw
    });

    let state_file = temp_state_file("real-private-e2e");
    let mut child = Command::new(bin)
        .args([
            "serve",
            "--backend",
            "real-private",
            "--port",
            "0",
            "--once",
            "--state-file",
            state_file.to_str().unwrap(),
        ])
        .env("OMX_API_CODEX_OAUTH_TOKEN", "oauth-token-for-e2e")
        .env("OMX_API_CODEX_ACCOUNT_ID", "account-e2e")
        .env("OMX_API_CODEX_SESSION_ID", "session-e2e")
        .env("OMX_API_CODEX_THREAD_ID", "thread-e2e")
        .env(
            "OMX_API_PRIVATE_BACKEND_URL",
            format!("http://127.0.0.1:{backend_port}/backend-api/codex"),
        )
        .env(
            "OMX_API_PRIVATE_IMAGE_BACKEND_URL",
            format!("http://127.0.0.1:{backend_port}/backend-api/codex"),
        )
        .env("OMX_API_IMAGE_MODEL", "omx-private-image-test")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn real-private omx-api serve");

    let state = wait_for_daemon_state(&state_file, &mut child);
    let token = state
        .local_bearer_token_file
        .as_ref()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .expect("real-private serve should write a local bearer token");
    let payload = serde_json::to_vec(&body).expect("request JSON");
    let response = http_request_with_bearer(
        &state.host,
        state.port,
        "POST",
        path,
        Some(&payload),
        Some(token.trim()),
    )
    .unwrap();

    let exit = child
        .wait_timeout(Duration::from_secs(2))
        .expect("wait for real-private child");
    assert!(exit.is_some(), "real-private --once server did not exit");
    let upstream_raw = backend_handle.join().expect("fake upstream thread");
    (response, upstream_raw)
}

fn wait_for_daemon_state(
    state_file: &std::path::Path,
    child: &mut std::process::Child,
) -> omx_api::DaemonState {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(state) = read_daemon_state(state_file).ok().flatten() {
            return state;
        }
        if let Ok(Some(status)) = child.try_wait() {
            let mut stderr = String::new();
            if let Some(mut pipe) = child.stderr.take() {
                use std::io::Read;
                let _ = pipe.read_to_string(&mut stderr);
            }
            panic!("server exited before writing daemon state: status={status}; stderr={stderr}");
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("server did not write daemon state within 5s at {state_file:?}");
        }
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn binary_system_dry_run_and_generate_emit_json() {
    let bin = env!("CARGO_BIN_EXE_omx-api");
    for action in ["dry-run", "generate"] {
        let output = Command::new(bin)
            .args(["system", action])
            .output()
            .expect("run omx-api system action");
        assert!(
            output.status.success(),
            "stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let value: Value = serde_json::from_slice(&output.stdout).expect("json stdout");
        assert_eq!(value["ok"], true);
        assert_eq!(value["action"], format!("system.{action}"));
    }
}

#[test]
fn binary_real_private_image_json_uses_fake_upstream_e2e() {
    let (response, upstream_raw) = real_private_once_request(
        "/v1/images/generations",
        serde_json::json!({
            "prompt": "image through upstream",
            "size": "1024x1024"
        }),
        "event: image_generation.completed\ndata: {\"type\":\"image_generation.completed\",\"b64_json\":\"ZmFrZS1pbWFnZQ==\",\"revised_prompt\":\"image through upstream\"}\n\ndata: [DONE]\n\n".to_string(),
    );

    assert!(response.contains("200 OK"), "{response}");
    let body = response.split("\r\n\r\n").nth(1).expect("response body");
    let value: Value = serde_json::from_str(body).expect("image response JSON");
    assert_eq!(value["backend"], "real-private");
    assert_eq!(value["data"][0]["b64_json"], "ZmFrZS1pbWFnZQ==");
    assert_eq!(value["data"][0]["revised_prompt"], "image through upstream");

    assert!(upstream_raw.starts_with("POST /backend-api/codex/images/generations HTTP/1.1"));
    assert!(upstream_raw.contains("Authorization: Bearer oauth-token-for-e2e\r\n"));
    let forwarded_body = upstream_raw
        .split("\r\n\r\n")
        .nth(1)
        .expect("upstream body");
    let forwarded_json: Value = serde_json::from_str(forwarded_body).expect("upstream JSON");
    assert_eq!(forwarded_json["model"], "omx-private-image-test");
    assert_eq!(forwarded_json["prompt"], "image through upstream");
    assert_eq!(forwarded_json["size"], "1024x1024");
}

#[test]
fn binary_real_private_responses_json_uses_fake_upstream_e2e() {
    let (response, upstream_raw) = real_private_once_request(
        "/v1/responses",
        serde_json::json!({
            "model": "gpt-5.6-terra",
            "input": "hello from integration",
            "reasoning": {"effort": "low"},
            "instructions": "Use fake upstream."
        }),
        fake_sse_text_response("upstream-text-json"),
    );

    assert!(response.contains("200 OK"), "{response}");
    let body = response.split("\r\n\r\n").nth(1).expect("response body");
    let value: Value = serde_json::from_str(body).expect("response JSON");
    assert_eq!(value["object"], "response");
    assert_eq!(value["backend"], "real-private");
    assert_eq!(value["output_text"], "upstream-text-json");
    assert_eq!(
        value["choices"][0]["message"]["content"],
        "upstream-text-json"
    );

    assert!(upstream_raw.starts_with("POST /backend-api/codex/responses HTTP/1.1"));
    assert!(upstream_raw.contains("Accept: text/event-stream\r\n"));
    assert!(upstream_raw.contains("Authorization: Bearer oauth-token-for-e2e\r\n"));
    assert!(upstream_raw.contains("ChatGPT-Account-ID: account-e2e\r\n"));
    assert!(upstream_raw.contains("originator: codex_cli_rs\r\n"));
    let forwarded_body = upstream_raw
        .split("\r\n\r\n")
        .nth(1)
        .expect("upstream body");
    let forwarded_json: Value = serde_json::from_str(forwarded_body).expect("upstream JSON");
    assert_eq!(forwarded_json["model"], "gpt-5.6-terra");
    assert_eq!(forwarded_json["stream"], true);
    assert_eq!(
        forwarded_json["reasoning"],
        serde_json::json!({"effort": "low"})
    );
    assert_eq!(forwarded_json["instructions"], "Use fake upstream.");
    assert_eq!(forwarded_json["prompt_cache_key"], "thread-e2e");
    assert_eq!(
        forwarded_json["input"][0]["content"][0]["text"],
        "hello from integration"
    );
}

#[test]
fn binary_real_private_responses_sse_uses_fake_upstream_e2e() {
    let (response, upstream_raw) = real_private_once_request(
        "/v1/responses",
        serde_json::json!({
            "model": "gpt-5.6-terra",
            "input": "stream please",
            "stream": true
        }),
        fake_sse_text_response("upstream-text-sse"),
    );

    assert!(response.contains("200 OK"), "{response}");
    assert!(
        response.contains("Content-Type: text/event-stream"),
        "{response}"
    );
    assert!(response.contains("event: response.created"), "{response}");
    assert!(
        response.contains("event: response.output_text.delta"),
        "{response}"
    );
    assert!(response.contains("upstream-text-sse"), "{response}");
    assert!(response.contains("data: [DONE]"), "{response}");

    let forwarded_body = upstream_raw
        .split("\r\n\r\n")
        .nth(1)
        .expect("upstream body");
    let forwarded_json: Value = serde_json::from_str(forwarded_body).expect("upstream JSON");
    assert_eq!(forwarded_json["stream"], true);
    assert_eq!(
        forwarded_json["input"][0]["content"][0]["text"],
        "stream please"
    );
}

#[test]
fn binary_real_private_chat_sse_uses_chat_chunk_shape_with_fake_upstream_e2e() {
    let (response, upstream_raw) = real_private_once_request(
        "/v1/chat/completions",
        serde_json::json!({
            "model": "gpt-5.6-terra",
            "messages": [{"role": "user", "content": "chat through upstream"}],
            "stream": true
        }),
        fake_sse_text_response("chat-upstream-text"),
    );

    assert!(response.contains("200 OK"), "{response}");
    assert!(
        response.contains("Content-Type: text/event-stream"),
        "{response}"
    );
    assert!(
        response.contains("\"object\":\"chat.completion.chunk\""),
        "{response}"
    );
    assert!(response.contains("chat-upstream-text"), "{response}");
    assert!(response.contains("data: [DONE]"), "{response}");

    let forwarded_body = upstream_raw
        .split("\r\n\r\n")
        .nth(1)
        .expect("upstream body");
    let forwarded_json: Value = serde_json::from_str(forwarded_body).expect("upstream JSON");
    assert_eq!(forwarded_json["stream"], true);
    assert_eq!(
        forwarded_json["input"][0]["content"][0]["text"],
        "chat through upstream"
    );
}

#[test]
fn binary_serve_status_and_stop_work_together() {
    let bin = env!("CARGO_BIN_EXE_omx-api");
    let state_file = temp_state_file("serve-status-stop");
    let mut child = Command::new(bin)
        .args([
            "serve",
            "--port",
            "0",
            "--state-file",
            state_file.to_str().unwrap(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn omx-api serve");

    let state = wait_for_daemon_state(&state_file, &mut child);

    let status = Command::new(bin)
        .args(["status", "--state-file", state_file.to_str().unwrap()])
        .output()
        .expect("run status");
    assert!(status.status.success());
    let status_json: Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(status_json["status"], "running");

    let health = http_request(&state.host, state.port, "GET", "/health", None).unwrap();
    assert!(health.contains("200 OK"));
    assert!(health.contains("\"status\":\"ok\""));

    let stop = Command::new(bin)
        .args(["stop", "--state-file", state_file.to_str().unwrap()])
        .output()
        .expect("run stop");
    assert!(
        stop.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&stop.stderr)
    );

    let exit = child
        .wait_timeout(Duration::from_secs(2))
        .expect("wait for child");
    if exit.is_none() {
        let _ = child.kill();
        panic!("server did not stop after stop command");
    }
}

#[test]
fn binary_local_bearer_gate_rejects_missing_authorization() {
    let bin = env!("CARGO_BIN_EXE_omx-api");
    let state_file = temp_state_file("bearer-required");
    let mut child = Command::new(bin)
        .args([
            "serve",
            "--port",
            "0",
            "--once",
            "--state-file",
            state_file.to_str().unwrap(),
        ])
        .env("OMX_API_REQUIRE_LOCAL_BEARER", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn omx-api serve");

    let state = wait_for_daemon_state(&state_file, &mut child);

    let response = http_request(&state.host, state.port, "GET", "/v1/models", None).unwrap();
    assert!(response.contains("401 Unauthorized"), "{response}");
    assert!(
        response.contains("local bearer token required"),
        "{response}"
    );

    let exit = child
        .wait_timeout(Duration::from_secs(2))
        .expect("wait for child");
    assert!(exit.is_some(), "server did not exit after --once request");
}

#[test]
fn binary_real_private_serve_generates_bearer_and_rejects_missing_authorization() {
    let bin = env!("CARGO_BIN_EXE_omx-api");
    let state_file = temp_state_file("real-private-bearer-default");
    let mut child = Command::new(bin)
        .args([
            "serve",
            "--backend",
            "real-private",
            "--port",
            "0",
            "--once",
            "--state-file",
            state_file.to_str().unwrap(),
        ])
        .env("OMX_API_REAL_PRIVATE_RESPONSE_TEXT", "fixture")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn omx-api real-private serve");

    let state = wait_for_daemon_state(&state_file, &mut child);
    assert!(
        state.local_bearer_token_file.is_some(),
        "real-private direct serve should persist a bearer token file"
    );

    let response = http_request(&state.host, state.port, "GET", "/v1/models", None).unwrap();
    assert!(response.contains("401 Unauthorized"), "{response}");
    assert!(
        response.contains("matching local bearer token required"),
        "{response}"
    );

    let exit = child
        .wait_timeout(Duration::from_secs(2))
        .expect("wait for child");
    assert!(exit.is_some(), "server did not exit after --once request");
}

#[test]
fn binary_daemon_token_is_not_printed_but_controls_generate_and_stop() {
    let bin = env!("CARGO_BIN_EXE_omx-api");
    let state_file = temp_state_file("daemon-token");
    let start = Command::new(bin)
        .args([
            "serve",
            "--port",
            "0",
            "--daemon",
            "--state-file",
            state_file.to_str().unwrap(),
        ])
        .output()
        .expect("start daemon");
    assert!(
        start.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&start.stderr)
    );
    let stdout = String::from_utf8_lossy(&start.stdout);
    assert!(!stdout.contains("local_bearer_token\":"), "{stdout}");

    let state = read_daemon_state(&state_file).unwrap().unwrap();
    assert!(state.local_bearer_token.is_none());
    let token_file = state
        .local_bearer_token_file
        .clone()
        .expect("token file path");
    let token = std::fs::read_to_string(&token_file).expect("token file");
    assert!(!stdout.contains(token.trim()), "daemon stdout leaked token");

    let unauthorized = http_request(&state.host, state.port, "GET", "/v1/models", None).unwrap();
    assert!(unauthorized.contains("401 Unauthorized"), "{unauthorized}");
    let authorized = http_request_with_bearer(
        &state.host,
        state.port,
        "GET",
        "/v1/models",
        None,
        Some(token.trim()),
    )
    .unwrap();
    assert!(authorized.contains("200 OK"), "{authorized}");

    let generated = Command::new(bin)
        .args([
            "generate",
            "text",
            "hello",
            "--state-file",
            state_file.to_str().unwrap(),
        ])
        .output()
        .expect("generate through daemon");
    assert!(
        generated.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&generated.stderr)
    );
    assert!(String::from_utf8_lossy(&generated.stdout).contains("omx mock response"));

    let stop = Command::new(bin)
        .args(["stop", "--state-file", state_file.to_str().unwrap()])
        .output()
        .expect("stop daemon");
    assert!(
        stop.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&stop.stderr)
    );
    assert!(!token_file.exists(), "token file should be removed on stop");
}

#[test]
fn binary_rejects_non_loopback_host() {
    let bin = env!("CARGO_BIN_EXE_omx-api");
    let output = Command::new(bin)
        .args(["serve", "--host", "0.0.0.0", "--once"])
        .output()
        .expect("run omx-api serve");
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("localhost-only"));
}

trait WaitTimeout {
    fn wait_timeout(
        &mut self,
        timeout: Duration,
    ) -> std::io::Result<Option<std::process::ExitStatus>>;
}

impl WaitTimeout for std::process::Child {
    fn wait_timeout(
        &mut self,
        timeout: Duration,
    ) -> std::io::Result<Option<std::process::ExitStatus>> {
        let start = std::time::Instant::now();
        loop {
            if let Some(status) = self.try_wait()? {
                return Ok(Some(status));
            }
            if start.elapsed() >= timeout {
                return Ok(None);
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
}
