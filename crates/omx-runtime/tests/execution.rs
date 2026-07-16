use std::process::Command;

#[test]
fn schema_subcommand_prints_contract_summary() {
    let output = Command::new(env!("CARGO_BIN_EXE_omx-runtime"))
        .arg("schema")
        .output()
        .expect("ran omx-runtime");

    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("utf8 stdout");
    assert!(stdout.contains("runtime-schema=1"));
    assert!(stdout.contains("acquire-authority"));
    assert!(stdout.contains("dispatch-queued"));
    assert!(stdout.contains("transport=tmux"));
    assert!(stdout.contains("queue-transition=notified"));
}

#[test]
fn schema_json_subcommand_prints_valid_json() {
    let output = Command::new(env!("CARGO_BIN_EXE_omx-runtime"))
        .args(["schema", "--json"])
        .output()
        .expect("ran omx-runtime");

    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("utf8 stdout");
    let parsed: serde_json::Value = serde_json::from_str(&stdout).expect("valid JSON");
    assert_eq!(parsed["schema_version"], 1);
    assert!(parsed["commands"].is_array());
    assert!(parsed["events"].is_array());
}

#[test]
fn snapshot_subcommand_prints_runtime_snapshot() {
    let output = Command::new(env!("CARGO_BIN_EXE_omx-runtime"))
        .arg("snapshot")
        .output()
        .expect("ran omx-runtime");

    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("utf8 stdout");
    assert!(stdout.contains("authority="));
    assert!(stdout.contains("readiness=blocked"));
}

#[test]
fn snapshot_json_subcommand_prints_valid_json() {
    let output = Command::new(env!("CARGO_BIN_EXE_omx-runtime"))
        .args(["snapshot", "--json"])
        .output()
        .expect("ran omx-runtime");

    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("utf8 stdout");
    let parsed: serde_json::Value = serde_json::from_str(&stdout).expect("valid JSON");
    assert_eq!(parsed["schema_version"], 1);
    assert!(parsed["authority"].is_object());
    assert!(parsed["backlog"].is_object());
    assert!(parsed["replay"].is_object());
    assert!(parsed["readiness"].is_object());
    assert_eq!(parsed["readiness"]["ready"], false);
}

#[test]
fn mux_contract_subcommand_reports_adapter_status() {
    let output = Command::new(env!("CARGO_BIN_EXE_omx-runtime"))
        .arg("mux-contract")
        .output()
        .expect("ran omx-runtime");

    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("utf8 stdout");
    assert!(stdout.contains("adapter-status=tmux adapter ready"));
    assert!(stdout.contains("resolve-target"));
    assert!(stdout.contains("submit-policy=enter(presses=2, delay_ms=100)"));
    assert!(stdout.contains("confirmation=Confirmed"));
}

#[test]
fn exec_subcommand_processes_json_command() {
    let cmd_json = r#"{"command":"CaptureSnapshot"}"#;
    let output = Command::new(env!("CARGO_BIN_EXE_omx-runtime"))
        .args(["exec", cmd_json])
        .output()
        .expect("ran omx-runtime");

    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("utf8 stdout");
    let parsed: serde_json::Value = serde_json::from_str(&stdout).expect("valid JSON");
    assert_eq!(parsed["event"], "SnapshotCaptured");
}

#[test]
fn exec_acquire_authority_returns_event() {
    let cmd_json = r#"{"command":"AcquireAuthority","owner":"w1","lease_id":"l1","leased_until":"2026-03-19T02:00:00Z"}"#;
    let output = Command::new(env!("CARGO_BIN_EXE_omx-runtime"))
        .args(["exec", cmd_json])
        .output()
        .expect("ran omx-runtime");

    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("utf8 stdout");
    let parsed: serde_json::Value = serde_json::from_str(&stdout).expect("valid JSON");
    assert_eq!(parsed["event"], "AuthorityAcquired");
    assert_eq!(parsed["owner"], "w1");
}

#[test]
fn exec_invalid_json_fails() {
    let output = Command::new(env!("CARGO_BIN_EXE_omx-runtime"))
        .args(["exec", "not-json"])
        .output()
        .expect("ran omx-runtime");

    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).expect("utf8 stderr");
    assert!(stderr.contains("invalid JSON"));
}

