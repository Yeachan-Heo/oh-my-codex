import {
  buildRalplanConsensusGateFromSources,
  RALPLAN_CONSENSUS_BLOCKED_REASONS,
  resolveRalplanExecutionHandoff,
  validateRalplanExecutionHandoffBinding,
  withParentReturnToRalplanContext,
  type RalplanConsensusGateEvidence,
  type RalplanExecutionHandoff,
} from '../ralplan/consensus-gate.js';
import {
  buildUnsupportedNativeSubagentGuidance,
  isUnsupportedNativeSubagentEvidenceForScope,
  type NativeSubagentSupportEvidence,
} from '../leader/contract.js';

type JsonObject = Record<string, unknown>;

export interface AutopilotRalplanUltragoalGateInput {
  cwd: string;
  sessionId?: string;
  currentState?: JsonObject | null;
  nextState?: JsonObject | null;
}

export interface AutopilotRalplanUltragoalGateDecision {
  allowed: boolean;
  reason: string;
  evidence?: RalplanConsensusGateEvidence;
  unsupportedNativeSubagentGuidance?: string;
}

function safeObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function nestedState(state: JsonObject | null | undefined): JsonObject | null {
  return safeObject(state?.state);
}

function handoffArtifacts(state: JsonObject | null | undefined): JsonObject | null {
  return safeObject(state?.handoff_artifacts) ?? safeObject(nestedState(state)?.handoff_artifacts);
}

function ralplanHandoff(state: JsonObject | null | undefined): JsonObject | null {
  return safeObject(handoffArtifacts(state)?.ralplan);
}
function unsupportedNativeSubagentEvidence(
  state: JsonObject | null | undefined,
  input: Pick<AutopilotRalplanUltragoalGateInput, 'cwd' | 'sessionId'>,
): NativeSubagentSupportEvidence | null {
  const nested = nestedState(state);
  const handoffRalplan = ralplanHandoff(state);
  const nestedHandoffRalplan = ralplanHandoff(nested);
  for (const candidate of [
    state?.native_subagent_support,
    nested?.native_subagent_support,
    handoffArtifacts(state)?.native_subagent_support,
    handoffArtifacts(nested)?.native_subagent_support,
    handoffRalplan?.native_subagent_support,
    nestedHandoffRalplan?.native_subagent_support,
  ]) {
    if (isUnsupportedNativeSubagentEvidenceForScope(candidate, input)) return candidate as NativeSubagentSupportEvidence;
  }
  return null;
}

function unsupportedNativeSubagentGuidance(input: AutopilotRalplanUltragoalGateInput): string | null {
  const evidence = unsupportedNativeSubagentEvidence(input.nextState, input)
    ?? unsupportedNativeSubagentEvidence(input.currentState, input);
  return evidence ? buildUnsupportedNativeSubagentGuidance(evidence) : null;
}

function sourcesForState(label: string, state: JsonObject | null | undefined): Array<{ source: string; value: unknown }> {
  if (!state) return [];
  const sources: Array<{ source: string; value: unknown }> = [{ source: label, value: state }];
  const handoffs = handoffArtifacts(state);
  if (handoffs) {
    sources.push({
      source: `${label}:handoff_artifacts`,
      value: withParentReturnToRalplanContext(handoffs, state),
    });
  }
  const ralplan = ralplanHandoff(state);
  if (ralplan) {
    sources.push({
      source: `${label}:handoff_artifacts.ralplan`,
      value: withParentReturnToRalplanContext(ralplan, state),
    });
  }
  return sources;
}

function gateSources(input: AutopilotRalplanUltragoalGateInput) {
  return [
    ...sourcesForState('next-autopilot-state', input.nextState),
    ...sourcesForState('current-autopilot-state', input.currentState),
  ];
}

