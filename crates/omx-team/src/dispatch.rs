use omx_types::OmxError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DispatchRequest {
    pub request_id: String,
    pub target: String,
    pub body: String,
    pub transport: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DispatchReceipt {
    pub request_id: String,
    pub success: bool,
    pub reason: Option<String>,
    pub duration_ms: u64,
}

pub fn queue_dispatch(_request: DispatchRequest) -> Result<(), OmxError> {
    todo!("Phase 3: queue dispatch request for delivery")
}

pub fn process_pending() -> Result<Vec<DispatchReceipt>, OmxError> {
    todo!("Phase 3: process all pending dispatch requests")
}

#[cfg(test)]
mod tests {
    #[ignore]
    #[test]
    fn dispatch_lifecycle_placeholder() {}
}
