use std::fmt;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailboxRecord {
    pub message_id: String,
    pub from_worker: String,
    pub to_worker: String,
    pub body: String,
    pub created_at: String,
    pub notified_at: Option<String>,
    pub delivered_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MailboxError {
    NotFound { message_id: String },
    AlreadyDelivered { message_id: String },
}

impl fmt::Display for MailboxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound { message_id } => {
                write!(f, "mailbox record not found: {message_id}")
            }
            Self::AlreadyDelivered { message_id } => {
                write!(f, "mailbox message already delivered: {message_id}")
            }
        }
    }
}

impl std::error::Error for MailboxError {}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MailboxLog {
    records: Vec<MailboxRecord>,
}

impl MailboxLog {
    pub fn new() -> Self {
        Self {
            records: Vec::new(),
        }
    }

    pub fn create(
        &mut self,
        message_id: impl Into<String>,
        from_worker: impl Into<String>,
        to_worker: impl Into<String>,
        body: impl Into<String>,
    ) {
        self.records.push(MailboxRecord {
            message_id: message_id.into(),
            from_worker: from_worker.into(),
            to_worker: to_worker.into(),
            body: body.into(),
            created_at: now_iso(),
            notified_at: None,
            delivered_at: None,
        });
    }

    pub fn mark_notified(&mut self, message_id: &str) -> Result<(), MailboxError> {
        let record = self.find_mut(message_id)?;
        if record.delivered_at.is_some() {
            return Err(MailboxError::AlreadyDelivered {
                message_id: message_id.to_string(),
            });
        }
        record.notified_at = Some(now_iso());
        Ok(())
    }

    pub fn mark_delivered(&mut self, message_id: &str) -> Result<(), MailboxError> {
        let record = self.find_mut(message_id)?;
        if record.delivered_at.is_some() {
            return Err(MailboxError::AlreadyDelivered {
                message_id: message_id.to_string(),
            });
        }
        record.delivered_at = Some(now_iso());
        Ok(())
    }

    pub fn records(&self) -> &[MailboxRecord] {
        &self.records
    }

    fn find_mut(&mut self, message_id: &str) -> Result<&mut MailboxRecord, MailboxError> {
        self.records
            .iter_mut()
            .find(|r| r.message_id == message_id)
            .ok_or_else(|| MailboxError::NotFound {
                message_id: message_id.to_string(),
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
    let days = secs / 86400;
    let remaining = secs % 86400;
    let hours = remaining / 3600;
    let minutes = (remaining % 3600) / 60;
    let seconds = remaining % 60;
    let (year, month, day) = epoch_days_to_date(days);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}.{millis:03}Z")
}

fn epoch_days_to_date(total_days: u64) -> (u64, u64, u64) {
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
    fn create_adds_record_with_timestamp() {
        let mut log = MailboxLog::new();
        log.create("msg-1", "worker-a", "worker-b", "hello");
        assert_eq!(log.records().len(), 1);
        let r = &log.records()[0];
        assert_eq!(r.message_id, "msg-1");
        assert_eq!(r.from_worker, "worker-a");
        assert_eq!(r.to_worker, "worker-b");
        assert_eq!(r.body, "hello");
        assert!(!r.created_at.is_empty());
        assert!(r.notified_at.is_none());
        assert!(r.delivered_at.is_none());
    }

    #[test]
    fn mark_notified_sets_timestamp() {
        let mut log = MailboxLog::new();
        log.create("msg-1", "a", "b", "body");
        log.mark_notified("msg-1").unwrap();
        assert!(log.records()[0].notified_at.is_some());
    }

    #[test]
    fn mark_delivered_sets_timestamp() {
        let mut log = MailboxLog::new();
        log.create("msg-1", "a", "b", "body");
        log.mark_delivered("msg-1").unwrap();
        assert!(log.records()[0].delivered_at.is_some());
    }

    #[test]
    fn mark_notified_not_found() {
        let mut log = MailboxLog::new();
        let err = log.mark_notified("nonexistent").unwrap_err();
        assert!(matches!(err, MailboxError::NotFound { .. }));
    }

    #[test]
    fn mark_delivered_not_found() {
        let mut log = MailboxLog::new();
        let err = log.mark_delivered("nonexistent").unwrap_err();
        assert!(matches!(err, MailboxError::NotFound { .. }));
    }

    #[test]
    fn mark_notified_already_delivered_errors() {
        let mut log = MailboxLog::new();
        log.create("msg-1", "a", "b", "body");
        log.mark_delivered("msg-1").unwrap();
        let err = log.mark_notified("msg-1").unwrap_err();
        assert!(matches!(err, MailboxError::AlreadyDelivered { .. }));
    }

    #[test]
    fn mark_delivered_twice_errors() {
        let mut log = MailboxLog::new();
        log.create("msg-1", "a", "b", "body");
        log.mark_delivered("msg-1").unwrap();
        let err = log.mark_delivered("msg-1").unwrap_err();
        assert!(matches!(err, MailboxError::AlreadyDelivered { .. }));
    }

    #[test]
    fn full_lifecycle() {
        let mut log = MailboxLog::new();
        log.create("msg-1", "worker-a", "worker-b", "task payload");
        log.mark_notified("msg-1").unwrap();
        log.mark_delivered("msg-1").unwrap();

        let r = &log.records()[0];
        assert!(r.notified_at.is_some());
        assert!(r.delivered_at.is_some());
    }

    #[test]
    fn multiple_messages() {
        let mut log = MailboxLog::new();
        log.create("msg-1", "a", "b", "first");
        log.create("msg-2", "b", "a", "second");
        assert_eq!(log.records().len(), 2);
        log.mark_delivered("msg-2").unwrap();
        assert!(log.records()[1].delivered_at.is_some());
        assert!(log.records()[0].delivered_at.is_none());
    }

    #[test]
    fn serialization_round_trip() {
        let mut log = MailboxLog::new();
        log.create("msg-1", "a", "b", "payload");
        log.mark_notified("msg-1").unwrap();
        let json = serde_json::to_string(&log).unwrap();
        let deserialized: MailboxLog = serde_json::from_str(&json).unwrap();
        assert_eq!(log.records().len(), deserialized.records().len());
        assert_eq!(log.records()[0], deserialized.records()[0]);
    }
}
