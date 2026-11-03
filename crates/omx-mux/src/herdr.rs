use std::env;
use std::path::PathBuf;
use std::process::Command;

use serde::Deserialize;

use crate::types::{MuxAdapter, MuxError, MuxOperation, MuxOutcome, MuxTarget};

/// Herdr control commands answer a JSON envelope; errors are the same
/// envelope shape printed on stderr with a non-zero exit.
#[derive(Debug, Deserialize)]
struct HerdrEnvelope {
    #[serde(default)]
    result: Option<serde_json::Value>,
    #[serde(default)]
    error: Option<HerdrErrorEnvelope>,
}

#[derive(Debug, Deserialize)]
struct HerdrErrorEnvelope {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

/// Herdr pane ids are `wN:pM`; both segments run alphanumeric past 9
/// (`wA:pB`, ...). Unlike tmux `%N` ids they are never reused.
pub fn is_herdr_pane_id(handle: &str) -> bool {
    let (workspace, pane) = match handle.split_once(':') {
        Some(parts) => parts,
        None => return false,
    };
    let workspace_body = workspace.strip_prefix('w').unwrap_or("");
    let pane_body = pane.strip_prefix('p').unwrap_or("");
    !workspace_body.is_empty()
        && !pane_body.is_empty()
        && workspace_body
            .chars()
            .chain(pane_body.chars())
            .all(|ch| ch.is_ascii_alphanumeric())
}

fn env_herdr_binary() -> String {
    // Same trust-pinning as the TypeScript backend (src/team/herdr-session.ts):
    // HERDR_BIN_PATH wins only when it is an absolute path to an existing file.
    match env::var("HERDR_BIN_PATH") {
        Ok(pinned) if PathBuf::from(&pinned).is_absolute() && PathBuf::from(&pinned).is_file() => {
            pinned
        }
        _ => "herdr".to_string(),
    }
}

/// Run a herdr command. Returns stdout on success; a non-zero exit decodes the
/// stderr error envelope into a typed AdapterFailed message.
fn run_herdr(bin: &str, args: &[&str]) -> Result<String, MuxError> {
    let output = Command::new(bin)
        .args(args)
        .output()
        .map_err(|e| MuxError::AdapterFailed(format!("failed to run herdr: {e}")))?;

    if output.status.success() {
        String::from_utf8(output.stdout)
            .map_err(|e| MuxError::AdapterFailed(format!("invalid utf-8 from herdr: {e}")))
    } else {
        Err(herdr_command_error(&output.stderr, args))
    }
}

fn herdr_command_error(stderr: &[u8], args: &[&str]) -> MuxError {
    let stderr_text = String::from_utf8_lossy(stderr);
    let detail = serde_json::from_str::<HerdrEnvelope>(stderr_text.trim())
        .ok()
        .and_then(|envelope| envelope.error)
        .map(|error| {
            format!(
                "herdr_{}: {}",
                error.code.as_deref().unwrap_or("error"),
                error.message.as_deref().unwrap_or("herdr command failed")
            )
        })
        .unwrap_or_else(|| stderr_text.trim().chars().take(300).collect());
    MuxError::AdapterFailed(format!(
        "herdr {} failed: {}",
        args.first().unwrap_or(&""),
        detail
    ))
}

/// Run a herdr control command and return its `result` payload.
fn run_herdr_result(bin: &str, args: &[&str]) -> Result<serde_json::Value, MuxError> {
    let stdout = run_herdr(bin, args)?;
    let envelope = serde_json::from_str::<HerdrEnvelope>(stdout.trim())
        .map_err(|e| MuxError::AdapterFailed(format!("herdr printed non-JSON output: {e}")))?;
    if let Some(error) = envelope.error {
        return Err(MuxError::AdapterFailed(format!(
            "herdr_{}: {}",
            error.code.as_deref().unwrap_or("error"),
            error.message.as_deref().unwrap_or("herdr command failed")
        )));
    }
    envelope.result.ok_or_else(|| {
        MuxError::AdapterFailed(format!(
            "herdr {} returned no result",
            args.first().unwrap_or(&"")
        ))
    })
}

/// Extract a herdr target string from a `MuxTarget`.
fn resolve_target_handle(target: &MuxTarget) -> Result<String, MuxError> {
    match target {
        MuxTarget::DeliveryHandle(handle) => {
            if handle.is_empty() {
                Err(MuxError::InvalidTarget("empty delivery handle".into()))
            } else if !is_herdr_pane_id(handle) {
                Err(MuxError::InvalidTarget(format!(
                    "not a herdr pane id (expected wN:pM): {handle}"
                )))
            } else {
                Ok(handle.clone())
            }
        }
        MuxTarget::Detached => Err(MuxError::InvalidTarget(
            "cannot operate on a detached target".into(),
        )),
    }
}

/// Build the argument list for `herdr pane get` (existence proof).
pub fn build_pane_get_args(pane: &str) -> Vec<String> {
    vec!["pane".into(), "get".into(), pane.into()]
}

/// Build the argument list for `herdr agent prompt` (semantic submit).
pub fn build_agent_prompt_args(pane: &str, text: &str) -> Vec<String> {
    vec!["agent".into(), "prompt".into(), pane.into(), text.into()]
}

/// Build the argument list for `herdr pane read --source recent-unwrapped`.
pub fn build_pane_read_args(pane: &str, visible_lines: usize) -> Vec<String> {
    vec![
        "pane".into(),
        "read".into(),
        pane.into(),
        "--source".into(),
        "recent-unwrapped".into(),
        "--lines".into(),
        visible_lines.to_string(),
    ]
}

/// Build the argument list for `herdr agent list` (liveness inventory).
pub fn build_agent_list_args() -> Vec<String> {
    vec!["agent".into(), "list".into()]
}

/// Build the argument list for `herdr agent attach`.
pub fn build_agent_attach_args(pane: &str) -> Vec<String> {
    vec!["agent".into(), "attach".into(), pane.into()]
}

/// Liveness from an `agent list` envelope: alive iff the pane hosts a live
/// agent (agent entries are cleared when the agent exits).
pub fn liveness_from_agent_list(list_json: &str, pane: &str) -> Result<bool, MuxError> {
    let envelope = serde_json::from_str::<HerdrEnvelope>(list_json.trim())
        .map_err(|e| MuxError::AdapterFailed(format!("herdr printed non-JSON output: {e}")))?;
    let agents = envelope
        .result
        .and_then(|result| result.get("agents").cloned())
        .and_then(|agents| agents.as_array().cloned())
        .unwrap_or_default();
    Ok(agents
        .iter()
        .any(|agent| agent.get("pane_id").and_then(|id| id.as_str()) == Some(pane)))
}

/// MuxAdapter implementation shelling out to the `herdr` CLI (verified against
/// Herdr v0.9.5). Pane-addressed: SendInput goes through `agent prompt`
/// (submission-verified, honors bracketed paste), CaptureTail through
/// `pane read --source recent-unwrapped` (same joined-line semantics as
/// `capture-pane -J`), liveness through the live `agent list` inventory.
#[derive(Debug, Clone)]
pub struct HerdrAdapter {
    bin: String,
}

impl HerdrAdapter {
    pub fn new() -> Self {
        Self {
            bin: env_herdr_binary(),
        }
    }