#[test]
fn init_creates_state_directory() {
    let dir = std::env::temp_dir().join("omx-runtime-test-init");
    let _ = std::fs::remove_dir_all(&dir);

    let output = Command::new(env!("CARGO_BIN_EXE_omx-runtime"))
        .args(["init", dir.to_str().unwrap()])
        .output()
        .expect("ran omx-runtime");

    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("utf8 stdout");
    assert!(stdout.contains("initialized state directory"));

    // Verify files were created
    assert!(dir.join("snapshot.json").exists());
    assert!(dir.join("events.json").exists());

    // Verify snapshot.json is valid JSON
    let snapshot_contents = std::fs::read_to_string(dir.join("snapshot.json")).unwrap();
    let parsed: serde_json::Value =
        serde_json::from_str(&snapshot_contents).expect("valid snapshot JSON");
    assert_eq!(parsed["schema_version"], 1);
    assert_eq!(parsed["readiness"]["ready"], false);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn exec_with_state_dir_persists() {
    let dir = std::env::temp_dir().join("omx-runtime-test-exec-persist");
    let _ = std::fs::remove_dir_all(&dir);

    let cmd_json = r#"{"command":"AcquireAuthority","owner":"w1","lease_id":"l1","leased_until":"2026-03-19T02:00:00Z"}"#;
    let state_arg = format!("--state-dir={}", dir.display());

    let output = Command::new(env!("CARGO_BIN_EXE_omx-runtime"))
        .args(["exec", cmd_json, &state_arg])
        .output()
        .expect("ran omx-runtime");

    assert!(output.status.success());

    // Verify snapshot was persisted with authority
    let snapshot_contents = std::fs::read_to_string(dir.join("snapshot.json")).unwrap();
    let parsed: serde_json::Value =
        serde_json::from_str(&snapshot_contents).expect("valid snapshot JSON");
    assert_eq!(parsed["authority"]["owner"], "w1");
    assert_eq!(parsed["readiness"]["ready"], true);

    // Verify events were persisted
    let events_contents = std::fs::read_to_string(dir.join("events.json")).unwrap();
    let events: serde_json::Value =
        serde_json::from_str(&events_contents).expect("valid events JSON");
    assert!(events.is_array());
    assert_eq!(events.as_array().unwrap().len(), 1);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn exec_rejects_missing_seen_ledger_after_persisted_dispatch_history() {
    let dir = std::env::temp_dir().join("omx-runtime-test-exec-missing-seen-ledger");
    let _ = std::fs::remove_dir_all(&dir);
    let state_arg = format!("--state-dir={}", dir.display());
    let queued = Command::new(env!("CARGO_BIN_EXE_omx-runtime"))
        .args([
            "exec",
            r#"{"command":"QueueDispatch","request_id":"request-1","target":"worker"}"#,
            &state_arg,
        ])
        .output()
        .expect("queued dispatch");
    assert!(queued.status.success());
    std::fs::remove_file(dir.join("dispatch-seen.json")).expect("removed seen ledger");

    let reloaded = Command::new(env!("CARGO_BIN_EXE_omx-runtime"))
        .args(["exec", r#"{"command":"CaptureSnapshot"}"#, &state_arg])
        .output()
        .expect("reloaded persisted state");
    assert!(!reloaded.status.success());
    assert!(String::from_utf8_lossy(&reloaded.stderr).contains("missing dispatch seen ledger"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn exec_ignores_dispatch_compat_without_authoritative_runtime_state() {
    let dir = std::env::temp_dir().join("omx-runtime-test-dispatch-compat-only");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("dispatch.json"), "[]\n").unwrap();

    let cmd_json = r#"{"command":"CaptureSnapshot"}"#;
    let state_arg = format!("--state-dir={}", dir.display());
    let output = Command::new(env!("CARGO_BIN_EXE_omx-runtime"))
        .args(["exec", cmd_json, &state_arg])
        .output()
        .expect("ran omx-runtime");

    assert!(
        output.status.success(),
        "dispatch compatibility output must not poison fresh authoritative state: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(dir.join("events.json").exists());
    assert!(dir.join("snapshot.json").exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn snapshot_from_state_dir_reads_persisted_state() {
    let dir = std::env::temp_dir().join("omx-runtime-test-snapshot-statedir");
    let _ = std::fs::remove_dir_all(&dir);

    // First: init and exec to create state
    Command::new(env!("CARGO_BIN_EXE_omx-runtime"))
        .args(["init", dir.to_str().unwrap()])
        .output()
        .expect("init");

    let cmd_json = r#"{"command":"AcquireAuthority","owner":"w1","lease_id":"l1","leased_until":"2026-03-19T02:00:00Z"}"#;
    let state_arg = format!("--state-dir={}", dir.display());
    Command::new(env!("CARGO_BIN_EXE_omx-runtime"))
        .args(["exec", cmd_json, &state_arg])
        .output()
        .expect("exec");

    // Then: snapshot --json with state-dir
    let output = Command::new(env!("CARGO_BIN_EXE_omx-runtime"))
        .args(["snapshot", "--json", &state_arg])
        .output()
        .expect("ran omx-runtime");

    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("utf8 stdout");
    let parsed: serde_json::Value = serde_json::from_str(&stdout).expect("valid JSON");
    assert_eq!(parsed["authority"]["owner"], "w1");
    assert_eq!(parsed["readiness"]["ready"], true);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn exec_compact_immediately_persists_only_nonterminal_dispatch_records() {
    let dir = std::env::temp_dir().join("omx-runtime-test-exec-compact-dispatch");
    let _ = std::fs::remove_dir_all(&dir);
    let state_arg = format!("--state-dir={}", dir.display());
    let run_exec = |json: &str, compact: bool| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_omx-runtime"));
        command.args(["exec", json, &state_arg]);
        if compact {
            command.arg("--compact");
        }
        let output = command.output().expect("ran omx-runtime");
        assert!(
            output.status.success(),
            "exec failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    };

    run_exec(
        r#"{"command":"QueueDispatch","request_id":"pending","target":"worker-pending"}"#,
        false,
    );
    run_exec(
        r#"{"command":"QueueDispatch","request_id":"notified","target":"worker-notified"}"#,
        false,
    );
    run_exec(
        r#"{"command":"MarkNotified","request_id":"notified","channel":"tmux"}"#,
        false,
    );
    run_exec(
        r#"{"command":"QueueDispatch","request_id":"delivered","target":"worker-delivered"}"#,
        false,
    );
    run_exec(
        r#"{"command":"MarkNotified","request_id":"delivered","channel":"tmux"}"#,
        false,
    );
    run_exec(
        r#"{"command":"MarkDelivered","request_id":"delivered"}"#,
        false,
    );
    run_exec(r#"{"command":"CaptureSnapshot"}"#, false);
    run_exec(
        r#"{"command":"QueueDispatch","request_id":"failed","target":"worker-failed"}"#,
        false,
    );
    run_exec(
        r#"{"command":"MarkFailed","request_id":"failed","reason":"target unavailable"}"#,
        true,
    );

    let duplicate = Command::new(env!("CARGO_BIN_EXE_omx-runtime"))
        .args([
            "exec",
            r#"{"command":"QueueDispatch","request_id":"failed","target":"replacement"}"#,
            &state_arg,
        ])
        .output()
        .expect("ran duplicate dispatch exec");
    assert!(!duplicate.status.success());
    assert!(String::from_utf8_lossy(&duplicate.stderr)
        .contains("duplicate dispatch request id: failed"));
    assert!(dir.join("dispatch-seen.json").exists());

    let dispatch: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("dispatch.json")).expect("read immediate dispatch view"),
    )
    .expect("valid dispatch JSON");
    let records = dispatch["records"]
        .as_array()
        .expect("dispatch records array");
    assert_eq!(records.len(), 2);
    assert_eq!(records[0]["request_id"], "pending");
    assert_eq!(records[0]["status"], "pending");
    assert_eq!(records[1]["request_id"], "notified");
    assert_eq!(records[1]["status"], "notified");

    run_exec(r#"{"command":"CaptureSnapshot"}"#, false);
    let reloaded_dispatch: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("dispatch.json"))
            .expect("read reload-persisted dispatch view"),
    )
    .expect("valid reload-persisted dispatch JSON");
    let reloaded_records = reloaded_dispatch["records"]
        .as_array()
        .expect("reload-persisted dispatch records array");
    assert_eq!(reloaded_records.len(), records.len());
    for (immediate, reloaded) in records.iter().zip(reloaded_records) {
        for field in ["request_id", "target", "status", "metadata", "reason"] {
            assert_eq!(reloaded[field], immediate[field], "semantic field {field}");
        }
    }

    let snapshot: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("snapshot.json"))
            .expect("read reload-persisted snapshot"),
    )
    .expect("valid reload-persisted snapshot JSON");
    assert_eq!(snapshot["backlog"]["pending"], 1);
    assert_eq!(snapshot["backlog"]["notified"], 1);
    assert_eq!(snapshot["backlog"]["delivered"], 0);
    assert_eq!(snapshot["backlog"]["failed"], 0);

    let events: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("events.json")).expect("read compacted events"),
    )
    .expect("valid events JSON");
    let events = events.as_array().expect("events array");
    assert!(events
        .iter()
        .any(|event| event["event"] == "SnapshotCaptured"));
    assert!(events
        .iter()
        .all(|event| { event["request_id"] != "delivered" && event["request_id"] != "failed" }));

    let event_request_ids: Vec<&str> = events
        .iter()
        .filter_map(|event| event["request_id"].as_str())
        .collect();
    assert_eq!(event_request_ids, vec!["pending", "notified", "notified"]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn concurrent_exec_queue_accepts_exactly_one_request_id() {
    let dir = std::env::temp_dir().join("omx-runtime-test-concurrent-dispatch-id");
    let _ = std::fs::remove_dir_all(&dir);
    let state_arg = format!("--state-dir={}", dir.display());
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let mut workers = Vec::new();
    for target in ["worker-a", "worker-b"] {
        let barrier = std::sync::Arc::clone(&barrier);
        let state_arg = state_arg.clone();
        workers.push(std::thread::spawn(move || {
            barrier.wait();
            Command::new(env!("CARGO_BIN_EXE_omx-runtime"))
                .args([
                    "exec",
                    &format!(
                        r#"{{"command":"QueueDispatch","request_id":"concurrent","target":"{target}"}}"#
                    ),
                    &state_arg,
                ])
                .output()
                .expect("ran concurrent dispatch exec")
                .status
                .success()
        }));
    }
    barrier.wait();
    assert_eq!(
        workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .filter(|accepted| *accepted)
            .count(),
        1
    );
    let dispatch: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("dispatch.json")).expect("read dispatch view"),
    )
    .expect("valid dispatch JSON");
    assert_eq!(dispatch["records"].as_array().unwrap().len(), 1);
    assert_eq!(dispatch["records"][0]["request_id"], "concurrent");
    let _ = std::fs::remove_dir_all(&dir);
}
