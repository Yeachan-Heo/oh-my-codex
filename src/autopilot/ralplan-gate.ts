import {
  buildRalplanConsensusGateFromSources,
  RALPLAN_CONSENSUS_BLOCKED_REASONS,
  type RalplanConsensusGateEvidence,
} from '../ralplan/consensus-gate.js';

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

function gateSources(input: AutopilotRalplanUltragoalGateInput) {
  const sources: Array<{ source: string; value: unknown }> = [];
  for (const [label, state] of [
    ['next-autopilot-state', input.nextState],
    ['current-autopilot-state', input.currentState],
  ] as const) {
    if (!state) continue;
    sources.push({ source: label, value: state });
    const handoffs = handoffArtifacts(state);
    if (handoffs) sources.push({ source: `${label}:handoff_artifacts`, value: handoffs });
    const ralplan = ralplanHandoff(state);
    if (ralplan) sources.push({ source: `${label}:handoff_artifacts.ralplan`, value: ralplan });
  }
  return sources;
}

export function canAdvanceAutopilotRalplanToUltragoal(
  input: AutopilotRalplanUltragoalGateInput,
): AutopilotRalplanUltragoalGateDecision {
  const evidence = buildRalplanConsensusGateFromSources(gateSources(input), {
    cwd: input.cwd,
    sessionId: input.sessionId,
    requireNativeSubagents: true,
  });
  if (evidence.complete) {
    return {
      allowed: true,
      reason: 'tracker-backed native ralplan architect and critic consensus evidence',
      evidence,
    };
  }
  return {
    allowed: false,
    reason: ralplanConsensusBlockedReason(evidence),
    evidence,
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
  const details = decision.evidence?.blockedDetails?.length
    ? ` Details: ${decision.evidence.blockedDetails.join('; ')}.`
    : '';
  return `Cannot transition ralplan -> ultragoal: ${decision.reason}.${details}`;
}