    /// Pin an explicit herdr binary (tests and trust-pinned deployments).
    pub fn with_bin(bin: impl Into<String>) -> Self {
        Self { bin: bin.into() }
    }

    pub fn status(&self) -> &'static str {
        "herdr adapter ready"
    }

    fn do_resolve_target(&self, target: &MuxTarget) -> Result<MuxOutcome, MuxError> {
        let handle = resolve_target_handle(target)?;
        let args = build_pane_get_args(&handle);
        let str_args: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        // `pane get` keeps answering for closed panes (ids are never reused):
        // this proves the target names a herdr pane, not that it hosts an
        // agent — liveness is a separate operation.
        run_herdr_result(&self.bin, &str_args)?;
        Ok(MuxOutcome::TargetResolved {
            resolved_handle: handle,
        })
    }

    fn do_send_input(
        &self,
        target: &MuxTarget,
        envelope: &crate::types::InputEnvelope,
    ) -> Result<MuxOutcome, MuxError> {
        let handle = resolve_target_handle(target)?;
        let text = envelope.normalized_text();
        let args = build_agent_prompt_args(&handle, &text);
        let str_args: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        // `agent prompt` submits natively: the Enter presses of the submit
        // policy are satisfied by the semantic submission itself.
        run_herdr_result(&self.bin, &str_args)?;
        Ok(MuxOutcome::InputAccepted {
            bytes_written: text.len(),
        })
    }

