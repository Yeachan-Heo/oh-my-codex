use omx_types::OmxError;

pub fn provision_worktree(_team_name: &str, _worker_name: &str) -> Result<String, OmxError> {
    todo!("Phase 3: git worktree add for worker isolation")
}

pub fn cleanup_worktree(_path: &str) -> Result<(), OmxError> {
    todo!("Phase 3: git worktree remove")
}

#[cfg(test)]
mod tests {
    #[ignore]
    #[test]
    fn worktree_lifecycle_placeholder() {}
}
