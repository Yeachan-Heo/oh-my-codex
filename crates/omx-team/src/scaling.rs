use omx_types::OmxError;

pub fn recommend_scale(_current_workers: u8, _pending_tasks: u32, _max: u8) -> u8 {
    todo!("Phase 3: recommend worker count based on pending work")
}

pub fn scale_up(_additional: u8) -> Result<(), OmxError> {
    todo!("Phase 3: spawn additional workers")
}

pub fn scale_down(_remove: u8) -> Result<(), OmxError> {
    todo!("Phase 3: gracefully remove workers")
}

#[cfg(test)]
mod tests {
    #[ignore]
    #[test]
    fn scaling_recommendation_placeholder() {}
}
