use std::collections::BTreeSet;
use std::fmt;
use std::io::Write;
use std::path::{Path, PathBuf};

use fs2::FileExt;
use serde::{Deserialize, Serialize};

use crate::authority::{AuthorityError, AuthorityLease};
use crate::dispatch::{DispatchError, DispatchLog};
use crate::mailbox::{MailboxError, MailboxLog};
use crate::replay::ReplayState;
use crate::{
    ReadinessSnapshot, RuntimeCommand, RuntimeEvent, RuntimeSnapshot, RUNTIME_SCHEMA_VERSION,
};

#[derive(Debug)]
pub enum EngineError {
    Authority(AuthorityError),
    Dispatch(DispatchError),
    Mailbox(MailboxError),
    Io(std::io::Error),
    Json(serde_json::Error),
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Authority(e) => write!(f, "authority error: {e}"),
            Self::Dispatch(e) => write!(f, "dispatch error: {e}"),
            Self::Mailbox(e) => write!(f, "mailbox error: {e}"),
            Self::Io(e) => write!(f, "io error: {e}"),
            Self::Json(e) => write!(f, "json error: {e}"),
        }
    }
}

impl std::error::Error for EngineError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Authority(e) => Some(e),
            Self::Dispatch(e) => Some(e),
            Self::Mailbox(e) => Some(e),
            Self::Io(e) => Some(e),
            Self::Json(e) => Some(e),
        }
    }
}

impl From<AuthorityError> for EngineError {
    fn from(e: AuthorityError) -> Self {
        Self::Authority(e)
    }
}

impl From<DispatchError> for EngineError {
    fn from(e: DispatchError) -> Self {
        Self::Dispatch(e)
    }
}

impl From<MailboxError> for EngineError {
    fn from(e: MailboxError) -> Self {
        Self::Mailbox(e)
    }
}

impl From<std::io::Error> for EngineError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

impl From<serde_json::Error> for EngineError {
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e)
    }
}

pub struct RuntimeEngine {
    authority: AuthorityLease,
    dispatch: DispatchLog,
    seen_dispatch_ids: BTreeSet<String>,
    mailbox: MailboxLog,
    replay: ReplayState,
    event_log: Vec<RuntimeEvent>,
    state_dir: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DispatchSeenLedgerV1 {
    schema_version: u32,
    request_ids: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DispatchSeenLedgerV2 {
    schema_version: u32,
    ledger_epoch: u64,
    request_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum DispatchSeenLedger {
    V1(DispatchSeenLedgerV1),
    V2(DispatchSeenLedgerV2),
}

const DISPATCH_SEEN_LEDGER_SCHEMA_VERSION: u32 = 2;
const DISPATCH_SEEN_LEDGER_EPOCH: u64 = 1;
const DISPATCH_SEEN_LEDGER_FILE: &str = "dispatch-seen.json";

impl RuntimeEngine {
    pub fn new() -> Self {
        Self {
            authority: AuthorityLease::new(),
            dispatch: DispatchLog::new(),
            seen_dispatch_ids: BTreeSet::new(),
            mailbox: MailboxLog::new(),
            replay: ReplayState::new(),
            event_log: Vec::new(),
            state_dir: None,
        }
    }

    pub fn with_state_dir(mut self, path: impl Into<PathBuf>) -> Self {
        self.state_dir = Some(path.into());
        self
    }

    pub fn process(&mut self, command: RuntimeCommand) -> Result<RuntimeEvent, EngineError> {
        let event = match command {
            RuntimeCommand::AcquireAuthority {
                owner,
                lease_id,
                leased_until,
            } => {
                self.authority.acquire(&owner, &lease_id, &leased_until)?;
                RuntimeEvent::AuthorityAcquired {
                    owner,
                    lease_id,
                    leased_until,
                }
            }
            RuntimeCommand::RenewAuthority {
                owner,
                lease_id,
                leased_until,
            } => {
                self.authority.renew(&owner, &lease_id, &leased_until)?;
                RuntimeEvent::AuthorityRenewed {
                    owner,
                    lease_id,
                    leased_until,
                }
            }
            RuntimeCommand::QueueDispatch {
                request_id,
                target,
                metadata,
            } => {
                if self.seen_dispatch_ids.contains(&request_id) {
                    return Err(DispatchError::DuplicateRequestId { request_id }.into());
                }
                self.dispatch
                    .queue(&request_id, &target, metadata.clone())?;
                self.seen_dispatch_ids.insert(request_id.clone());
                RuntimeEvent::DispatchQueued {
                    request_id,
                    target,
                    metadata,
                }
            }
            RuntimeCommand::MarkNotified {
                request_id,
                channel,
            } => {
                self.dispatch.mark_notified(&request_id, &channel)?;
                RuntimeEvent::DispatchNotified {
                    request_id,
                    channel,
                }
            }
            RuntimeCommand::MarkDelivered { request_id } => {
                self.dispatch.mark_delivered(&request_id)?;
                RuntimeEvent::DispatchDelivered { request_id }
            }
            RuntimeCommand::MarkFailed { request_id, reason } => {
                self.dispatch.mark_failed(&request_id, &reason)?;
                RuntimeEvent::DispatchFailed { request_id, reason }
            }
            RuntimeCommand::RemoveDispatchRecords { request_ids } => {
                let request_ids = canonical_remove_dispatch_ids(&request_ids)?;
                for request_id in &request_ids {
                    if !self.dispatch.contains_request_id(request_id) {
                        return Err(DispatchError::NotFound {
                            request_id: request_id.clone(),
                        }
                        .into());
                    }
                }
                let request_id_set: std::collections::HashSet<&str> =
                    request_ids.iter().map(String::as_str).collect();
                self.event_log
                    .retain(|event| !dispatch_event_matches_request_ids(event, &request_id_set));
                self.dispatch = DispatchLog::new();
                for event in &self.event_log {
                    replay_dispatch_event(&mut self.dispatch, event)?;
                }
                RuntimeEvent::DispatchRecordsRemoved { request_ids }
            }
            RuntimeCommand::RequestReplay { cursor } => {
                self.replay.request_replay(cursor.clone());
                RuntimeEvent::ReplayRequested { cursor }
            }
            RuntimeCommand::CaptureSnapshot => RuntimeEvent::SnapshotCaptured,
            RuntimeCommand::CreateMailboxMessage {
                message_id,
                from_worker,
                to_worker,
                body,
            } => {
                self.mailbox
                    .create(&message_id, &from_worker, &to_worker, &body);
                RuntimeEvent::MailboxMessageCreated {
                    message_id,
                    from_worker,
                    to_worker,
                    body: Some(body),
                }
            }
            RuntimeCommand::MarkMailboxNotified { message_id } => {
                self.mailbox.mark_notified(&message_id)?;
                RuntimeEvent::MailboxNotified { message_id }
            }
            RuntimeCommand::MarkMailboxDelivered { message_id } => {
                self.mailbox.mark_delivered(&message_id)?;
                RuntimeEvent::MailboxDelivered { message_id }
            }
        };

        if !matches!(event, RuntimeEvent::DispatchRecordsRemoved { .. }) {
            self.event_log.push(event.clone());
        }
        Ok(event)
    }

    pub fn snapshot(&self) -> RuntimeSnapshot {
        RuntimeSnapshot {
            schema_version: RUNTIME_SCHEMA_VERSION,
            authority: self.authority.to_snapshot(),
            backlog: self.dispatch.to_backlog_snapshot(),
            replay: self.replay.to_snapshot(),
            readiness: derive_readiness(&self.authority, &self.dispatch, &self.replay),
        }
    }

    pub fn event_log(&self) -> &[RuntimeEvent] {
        &self.event_log
    }

    /// Remove events for dispatches that reached Delivered or Failed status.
    pub fn compact(&mut self) {
        // Collect request_ids that are delivered or failed
        let terminal_ids: std::collections::HashSet<&str> = self
            .dispatch
            .records()
            .iter()
            .filter(|r| {
                r.status == crate::dispatch::DispatchStatus::Delivered
                    || r.status == crate::dispatch::DispatchStatus::Failed
            })
            .map(|r| r.request_id.as_str())
            .collect();

        self.event_log.retain(|event| match event {
            RuntimeEvent::DispatchQueued { request_id, .. }
            | RuntimeEvent::DispatchNotified { request_id, .. }
            | RuntimeEvent::DispatchDelivered { request_id }
            | RuntimeEvent::DispatchFailed { request_id, .. } => {
                !terminal_ids.contains(request_id.as_str())
            }
            _ => true,
        });
        self.dispatch.prune_terminal_records();
    }

    pub fn persist(&self) -> Result<(), EngineError> {
        let dir = self.state_dir.as_ref().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, "no state_dir configured")
        })?;
        std::fs::create_dir_all(dir)?;

        let lock_file = std::fs::File::create(dir.join("engine.lock"))?;
        FileExt::lock_exclusive(&lock_file)?;

        let snapshot_json = serde_json::to_string_pretty(&self.snapshot())?;
        std::fs::write(dir.join("snapshot.json"), snapshot_json)?;

        // Publish the permanent dispatch identity ledger before any compaction/removal
        // can make its corresponding events unavailable. A crash can conservatively
        // retain extra IDs, but can never make an accepted ID reusable.
        persist_dispatch_seen_ledger(dir, &self.seen_dispatch_ids)?;

        let events_json = serde_json::to_string_pretty(&self.event_log)?;
        std::fs::write(dir.join("events.json"), events_json)?;

        let mailbox_json = serde_json::to_string_pretty(&self.mailbox)?;
        std::fs::write(dir.join("mailbox.json"), mailbox_json)?;
        let dispatch_json = serde_json::to_string_pretty(&self.dispatch)?;
        std::fs::write(dir.join("dispatch.json"), dispatch_json)?;

        drop(lock_file);
        Ok(())
    }