export function canAdvanceAutopilotRalplanToUltragoal(
  input: AutopilotRalplanUltragoalGateInput,
): AutopilotRalplanUltragoalGateDecision {
  const options = {
    cwd: input.cwd,
    sessionId: input.sessionId,
    requireNativeSubagents: true,
  };
  const unsupportedGuidance = unsupportedNativeSubagentGuidance(input) ?? undefined;
  if (unsupportedGuidance) {
    return {
      allowed: false,
      reason: 'native subagent support is unavailable; ralplan must terminalize non-clean instead of handing off to ultragoal',
      unsupportedNativeSubagentGuidance: unsupportedGuidance,
    };
  }
  // Resolve both states as one ordered evidence set. The consensus resolver selects
  // the freshest lifecycle record, including a newer invalid next-state record,
  // while the invariant host-receipt blocker prevents every local record from authorizing execution.
  const evidence = buildRalplanConsensusGateFromSources(gateSources(input), options);
  if (evidence.complete) {
    return {
      allowed: true,
      reason: 'tracker-backed native ralplan architect and critic consensus evidence',
      evidence,
      unsupportedNativeSubagentGuidance: unsupportedGuidance,
    };
  }

  // Option A (#3463): a user-authorized execution handoff is a distinct typed
  // contract that does NOT claim host-consensus authority. It allows the
  // ralplan → ultragoal transition only when valid Architect→Critic lifecycle
  // evidence exists and the user explicitly authorized the transition in-session.
  // This is the reachable alternative to the (currently unreachable) host-receipt
  // verifier path. Forged local lifecycle evidence without a user-authorized
  // handoff remains rejected.
  const lifecycleCycle = consensusEvidenceReviewCycle(evidence);
  const lifecycleEvidencePresent = hasValidLifecycleEvidence(evidence, input.sessionId);
  if (lifecycleEvidencePresent) {
    const handoff = resolveExecutionHandoffFromInput(input);
    if (handoff) {
      const bindingError = validateRalplanExecutionHandoffBinding(handoff, input.sessionId, lifecycleCycle);
      if (!bindingError) {
        return {
          allowed: true,
          reason: 'user-authorized ralplan execution handoff (distinct from host-consensus authority)',
          evidence,
          unsupportedNativeSubagentGuidance: unsupportedGuidance,
        };
      }
      return {
        allowed: false,
        reason: bindingError,
        evidence,
        unsupportedNativeSubagentGuidance: unsupportedGuidance,
      };
    }
    return {
      allowed: false,
      reason: 'ralplan lifecycle consensus reached; awaiting user-authorized execution handoff (ralplan_execution_handoff)',
      evidence,
      unsupportedNativeSubagentGuidance: unsupportedGuidance,
    };
  }

  return {
    allowed: false,
    reason: ralplanConsensusBlockedReason(evidence),
    evidence,
    unsupportedNativeSubagentGuidance: unsupportedGuidance,
  };
}

function resolveExecutionHandoffFromInput(
  input: AutopilotRalplanUltragoalGateInput,
): RalplanExecutionHandoff | null {
  return resolveRalplanExecutionHandoff(input.nextState)
    ?? resolveRalplanExecutionHandoff(input.currentState);
}

function hasValidLifecycleEvidence(
  evidence: RalplanConsensusGateEvidence,
  expectedSessionId: string | undefined,
): boolean {
  const architect = evidence.ralplan_architect_review;
  const critic = evidence.ralplan_critic_review;
  if (!architect || !critic) return false;
  // P1-C (fail-closed): an authoritative current session must be resolved.
  // If expectedSessionId is absent, there is no authoritative session to bind
  // to, so the lifecycle evidence is rejected.
  if (!expectedSessionId) return false;
  // P1-E (fail-closed): both reviews must bind to the same authoritative
  // current session as the handoff request. A foreign review pair copied
  // from another session is rejected.
  const architectSession = typeof architect.session_id === 'string' ? architect.session_id.trim() : '';
  const criticSession = typeof critic.session_id === 'string' ? critic.session_id.trim() : '';
  if (!architectSession || !criticSession) return false;
  if (architectSession !== expectedSessionId || criticSession !== expectedSessionId) return false;
  if (evidence.blockedReason !== RALPLAN_CONSENSUS_BLOCKED_REASONS.documentedHostConsensusReceiptUnavailable) {
    return false;
  }
  // Both reviews must have approving verdicts.
  const architectVerdict = architect.verdict;
  const criticVerdict = critic.verdict;
  if (!((architectVerdict === undefined || architectVerdict === 'approve')
    && (criticVerdict === undefined || criticVerdict === 'approve'))) {
    return false;
  }
  // Both reviews must have the correct agent roles.
  if (architect.agent_role !== 'architect' || critic.agent_role !== 'critic') {
    return false;
  }
  // Both reviews must be native_subagent provenance.
  if (architect.provenance_kind !== 'native_subagent' || critic.provenance_kind !== 'native_subagent') {
    return false;
  }
  // The reviews must use distinct native thread_ids.
  const architectThreadId = typeof architect.thread_id === 'string' ? architect.thread_id.trim() : '';
  const criticThreadId = typeof critic.thread_id === 'string' ? critic.thread_id.trim() : '';
  if (!architectThreadId || !criticThreadId || architectThreadId === criticThreadId) return false;

  // P1-1 (fail-closed): both reviews MUST expose an authoritative,
  // comparable order value (sequence_index or review_order). Missing order
  // on either side is rejected — no silent bypass.
  const architectOrder = reviewOrderValue(architect);
  const criticOrder = reviewOrderValue(critic);
  if (architectOrder === null || criticOrder === null) return false;
  if (architectOrder >= criticOrder) return false; // Architect must strictly precede Critic

  // P1-3 (fail-closed): both reviews MUST carry the same finite review_cycle
  // (or iteration as fallback). Missing or mismatched cycles are rejected.
  const architectCycle = reviewCycleValue(architect);
  const criticCycle = reviewCycleValue(critic);
  if (architectCycle === null || criticCycle === null || architectCycle !== criticCycle) return false;

  return true;
}

