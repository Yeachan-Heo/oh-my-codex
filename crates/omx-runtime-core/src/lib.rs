use std::fmt;

use serde::{Deserialize, Serialize};

pub mod authority;
pub mod dispatch;
pub mod engine;
pub mod mailbox;
pub mod replay;

pub use authority::{AuthorityError, AuthorityLease};
pub use dispatch::{DispatchError, DispatchLog, DispatchRecord, DispatchStatus};
pub use engine::{derive_readiness, EngineError, RuntimeEngine};
pub use mailbox::{MailboxError, MailboxLog, MailboxRecord};
pub use replay::ReplayState;

pub const RUNTIME_SCHEMA_VERSION: u32 = 1;
pub const RUNTIME_COMMAND_NAMES: &[&str] = &[
    "acquire-authority",
    "renew-authority",
    "queue-dispatch",
    "mark-notified",
    "mark-delivered",
    "mark-failed",
    "remove-dispatch-records",
    "request-replay",
    "capture-snapshot",
    "create-mailbox-message",
    "mark-mailbox-notified",
    "mark-mailbox-delivered",
];
pub const RUNTIME_EVENT_NAMES: &[&str] = &[
    "authority-acquired",
    "authority-renewed",
    "dispatch-queued",
    "dispatch-notified",
    "dispatch-delivered",
    "dispatch-failed",
    "dispatch-records-removed",
    "replay-requested",
    "snapshot-captured",
    "mailbox-message-created",
    "mailbox-notified",
    "mailbox-delivered",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum WorkerCli {
    Codex,
    Claude,
    Other(String),
}

impl WorkerCli {
    pub fn from_label(label: impl AsRef<str>) -> Self {
        match label.as_ref().trim().to_lowercase().as_str() {
            "claude" => Self::Claude,
            "codex" => Self::Codex,
            other => Self::Other(other.to_string()),
        }
    }
}

pub fn submit_presses_for_worker_cli(worker_cli: &WorkerCli) -> u8 {
    match worker_cli {
        WorkerCli::Claude => 1,
        WorkerCli::Codex | WorkerCli::Other(_) => 2,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DispatchTransportKind {
    Tmux,
}

impl fmt::Display for DispatchTransportKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Tmux => write!(f, "tmux"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "detail")]
pub enum DispatchOutcomeReason {
    DeliveredConfirmed,
    DeliveredConfirmedActiveTask,
    DeliveredUnconfirmed,
    DeferredLeaderPaneMissing,
    DeferredShellNotInjectable,
    FailedMissingTarget,
    FailedTargetResolution(String),
    FailedPreflight(String),
    FailedSend(String),
}

impl fmt::Display for DispatchOutcomeReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DeliveredConfirmed => write!(f, "tmux_send_keys_confirmed"),
            Self::DeliveredConfirmedActiveTask => {
                write!(f, "tmux_send_keys_confirmed_active_task")
            }
            Self::DeliveredUnconfirmed => write!(f, "tmux_send_keys_unconfirmed"),
            Self::DeferredLeaderPaneMissing => write!(f, "leader_pane_missing_deferred"),
            Self::DeferredShellNotInjectable => write!(f, "deferred_shell"),
            Self::FailedMissingTarget => write!(f, "missing_tmux_target"),
            Self::FailedTargetResolution(reason) => {
                write!(f, "target_resolution_failed:{reason}")
            }
            Self::FailedPreflight(reason) => write!(f, "preflight_failed:{reason}"),
            Self::FailedSend(reason) => write!(f, "send_failed:{reason}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status")]
pub enum QueueTransition {
    KeepPending { reason: DispatchOutcomeReason },
    MarkNotified { reason: DispatchOutcomeReason },
    MarkFailed { reason: DispatchOutcomeReason },
}

impl QueueTransition {
    pub fn status(&self) -> &'static str {
        match self {
            Self::KeepPending { .. } => "pending",
            Self::MarkNotified { .. } => "notified",
            Self::MarkFailed { .. } => "failed",
        }
    }

    pub fn reason(&self) -> &DispatchOutcomeReason {
        match self {
            Self::KeepPending { reason }
            | Self::MarkNotified { reason }
            | Self::MarkFailed { reason } => reason,
        }
    }
}

