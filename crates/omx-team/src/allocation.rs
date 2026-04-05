use omx_types::{TaskId, WorkerId};

pub fn allocate(
    _ready_tasks: &[TaskId],
    _available_workers: &[WorkerId],
) -> Vec<(TaskId, WorkerId)> {
    todo!("Phase 3: task allocation policy — match tasks to workers")
}

#[cfg(test)]
mod tests {
    #[ignore]
    #[test]
    fn allocation_policy_placeholder() {}
}
