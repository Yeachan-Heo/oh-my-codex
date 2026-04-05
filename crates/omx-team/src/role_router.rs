use omx_types::TeamPhase;

pub fn recommend_roles(_phase: &TeamPhase) -> Vec<String> {
    todo!("Phase 3: return role recommendations based on phase")
}

pub fn route_task(_description: &str, _available_roles: &[String]) -> Option<String> {
    todo!("Phase 3: intent-based role inference")
}

#[cfg(test)]
mod tests {
    #[ignore]
    #[test]
    fn role_routing_placeholder() {}
}
