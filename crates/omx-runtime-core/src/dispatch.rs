use std::fmt;

use serde::{Deserialize, Serialize};

use crate::BacklogSnapshot;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DispatchStatus {
    Pending,
    Notified,
    Delivered,
    Failed,
}

impl fmt::Display for DispatchStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Pending => write!(f, "pending"),
            Self::Notified => write!(f, "notified"),
            Self::Delivered => write!(f, "delivered"),
            Self::Failed => write!(f, "failed"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DispatchRecord {
    pub request_id: String,
    pub target: String,
    pub status: DispatchStatus,
    pub created_at: String,
    pub notified_at: Option<String>,
    pub delivered_at: Option<String>,
    pub failed_at: Option<String>,
    pub reason: Option<String>,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DispatchError {
    NotFound {
        request_id: String,
    },
    InvalidTransition {
        request_id: String,
        from: DispatchStatus,
        to: DispatchStatus,
    },
}

impl fmt::Display for DispatchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound { request_id } => {
                write!(f, "dispatch record not found: {request_id}")
            }
            Self::InvalidTransition {
                request_id,
                from,
                to,
            } => {
                write!(f, "invalid transition for {request_id}: {from} -> {to}")
            }
        }
    }
}

impl std::error::Error for DispatchError {}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DispatchLog {
    records: Vec<DispatchRecord>,
}

impl DispatchLog {
    pub fn new() -> Self {
        Self {
            records: Vec::new(),
        }
    }

    pub fn queue(
        &mut self,
        request_id: impl Into<String>,
        target: impl Into<String>,
        metadata: Option<serde_json::Value>,
    ) {
        self.records.push(DispatchRecord {
            request_id: request_id.into(),
            target: target.into(),
            status: DispatchStatus::Pending,
            created_at: now_iso(),
            notified_at: None,
            delivered_at: None,
            failed_at: None,
            reason: None,
            metadata,
        });
    }

    pub fn mark_notified(
        &mut self,
        request_id: &str,
        channel: impl Into<String>,
    ) -> Result<(), DispatchError> {
        let record = self.find_mut(request_id)?;
        if record.status != DispatchStatus::Pending {
            return Err(DispatchError::InvalidTransition {
                request_id: request_id.to_string(),
                from: record.status.clone(),
                to: DispatchStatus::Notified,
            });
        }
        record.status = DispatchStatus::Notified;
        record.notified_at = Some(now_iso());
        record.reason = Some(channel.into());
        Ok(())
    }

    pub fn mark_delivered(&mut self, request_id: &str) -> Result<(), DispatchError> {
        let record = self.find_mut(request_id)?;
        if record.status != DispatchStatus::Notified {
            return Err(DispatchError::InvalidTransition {
                request_id: request_id.to_string(),
                from: record.status.clone(),
                to: DispatchStatus::Delivered,
            });
        }
        record.status = DispatchStatus::Delivered;
        record.delivered_at = Some(now_iso());
        Ok(())
    }

    pub fn mark_failed(
        &mut self,
        request_id: &str,
        reason: impl Into<String>,
    ) -> Result<(), DispatchError> {
        let record = self.find_mut(request_id)?;
        // Allow failed from both Pending (target resolution failure) and Notified (delivery failure)
        if record.status != DispatchStatus::Pending && record.status != DispatchStatus::Notified {
            return Err(DispatchError::InvalidTransition {
                request_id: request_id.to_string(),
                from: record.status.clone(),
                to: DispatchStatus::Failed,
            });
        }
        record.status = DispatchStatus::Failed;
        record.failed_at = Some(now_iso());
        record.reason = Some(reason.into());
        Ok(())
    }

    pub fn records(&self) -> &[DispatchRecord] {
        &self.records
    }

    pub fn to_backlog_snapshot(&self) -> BacklogSnapshot {
        let mut snapshot = BacklogSnapshot::default();
        for record in &self.records {
            match record.status {
                DispatchStatus::Pending => snapshot.pending += 1,
                DispatchStatus::Notified => snapshot.notified += 1,
                DispatchStatus::Delivered => snapshot.delivered += 1,
                DispatchStatus::Failed => snapshot.failed += 1,
            }
        }
        snapshot
    }

    fn find_mut(&mut self, request_id: &str) -> Result<&mut DispatchRecord, DispatchError> {
        self.records
            .iter_mut()
            .find(|r| r.request_id == request_id)
            .ok_or_else(|| DispatchError::NotFound {
                request_id: request_id.to_string(),
            })
    }
}