    /// Write compatibility view files for legacy TS readers (team/doctor/HUD).
    /// Writes individual section files alongside the main snapshot.
    pub fn write_compatibility_view(&self) -> Result<(), EngineError> {
        let dir = self.state_dir.as_ref().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, "no state_dir configured")
        })?;
        std::fs::create_dir_all(dir)?;

        let snapshot = self.snapshot();

        // Write individual section files for TS compatibility readers
        let authority_json = serde_json::to_string_pretty(&snapshot.authority)?;
        std::fs::write(dir.join("authority.json"), authority_json)?;

        let backlog_json = serde_json::to_string_pretty(&snapshot.backlog)?;
        std::fs::write(dir.join("backlog.json"), backlog_json)?;

        let readiness_json = serde_json::to_string_pretty(&snapshot.readiness)?;
        std::fs::write(dir.join("readiness.json"), readiness_json)?;

        let replay_json = serde_json::to_string_pretty(&snapshot.replay)?;
        std::fs::write(dir.join("replay.json"), replay_json)?;

        // Write dispatch records for team status readers
        let dispatch_json = serde_json::to_string_pretty(&self.dispatch)?;
        std::fs::write(dir.join("dispatch.json"), dispatch_json)?;

        // Write mailbox records
        let mailbox_json = serde_json::to_string_pretty(&self.mailbox)?;
        std::fs::write(dir.join("mailbox.json"), mailbox_json)?;

        Ok(())
    }

    pub fn load(state_dir: impl Into<PathBuf>) -> Result<Self, EngineError> {
        let dir = state_dir.into();

        let lock_path = dir.join("engine.lock");
        let lock_file =
            std::fs::File::open(&lock_path).or_else(|_| std::fs::File::create(&lock_path))?;
        FileExt::lock_shared(&lock_file)?;

        let events_path = dir.join("events.json");
        let events_json = std::fs::read_to_string(&events_path)?;
        let mut events: Vec<RuntimeEvent> = serde_json::from_str(&events_json)?;
        let mailbox = std::fs::read_to_string(dir.join("mailbox.json"))
            .ok()
            .and_then(|mailbox_json| serde_json::from_str::<MailboxLog>(&mailbox_json).ok());
        let ledger = match std::fs::read_to_string(dir.join(DISPATCH_SEEN_LEDGER_FILE)) {
            Ok(json) => parse_dispatch_seen_ledger(&json)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "missing dispatch seen ledger; pre-ledger dispatch history is ambiguous",
                )
                .into())
            }
            Err(error) => return Err(error.into()),
        };
        let persisted_dispatch_ids = match std::fs::read_to_string(dir.join("dispatch.json")) {
            Ok(json) => {
                let dispatch: DispatchLog = serde_json::from_str(&json)?;
                collect_unique_dispatch_ids(dispatch.request_ids())?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeSet::new(),
            Err(error) => return Err(error.into()),
        };

        drop(lock_file);

        let mut engine = Self::new().with_state_dir(&dir);
        // Replay all events to rebuild state. Duplicate/out-of-order dispatch history
        // is rejected by replay, rather than silently repaired.
        for event in &events {
            replay_event(&mut engine, event)?;
        }
        let authoritative_dispatch_ids = collect_legacy_dispatch_ids(&events)?;
        if !authoritative_dispatch_ids.is_subset(&ledger)
            || !persisted_dispatch_ids.is_subset(&ledger)
        {
            return Err(DispatchError::InvalidRequestId {
                request_id: "dispatch seen ledger omits an authoritative dispatch id".into(),
            }
            .into());
        }
        engine.seen_dispatch_ids = ledger;

        if let Some(mailbox_state) = mailbox {
            let body_by_message_id: std::collections::HashMap<&str, &str> = mailbox_state
                .records()
                .iter()
                .map(|record| (record.message_id.as_str(), record.body.as_str()))
                .collect();

            for event in &mut events {
                if let RuntimeEvent::MailboxMessageCreated {
                    message_id, body, ..
                } = event
                {
                    if body.is_none() {
                        if let Some(record_body) = body_by_message_id.get(message_id.as_str()) {
                            if !record_body.is_empty() {
                                *body = Some((*record_body).to_string());
                            }
                        }
                    }
                }
            }
            engine.mailbox = mailbox_state;
        }

        engine.event_log = events;
        Ok(engine)
    }
}

