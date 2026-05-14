use omx_api::{http_request, http_request_with_bearer, read_daemon_state};
use serde_json::Value;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn temp_state_file(name: &str) -> std::path::PathBuf {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    std::env::temp_dir().join(format!("omx-api-{name}-{millis}.json"))
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

    let state = (0..50)
        .find_map(|_| {
            let state = read_daemon_state(&state_file).ok().flatten();
            if state.is_none() {
                thread::sleep(Duration::from_millis(20));
            }
            state
        })
        .expect("server wrote daemon state");

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

    let state = (0..50)
        .find_map(|_| {
            let state = read_daemon_state(&state_file).ok().flatten();
            if state.is_none() {
                thread::sleep(Duration::from_millis(20));
            }
            state
        })
        .expect("server wrote daemon state");

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
