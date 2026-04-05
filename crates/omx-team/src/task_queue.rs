use omx_types::{LeaseToken, OmxError, TaskId, TaskStatus, WorkerId};

pub fn ready_tasks(_tasks: &[(TaskId, TaskStatus, Vec<TaskId>)]) -> Vec<TaskId> {
    todo!("Phase 3: resolve DAG dependencies, return tasks with all deps completed")
}

pub fn claim(
    _task: &TaskId,
    _worker: &WorkerId,
    _current_status: &TaskStatus,
) -> Result<LeaseToken, OmxError> {
    todo!("Phase 3: generate LeaseToken, validate task is claimable")
}

pub fn transition(
    _task: &TaskId,
    _token: &LeaseToken,
    _new_status: TaskStatus,
    _result: Option<String>,
) -> Result<(), OmxError> {
    todo!("Phase 3: verify token, update status atomically")
}

#[cfg(test)]
mod tests {
    #[ignore]
    #[test]
    fn ready_tasks_respects_dependency_dag() {}

    #[ignore]
    #[test]
    fn claim_rejects_non_pending_tasks() {}
}
