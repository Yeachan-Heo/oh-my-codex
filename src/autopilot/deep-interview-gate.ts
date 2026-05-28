import { getQuestionRecordPath, getQuestionRecordPathForStateDir, readQuestionRecord } from '../question/state.js';
import type { QuestionRecord } from '../question/types.js';
import type { DeepInterviewQuestionEnforcementState } from '../question/deep-interview.js';

type JsonObject = Record<string, unknown>;

export interface AutopilotDeepInterviewRalplanGateInput {
  cwd: string;
  sessionId?: string;
  baseStateDir?: string;
  currentState?: JsonObject | null;
  nextState?: JsonObject | null;
  deepInterviewState?: JsonObject | null;
}

export interface AutopilotDeepInterviewRalplanGateDecision {
  allowed: boolean;
  reason: string;
  evidence?: JsonObject;
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function safeObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

async function readDeepInterviewState(input: AutopilotDeepInterviewRalplanGateInput): Promise<JsonObject | null> {
  // Autopilot supervisor handoffs must not be driven by sibling workflow files.
  // Standalone deep-interview -> ralplan reconciliation passes its source state
  // explicitly; Autopilot state writes pass only current/next supervisor state.
  return input.deepInterviewState ?? null;
}

function nestedState(state: JsonObject | null | undefined): JsonObject | null {
  return safeObject(state?.state);
}

function handoffArtifacts(state: JsonObject | null | undefined): JsonObject | null {
  return safeObject(state?.handoff_artifacts) ?? safeObject(nestedState(state)?.handoff_artifacts);
}

function deepInterviewHandoff(state: JsonObject | null | undefined): unknown {
  return handoffArtifacts(state)?.deep_interview;
}

function deepInterviewGate(state: JsonObject | null | undefined): JsonObject | null {
  return safeObject(state?.deep_interview_gate) ?? safeObject(nestedState(state)?.deep_interview_gate);
}

function questionEnforcement(state: JsonObject | null | undefined): DeepInterviewQuestionEnforcementState | undefined {
  return safeObject(state?.question_enforcement) as unknown as DeepInterviewQuestionEnforcementState | undefined;
}

function autopilotQuestionEnforcement(
  state: JsonObject | null | undefined,
): DeepInterviewQuestionEnforcementState | undefined {
  const wait = safeObject(state?.deep_interview_question) ?? safeObject(nestedState(state)?.deep_interview_question);
  if (!wait) return undefined;
  if (safeString(wait.source) !== 'omx-question') return undefined;
  const obligationId = safeString(wait.obligation_id);
  if (!obligationId) return undefined;
  const status = normalizeStatus(wait.status);
  if (status === 'waiting-for-user') {
    return {
      obligation_id: obligationId,
      source: 'omx-question',
      status: 'pending',
      lifecycle_outcome: 'askuserQuestion',
      requested_at: safeString(wait.requested_at) || safeString(wait.updated_at),
    };
  }
  if (status === 'satisfied') {
    return {
      obligation_id: obligationId,
      source: 'omx-question',
      status: 'satisfied',
      lifecycle_outcome: 'askuserQuestion',
      requested_at: safeString(wait.requested_at) || safeString(wait.updated_at),
      question_id: safeString(wait.question_id) || undefined,
      satisfied_at: safeString(wait.satisfied_at) || safeString(wait.resolved_at) || undefined,
    };
  }
  if (status === 'cleared') {
    const clearReason = normalizeStatus(wait.clear_reason);
    return {
      obligation_id: obligationId,
      source: 'omx-question',
      status: 'cleared',
      lifecycle_outcome: 'askuserQuestion',
      requested_at: safeString(wait.requested_at) || safeString(wait.updated_at),
      cleared_at: safeString(wait.cleared_at) || safeString(wait.resolved_at) || undefined,
      clear_reason: clearReason === 'abort' ? 'abort' : clearReason === 'error' ? 'error' : 'handoff',
    };
  }
  return undefined;
}

function allCandidateStates(
  input: AutopilotDeepInterviewRalplanGateInput,
  deepState: JsonObject | null,
): Array<JsonObject | null | undefined> {
  return [input.nextState, input.currentState, deepState];
}

function firstGate(
  input: AutopilotDeepInterviewRalplanGateInput,
  deepState: JsonObject | null,
): JsonObject | null {
  const gates = allCandidateStates(input, deepState)
    .map((state) => deepInterviewGate(state))
    .filter((gate): gate is JsonObject => Boolean(gate));

  return gates.find((gate) => isSkipGate(gate, input.sessionId))
    ?? gates.find((gate) => isCompletionGate(gate, input, deepState))
    ?? gates[0]
    ?? null;
}

function hasNonEmptyObjectSummary(value: unknown): boolean {
  const object = safeObject(value);
  if (!object) return false;
  return ['summary', 'rationale', 'handoff_summary', 'artifact_path', 'path']
    .some((key) => safeString(object[key]).length > 0);
}

function completionRationaleExists(
  gate: JsonObject,
  input: AutopilotDeepInterviewRalplanGateInput,
  deepState: JsonObject | null,
): boolean {
  if (['rationale', 'completion_rationale', 'handoff_summary', 'summary', 'reason']
    .some((key) => safeString(gate[key]).length > 0)) {
    return true;
  }

  for (const state of allCandidateStates(input, deepState)) {
    const handoff = deepInterviewHandoff(state);
    if (typeof handoff === 'string' && handoff.trim()) return true;
    if (hasNonEmptyObjectSummary(handoff)) return true;
  }

  return false;
}

function normalizeStatus(value: unknown): string {
  return safeString(value).toLowerCase().replace(/_/g, '-');
}

function isCompletionGate(
  gate: JsonObject,
  input: AutopilotDeepInterviewRalplanGateInput,
  deepState: JsonObject | null,
): boolean {
  const status = normalizeStatus(gate.status);
  return (status === 'complete' || gate.complete === true)
    && completionRationaleExists(gate, input, deepState);
}

function isSkipGate(gate: JsonObject, sessionId?: string): boolean {
  const status = normalizeStatus(gate.status);
  const reason = safeString(gate.reason) || safeString(gate.skip_reason) || safeString(gate.rationale);
  const timestamp = safeString(gate.skipped_at) || safeString(gate.timestamp) || safeString(gate.updated_at);
  const source = safeString(gate.source);
  const gateSession = safeString(gate.session_id);
  const userAuthorized = gate.skip_authorized_by_user === true || gate.authorized_by_user === true;
  const sessionMatches = !sessionId || gateSession === sessionId;
  return status === 'skipped'
    && userAuthorized
    && reason.length > 0
    && timestamp.length > 0
    && source.length > 0
    && gateSession.length > 0
    && sessionMatches;
}

function collectQuestionEnforcementsFromStates(
  states: Array<JsonObject | null | undefined>,
): DeepInterviewQuestionEnforcementState[] {
  const enforcements: DeepInterviewQuestionEnforcementState[] = [];
  for (const state of states) {
    const standalone = questionEnforcement(state);
    if (standalone) enforcements.push(standalone);
    const autopilotWait = autopilotQuestionEnforcement(state);
    if (autopilotWait) enforcements.push(autopilotWait);
  }
  return enforcements;
}

function questionEnforcementKey(enforcement: DeepInterviewQuestionEnforcementState): string | null {
  const obligationId = safeString(enforcement.obligation_id);
  if (obligationId) return `obligation:${obligationId}`;
  const questionId = safeString(enforcement.question_id);
  if (questionId) return `question:${questionId}`;
  return null;
}

function collectResultingQuestionEnforcements(
  input: AutopilotDeepInterviewRalplanGateInput,
  deepState: JsonObject | null,
): DeepInterviewQuestionEnforcementState[] {
  if (!input.nextState) return collectQuestionEnforcementsFromStates([input.currentState, deepState]);

  const resulting = collectQuestionEnforcementsFromStates([input.nextState, deepState]);
  const resultingKeys = new Set(
    resulting
      .map((enforcement) => questionEnforcementKey(enforcement))
      .filter((key): key is string => Boolean(key)),
  );

  for (const current of collectQuestionEnforcementsFromStates([input.currentState])) {
    const key = questionEnforcementKey(current);
    if (key && resultingKeys.has(key)) continue;
    resulting.push(current);
  }

  return resulting;
}

function hasPendingQuestion(enforcements: readonly DeepInterviewQuestionEnforcementState[]): boolean {
  return enforcements.some((enforcement) => normalizeStatus(enforcement.status) === 'pending');
}

function hasDeniedClearedQuestion(enforcements: readonly DeepInterviewQuestionEnforcementState[]): boolean {
  return enforcements.some((enforcement) => (
    normalizeStatus(enforcement.status) === 'cleared'
    && ['handoff', 'error'].includes(normalizeStatus(enforcement.clear_reason))
  ));
}

function isSameSessionAnsweredDeepInterviewRecord(
  record: QuestionRecord | null,
  sessionId: string | undefined,
): record is QuestionRecord {
  if (!record) return false;
  const recordSession = safeString(record.session_id);
  if (sessionId && recordSession && recordSession !== sessionId) return false;
  return record.status === 'answered'
    && record.source === 'deep-interview'
    && Boolean(record.answer || record.answers?.length);
}

async function satisfiedQuestionHasAnsweredRecord(
  input: AutopilotDeepInterviewRalplanGateInput,
  enforcement: DeepInterviewQuestionEnforcementState,
): Promise<boolean> {
  const questionId = safeString(enforcement.question_id);
  const satisfiedAt = safeString(enforcement.satisfied_at);
  if (!questionId || !satisfiedAt) return false;
  const recordPath = input.baseStateDir
    ? getQuestionRecordPathForStateDir(input.baseStateDir, questionId, input.sessionId)
    : getQuestionRecordPath(input.cwd, questionId, input.sessionId);
  const record = await readQuestionRecord(recordPath);
  return isSameSessionAnsweredDeepInterviewRecord(record, input.sessionId);
}

async function allSatisfiedQuestionsHaveAnsweredRecords(
  input: AutopilotDeepInterviewRalplanGateInput,
  enforcements: readonly DeepInterviewQuestionEnforcementState[],
): Promise<boolean> {
  for (const enforcement of enforcements) {
    if (normalizeStatus(enforcement.status) !== 'satisfied') continue;
    if (!await satisfiedQuestionHasAnsweredRecord(input, enforcement)) return false;
  }
  return true;
}

export async function canAdvanceAutopilotDeepInterviewToRalplan(
  input: AutopilotDeepInterviewRalplanGateInput,
): Promise<AutopilotDeepInterviewRalplanGateDecision> {
  const deepState = await readDeepInterviewState(input);
  const enforcements = collectResultingQuestionEnforcements(input, deepState);
  if (hasPendingQuestion(enforcements)) {
    return {
      allowed: false,
      reason: 'deep-interview question obligation is still pending; ralplan handoff requires completion or explicit user-authorized skip',
    };
  }
  if (hasDeniedClearedQuestion(enforcements)) {
    return {
      allowed: false,
      reason: 'cleared deep-interview question obligations with handoff/error are not completion evidence',
    };
  }

  const gate = firstGate(input, deepState);
  if (!gate) {
    return {
      allowed: false,
      reason: 'missing deep-interview completion/skip gate for ralplan handoff',
    };
  }

  if (isSkipGate(gate, input.sessionId)) {
    return {
      allowed: true,
      reason: 'explicit user-authorized deep-interview skip gate',
      evidence: { gate_status: 'skipped' },
    };
  }

  if (!isCompletionGate(gate, input, deepState)) {
    return {
      allowed: false,
      reason: 'deep-interview gate is not complete/skipped with required rationale',
      evidence: { gate_status: gate.status },
    };
  }

  if (!await allSatisfiedQuestionsHaveAnsweredRecords(input, enforcements)) {
    return {
      allowed: false,
      reason: 'satisfied deep-interview question obligation lacks same-session answered omx question record',
    };
  }

  return {
    allowed: true,
    reason: 'record-backed deep-interview completion gate',
    evidence: { gate_status: 'complete' },
  };
}

export function buildAutopilotDeepInterviewRalplanGateError(
  decision: AutopilotDeepInterviewRalplanGateDecision,
): string {
  return `Cannot transition deep-interview -> ralplan: ${decision.reason}.`;
}