impl Default for RuntimeEngine {
    fn default() -> Self {
        Self::new()
    }
}

fn persist_dispatch_seen_ledger(
    dir: &Path,
    seen_dispatch_ids: &BTreeSet<String>,
) -> Result<(), EngineError> {
    let ledger = DispatchSeenLedgerV2 {
        schema_version: DISPATCH_SEEN_LEDGER_SCHEMA_VERSION,
        ledger_epoch: DISPATCH_SEEN_LEDGER_EPOCH,
        request_ids: seen_dispatch_ids.iter().cloned().collect(),
    };
    let path = dir.join(DISPATCH_SEEN_LEDGER_FILE);
    let temporary_path = dir.join(format!("{DISPATCH_SEEN_LEDGER_FILE}.tmp"));
    let json = serde_json::to_vec_pretty(&ledger)?;
    let mut temporary_file = std::fs::File::create(&temporary_path)?;
    temporary_file.write_all(&json)?;
    temporary_file.sync_all()?;
    std::fs::rename(temporary_path, path)?;
    sync_directory(dir)?;
    Ok(())
}

fn parse_dispatch_seen_ledger(json: &str) -> Result<BTreeSet<String>, EngineError> {
    let request_ids = match serde_json::from_str(json)? {
        DispatchSeenLedger::V1(ledger) if ledger.schema_version == 1 => ledger.request_ids,
        DispatchSeenLedger::V2(ledger)
            if ledger.schema_version == DISPATCH_SEEN_LEDGER_SCHEMA_VERSION
                && ledger.ledger_epoch == DISPATCH_SEEN_LEDGER_EPOCH =>
        {
            ledger.request_ids
        }
        DispatchSeenLedger::V1(_) | DispatchSeenLedger::V2(_) => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "unsupported dispatch seen ledger schema version or epoch",
            )
            .into())
        }
    };
    collect_unique_dispatch_ids(request_ids.iter().map(String::as_str))
}

