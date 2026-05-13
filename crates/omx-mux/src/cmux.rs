use std::env;
use std::process::Command;
use std::thread;
use std::time::Duration;

use crate::types::{MuxAdapter, MuxError, MuxOperation, MuxOutcome, MuxTarget, SubmitPolicy};

fn cmux_binary() -> String {
    env::var("OMX_CMUX_BIN")
        .or_else(|_| env::var("OMX_MUX_BIN"))
        .unwrap_or_else(|_| "cmux".to_string())
}

fn run_cmux(args: &[&str]) -> Result<String, MuxError> {
    let binary = cmux_binary();
    let output = Command::new(&binary)
        .args(args)
        .output()
        .map_err(|e| MuxError::AdapterFailed(format!("failed to run {binary}: {e}")))?;

    if output.status.success() {
        String::from_utf8(output.stdout)
            .map_err(|e| MuxError::AdapterFailed(format!("invalid utf-8 from cmux: {e}")))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(MuxError::AdapterFailed(format!(
            "cmux {} failed: {}",
            args.first().unwrap_or(&""),
            stderr.trim()
        )))
    }
}

fn resolve_target_handle(target: &MuxTarget) -> Result<String, MuxError> {
    match target {
        MuxTarget::DeliveryHandle(handle) => {
            if handle.is_empty() {
                Err(MuxError::InvalidTarget("empty cmux surface handle".into()))
            } else {
                Ok(handle.clone())
            }
        }
        MuxTarget::Detached => Err(MuxError::InvalidTarget(
            "cannot operate on a detached cmux target".into(),
        )),
    }
}

pub(crate) fn build_cmux_send_args<'a>(target: &'a str, text: &'a str) -> Vec<&'a str> {
    vec!["send", "--surface", target, text]
}

pub(crate) fn build_cmux_enter_key_args(target: &str) -> Vec<String> {
    vec![
        "send-key".into(),
        "--surface".into(),
        target.into(),
        "Enter".into(),
    ]
}

pub fn build_cmux_capture_pane_args(target: &str, visible_lines: usize) -> Vec<String> {
    vec![
        "capture-pane".into(),
        "--surface".into(),
        target.into(),
        "--scrollback".into(),
        "--lines".into(),
        visible_lines.to_string(),
    ]
}

#[derive(Debug, Clone, Copy, Default)]
pub struct CmuxAdapter;

impl CmuxAdapter {
    pub fn new() -> Self {
        Self
    }

    pub fn status(&self) -> &'static str {
        "cmux adapter ready"
    }

    fn do_resolve_target(&self, target: &MuxTarget) -> Result<MuxOutcome, MuxError> {
        let handle = resolve_target_handle(target)?;
        run_cmux(&["read-screen", "--surface", &handle, "--lines", "1"])?;
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

        let args = build_cmux_send_args(&handle, &text);
        run_cmux(&args)?;

        if let SubmitPolicy::Enter { presses, delay_ms } = &envelope.submit {
            for i in 0..*presses {
                if i > 0 && *delay_ms > 0 {
                    thread::sleep(Duration::from_millis(*delay_ms));
                }
                let enter_args = build_cmux_enter_key_args(&handle);
                let str_args: Vec<&str> = enter_args.iter().map(|s| s.as_str()).collect();
                run_cmux(&str_args)?;
            }
        }

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
        let args = build_cmux_capture_pane_args(&handle, visible_lines);
        let str_args: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let body = run_cmux(&str_args)?;

        Ok(MuxOutcome::TailCaptured {
            visible_lines,
            body,
        })
    }

    fn do_inspect_liveness(&self, target: &MuxTarget) -> Result<MuxOutcome, MuxError> {
        let handle = resolve_target_handle(target)?;
        let alive = run_cmux(&["read-screen", "--surface", &handle, "--lines", "1"]).is_ok();
        Ok(MuxOutcome::LivenessChecked { alive })
    }
}

impl MuxAdapter for CmuxAdapter {
    fn adapter_name(&self) -> &'static str {
        "cmux"
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
            MuxOperation::Attach { .. } => Err(MuxError::Unsupported(
                "cmux attach is managed by the cmux application".into(),
            )),
            MuxOperation::Detach { .. } => Err(MuxError::Unsupported(
                "cmux detach is managed by the cmux application".into(),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::InputEnvelope;

    #[test]
    fn resolve_target_handle_rejects_empty() {
        let err = resolve_target_handle(&MuxTarget::DeliveryHandle(String::new()))
            .expect_err("should reject empty");
        assert!(matches!(err, MuxError::InvalidTarget(_)));
    }

    #[test]
    fn build_send_args_constructs_cmux_send() {
        let args = build_cmux_send_args("surface:abc", "hello");
        assert_eq!(args, vec!["send", "--surface", "surface:abc", "hello"]);
    }

    #[test]
    fn build_enter_key_args_constructs_cmux_enter() {
        let args = build_cmux_enter_key_args("surface:abc");
        assert_eq!(args, vec!["send-key", "--surface", "surface:abc", "Enter"]);
    }

    #[test]
    fn build_capture_args_constructs_cmux_capture() {
        let args = build_cmux_capture_pane_args("surface:abc", 80);
        assert_eq!(
            args,
            vec![
                "capture-pane",
                "--surface",
                "surface:abc",
                "--scrollback",
                "--lines",
                "80"
            ]
        );
    }

    #[test]
    fn adapter_name_is_cmux() {
        let adapter = CmuxAdapter::new();
        assert_eq!(adapter.adapter_name(), "cmux");
    }

    #[test]
    fn status_reports_ready() {
        let adapter = CmuxAdapter::new();
        assert_eq!(adapter.status(), "cmux adapter ready");
    }

    #[test]
    fn attach_is_explicitly_unsupported() {
        let adapter = CmuxAdapter::new();
        let result = adapter.execute(&MuxOperation::Attach {
            target: MuxTarget::DeliveryHandle("surface:abc".into()),
        });
        assert!(matches!(result.unwrap_err(), MuxError::Unsupported(_)));
    }

    #[test]
    fn send_args_use_normalized_text() {
        let envelope = InputEnvelope::new("line1\nline2", SubmitPolicy::None);
        let text = envelope.normalized_text();
        let args = build_cmux_send_args("surface:abc", &text);
        assert_eq!(args[3], "line1 line2");
    }
}
