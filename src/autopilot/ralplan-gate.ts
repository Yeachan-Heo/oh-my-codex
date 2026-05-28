import { buildRalplanConsensusGateFromSources, type RalplanConsensusGateEvidence } from '../ralplan/consensus-gate.js';

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
    reason: evidence.blockedReason === 'native_subagent_consensus_evidence_missing'
      ? 'ralplan consensus lacks tracker-backed native architect and critic lanes'
      : 'missing ralplan consensus gate with tracker-backed native architect and critic lanes',
    evidence,
  };
}

export function buildAutopilotRalplanUltragoalGateError(
  decision: AutopilotRalplanUltragoalGateDecision,
): string {
  return `Cannot transition ralplan -> ultragoal: ${decision.reason}.`;
}
