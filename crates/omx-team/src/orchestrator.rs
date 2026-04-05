use omx_types::OmxError;

use crate::TeamSnapshot;

pub async fn tick() -> Result<TeamSnapshot, OmxError> {
    todo!("Phase 3: snapshot state, infer phase, deliver mailbox, track dispatch, detect stalls, dispatch hooks, update HUD")
}

pub async fn shutdown() -> Result<(), OmxError> {
    todo!("Phase 3: checkpoint worktrees, integrate commits, kill windows, cleanup, persist final state")
}

#[cfg(test)]
mod tests {
    #[ignore]
    #[tokio::test]
    async fn monitor_tick_placeholder() {}
}
