use omx_types::OmxError;

pub fn create_team_session(_name: &str) -> Result<String, OmxError> {
    todo!("Phase 3: create tmux session 'omx-team-{{name}}'")
}

pub fn create_worker_window(_session: &str, _worker_name: &str) -> Result<String, OmxError> {
    todo!("Phase 3: create tmux window for worker")
}

pub fn kill_team_session(_name: &str) -> Result<(), OmxError> {
    todo!("Phase 3: kill tmux session and all windows")
}

#[cfg(test)]
mod tests {
    #[ignore]
    #[test]
    fn tmux_session_placeholder() {}
}