    fn do_capture_tail(
        &self,
        target: &MuxTarget,
        visible_lines: usize,
    ) -> Result<MuxOutcome, MuxError> {
        let handle = resolve_target_handle(target)?;
        let args = build_pane_read_args(&handle, visible_lines);
        let str_args: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        // `pane read` prints plain text, not the JSON envelope.
        let body = run_herdr(&self.bin, &str_args)?;
        Ok(MuxOutcome::TailCaptured {
            visible_lines,
            body,
        })
    }

    fn do_inspect_liveness(&self, target: &MuxTarget) -> Result<MuxOutcome, MuxError> {
        let handle = resolve_target_handle(target)?;
        let args = build_agent_list_args();
        let str_args: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let result = run_herdr_result(&self.bin, &str_args)?;
        let alive = result
            .get("agents")
            .and_then(|agents| agents.as_array())
            .map(|agents| {
                agents.iter().any(|agent| {
                    agent.get("pane_id").and_then(|id| id.as_str()) == Some(handle.as_str())
                })
            })
            .unwrap_or(false);
        Ok(MuxOutcome::LivenessChecked { alive })
    }

    fn do_attach(&self, target: &MuxTarget) -> Result<MuxOutcome, MuxError> {
        let handle = resolve_target_handle(target)?;
        let args = build_agent_attach_args(&handle);
        let str_args: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        // Interactive: takes over the terminal until the client detaches,
        // mirroring `tmux attach-session`.
        run_herdr(&self.bin, &str_args)?;
        Ok(MuxOutcome::Attached { handle })
    }

    fn do_detach(&self, _target: &MuxTarget) -> Result<MuxOutcome, MuxError> {
        // Detaching is a Herdr TUI keybinding; the CLI exposes no detach, so
        // there is nothing an automation adapter could drive.
        Err(MuxError::Unsupported(
            "herdr detach is an interactive TUI action; the CLI has no detach command".into(),
        ))
    }
}

