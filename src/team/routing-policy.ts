import type {
  TeamTask,
  TeamTaskComplexity,
  TeamTaskDelegationMode,
  TeamTaskExecutionContract,
  TeamTaskExecutionMetadata,
  TeamTaskModelTier,
} from './state.js';

export interface TaskExecutionClassification {
  executionContract: TeamTaskExecutionContract;
  initialExecution: TeamTaskExecutionMetadata;
}

export interface EscalationObservationPatch {
  escalation_count: number;
  last_failure_reason?: string;
  shared_core_risk_observed?: boolean;
  ambiguity_observed?: boolean;
  rebalance_requested?: boolean;
}

function normalizeDescription(task: Pick<TeamTask, 'subject' | 'description'>): string {
  return `${task.subject} ${task.description}`.toLowerCase();
}

export function choosePreferredModelTier(complexity: TeamTaskComplexity): TeamTaskModelTier {
  switch (complexity) {
    case 'low':
      return 'low';
    case 'high':
      return 'frontier';
    case 'medium':
    default:
      return 'standard';
  }
}

export function chooseAssignedModelTier(task: Pick<TeamTask, 'execution_contract' | 'execution'>): TeamTaskModelTier {
  return task.execution?.assigned_model_tier
    ?? task.execution_contract?.preferred_model_tier
    ?? 'standard';
}

export function shouldWorkerDelegateToMini(task: Pick<TeamTask, 'execution_contract' | 'execution'>): boolean {
  const delegationMode = task.execution?.observed_delegation_mode ?? task.execution_contract?.delegation_mode;
  const assignedTier = chooseAssignedModelTier(task);
  return delegationMode === 'mini_preferred' || (delegationMode === 'mini_allowed' && assignedTier === 'low');
}

export function shouldRequestRebalance(task: Pick<TeamTask, 'execution' | 'execution_contract'>): boolean {
  if (task.execution?.rebalance_requested === true) return true;
  return Boolean(
    task.execution?.shared_core_risk_observed
    || task.execution?.ambiguity_observed
    || ((task.execution?.escalation_count ?? 0) > 0 && task.execution_contract?.complexity === 'high'),
  );
}

export function buildObservedEscalationPatch(
  task: Pick<TeamTask, 'execution'>,
  reason: string,
  options: {
    shared_core_risk_observed?: boolean;
    ambiguity_observed?: boolean;
    rebalance_requested?: boolean;
  } = {},
): EscalationObservationPatch {
  return {
    escalation_count: (task.execution?.escalation_count ?? 0) + 1,
    last_failure_reason: reason,
    shared_core_risk_observed:
      options.shared_core_risk_observed ?? task.execution?.shared_core_risk_observed ?? false,
    ambiguity_observed:
      options.ambiguity_observed ?? task.execution?.ambiguity_observed ?? false,
    rebalance_requested:
      options.rebalance_requested
      ?? task.execution?.rebalance_requested
      ?? options.shared_core_risk_observed
      ?? options.ambiguity_observed
      ?? false,
  };
}

export function classifyTaskExecution(task: Partial<Pick<TeamTask, 'subject' | 'description' | 'execution_contract' | 'execution'>>): TaskExecutionClassification {
  const text = normalizeDescription({
    subject: task.subject ?? '',
    description: task.description ?? '',
  });

  const inferredComplexity: TeamTaskComplexity = text.length < 140 && /(search|find|doc|docs|summary|readme|single-file|single file|test)/.test(text)
    ? 'low'
    : /(architecture|runtime|scaling|rebalance|multi-file|migration|orchestrator|state)/.test(text)
      ? 'high'
      : 'medium';

  const complexity = task.execution_contract?.complexity ?? inferredComplexity;
  const delegationMode: TeamTaskDelegationMode = task.execution_contract?.delegation_mode
    ?? (complexity === 'low' ? 'mini_preferred' : complexity === 'medium' ? 'mini_allowed' : 'direct_only');

  const doneDefinition = task.execution_contract?.done_definition?.length
    ? task.execution_contract.done_definition
    : ['Implement requested behavior', 'Verify changed area', 'Report concrete evidence'];

  const allowedEditScope = task.execution_contract?.allowed_edit_scope?.length
    ? task.execution_contract.allowed_edit_scope
    : ['Follow task-specific file ownership lane'];

  const executionContract: TeamTaskExecutionContract = {
    complexity,
    delegation_mode: delegationMode,
    preferred_model_tier: task.execution_contract?.preferred_model_tier ?? choosePreferredModelTier(complexity),
    done_definition: doneDefinition,
    allowed_edit_scope: allowedEditScope,
    verification_mode: task.execution_contract?.verification_mode ?? (complexity === 'high' ? 'thorough' : 'standard'),
    report_format: task.execution_contract?.report_format ?? 'structured_markdown',
    supervisor_notes: task.execution_contract?.supervisor_notes ?? [],
    max_parallel_subtasks: task.execution_contract?.max_parallel_subtasks ?? (complexity === 'low' ? 1 : 2),
  };

  const initialExecution: TeamTaskExecutionMetadata = {
    assigned_model_tier: task.execution?.assigned_model_tier ?? executionContract.preferred_model_tier,
    escalation_count: task.execution?.escalation_count ?? 0,
    last_failure_reason: task.execution?.last_failure_reason,
    observed_complexity: task.execution?.observed_complexity,
    observed_delegation_mode: task.execution?.observed_delegation_mode,
    delegation_state: task.execution?.delegation_state ?? 'not_started',
    child_attempts: task.execution?.child_attempts ?? 0,
    attempt_count: task.execution?.attempt_count ?? 0,
    rebalance_requested: task.execution?.rebalance_requested ?? false,
    shared_core_risk_observed: task.execution?.shared_core_risk_observed ?? false,
    ambiguity_observed: task.execution?.ambiguity_observed ?? false,
    latest_report_summary: task.execution?.latest_report_summary,
  };

  return { executionContract, initialExecution };
}