/** Extracts a single authoritative review-cycle number from a review record. */
function reviewCycleValue(review: Record<string, unknown> | null): number | null {
  if (!review) return null;
  if (typeof review.review_cycle === 'number') return review.review_cycle;
  if (typeof review.iteration === 'number') return review.iteration;
  return null;
}

/** Extracts a single authoritative order value from a review record. */
function reviewOrderValue(review: Record<string, unknown> | null): number | null {
  if (!review) return null;
  if (typeof review.sequence_index === 'number') return review.sequence_index;
  if (typeof review.review_order === 'number') return review.review_order;
  return null;
}

function consensusEvidenceReviewCycle(evidence: RalplanConsensusGateEvidence): number | null {
  // P1-3 (fail-closed): both reviews must carry the same finite cycle.
  // Return null when either is missing or they disagree, so the handoff
  // binding check rejects it.
  const architectCycle = reviewCycleValue(evidence.ralplan_architect_review);
  const criticCycle = reviewCycleValue(evidence.ralplan_critic_review);
  if (architectCycle === null || criticCycle === null || architectCycle !== criticCycle) return null;
  return architectCycle;
}

function ralplanConsensusBlockedReason(evidence: RalplanConsensusGateEvidence): string {
  if (evidence.blockedReason === RALPLAN_CONSENSUS_BLOCKED_REASONS.documentedHostConsensusReceiptUnavailable) {
    return 'documented_host_consensus_receipt_unavailable';
  }
  if (evidence.blockedReason === RALPLAN_CONSENSUS_BLOCKED_REASONS.nativeSubagentEvidenceMissing) {
    return 'ralplan consensus lacks tracker-backed native architect and critic lanes';
  }
  if (evidence.blockedReason === RALPLAN_CONSENSUS_BLOCKED_REASONS.nonApprovingReview) {
    return 'ralplan consensus gate contains non-approving architect or critic review evidence';
  }
  return 'missing ralplan consensus gate with tracker-backed native architect and critic lanes';
}

export function buildAutopilotRalplanUltragoalGateError(
  decision: AutopilotRalplanUltragoalGateDecision,
): string {
  const diagnostic = decision.evidence?.diagnostic;
  if (diagnostic) {
    const architect = diagnostic.architect;
    const critic = diagnostic.critic;
    const renderReview = (label: string, review: typeof architect) => [
      `  ${label} thread_id: ${review.thread_id ?? 'missing'} found: ${review.thread_found ? 'yes' : 'no'} kind=${review.kind ?? 'missing'} completed=${review.completed ? 'yes' : 'no'}`,
      `    session_id: ${review.session_id ?? 'missing'} session_found=${review.session_found ? 'yes' : 'no'}`,
      review.problem ? `    problem: ${review.problem}` : null,
    ].filter((line): line is string => Boolean(line)).join('\n');
    const guidance = decision.unsupportedNativeSubagentGuidance;
    return [
      `Cannot transition ralplan -> ultragoal: ${decision.reason}.`,
      guidance ? `Unsupported native recovery: ${guidance}` : null,
      '',
      'Expected:',
      ...diagnostic.expected_schema.map((line) => `  ${line}`),
      '',
      'Observed:',
      `  current_session_id: ${diagnostic.current_session_id ?? 'missing'}`,
      `  tracker_path: ${diagnostic.tracker_path}`,
      renderReview('architect', architect),
      renderReview('critic', critic),
      `  distinct_thread_ids: ${diagnostic.distinct_thread_ids === null ? 'unknown' : diagnostic.distinct_thread_ids ? 'yes' : 'no'}`,
      diagnostic.pair_problem ? `  pair_problem: ${diagnostic.pair_problem}` : null,
      '',
      'Fix:',
      ...diagnostic.remediation.map((line) => `  ${line}`),
      '',
      'Docs:',
      `  ${diagnostic.docs}`,
    ].filter((line): line is string => line !== null).join('\n');
  }
  const details = decision.evidence?.blockedDetails?.length
    ? ` Details: ${decision.evidence.blockedDetails.join('; ')}.`
    : '';
  const guidance = decision.unsupportedNativeSubagentGuidance;
  return `Cannot transition ralplan -> ultragoal: ${decision.reason}.${details}${guidance ? ` ${guidance}` : ''}`;
}
