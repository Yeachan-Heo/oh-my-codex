use omx_types::{OmxError, WorkerId};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailboxMessage {
    pub id: String,
    pub from: WorkerId,
    pub to: WorkerId,
    pub body: String,
    pub created_at: String,
    pub delivered: bool,
}

pub fn create_message(
    _from: &WorkerId,
    _to: &WorkerId,
    _body: &str,
) -> Result<MailboxMessage, OmxError> {
    todo!("Phase 3: create mailbox message with unique ID and timestamp")
}

pub fn pending_messages(_for_worker: &WorkerId) -> Result<Vec<MailboxMessage>, OmxError> {
    todo!("Phase 3: read undelivered messages for worker")
}

pub fn mark_delivered(_message_id: &str) -> Result<(), OmxError> {
    todo!("Phase 3: mark message as delivered")
}

#[cfg(test)]
mod tests {
    #[ignore]
    #[test]
    fn message_lifecycle_placeholder() {}
}