pub fn classify_dispatch_outcome(
    target_present: bool,
    target_resolved: bool,
    preflight_ok: bool,
    send_ok: bool,
    confirmed: bool,
    active_task: bool,
    retry_remaining: bool,
) -> QueueTransition {
    if !target_present {
        return QueueTransition::MarkFailed {
            reason: DispatchOutcomeReason::FailedMissingTarget,
        };
    }
    if !target_resolved {
        return QueueTransition::MarkFailed {
            reason: DispatchOutcomeReason::FailedTargetResolution("unresolved_target".to_string()),
        };
    }
    if !preflight_ok {
        return QueueTransition::MarkFailed {
            reason: DispatchOutcomeReason::FailedPreflight("pane_not_ready".to_string()),
        };
    }
    if !send_ok {
        return QueueTransition::MarkFailed {
            reason: DispatchOutcomeReason::FailedSend("send_failed".to_string()),
        };
    }
    if confirmed {
        return QueueTransition::MarkNotified {
            reason: if active_task {
                DispatchOutcomeReason::DeliveredConfirmedActiveTask
            } else {
                DispatchOutcomeReason::DeliveredConfirmed
            },
        };
    }
    if retry_remaining {
        return QueueTransition::KeepPending {
            reason: DispatchOutcomeReason::DeliveredUnconfirmed,
        };
    }
    QueueTransition::MarkFailed {
        reason: DispatchOutcomeReason::DeliveredUnconfirmed,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "command")]