fn sync_directory(dir: &Path) -> Result<(), EngineError> {
    match std::fs::File::open(dir).and_then(|directory| directory.sync_all()) {
        Ok(()) => Ok(()),
        Err(error) if directory_sync_is_unsupported(&error) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn directory_sync_is_unsupported(error: &std::io::Error) -> bool {
    if error.kind() == std::io::ErrorKind::Unsupported {
        return true;
    }
    #[cfg(windows)]
    {
        // Windows does not support opening/syncing directories with the same
        // semantics as Unix. These are the documented unsupported outcomes.
        return matches!(error.raw_os_error(), Some(1 | 5));
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn canonical_remove_dispatch_ids(request_ids: &[String]) -> Result<Vec<String>, EngineError> {
    if request_ids.is_empty() {
        return Err(DispatchError::InvalidRequestId {
            request_id: String::new(),
        }
        .into());
    }
    let request_ids = collect_unique_dispatch_ids(request_ids.iter().map(String::as_str))?;
    Ok(request_ids.into_iter().collect())
}

fn collect_unique_dispatch_ids<'a>(
    request_ids: impl Iterator<Item = &'a str>,
) -> Result<BTreeSet<String>, EngineError> {
    let mut seen = BTreeSet::new();
    for request_id in request_ids {
        if request_id.is_empty() {
            return Err(DispatchError::InvalidRequestId {
                request_id: request_id.to_string(),
            }
            .into());
        }
        if !seen.insert(request_id.to_string()) {
            return Err(DispatchError::DuplicateRequestId {
                request_id: request_id.to_string(),
            }
            .into());
        }
    }
    Ok(seen)
}

fn collect_queued_dispatch_ids(events: &[RuntimeEvent]) -> Result<BTreeSet<String>, EngineError> {
    collect_unique_dispatch_ids(events.iter().filter_map(|event| match event {
        RuntimeEvent::DispatchQueued { request_id, .. } => Some(request_id.as_str()),
        _ => None,
    }))
}

fn collect_legacy_dispatch_ids(events: &[RuntimeEvent]) -> Result<BTreeSet<String>, EngineError> {
    let mut seen_dispatch_ids = collect_queued_dispatch_ids(events)?;
    for event in events {
        if let RuntimeEvent::DispatchRecordsRemoved { request_ids } = event {
            seen_dispatch_ids.extend(collect_unique_dispatch_ids(
                request_ids.iter().map(String::as_str),
            )?);
        }
    }
    Ok(seen_dispatch_ids)
}

fn dispatch_event_matches_request_ids(
    event: &RuntimeEvent,
    request_ids: &std::collections::HashSet<&str>,
) -> bool {
    match event {
        RuntimeEvent::DispatchQueued { request_id, .. }
        | RuntimeEvent::DispatchNotified { request_id, .. }
        | RuntimeEvent::DispatchDelivered { request_id }
        | RuntimeEvent::DispatchFailed { request_id, .. } => {
            request_ids.contains(request_id.as_str())
        }
        _ => false,
    }
}

fn replay_dispatch_event(
    dispatch: &mut DispatchLog,
    event: &RuntimeEvent,
) -> Result<(), DispatchError> {
    match event {
        RuntimeEvent::DispatchQueued {
            request_id,
            target,
            metadata,
        } => dispatch.queue(request_id, target, metadata.clone()),
        RuntimeEvent::DispatchNotified {
            request_id,
            channel,
        } => dispatch.mark_notified(request_id, channel),
        RuntimeEvent::DispatchDelivered { request_id } => dispatch.mark_delivered(request_id),
        RuntimeEvent::DispatchFailed { request_id, reason } => {
            dispatch.mark_failed(request_id, reason)
        }
        _ => Ok(()),
    }
}

fn replay_event(engine: &mut RuntimeEngine, event: &RuntimeEvent) -> Result<(), DispatchError> {
    match event {
        RuntimeEvent::AuthorityAcquired {
            owner,
            lease_id,
            leased_until,
        } => {
            let _ = engine.authority.acquire(owner, lease_id, leased_until);
        }
        RuntimeEvent::AuthorityRenewed {
            owner,
            lease_id,
            leased_until,
        } => {
            let _ = engine.authority.renew(owner, lease_id, leased_until);
        }
        RuntimeEvent::ReplayRequested { cursor } => {
            engine.replay.request_replay(cursor.clone());
        }
        RuntimeEvent::MailboxMessageCreated {
            message_id,
            from_worker,
            to_worker,
            body,
        } => {
            engine.mailbox.create(
                message_id,
                from_worker,
                to_worker,
                body.as_deref().unwrap_or(""),
            );
        }
        RuntimeEvent::MailboxNotified { message_id } => {
            let _ = engine.mailbox.mark_notified(message_id);
        }
        RuntimeEvent::MailboxDelivered { message_id } => {
            let _ = engine.mailbox.mark_delivered(message_id);
        }
        RuntimeEvent::DispatchRecordsRemoved { .. } | RuntimeEvent::SnapshotCaptured => {}
        event => replay_dispatch_event(&mut engine.dispatch, event)?,
    }
    Ok(())
}

pub fn derive_readiness(
    authority: &AuthorityLease,
    _dispatch: &DispatchLog,
    replay: &ReplayState,
) -> ReadinessSnapshot {
    let mut reasons = Vec::new();

    if !authority.is_held() {
        reasons.push("authority lease not acquired".to_string());
    } else if authority.is_stale() {
        let stale_detail = authority.to_snapshot().stale_reason.unwrap_or_default();
        reasons.push(format!("authority lease is stale: {stale_detail}"));
    }

    let snap = replay.to_snapshot();
    if snap.pending_events > 0 {
        reasons.push(format!("replay has {} pending events", snap.pending_events));
    }

    if reasons.is_empty() {
        ReadinessSnapshot::ready()
    } else {
        let mut readiness = ReadinessSnapshot::blocked(reasons[0].clone());
        for reason in &reasons[1..] {
            readiness.add_reason(reason.clone());
        }
        readiness
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_acquire_authority() {
        let mut engine = RuntimeEngine::new();
        let event = engine
            .process(RuntimeCommand::AcquireAuthority {
                owner: "w1".into(),
                lease_id: "l1".into(),
                leased_until: "2026-03-19T02:00:00Z".into(),
            })
            .unwrap();
        assert!(matches!(event, RuntimeEvent::AuthorityAcquired { .. }));
        let snap = engine.snapshot();
        assert_eq!(snap.authority.owner.as_deref(), Some("w1"));
        assert!(snap.ready());
    }

    #[test]
    fn process_full_dispatch_cycle() {
        let mut engine = RuntimeEngine::new();
        engine
            .process(RuntimeCommand::AcquireAuthority {
                owner: "w1".into(),
                lease_id: "l1".into(),
                leased_until: "2026-03-19T02:00:00Z".into(),
            })
            .unwrap();
        engine
            .process(RuntimeCommand::QueueDispatch {
                request_id: "req-1".into(),
                target: "worker-2".into(),
                metadata: None,
            })
            .unwrap();
        engine
            .process(RuntimeCommand::MarkNotified {
                request_id: "req-1".into(),
                channel: "tmux".into(),
            })
            .unwrap();
        engine
            .process(RuntimeCommand::MarkDelivered {
                request_id: "req-1".into(),
            })
            .unwrap();

        let snap = engine.snapshot();
        assert_eq!(snap.backlog.delivered, 1);
        assert_eq!(snap.backlog.pending, 0);
    }

    #[test]
    fn snapshot_shows_blocked_without_authority() {
        let engine = RuntimeEngine::new();
        let snap = engine.snapshot();
        assert!(!snap.ready());
        assert_eq!(snap.readiness.reasons, vec!["authority lease not acquired"]);
    }

    #[test]
    fn process_replay_request() {
        let mut engine = RuntimeEngine::new();
        engine
            .process(RuntimeCommand::RequestReplay {
                cursor: Some("cur-1".into()),
            })
            .unwrap();
        let snap = engine.snapshot();
        assert_eq!(snap.replay.cursor.as_deref(), Some("cur-1"));
    }

    #[test]
    fn event_log_accumulates() {
        let mut engine = RuntimeEngine::new();
        engine.process(RuntimeCommand::CaptureSnapshot).unwrap();
        engine.process(RuntimeCommand::CaptureSnapshot).unwrap();
        assert_eq!(engine.event_log().len(), 2);
    }

    #[test]
    fn persist_and_load_round_trip() {
        let dir = std::env::temp_dir().join("omx-runtime-test-persist");
        let _ = std::fs::remove_dir_all(&dir);

        let mut engine = RuntimeEngine::new().with_state_dir(&dir);
        engine
            .process(RuntimeCommand::AcquireAuthority {
                owner: "w1".into(),
                lease_id: "l1".into(),
                leased_until: "2026-03-19T02:00:00Z".into(),
            })
            .unwrap();
        engine
            .process(RuntimeCommand::QueueDispatch {
                request_id: "req-1".into(),
                target: "worker-2".into(),
                metadata: None,
            })
            .unwrap();
        engine.persist().unwrap();

        let loaded = RuntimeEngine::load(&dir).unwrap();
        let original_snap = engine.snapshot();
        let loaded_snap = loaded.snapshot();
        assert_eq!(original_snap.authority, loaded_snap.authority);
        assert_eq!(original_snap.backlog, loaded_snap.backlog);
        assert_eq!(loaded.event_log().len(), 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn persist_and_load_round_trip_preserves_mailbox_body() {
        let dir = std::env::temp_dir().join("omx-runtime-test-mailbox-body");
        let _ = std::fs::remove_dir_all(&dir);

        let mut engine = RuntimeEngine::new().with_state_dir(&dir);
        engine
            .process(RuntimeCommand::CreateMailboxMessage {
                message_id: "msg-1".into(),
                from_worker: "worker-1".into(),
                to_worker: "leader-fixed".into(),
                body: "ACK: worker-1 initialized".into(),
            })
            .unwrap();
        engine.persist().unwrap();

        let loaded = RuntimeEngine::load(&dir).unwrap();
        loaded.write_compatibility_view().unwrap();

        let mailbox_json = std::fs::read_to_string(dir.join("mailbox.json")).unwrap();
        let mailbox: serde_json::Value = serde_json::from_str(&mailbox_json).unwrap();
        assert_eq!(
            mailbox["records"][0]["body"],
            serde_json::Value::String("ACK: worker-1 initialized".into())
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_backfills_legacy_mailbox_event_body_from_mailbox_json() {
        let dir = std::env::temp_dir().join("omx-runtime-test-mailbox-backfill");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        std::fs::write(
            dir.join("events.json"),
            serde_json::to_string_pretty(&vec![RuntimeEvent::MailboxMessageCreated {
                message_id: "msg-legacy".into(),
                from_worker: "worker-1".into(),
                to_worker: "leader-fixed".into(),
                body: None,
            }])
            .unwrap(),
        )
        .unwrap();
        std::fs::write(
            dir.join("mailbox.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "records": [{
                    "message_id": "msg-legacy",
                    "from_worker": "worker-1",
                    "to_worker": "leader-fixed",
                    "body": "recovered body",
                    "created_at": "2026-04-04T00:00:00.000Z",
                    "notified_at": null,
                    "delivered_at": null
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(
            dir.join(DISPATCH_SEEN_LEDGER_FILE),
            r#"{"schema_version":2,"ledger_epoch":1,"request_ids":[]}"#,
        )
        .unwrap();
        std::fs::write(dir.join("engine.lock"), "").unwrap();

        let loaded = RuntimeEngine::load(&dir).unwrap();
        loaded.persist().unwrap();

        let events_json = std::fs::read_to_string(dir.join("events.json")).unwrap();
        let persisted_events: Vec<RuntimeEvent> = serde_json::from_str(&events_json).unwrap();
        assert!(matches!(
            &persisted_events[0],
            RuntimeEvent::MailboxMessageCreated { body: Some(body), .. } if body == "recovered body"
        ));

        let mailbox_json = std::fs::read_to_string(dir.join("mailbox.json")).unwrap();
        let mailbox: serde_json::Value = serde_json::from_str(&mailbox_json).unwrap();
        assert_eq!(
            mailbox["records"][0]["body"],
            serde_json::Value::String("recovered body".into())
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn derive_readiness_stale_authority() {
        let mut authority = AuthorityLease::new();
        authority
            .acquire("w1", "l1", "2026-03-19T02:00:00Z")
            .unwrap();
        authority.mark_stale("expired");
        let dispatch = DispatchLog::new();
        let replay = ReplayState::new();

        let readiness = derive_readiness(&authority, &dispatch, &replay);
        assert!(!readiness.ready);
        assert!(readiness.reasons[0].contains("stale"));
    }

    #[test]
    fn renew_authority_via_engine() {
        let mut engine = RuntimeEngine::new();
        engine
            .process(RuntimeCommand::AcquireAuthority {
                owner: "w1".into(),
                lease_id: "l1".into(),
                leased_until: "2026-03-19T02:00:00Z".into(),
            })
            .unwrap();
        let event = engine
            .process(RuntimeCommand::RenewAuthority {
                owner: "w1".into(),
                lease_id: "l2".into(),
                leased_until: "2026-03-19T03:00:00Z".into(),
            })
            .unwrap();
        assert!(matches!(event, RuntimeEvent::AuthorityRenewed { .. }));
    }

    #[test]
    fn acquire_authority_wrong_owner_fails() {
        let mut engine = RuntimeEngine::new();
        engine
            .process(RuntimeCommand::AcquireAuthority {
                owner: "w1".into(),
                lease_id: "l1".into(),
                leased_until: "2026-03-19T02:00:00Z".into(),
            })
            .unwrap();
        let err = engine.process(RuntimeCommand::AcquireAuthority {
            owner: "w2".into(),
            lease_id: "l2".into(),
            leased_until: "2026-03-19T03:00:00Z".into(),
        });
        assert!(err.is_err());
    }

    #[test]
    fn compatibility_view_writes_section_files() {
        let dir = std::env::temp_dir().join("omx-runtime-test-compat");
        let _ = std::fs::remove_dir_all(&dir);

        let mut engine = RuntimeEngine::new().with_state_dir(&dir);
        engine
            .process(RuntimeCommand::AcquireAuthority {
                owner: "w1".into(),
                lease_id: "l1".into(),
                leased_until: "2026-03-19T02:00:00Z".into(),
            })
            .unwrap();
        engine
            .process(RuntimeCommand::QueueDispatch {
                request_id: "req-1".into(),
                target: "worker-2".into(),
                metadata: None,
            })
            .unwrap();
        engine.write_compatibility_view().unwrap();

        // Verify individual files exist and contain valid JSON
        let authority: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("authority.json")).unwrap())
                .unwrap();
        assert_eq!(authority["owner"], "w1");

        let backlog: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("backlog.json")).unwrap())
                .unwrap();
        assert_eq!(backlog["pending"], 1);

        let readiness: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("readiness.json")).unwrap())
                .unwrap();
        assert_eq!(readiness["ready"], true);

        let replay: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("replay.json")).unwrap())
                .unwrap();
        assert_eq!(replay["deferred_leader_notification"], false);

        assert!(dir.join("dispatch.json").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mark_failed_dispatch_via_engine() {
        let mut engine = RuntimeEngine::new();
        engine
            .process(RuntimeCommand::QueueDispatch {
                request_id: "req-1".into(),
                target: "worker-2".into(),
                metadata: None,
            })
            .unwrap();
        engine
            .process(RuntimeCommand::MarkNotified {
                request_id: "req-1".into(),
                channel: "tmux".into(),
            })
            .unwrap();
        let event = engine
            .process(RuntimeCommand::MarkFailed {
                request_id: "req-1".into(),
                reason: "timeout".into(),
            })
            .unwrap();
        assert!(matches!(event, RuntimeEvent::DispatchFailed { .. }));
        assert_eq!(engine.snapshot().backlog.failed, 1);
    }

    #[test]
    fn queue_dispatch_with_metadata_persists_and_round_trips() {
        let dir = std::env::temp_dir().join("omx-runtime-test-metadata");
        let _ = std::fs::remove_dir_all(&dir);

        let mut engine = RuntimeEngine::new().with_state_dir(&dir);
        let meta = serde_json::json!({"priority": "high", "worker_type": "codex"});
        engine
            .process(RuntimeCommand::QueueDispatch {
                request_id: "req-meta".into(),
                target: "worker-3".into(),
                metadata: Some(meta.clone()),
            })
            .unwrap();
        engine.persist().unwrap();

        let loaded = RuntimeEngine::load(&dir).unwrap();
        let queued_event = loaded.event_log().iter().find(|e| {
            matches!(e, RuntimeEvent::DispatchQueued { request_id, .. } if request_id == "req-meta")
        });
        assert!(queued_event.is_some());
        if let Some(RuntimeEvent::DispatchQueued { metadata, .. }) = queued_event {
            assert_eq!(*metadata, Some(meta));
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_dispatch_records_persists_unrelated_records_and_survives_reload() {
        let dir = std::env::temp_dir().join("omx-runtime-test-remove-dispatch-records");
        let _ = std::fs::remove_dir_all(&dir);

        let mut engine = RuntimeEngine::new().with_state_dir(&dir);
        for (request_id, target) in [
            ("req-removed", "worker-removed"),
            ("req-kept", "worker-kept"),
        ] {
            engine
                .process(RuntimeCommand::QueueDispatch {
                    request_id: request_id.into(),
                    target: target.into(),
                    metadata: None,
                })
                .unwrap();
        }
        engine.persist().unwrap();
        let removed = engine
            .process(RuntimeCommand::RemoveDispatchRecords {
                request_ids: vec!["req-removed".into()],
            })
            .unwrap();
        assert_eq!(
            removed,
            RuntimeEvent::DispatchRecordsRemoved {
                request_ids: vec!["req-removed".into()],
            }
        );
        engine.persist().unwrap();

        let dispatch: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("dispatch.json")).unwrap())
                .unwrap();
        assert_eq!(dispatch["records"].as_array().unwrap().len(), 1);
        assert_eq!(dispatch["records"][0]["request_id"], "req-kept");
        assert!(engine.event_log().iter().all(|event| {
            !dispatch_event_matches_request_ids(
                event,
                &std::collections::HashSet::from(["req-removed"]),
            )
        }));

        let loaded = RuntimeEngine::load(&dir).unwrap();
        assert_eq!(loaded.snapshot().backlog.pending, 1);
        loaded.persist().unwrap();
        let reloaded_dispatch: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("dispatch.json")).unwrap())
                .unwrap();
        assert_eq!(reloaded_dispatch["records"].as_array().unwrap().len(), 1);
        assert_eq!(reloaded_dispatch["records"][0]["request_id"], "req-kept");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn compact_removes_delivered_and_failed_events() {
        let mut engine = RuntimeEngine::new();
        engine
            .process(RuntimeCommand::QueueDispatch {
                request_id: "req-pending".into(),
                target: "w1".into(),
                metadata: None,
            })
            .unwrap();
        engine
            .process(RuntimeCommand::QueueDispatch {
                request_id: "req-delivered".into(),
                target: "w2".into(),
                metadata: None,
            })
            .unwrap();
        engine
            .process(RuntimeCommand::QueueDispatch {
                request_id: "req-failed".into(),
                target: "w3".into(),
                metadata: None,
            })
            .unwrap();

        engine
            .process(RuntimeCommand::MarkNotified {
                request_id: "req-delivered".into(),
                channel: "tmux".into(),
            })
            .unwrap();
        engine
            .process(RuntimeCommand::MarkDelivered {
                request_id: "req-delivered".into(),
            })
            .unwrap();

        engine
            .process(RuntimeCommand::MarkNotified {
                request_id: "req-failed".into(),
                channel: "tmux".into(),
            })
            .unwrap();
        engine
            .process(RuntimeCommand::MarkFailed {
                request_id: "req-failed".into(),
                reason: "timeout".into(),
            })
            .unwrap();

        assert_eq!(engine.event_log().len(), 7);

        engine.compact();

        // Only the pending dispatch event remains
        let remaining: Vec<&RuntimeEvent> = engine.event_log().iter().collect();
        assert_eq!(remaining.len(), 1);
        assert!(matches!(
            remaining[0],
            RuntimeEvent::DispatchQueued { request_id, .. } if request_id == "req-pending"
        ));
    }

    #[test]
    fn queue_dispatch_rejects_duplicate_ids_before_and_after_terminal_lifecycle() {
        let mut engine = RuntimeEngine::new();
        engine
            .process(RuntimeCommand::QueueDispatch {
                request_id: "req-duplicate".into(),
                target: "worker-1".into(),
                metadata: None,
            })
            .unwrap();

        let pending_duplicate = engine
            .process(RuntimeCommand::QueueDispatch {
                request_id: "req-duplicate".into(),
                target: "worker-2".into(),
                metadata: None,
            })
            .unwrap_err();
        assert!(matches!(
            pending_duplicate,
            EngineError::Dispatch(DispatchError::DuplicateRequestId { .. })
        ));

        engine
            .process(RuntimeCommand::MarkFailed {
                request_id: "req-duplicate".into(),
                reason: "unavailable".into(),
            })
            .unwrap();
        let terminal_duplicate = engine
            .process(RuntimeCommand::QueueDispatch {
                request_id: "req-duplicate".into(),
                target: "worker-3".into(),
                metadata: None,
            })
            .unwrap_err();
        assert!(matches!(
            terminal_duplicate,
            EngineError::Dispatch(DispatchError::DuplicateRequestId { .. })
        ));
        assert_eq!(engine.event_log().len(), 2);
    }

    #[test]
    fn load_rejects_duplicate_and_out_of_order_legacy_dispatch_events() {
        let cases = [
            (
                "duplicate",
                vec![
                    RuntimeEvent::DispatchQueued {
                        request_id: "req-1".into(),
                        target: "worker-1".into(),
                        metadata: None,
                    },
                    RuntimeEvent::DispatchQueued {
                        request_id: "req-1".into(),
                        target: "worker-2".into(),
                        metadata: None,
                    },
                ],
                "duplicate dispatch request id: req-1",
            ),
            (
                "out-of-order",
                vec![RuntimeEvent::DispatchDelivered {
                    request_id: "req-1".into(),
                }],
                "dispatch record not found: req-1",
            ),
        ];

        for (name, events, expected_error) in cases {
            let dir = std::env::temp_dir().join(format!("omx-runtime-test-malformed-{name}"));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("events.json"),
                serde_json::to_string(&events).unwrap(),
            )
            .unwrap();
            std::fs::write(
                dir.join(DISPATCH_SEEN_LEDGER_FILE),
                r#"{"schema_version":2,"ledger_epoch":1,"request_ids":["req-1"]}"#,
            )
            .unwrap();

            let err = match RuntimeEngine::load(&dir) {
                Ok(_) => panic!("malformed dispatch event log loaded successfully"),
                Err(err) => err,
            };
            assert!(err.to_string().contains(expected_error));
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn compact_persist_reload_is_idempotent_and_preserves_unrelated_dispatches() {
        let dir = std::env::temp_dir().join("omx-runtime-test-compact-idempotent");
        let _ = std::fs::remove_dir_all(&dir);
        let mut engine = RuntimeEngine::new().with_state_dir(&dir);

        for request_id in ["pending", "terminal"] {
            engine
                .process(RuntimeCommand::QueueDispatch {
                    request_id: request_id.into(),
                    target: format!("worker-{request_id}"),
                    metadata: None,
                })
                .unwrap();
        }
        engine
            .process(RuntimeCommand::MarkFailed {
                request_id: "terminal".into(),
                reason: "target unavailable".into(),
            })
            .unwrap();
        engine.compact();
        engine.persist().unwrap();

        let immediate_dispatch: DispatchLog =
            serde_json::from_str(&std::fs::read_to_string(dir.join("dispatch.json")).unwrap())
                .unwrap();
        assert_eq!(immediate_dispatch.records().len(), 1);
        assert_eq!(immediate_dispatch.records()[0].request_id, "pending");

        let mut loaded = RuntimeEngine::load(&dir).unwrap();
        assert_eq!(loaded.snapshot().backlog, engine.snapshot().backlog);
        assert_eq!(loaded.event_log(), engine.event_log());
        loaded.compact();
        assert_eq!(loaded.event_log(), engine.event_log());
        loaded.persist().unwrap();

        let reloaded = RuntimeEngine::load(&dir).unwrap();
        assert_eq!(reloaded.snapshot().backlog, engine.snapshot().backlog);
        assert_eq!(reloaded.event_log(), engine.event_log());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn compacted_and_removed_dispatch_ids_remain_permanently_reserved_after_reload() {
        let dir = std::env::temp_dir().join("omx-runtime-test-dispatch-seen-ledger");
        let _ = std::fs::remove_dir_all(&dir);
        let mut engine = RuntimeEngine::new().with_state_dir(&dir);
        for request_id in ["compacted", "removed", "unrelated"] {
            engine
                .process(RuntimeCommand::QueueDispatch {
                    request_id: request_id.into(),
                    target: format!("worker-{request_id}"),
                    metadata: None,
                })
                .unwrap();
        }
        engine
            .process(RuntimeCommand::MarkFailed {
                request_id: "compacted".into(),
                reason: "unavailable".into(),
            })
            .unwrap();
        engine.compact();
        engine
            .process(RuntimeCommand::RemoveDispatchRecords {
                request_ids: vec!["removed".into()],
            })
            .unwrap();
        engine.persist().unwrap();

        let mut loaded = RuntimeEngine::load(&dir).unwrap();
        assert_eq!(loaded.snapshot().backlog.pending, 1);
        for request_id in ["compacted", "removed"] {
            assert!(matches!(
                loaded
                    .process(RuntimeCommand::QueueDispatch {
                        request_id: request_id.into(),
                        target: "replacement".into(),
                        metadata: None,
                    })
                    .unwrap_err(),
                EngineError::Dispatch(DispatchError::DuplicateRequestId { .. })
            ));
        }
        loaded
            .process(RuntimeCommand::MarkFailed {
                request_id: "unrelated".into(),
                reason: "unavailable".into(),
            })
            .unwrap();
        assert_eq!(loaded.snapshot().backlog.failed, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn schema_1_dispatch_seen_ledger_migrates_with_removed_and_compacted_history() {
        let dir = std::env::temp_dir().join("omx-runtime-test-schema-1-dispatch-seen-ledger");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let events = vec![
            RuntimeEvent::DispatchQueued {
                request_id: "pending".into(),
                target: "worker-pending".into(),
                metadata: None,
            },
            RuntimeEvent::DispatchRecordsRemoved {
                request_ids: vec!["removed".into()],
            },
        ];
        std::fs::write(
            dir.join("events.json"),
            serde_json::to_string(&events).unwrap(),
        )
        .unwrap();
        std::fs::write(
            dir.join(DISPATCH_SEEN_LEDGER_FILE),
            r#"{"schema_version":1,"request_ids":["compacted","pending","removed"]}"#,
        )
        .unwrap();

        let mut loaded = RuntimeEngine::load(&dir).unwrap();
        assert_eq!(loaded.snapshot().backlog.pending, 1);
        for request_id in ["compacted", "pending", "removed"] {
            assert!(matches!(
                loaded
                    .process(RuntimeCommand::QueueDispatch {
                        request_id: request_id.into(),
                        target: "replacement".into(),
                        metadata: None,
                    })
                    .unwrap_err(),
                EngineError::Dispatch(DispatchError::DuplicateRequestId { .. })
            ));
        }
        loaded.persist().unwrap();

        let ledger: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join(DISPATCH_SEEN_LEDGER_FILE)).unwrap(),
        )
        .unwrap();
        assert_eq!(ledger["schema_version"], 2);
        assert_eq!(ledger["ledger_epoch"], 1);
        assert_eq!(
            ledger["request_ids"],
            serde_json::json!(["compacted", "pending", "removed"])
        );

        let mut reloaded = RuntimeEngine::load(&dir).unwrap();
        assert_eq!(reloaded.snapshot().backlog.pending, 1);
        for request_id in ["compacted", "pending", "removed"] {
            assert!(matches!(
                reloaded
                    .process(RuntimeCommand::QueueDispatch {
                        request_id: request_id.into(),
                        target: "replacement".into(),
                        metadata: None,
                    })
                    .unwrap_err(),
                EngineError::Dispatch(DispatchError::DuplicateRequestId { .. })
            ));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_rejects_malformed_or_duplicate_dispatch_seen_ledger() {
        let cases = [
            (
                "malformed",
                r#"{"schema_version":2,"ledger_epoch":1,"request_ids":"req-1"}"#,
            ),
            (
                "duplicate",
                r#"{"schema_version":2,"ledger_epoch":1,"request_ids":["req-1","req-1"]}"#,
            ),
            (
                "unknown-schema",
                r#"{"schema_version":3,"ledger_epoch":1,"request_ids":[]}"#,
            ),
            (
                "unknown-epoch",
                r#"{"schema_version":2,"ledger_epoch":2,"request_ids":[]}"#,
            ),
            (
                "empty-id",
                r#"{"schema_version":2,"ledger_epoch":1,"request_ids":[""]}"#,
            ),
        ];
        for (name, ledger) in cases {
            let dir = std::env::temp_dir().join(format!("omx-runtime-test-seen-ledger-{name}"));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("events.json"), "[]").unwrap();
            std::fs::write(dir.join(DISPATCH_SEEN_LEDGER_FILE), ledger).unwrap();
            assert!(RuntimeEngine::load(&dir).is_err());
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn load_rejects_missing_or_ambiguous_pre_ledger_dispatch_history() {
        let cases = [
            (
                "missing-ledger",
                vec![RuntimeEvent::DispatchQueued {
                    request_id: "legacy".into(),
                    target: "worker-legacy".into(),
                    metadata: None,
                }],
            ),
            (
                "legacy-removal",
                vec![RuntimeEvent::DispatchRecordsRemoved {
                    request_ids: vec!["legacy-removed".into()],
                }],
            ),
        ];
        for (name, events) in cases {
            let dir = std::env::temp_dir().join(format!("omx-runtime-test-{name}"));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("events.json"),
                serde_json::to_string(&events).unwrap(),
            )
            .unwrap();
            assert!(RuntimeEngine::load(&dir).is_err());
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn removal_reserves_ids_immediately_and_after_reload() {
        let dir = std::env::temp_dir().join("omx-runtime-test-remove-reserves-id");
        let _ = std::fs::remove_dir_all(&dir);
        let mut engine = RuntimeEngine::new().with_state_dir(&dir);
        for request_id in ["removed", "kept"] {
            engine
                .process(RuntimeCommand::QueueDispatch {
                    request_id: request_id.into(),
                    target: format!("worker-{request_id}"),
                    metadata: None,
                })
                .unwrap();
        }
        engine
            .process(RuntimeCommand::RemoveDispatchRecords {
                request_ids: vec!["removed".into()],
            })
            .unwrap();
        assert!(matches!(
            engine
                .process(RuntimeCommand::QueueDispatch {
                    request_id: "removed".into(),
                    target: "replacement".into(),
                    metadata: None,
                })
                .unwrap_err(),
            EngineError::Dispatch(DispatchError::DuplicateRequestId { .. })
        ));
        engine.persist().unwrap();
        let mut loaded = RuntimeEngine::load(&dir).unwrap();
        assert!(matches!(
            loaded
                .process(RuntimeCommand::QueueDispatch {
                    request_id: "removed".into(),
                    target: "replacement".into(),
                    metadata: None,
                })
                .unwrap_err(),
            EngineError::Dispatch(DispatchError::DuplicateRequestId { .. })
        ));
        assert_eq!(loaded.snapshot().backlog.pending, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delayed_terminal_commands_and_removal_do_not_mutate_unrelated_dispatch() {
        let mut engine = RuntimeEngine::new();
        for request_id in ["terminal", "unrelated"] {
            engine
                .process(RuntimeCommand::QueueDispatch {
                    request_id: request_id.into(),
                    target: format!("worker-{request_id}"),
                    metadata: None,
                })
                .unwrap();
        }
        engine
            .process(RuntimeCommand::MarkFailed {
                request_id: "terminal".into(),
                reason: "unavailable".into(),
            })
            .unwrap();
        engine.compact();
        for command in [
            RuntimeCommand::MarkNotified {
                request_id: "terminal".into(),
                channel: "tmux".into(),
            },
            RuntimeCommand::MarkDelivered {
                request_id: "terminal".into(),
            },
            RuntimeCommand::MarkFailed {
                request_id: "terminal".into(),
                reason: "late".into(),
            },
        ] {
            assert!(matches!(
                engine.process(command),
                Err(EngineError::Dispatch(DispatchError::NotFound { .. }))
            ));
        }
        assert!(matches!(
            engine.process(RuntimeCommand::RemoveDispatchRecords {
                request_ids: vec!["terminal".into()],
            }),
            Err(EngineError::Dispatch(DispatchError::NotFound { .. }))
        ));
        assert_eq!(engine.snapshot().backlog.pending, 1);
        assert_eq!(engine.dispatch.records()[0].request_id, "unrelated");
    }

    #[test]
    fn repeated_terminal_commands_are_rejected_without_replay_events() {
        let mut engine = RuntimeEngine::new();
        engine
            .process(RuntimeCommand::QueueDispatch {
                request_id: "terminal".into(),
                target: "worker".into(),
                metadata: None,
            })
            .unwrap();
        engine
            .process(RuntimeCommand::MarkFailed {
                request_id: "terminal".into(),
                reason: "unavailable".into(),
            })
            .unwrap();
        let events_before_replay = engine.event_log().len();
        assert!(matches!(
            engine.process(RuntimeCommand::MarkFailed {
                request_id: "terminal".into(),
                reason: "replayed".into(),
            }),
            Err(EngineError::Dispatch(
                DispatchError::InvalidTransition { .. }
            ))
        ));
        assert_eq!(engine.event_log().len(), events_before_replay);
        engine.compact();
        engine.compact();
        assert_eq!(engine.snapshot().backlog.failed, 0);
    }

    #[test]
    fn remove_dispatch_records_rejects_noncanonical_or_unknown_ids_without_mutation() {
        let mut engine = RuntimeEngine::new();
        for request_id in ["a", "b"] {
            engine
                .process(RuntimeCommand::QueueDispatch {
                    request_id: request_id.into(),
                    target: "worker".into(),
                    metadata: None,
                })
                .unwrap();
        }
        let events_before = engine.event_log().to_vec();
        for request_ids in [
            vec![],
            vec!["".into()],
            vec!["a".into(), "a".into()],
            vec!["missing".into()],
            vec!["a".into(), "missing".into()],
        ] {
            assert!(engine
                .process(RuntimeCommand::RemoveDispatchRecords { request_ids })
                .is_err());
            assert_eq!(engine.event_log(), events_before);
            assert_eq!(engine.dispatch.records().len(), 2);
        }

        let removed = engine
            .process(RuntimeCommand::RemoveDispatchRecords {
                request_ids: vec!["b".into(), "a".into()],
            })
            .unwrap();
        assert_eq!(
            removed,
            RuntimeEvent::DispatchRecordsRemoved {
                request_ids: vec!["a".into(), "b".into()],
            }
        );
        assert!(engine.event_log().is_empty());
    }

    #[test]
    fn torn_or_deleted_seen_ledger_fails_reload_after_compaction() {
        let dir = std::env::temp_dir().join("omx-runtime-test-torn-seen-ledger");
        let _ = std::fs::remove_dir_all(&dir);
        let mut engine = RuntimeEngine::new().with_state_dir(&dir);
        engine
            .process(RuntimeCommand::QueueDispatch {
                request_id: "retired".into(),
                target: "worker".into(),
                metadata: None,
            })
            .unwrap();
        engine
            .process(RuntimeCommand::MarkFailed {
                request_id: "retired".into(),
                reason: "unavailable".into(),
            })
            .unwrap();
        engine.compact();
        engine.persist().unwrap();
        std::fs::remove_file(dir.join(DISPATCH_SEEN_LEDGER_FILE)).unwrap();
        assert!(RuntimeEngine::load(&dir).is_err());
        std::fs::write(dir.join(DISPATCH_SEEN_LEDGER_FILE), "{").unwrap();
        assert!(RuntimeEngine::load(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