fn now_iso() -> String {
    use std::time::SystemTime;
    let duration = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = duration.as_secs();
    let millis = duration.subsec_millis();
    // ISO 8601 approximation without chrono dependency
    let days = secs / 86400;
    let remaining = secs % 86400;
    let hours = remaining / 3600;
    let minutes = (remaining % 3600) / 60;
    let seconds = remaining % 60;
    // Epoch date: 1970-01-01
    // Simple calculation for dates (good enough for ordering, not calendar-precise for leap years)
    let (year, month, day) = epoch_days_to_date(days);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}.{millis:03}Z")
}

fn epoch_days_to_date(total_days: u64) -> (u64, u64, u64) {
    // Simplified date calculation from epoch days
    let mut days = total_days;
    let mut year = 1970u64;
    loop {
        let days_in_year = if is_leap(year) { 366 } else { 365 };
        if days < days_in_year {
            break;
        }
        days -= days_in_year;
        year += 1;
    }
    let leap = is_leap(year);
    let month_days: [u64; 12] = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1u64;
    for &md in &month_days {
        if days < md {
            break;
        }
        days -= md;
        month += 1;
    }
    (year, month, days + 1)
}

#[allow(unknown_lints, clippy::manual_is_multiple_of)]
fn is_leap(year: u64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_and_transition_happy_path() {
        let mut log = DispatchLog::new();
        log.queue("req-1", "worker-1", None);
        assert_eq!(log.records().len(), 1);
        assert_eq!(log.records()[0].status, DispatchStatus::Pending);

        log.mark_notified("req-1", "tmux").unwrap();
        assert_eq!(log.records()[0].status, DispatchStatus::Notified);

        log.mark_delivered("req-1").unwrap();
        assert_eq!(log.records()[0].status, DispatchStatus::Delivered);
    }

    #[test]
    fn mark_failed_from_notified() {
        let mut log = DispatchLog::new();
        log.queue("req-1", "worker-1", None);
        log.mark_notified("req-1", "tmux").unwrap();
        log.mark_failed("req-1", "send_error").unwrap();
        assert_eq!(log.records()[0].status, DispatchStatus::Failed);
    }

    #[test]
    fn invalid_transition_errors() {
        let mut log = DispatchLog::new();
        log.queue("req-1", "worker-1", None);

        // Can't deliver from pending
        let err = log.mark_delivered("req-1").unwrap_err();
        assert!(matches!(err, DispatchError::InvalidTransition { .. }));
    }

    #[test]
    fn mark_failed_from_pending() {
        // Matches TS behavior: pending -> failed allowed for target resolution failures
        let mut log = DispatchLog::new();
        log.queue("req-1", "worker-1", None);
        log.mark_failed("req-1", "target_resolution_failed")
            .unwrap();
        assert_eq!(log.records()[0].status, DispatchStatus::Failed);
    }

    #[test]
    fn not_found_errors() {
        let mut log = DispatchLog::new();
        let err = log.mark_notified("nonexistent", "tmux").unwrap_err();
        assert!(matches!(err, DispatchError::NotFound { .. }));
    }

    #[test]
    fn backlog_snapshot_counts() {
        let mut log = DispatchLog::new();
        log.queue("req-1", "w1", None);
        log.queue("req-2", "w2", None);
        log.queue("req-3", "w3", None);
        log.mark_notified("req-2", "tmux").unwrap();
        log.mark_notified("req-3", "tmux").unwrap();
        log.mark_delivered("req-2").unwrap();
        log.mark_failed("req-3", "error").unwrap();

        let snap = log.to_backlog_snapshot();
        assert_eq!(snap.pending, 1);
        assert_eq!(snap.notified, 0);
        assert_eq!(snap.delivered, 1);
        assert_eq!(snap.failed, 1);
    }

    #[test]
    fn queue_with_metadata_round_trips() {
        let mut log = DispatchLog::new();
        let meta = serde_json::json!({"priority": "high", "tags": ["urgent"]});
        log.queue("req-meta", "worker-1", Some(meta.clone()));

        assert_eq!(log.records()[0].metadata, Some(meta.clone()));

        // Verify serialization round-trip
        let json = serde_json::to_string(&log).unwrap();
        let loaded: DispatchLog = serde_json::from_str(&json).unwrap();
        assert_eq!(loaded.records()[0].metadata, Some(meta));
        assert_eq!(loaded.records()[0].request_id, "req-meta");
    }
}
