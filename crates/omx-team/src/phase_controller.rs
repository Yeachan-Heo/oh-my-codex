use omx_types::{TaskStatus, TeamPhase};

pub trait PhaseController: Send + Sync {
    fn infer_phase(&self, tasks: &[(TaskStatus, Option<TeamPhase>)]) -> TeamPhase;
    fn recommend_roles(&self, phase: &TeamPhase) -> Vec<String>;
}

pub struct DefaultPhaseController;

impl PhaseController for DefaultPhaseController {
    fn infer_phase(&self, _tasks: &[(TaskStatus, Option<TeamPhase>)]) -> TeamPhase {
        todo!("Phase 3: count task statuses per phase, infer current phase")
    }

    fn recommend_roles(&self, _phase: &TeamPhase) -> Vec<String> {
        todo!("Phase 3: return recommended roles for phase")
    }
}

#[cfg(test)]
mod tests {
    #[ignore]
    #[test]
    fn phase_inference_placeholder() {}
}
