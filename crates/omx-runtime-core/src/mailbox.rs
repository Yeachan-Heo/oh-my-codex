use std::fmt;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailboxRecord {
    #[serde(default)]
    pub team_name: Option<String>,
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
    DuplicateMessageId { message_id: String },
    NotFound { message_id: String },
    AlreadyDelivered { message_id: String },
}

impl fmt::Display for MailboxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DuplicateMessageId { message_id } => {
                write!(f, "mailbox message already exists: {message_id}")
            }
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
        team_name: Option<String>,
        message_id: impl Into<String>,
        from_worker: impl Into<String>,
        to_worker: impl Into<String>,
        body: impl Into<String>,
    ) -> Result<(), MailboxError> {
        let message_id = message_id.into();
        if self.records.iter().any(|record| {
            record.message_id == message_id
                && (team_name.is_none()
                    || record.team_name.is_none()
                    || record.team_name == team_name)
        }) {
            return Err(MailboxError::DuplicateMessageId { message_id });
        }
        self.replay_create(team_name, message_id, from_worker, to_worker, body);
        Ok(())
    }

    pub(crate) fn replay_create(
        &mut self,
        team_name: Option<String>,
        message_id: impl Into<String>,
        from_worker: impl Into<String>,
        to_worker: impl Into<String>,
        body: impl Into<String>,
    ) {
        self.records.push(MailboxRecord {
            team_name,
            message_id: message_id.into(),
            from_worker: from_worker.into(),
            to_worker: to_worker.into(),
            body: body.into(),
            created_at: now_iso(),
            notified_at: None,
            delivered_at: None,
        });
    }

    pub fn mark_notified(
        &mut self,
        message_id: &str,
        team_name: Option<&str>,
    ) -> Result<Option<String>, MailboxError> {
        let record = self.find_mut(message_id, team_name)?;
        if record.delivered_at.is_some() {
            return Err(MailboxError::AlreadyDelivered {
                message_id: message_id.to_string(),
            });
        }
        record.notified_at = Some(now_iso());
        Ok(record.team_name.clone())
    }

    pub fn mark_delivered(
        &mut self,
        message_id: &str,
        team_name: Option<&str>,
    ) -> Result<Option<String>, MailboxError> {
        let record = self.find_mut(message_id, team_name)?;
        // Retrying a durable acknowledgement must still repair its stale projection.
        if record.delivered_at.is_none() {
            record.delivered_at = Some(now_iso());
        }
        Ok(record.team_name.clone())
    }

    pub fn records(&self) -> &[MailboxRecord] {
        &self.records
    }

    pub(crate) fn recover_body(&mut self, team_name: Option<&str>, message_id: &str, body: &str) {
        let mut matches = self.records.iter().enumerate().filter(|(_, record)| {
            record.message_id == message_id && record.team_name.as_deref() == team_name
        });
        let Some((index, _)) = matches.next() else {
            return;
        };
        if matches.next().is_none() && self.records[index].body.is_empty() && !body.is_empty() {
            self.records[index].body = body.to_string();
        }
    }

    fn find_mut(
        &mut self,
        message_id: &str,
        team_name: Option<&str>,
    ) -> Result<&mut MailboxRecord, MailboxError> {
        let mut scoped = self.records.iter().enumerate().filter(|(_, record)| {
            record.message_id == message_id
                && team_name.is_some()
                && record.team_name.as_deref() == team_name
        });
        let first = scoped.next().map(|(index, _)| index);
        let index = if scoped.next().is_some() {
            None
        } else if first.is_some() {
            first
        } else {
            // Legacy ownership is checked by the caller; duplicate IDs cannot prove identity.
            let mut matches = self
                .records
                .iter()
                .enumerate()
                .filter(|(_, record)| record.message_id == message_id);
            let first = matches
                .next()
                .filter(|(_, record)| record.team_name.is_none())
                .map(|(index, _)| index);
            if matches.next().is_none() {
                first
            } else {
                None
            }
        };
        index
            .map(|index| &mut self.records[index])
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
        log.create(None, "msg-1", "worker-a", "worker-b", "hello")
            .unwrap();
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
    fn create_rejects_duplicate_team_ids_but_allows_cross_team_reuse() {
        let mut log = MailboxLog::new();
        log.create(Some("alpha".into()), "same-id", "a", "worker-1", "alpha")
            .unwrap();
        assert!(matches!(
            log.create(
                Some("alpha".into()),
                "same-id",
                "b",
                "worker-1",
                "duplicate"
            ),
            Err(MailboxError::DuplicateMessageId { .. })
        ));
        log.create(Some("beta".into()), "same-id", "b", "worker-1", "beta")
            .unwrap();
        assert_eq!(log.records().len(), 2);
        assert_eq!(log.records()[0].team_name.as_deref(), Some("alpha"));
        assert_eq!(log.records()[1].team_name.as_deref(), Some("beta"));
    }

    #[test]
    fn mark_notified_sets_timestamp() {
        let mut log = MailboxLog::new();
        log.create(None, "msg-1", "a", "b", "body").unwrap();
        log.mark_notified("msg-1", None).unwrap();
        assert!(log.records()[0].notified_at.is_some());
    }

    #[test]
    fn mark_delivered_sets_timestamp() {
        let mut log = MailboxLog::new();
        log.create(None, "msg-1", "a", "b", "body").unwrap();
        log.mark_delivered("msg-1", None).unwrap();
        assert!(log.records()[0].delivered_at.is_some());
    }

    #[test]
    fn mark_notified_not_found() {
        let mut log = MailboxLog::new();
        let err = log.mark_notified("nonexistent", None).unwrap_err();
        assert!(matches!(err, MailboxError::NotFound { .. }));
    }

    #[test]
    fn mark_delivered_not_found() {
        let mut log = MailboxLog::new();
        let err = log.mark_delivered("nonexistent", None).unwrap_err();
        assert!(matches!(err, MailboxError::NotFound { .. }));
    }

    #[test]
    fn mark_notified_already_delivered_errors() {
        let mut log = MailboxLog::new();
        log.create(None, "msg-1", "a", "b", "body").unwrap();
        log.mark_delivered("msg-1", None).unwrap();
        let err = log.mark_notified("msg-1", None).unwrap_err();
        assert!(matches!(err, MailboxError::AlreadyDelivered { .. }));
    }

    #[test]
    fn mark_delivered_twice_preserves_timestamp_and_scope_checks() {
        let mut log = MailboxLog::new();
        log.create(Some("alpha".into()), "msg-1", "a", "b", "body")
            .unwrap();
        log.mark_delivered("msg-1", Some("alpha")).unwrap();
        let timestamp = log.records()[0].delivered_at.clone();
        assert_eq!(
            log.mark_delivered("msg-1", Some("alpha")).unwrap(),
            Some("alpha".into())
        );
        assert_eq!(log.records()[0].delivered_at, timestamp);
        for team in [None, Some("beta")] {
            assert!(log.mark_delivered("msg-1", team).is_err());
        }
    }

    #[test]
    fn ambiguous_mailbox_ids_cannot_be_acknowledged() {
        for scopes in [
            vec![None, None],
            vec![Some("beta".to_string()), Some("beta".to_string())],
        ] {
            let mut log = MailboxLog::new();
            for scope in scopes {
                log.replay_create(scope, "duplicate", "leader-fixed", "worker-1", "body");
            }
            for team in [None, Some("alpha"), Some("beta")] {
                assert!(log.mark_notified("duplicate", team).is_err());
                assert!(log.mark_delivered("duplicate", team).is_err());
            }
            assert!(log
                .records()
                .iter()
                .all(|record| record.notified_at.is_none() && record.delivered_at.is_none()));
        }
    }

    #[test]
    fn full_lifecycle() {
        let mut log = MailboxLog::new();
        log.create(None, "msg-1", "worker-a", "worker-b", "task payload")
            .unwrap();
        log.mark_notified("msg-1", None).unwrap();
        log.mark_delivered("msg-1", None).unwrap();

        let r = &log.records()[0];
        assert!(r.notified_at.is_some());
        assert!(r.delivered_at.is_some());
    }

    #[test]
    fn multiple_messages() {
        let mut log = MailboxLog::new();
        log.create(None, "msg-1", "a", "b", "first").unwrap();
        log.create(None, "msg-2", "b", "a", "second").unwrap();
        assert_eq!(log.records().len(), 2);
        log.mark_delivered("msg-2", None).unwrap();
        assert!(log.records()[1].delivered_at.is_some());
        assert!(log.records()[0].delivered_at.is_none());
    }

    #[test]
    fn serialization_round_trip() {
        let mut log = MailboxLog::new();
        log.create(None, "msg-1", "a", "b", "payload").unwrap();
        log.mark_notified("msg-1", None).unwrap();
        let json = serde_json::to_string(&log).unwrap();
        let deserialized: MailboxLog = serde_json::from_str(&json).unwrap();
        assert_eq!(log.records().len(), deserialized.records().len());
        assert_eq!(log.records()[0], deserialized.records()[0]);
    }
}
