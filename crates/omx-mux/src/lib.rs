mod cmux;
mod tmux;
mod types;

pub use cmux::{build_cmux_capture_pane_args, CmuxAdapter};
pub use tmux::{build_capture_pane_args, TmuxAdapter};
pub use types::*;

pub fn canonical_contract_summary() -> String {
    format!(
        "mux-operations={operations}\nmux-target-kinds={target_kinds}\nsubmit-policy={submit_policy}\nreadiness={readiness}\nconfirmation={confirmation}\nadapters=tmux,cmux",
        operations = MUX_OPERATION_NAMES.join(", "),
        target_kinds = MUX_TARGET_KINDS.join(", "),
        submit_policy = SubmitPolicy::enter(2, 100),
        readiness = PaneReadinessReason::Ok,
        confirmation = DeliveryConfirmation::Confirmed,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_contract_names_remain_generic() {
        assert_eq!(
            MUX_OPERATION_NAMES,
            &[
                "resolve-target",
                "send-input",
                "capture-tail",
                "inspect-liveness",
                "attach",
                "detach",
            ]
        );
        assert_eq!(MUX_TARGET_KINDS, &["delivery-handle", "detached"]);
    }

    #[test]
    fn input_envelope_normalizes_literal_text_for_typed_send() {
        let envelope = InputEnvelope::new("hello\nbridge", SubmitPolicy::enter(2, 100));
        assert_eq!(envelope.normalized_text(), "hello bridge");
        assert_eq!(envelope.submit.presses(), 2);
        assert_eq!(
            format!("{}", envelope.submit),
            "enter(presses=2, delay_ms=100)"
        );
    }

    #[test]
    fn confirmation_policy_defaults_match_notify_hook_expectations() {
        let policy = ConfirmationPolicy::default();
        assert_eq!(policy.narrow_capture_lines, 8);
        assert_eq!(policy.wide_capture_lines, 80);
        assert_eq!(policy.verify_delay_ms, 250);
        assert_eq!(policy.verify_rounds, 3);
        assert!(policy.allow_active_task_confirmation);
        assert!(policy.require_ready_for_worker_targets);
        assert_eq!(policy.non_empty_tail_lines, 24);
        assert!(policy.retry_submit_without_retyping);
    }

    #[test]
    fn serde_roundtrip_mux_operation() {
        let op = MuxOperation::SendInput {
            target: MuxTarget::DeliveryHandle("sess:0.1".into()),
            envelope: InputEnvelope::new("test", SubmitPolicy::enter(1, 50)),
        };
        let json = serde_json::to_string(&op).expect("serialize");
        let deserialized: MuxOperation = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(format!("{deserialized:?}"), format!("{op:?}"));
    }

    #[test]
    fn serde_roundtrip_mux_outcome() {
        let outcome = MuxOutcome::TailCaptured {
            visible_lines: 80,
            body: "hello".into(),
        };
        let json = serde_json::to_string(&outcome).expect("serialize");
        let deserialized: MuxOutcome = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(deserialized, outcome);
    }

    #[test]
    fn serde_roundtrip_mux_error() {
        let err = MuxError::InvalidTarget("bad".into());
        let json = serde_json::to_string(&err).expect("serialize");
        let deserialized: MuxError = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(deserialized, err);
    }
}
