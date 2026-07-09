import {
  buildRalplanConsensusGateFromSources,
  RALPLAN_CONSENSUS_BLOCKED_REASONS,
  withParentReturnToRalplanContext,
  type RalplanConsensusGateEvidence,
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
  const nextStateEvidence = buildRalplanConsensusGateFromSources(
    sourcesForState('next-autopilot-state', input.nextState),
    options,
  );
  const evidence = nextStateEvidence.complete
    || nextStateEvidence.blockedReason === RALPLAN_CONSENSUS_BLOCKED_REASONS.nonApprovingReview
    || nextStateEvidence.blockedReason === RALPLAN_CONSENSUS_BLOCKED_REASONS.nativeSubagentEvidenceMissing
    ? nextStateEvidence
    : buildRalplanConsensusGateFromSources(gateSources(input), options);
  if (evidence.complete) {
    return {
      allowed: true,
      reason: 'tracker-backed native ralplan architect and critic consensus evidence',
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

function ralplanConsensusBlockedReason(evidence: RalplanConsensusGateEvidence): string {
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