pub enum RuntimeCommand {
    AcquireAuthority {
        owner: String,
        lease_id: String,
        leased_until: String,
    },
    RenewAuthority {
        owner: String,
        lease_id: String,
        leased_until: String,
    },
    QueueDispatch {
        request_id: String,
        target: String,
        metadata: Option<serde_json::Value>,
    },
    MarkNotified {
        request_id: String,
        channel: String,
    },
    MarkDelivered {
        request_id: String,
    },
    MarkFailed {
        request_id: String,
        reason: String,
    },
    RemoveDispatchRecords {
        request_ids: Vec<String>,
    },
    RequestReplay {
        cursor: Option<String>,
    },
    CaptureSnapshot,
    CreateMailboxMessage {
        message_id: String,
        from_worker: String,
        to_worker: String,
        body: String,
    },
    MarkMailboxNotified {
        message_id: String,
    },
    MarkMailboxDelivered {
        message_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event")]
pub enum RuntimeEvent {
    AuthorityAcquired {
        owner: String,
        lease_id: String,
        leased_until: String,
    },
    AuthorityRenewed {
        owner: String,
        lease_id: String,
        leased_until: String,
    },
    DispatchQueued {
        request_id: String,
        target: String,
        metadata: Option<serde_json::Value>,
    },
    DispatchNotified {
        request_id: String,
        channel: String,
    },
    DispatchDelivered {
        request_id: String,
    },
    DispatchFailed {
        request_id: String,
        reason: String,
    },
    DispatchRecordsRemoved {
        request_ids: Vec<String>,
    },
    ReplayRequested {
        cursor: Option<String>,
    },
    SnapshotCaptured,
    MailboxMessageCreated {
        message_id: String,
        from_worker: String,
        to_worker: String,
        #[serde(default)]
        body: Option<String>,
    },
    MailboxNotified {
        message_id: String,
    },
    MailboxDelivered {
        message_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeSnapshot {
    pub schema_version: u32,
    pub authority: AuthoritySnapshot,
    pub backlog: BacklogSnapshot,
    pub replay: ReplaySnapshot,
    pub readiness: ReadinessSnapshot,
}

impl RuntimeSnapshot {
    pub fn new() -> Self {
        Self {
            schema_version: RUNTIME_SCHEMA_VERSION,
            authority: AuthoritySnapshot::default(),
            backlog: BacklogSnapshot::default(),
            replay: ReplaySnapshot::default(),
            readiness: ReadinessSnapshot::default(),
        }
    }

    pub fn ready(&self) -> bool {
        self.readiness.ready
    }
}

impl Default for RuntimeSnapshot {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for RuntimeSnapshot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "schema={} authority={} backlog={} replay={} readiness={}",
            self.schema_version, self.authority, self.backlog, self.replay, self.readiness
        )
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthoritySnapshot {
    pub owner: Option<String>,
    pub lease_id: Option<String>,
    pub leased_until: Option<String>,
    pub stale: bool,
    pub stale_reason: Option<String>,
}

impl AuthoritySnapshot {
    pub fn acquire(
        owner: impl Into<String>,
        lease_id: impl Into<String>,
        leased_until: impl Into<String>,
    ) -> Self {
        Self {
            owner: Some(owner.into()),
            lease_id: Some(lease_id.into()),
            leased_until: Some(leased_until.into()),
            stale: false,
            stale_reason: None,
        }
    }

    pub fn mark_stale(&mut self, reason: impl Into<String>) {
        self.stale = true;
        self.stale_reason = Some(reason.into());
    }

    pub fn clear_stale(&mut self) {
        self.stale = false;
        self.stale_reason = None;
    }
}

impl fmt::Display for AuthoritySnapshot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let owner = self.owner.as_deref().unwrap_or("none");
        let lease_id = self.lease_id.as_deref().unwrap_or("none");
        let leased_until = self.leased_until.as_deref().unwrap_or("none");
        let stale_reason = self.stale_reason.as_deref().unwrap_or("none");
        write!(
            f,
            "owner={} lease_id={} leased_until={} stale={} stale_reason={}",
            owner, lease_id, leased_until, self.stale, stale_reason
        )
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BacklogSnapshot {
    pub pending: u64,
    pub notified: u64,
    pub delivered: u64,
    pub failed: u64,
}

impl BacklogSnapshot {
    pub fn queue_dispatch(&mut self) {
        self.pending += 1;
    }

    pub fn mark_notified(&mut self) -> bool {
        if self.pending == 0 {
            return false;
        }
        self.pending -= 1;
        self.notified += 1;
        true
    }

    pub fn mark_delivered(&mut self) -> bool {
        if self.notified == 0 {
            return false;
        }
        self.notified -= 1;
        self.delivered += 1;
        true
    }

    pub fn mark_failed(&mut self) -> bool {
        if self.notified == 0 {
            return false;
        }
        self.notified -= 1;
        self.failed += 1;
        true
    }
}

impl fmt::Display for BacklogSnapshot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "pending={} notified={} delivered={} failed={}",
            self.pending, self.notified, self.delivered, self.failed
        )
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplaySnapshot {
    pub cursor: Option<String>,
    pub pending_events: u64,
    pub last_replayed_event_id: Option<String>,
    pub deferred_leader_notification: bool,
}

impl ReplaySnapshot {
    pub fn queue_event(&mut self) {
        self.pending_events += 1;
    }

    pub fn mark_replayed(&mut self, event_id: impl Into<String>) {
        if self.pending_events > 0 {
            self.pending_events -= 1;
        }
        self.last_replayed_event_id = Some(event_id.into());
    }

    pub fn defer_leader_notification(&mut self) {
        self.deferred_leader_notification = true;
    }

    pub fn clear_deferred_leader_notification(&mut self) {
        self.deferred_leader_notification = false;
    }
}

impl fmt::Display for ReplaySnapshot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let cursor = self.cursor.as_deref().unwrap_or("none");
        let last_replayed = self.last_replayed_event_id.as_deref().unwrap_or("none");
        write!(
            f,
            "cursor={} pending_events={} last_replayed_event_id={} deferred_leader_notification={}",
            cursor, self.pending_events, last_replayed, self.deferred_leader_notification
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadinessSnapshot {
    pub ready: bool,
    pub reasons: Vec<String>,
}

impl ReadinessSnapshot {
    pub fn ready() -> Self {
        Self {
            ready: true,
            reasons: Vec::new(),
        }
    }

    pub fn blocked(reason: impl Into<String>) -> Self {
        Self {
            ready: false,
            reasons: vec![reason.into()],
        }
    }

    pub fn add_reason(&mut self, reason: impl Into<String>) {
        self.ready = false;
        self.reasons.push(reason.into());
    }
}

impl Default for ReadinessSnapshot {
    fn default() -> Self {
        Self::blocked("authority lease not acquired")
    }
}

impl fmt::Display for ReadinessSnapshot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.ready {
            return write!(f, "ready");
        }

        write!(f, "blocked({})", self.reasons.join("; "))
    }
}

pub fn runtime_contract_summary() -> String {
    format!(
        "runtime-schema={version}\ncommands={commands}\nevents={events}\ntransport={transport}\nqueue-transition={queue_transition}\nsnapshot=authority, backlog, replay, readiness",
        version = RUNTIME_SCHEMA_VERSION,
        commands = RUNTIME_COMMAND_NAMES.join(", "),
        events = RUNTIME_EVENT_NAMES.join(", "),
        transport = DispatchTransportKind::Tmux,
        queue_transition = classify_dispatch_outcome(true, true, true, true, true, false, false).status(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_defaults_to_blocked_state() {
        let snapshot = RuntimeSnapshot::new();
        assert_eq!(snapshot.schema_version, RUNTIME_SCHEMA_VERSION);
        assert!(!snapshot.ready());
        assert_eq!(snapshot.backlog, BacklogSnapshot::default());
        assert_eq!(snapshot.authority.owner, None);
        assert_eq!(
            snapshot.readiness.reasons,
            vec!["authority lease not acquired"]
        );
    }

    #[test]
    fn backlog_transitions_preserve_pending_notified_flow() {
        let mut backlog = BacklogSnapshot::default();
        backlog.queue_dispatch();
        assert_eq!(backlog.pending, 1);
        assert!(backlog.mark_notified());
        assert_eq!(backlog.pending, 0);
        assert_eq!(backlog.notified, 1);
        assert!(backlog.mark_delivered());
        assert_eq!(backlog.notified, 0);
        assert_eq!(backlog.delivered, 1);
        assert!(!backlog.mark_failed());
    }

    #[test]
    fn authority_state_can_be_marked_stale() {
        let mut authority =
            AuthoritySnapshot::acquire("worker-1", "lease-1", "2026-03-19T01:40:37Z");
        authority.mark_stale("lease expired");
        assert!(authority.stale);
        assert_eq!(authority.stale_reason.as_deref(), Some("lease expired"));
        authority.clear_stale();
        assert!(!authority.stale);
        assert_eq!(authority.stale_reason, None);
    }

    #[test]
    fn worker_cli_submit_policy_matches_current_dispatch_behavior() {
        assert_eq!(submit_presses_for_worker_cli(&WorkerCli::Claude), 1);
        assert_eq!(submit_presses_for_worker_cli(&WorkerCli::Codex), 2);
        assert_eq!(
            submit_presses_for_worker_cli(&WorkerCli::from_label("other")),
            2
        );
    }

    #[test]
    fn dispatch_outcome_classification_distinguishes_confirmation_and_retry_paths() {
        let confirmed = classify_dispatch_outcome(true, true, true, true, true, false, false);
        assert!(matches!(
            confirmed,
            QueueTransition::MarkNotified {
                reason: DispatchOutcomeReason::DeliveredConfirmed
            }
        ));

        let active_task = classify_dispatch_outcome(true, true, true, true, true, true, false);
        assert!(matches!(
            active_task,
            QueueTransition::MarkNotified {
                reason: DispatchOutcomeReason::DeliveredConfirmedActiveTask
            }
        ));

        let unconfirmed_retry =
            classify_dispatch_outcome(true, true, true, true, false, false, true);
        assert!(matches!(
            unconfirmed_retry,
            QueueTransition::KeepPending {
                reason: DispatchOutcomeReason::DeliveredUnconfirmed
            }
        ));

        let unconfirmed_failed =
            classify_dispatch_outcome(true, true, true, true, false, false, false);
        assert!(matches!(
            unconfirmed_failed,
            QueueTransition::MarkFailed {
                reason: DispatchOutcomeReason::DeliveredUnconfirmed
            }
        ));
    }

    #[test]
    fn snapshot_serializes_to_json() {
        let snapshot = RuntimeSnapshot::new();
        let json = serde_json::to_string(&snapshot).unwrap();
        let deserialized: RuntimeSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(snapshot, deserialized);
    }

    #[test]
    fn runtime_command_serializes_to_json() {
        let cmd = RuntimeCommand::AcquireAuthority {
            owner: "w1".into(),
            lease_id: "l1".into(),
            leased_until: "2026-03-19T02:00:00Z".into(),
        };
        let json = serde_json::to_string(&cmd).unwrap();
        let deserialized: RuntimeCommand = serde_json::from_str(&json).unwrap();
        assert_eq!(cmd, deserialized);
    }

    #[test]
    fn runtime_event_serializes_to_json() {
        let event = RuntimeEvent::SnapshotCaptured;
        let json = serde_json::to_string(&event).unwrap();
        let deserialized: RuntimeEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(event, deserialized);
    }

    #[test]
    fn mailbox_message_created_event_deserializes_without_body_for_back_compat() {
        let json = r#"{"event":"MailboxMessageCreated","message_id":"msg-1","from_worker":"worker-1","to_worker":"leader-fixed"}"#;
        let deserialized: RuntimeEvent = serde_json::from_str(json).unwrap();
        assert_eq!(
            deserialized,
            RuntimeEvent::MailboxMessageCreated {
                message_id: "msg-1".into(),
                from_worker: "worker-1".into(),
                to_worker: "leader-fixed".into(),
                body: None,
            }
        );
    }
}