impl Default for HerdrAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl MuxAdapter for HerdrAdapter {
    fn adapter_name(&self) -> &'static str {
        "herdr"
    }

    fn execute(&self, operation: &MuxOperation) -> Result<MuxOutcome, MuxError> {
        match operation {
            MuxOperation::ResolveTarget { target } => self.do_resolve_target(target),
            MuxOperation::SendInput { target, envelope } => self.do_send_input(target, envelope),
            MuxOperation::CaptureTail {
                target,
                visible_lines,
            } => self.do_capture_tail(target, *visible_lines),
            MuxOperation::InspectLiveness { target } => self.do_inspect_liveness(target),
            MuxOperation::Attach { target } => self.do_attach(target),
            MuxOperation::Detach { target } => self.do_detach(target),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{InputEnvelope, SubmitPolicy};

    #[test]
    fn is_herdr_pane_id_accepts_the_grammar_including_alphanumeric_past_nine() {
        for handle in ["w5:p2", "wA:pB", "w12:p34", "w9:p12"] {
            assert!(is_herdr_pane_id(handle), "{handle} should parse");
        }
        for handle in [
            "%12", "w5", "w5:", ":p2", "x5:p2", "w5:x2", "w-1:p2", "", "w5:p2:q",
        ] {
            assert!(!is_herdr_pane_id(handle), "{handle} should not parse");
        }
    }

    #[test]
    fn resolve_target_handle_rejects_empty_detached_and_tmux_handles() {
        let err = resolve_target_handle(&MuxTarget::DeliveryHandle(String::new()))
            .expect_err("should reject empty");
        assert!(matches!(err, MuxError::InvalidTarget(_)));

        let err = resolve_target_handle(&MuxTarget::Detached).expect_err("should reject detached");
        assert!(matches!(err, MuxError::InvalidTarget(_)));

        let err = resolve_target_handle(&MuxTarget::DeliveryHandle("sess:0.1".into()))
            .expect_err("should reject tmux handles");
        assert!(matches!(err, MuxError::InvalidTarget(_)));
        match err {
            MuxError::InvalidTarget(message) => {
                assert!(message.contains("not a herdr pane id"), "{message}");
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn resolve_target_handle_accepts_valid_pane_id() {
        let handle = resolve_target_handle(&MuxTarget::DeliveryHandle("w5:p2".into()))
            .expect("should accept valid handle");
        assert_eq!(handle, "w5:p2");
    }

    #[test]
    fn build_agent_prompt_args_constructs_correct_args() {
        let args = build_agent_prompt_args("w5:p2", "hello world");
        assert_eq!(args, vec!["agent", "prompt", "w5:p2", "hello world"]);
    }

    #[test]
    fn build_pane_read_args_constructs_correct_args() {
        let args = build_pane_read_args("wA:pB", 80);
        assert_eq!(
            args,
            vec![
                "pane",
                "read",
                "wA:pB",
                "--source",
                "recent-unwrapped",
                "--lines",
                "80"
            ]
        );
    }

    #[test]
    fn build_pane_get_and_list_and_attach_args_are_stable() {
        assert_eq!(build_pane_get_args("w5:p2"), vec!["pane", "get", "w5:p2"]);
        assert_eq!(build_agent_list_args(), vec!["agent", "list"]);
        assert_eq!(
            build_agent_attach_args("w5:p2"),
            vec!["agent", "attach", "w5:p2"]
        );
    }

    #[test]
    fn herdr_command_error_decodes_the_stderr_envelope() {
        let stderr = br#"{"error":{"code":"pane_not_found","message":"pane w99:p1 not found"},"id":"cli:pane:get"}"#;
        match herdr_command_error(stderr, &["pane", "get"]) {
            MuxError::AdapterFailed(detail) => {
                assert!(detail.contains("herdr_pane_not_found"), "{detail}");
                assert!(detail.contains("pane w99:p1 not found"), "{detail}");
            }
            other => panic!("expected AdapterFailed, got {other:?}"),
        }
    }

    #[test]
    fn herdr_command_error_falls_back_to_raw_stderr() {
        match herdr_command_error(b"some raw failure\n", &["pane", "close"]) {
            MuxError::AdapterFailed(detail) => assert!(detail.contains("some raw failure")),
            other => panic!("expected AdapterFailed, got {other:?}"),
        }
    }

    #[test]
    fn liveness_from_agent_list_matches_the_pane_entry() {
        let list = r#"{"id":"cli:agent:list","result":{"agents":[{"name":"omx-a-w1","pane_id":"w5:p2"}],"type":"agent_list"}}"#;
        assert!(liveness_from_agent_list(list, "w5:p2").expect("parse"));
        assert!(!liveness_from_agent_list(list, "w5:p3").expect("parse"));
        assert!(!liveness_from_agent_list(
            r#"{"id":"cli:agent:list","result":{"agents":[],"type":"agent_list"}}"#,
            "w5:p2"
        )
        .expect("parse"));
    }

    #[test]
    fn liveness_from_agent_list_rejects_non_json() {
        let err = liveness_from_agent_list("not json", "w5:p2").expect_err("should reject");
        assert!(matches!(err, MuxError::AdapterFailed(_)));
    }

    #[test]
    fn send_prompt_uses_normalized_text() {
        let envelope = InputEnvelope::new("line1\nline2", SubmitPolicy::enter(2, 100));
        let text = envelope.normalized_text();
        assert_eq!(text, "line1 line2");
        let args = build_agent_prompt_args("w5:p2", &text);
        assert_eq!(args[3], "line1 line2");
    }

    #[test]
    fn adapter_name_is_herdr() {
        let adapter = HerdrAdapter::new();
        assert_eq!(adapter.adapter_name(), "herdr");
    }

    #[test]
    fn status_reports_ready() {
        let adapter = HerdrAdapter::new();
        assert_eq!(adapter.status(), "herdr adapter ready");
    }

    #[test]
    fn execute_rejects_targets_without_shelling_out() {
        let adapter = HerdrAdapter::with_bin("/nonexistent/herdr-binary");
        for operation in [
            MuxOperation::ResolveTarget {
                target: MuxTarget::Detached,
            },
            MuxOperation::ResolveTarget {
                target: MuxTarget::DeliveryHandle("%12".into()),
            },
            MuxOperation::CaptureTail {
                target: MuxTarget::DeliveryHandle("sess:0.1".into()),
                visible_lines: 80,
            },
        ] {
            let err = adapter
                .execute(&operation)
                .expect_err("should reject target");
            assert!(matches!(err, MuxError::InvalidTarget(_)), "{err}");
        }
    }

    #[test]
    fn execute_detach_is_unsupported() {
        let adapter = HerdrAdapter::with_bin("/nonexistent/herdr-binary");
        let err = adapter
            .execute(&MuxOperation::Detach {
                target: MuxTarget::DeliveryHandle("w5:p2".into()),
            })
            .expect_err("detach is unsupported");
        assert!(matches!(err, MuxError::Unsupported(_)), "{err}");
    }
}
