use std::ffi::OsString;

use crate::process_bridge::{CommandSpec, ProcessBridge, ProcessResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedStep {
    pub name: String,
    pub command: CommandSpec,
    pub rollback: Option<CommandSpec>,
    pub allow_non_zero: bool,
}

impl PlannedStep {
    #[must_use]
    pub fn new(name: impl Into<String>, command: CommandSpec) -> Self {
        Self {
            name: name.into(),
            command,
            rollback: None,
            allow_non_zero: false,
        }
    }

    #[must_use]
    pub fn with_rollback(mut self, rollback: CommandSpec) -> Self {
        self.rollback = Some(rollback);
        self
    }

    #[must_use]
    pub fn allow_non_zero(mut self) -> Self {
        self.allow_non_zero = true;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepResult {
    pub name: String,
    pub result: ProcessResult,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanExecution {
    pub steps: Vec<StepResult>,
    pub rollbacks: Vec<StepResult>,
    pub failed_step: Option<String>,
}

impl PlanExecution {
    #[must_use]
    pub fn success(&self) -> bool {
        self.failed_step.is_none()
    }
}

impl ProcessBridge {
    #[must_use]
    pub fn run_plan(&self, steps: &[PlannedStep]) -> PlanExecution {
        let mut completed_steps = Vec::new();
        let mut rollbacks = Vec::new();
        let mut rollback_specs = Vec::<(String, CommandSpec)>::new();

        for step in steps {
            let result = self.run(&step.command);
            let step_result = StepResult {
                name: step.name.clone(),
                result,
            };
            let failed = step_result.result.spawn_error_kind.is_some()
                || (!step.allow_non_zero && step_result.result.status_code != Some(0));

            if failed {
                for (name, rollback) in rollback_specs.into_iter().rev() {
                    rollbacks.push(StepResult {
                        name,
                        result: self.run(&rollback),
                    });
                }
                let failed_step = Some(step.name.clone());
                completed_steps.push(step_result);
                return PlanExecution {
                    steps: completed_steps,
                    rollbacks,
                    failed_step,
                };
            }

            if let Some(rollback) = &step.rollback {
                rollback_specs.push((format!("rollback:{}", step.name), rollback.clone()));
            }
            completed_steps.push(step_result);
        }

        PlanExecution {
            steps: completed_steps,
            rollbacks,
            failed_step: None,
        }
    }
}

#[must_use]
pub fn command_spec_for_shell(script: &str) -> CommandSpec {
    let mut spec = CommandSpec::new("sh");
    spec.args = vec![OsString::from("-c"), OsString::from(script)];
    spec
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::process_bridge::{Platform, StdioMode};

    #[cfg(unix)]
    #[test]
    fn runs_plan_without_rollbacks_when_all_steps_pass() {
        let bridge = ProcessBridge::new(Platform::Unix, std::env::vars_os().collect());
        let mut first = command_spec_for_shell("printf first");
        first.stdio_mode = StdioMode::Capture;
        let mut second = command_spec_for_shell("printf second");
        second.stdio_mode = StdioMode::Capture;

        let execution = bridge.run_plan(&[
            PlannedStep::new("first", first),
            PlannedStep::new("second", second),
        ]);

        assert!(execution.success());
        assert_eq!(execution.steps.len(), 2);
        assert!(execution.rollbacks.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn rolls_back_prior_steps_after_failure() {
        let bridge = ProcessBridge::new(Platform::Unix, std::env::vars_os().collect());
        let mut create = command_spec_for_shell("printf create");
        create.stdio_mode = StdioMode::Capture;
        let mut rollback = command_spec_for_shell("printf cleanup");
        rollback.stdio_mode = StdioMode::Capture;
        let mut fail = command_spec_for_shell("printf boom >&2; exit 7");
        fail.stdio_mode = StdioMode::Capture;

        let execution = bridge.run_plan(&[
            PlannedStep::new("create", create).with_rollback(rollback),
            PlannedStep::new("fail", fail),
        ]);

        assert!(!execution.success());
        assert_eq!(execution.failed_step.as_deref(), Some("fail"));
        assert_eq!(execution.steps.len(), 2);
        assert_eq!(execution.rollbacks.len(), 1);
        assert_eq!(execution.rollbacks[0].name, "rollback:create");
        assert_eq!(execution.rollbacks[0].result.stdout, b"cleanup");
    }

    #[cfg(unix)]
    #[test]
    fn can_allow_non_zero_probe_steps() {
        let bridge = ProcessBridge::new(Platform::Unix, BTreeMap::new());
        let mut probe = command_spec_for_shell("exit 1");
        probe.stdio_mode = StdioMode::Capture;

        let execution = bridge.run_plan(&[PlannedStep::new("probe", probe).allow_non_zero()]);

        assert!(execution.success());
        assert_eq!(execution.steps[0].result.status_code, Some(1));
    }
}
