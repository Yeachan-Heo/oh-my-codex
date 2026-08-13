import { deriveAutopilotChildPhase, normalizeAutopilotPhase, type AutopilotChildPhase } from './fsm.js';
import { inferRunOutcome, inferTerminalLifecycleOutcome } from '../runtime/run-outcome.js';
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

type JsonObject = Record<string, unknown>;

function objectRecord(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stateField(state: JsonObject, key: string): unknown {
  if (Object.prototype.hasOwnProperty.call(state, key)) return state[key];
  return objectRecord(state.state)[key];
}

function existingRepoArtifact(
  state: JsonObject,
  rawPath: unknown,
  allowedPrefixes: readonly string[],
): boolean {
  const nested = objectRecord(state.state);
  const cwd = nonEmptyString(state.workingDirectory ?? state.cwd ?? nested.workingDirectory ?? nested.cwd);
  const path = nonEmptyString(rawPath);
  if (!cwd || !path) return false;
  const absolute = resolve(cwd, path);
  const rel = relative(resolve(cwd), absolute);
  const allowedRoot = resolve(cwd, '.omx');
  const allowedRel = relative(allowedRoot, absolute);
  return !isAbsolute(rel)
    && rel !== '..'
    && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(allowedRel)
    && allowedRel !== '..'
    && !allowedRel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && allowedPrefixes.some((prefix) => allowedRel.replace(/\\/g, '/').startsWith(prefix))
    && existsSync(absolute);
}

function hasAnyStringField(value: JsonObject, keys: string[]): boolean {
  return keys.some((key) => nonEmptyString(value[key]).length > 0);
}

function stringField(value: JsonObject, key: string): string {
  return nonEmptyString(value[key]);
}

function isImplementationPhase(phase: AutopilotChildPhase | null): boolean {
  return phase === 'ultragoal' || phase === 'rework' || phase === 'team' || phase === 'ralph';
}

const ALLOWED_ACTIVE_TRANSITIONS: Readonly<Record<AutopilotChildPhase, readonly AutopilotChildPhase[]>> = {
  'deep-interview': ['deep-interview', 'ralplan'],
  ralplan: ['ralplan', 'ultragoal'],
  ultragoal: ['ultragoal', 'team', 'code-review'],
  rework: ['rework', 'team', 'code-review'],
  team: ['team', 'ultragoal', 'rework', 'code-review'],
  ralph: ['ralph', 'code-review'],
  'code-review': ['code-review', 'rework', 'ralplan', 'ultraqa'],
  ultraqa: ['ultraqa', 'ralplan'],
};

function isActiveAutopilotState(state: JsonObject): boolean {
  return state.mode === 'autopilot' && state.active === true;
}

function hasDeepInterviewHandoff(state: JsonObject): boolean {
  const gate = objectRecord(stateField(state, 'deep_interview_gate'));
  const handoffs = objectRecord(stateField(state, 'handoff_artifacts'));
  const artifact = handoffs.deep_interview;
  const status = nonEmptyString(gate.status).toLowerCase();
  if (
    status === 'skipped'
    && gate.skip_authorized_by_user === true
    && nonEmptyString(gate.skip_reason)
  ) {
    return nonEmptyString(gate.source).toLowerCase() === 'user'
      && nonEmptyString(gate.session_id) === nonEmptyString(state.session_id)
      && !Number.isNaN(Date.parse(nonEmptyString(gate.skipped_at)))
      && existingRepoArtifact(state, objectRecord(artifact).spec_path ?? objectRecord(artifact).path, ['specs/', 'context/', 'interviews/']);
  }
  if (status !== 'complete') return false;
  if (!nonEmptyString(gate.rationale)) return false;
  const artifactRecord = objectRecord(artifact);
  const hasArtifact = typeof artifact === 'string'
    ? existingRepoArtifact(state, artifact, ['specs/', 'context/', 'interviews/'])
    : existingRepoArtifact(state, artifactRecord.spec_path ?? artifactRecord.path ?? artifactRecord.artifact_path, ['specs/', 'context/', 'interviews/']);
  return hasArtifact;
}

function approvedReview(value: unknown, role: 'architect' | 'critic'): boolean {
  const review = objectRecord(value);
  const reviewRole = nonEmptyString(review.agent_role ?? review.role).toLowerCase();
  const verdict = nonEmptyString(review.verdict ?? review.recommendation).toLowerCase();
  return reviewRole === role && ['approve', 'approved', 'okay'].includes(verdict);
}

function exactInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function validIsoTimestamp(value: unknown): boolean {
  const text = nonEmptyString(value);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(text)
    && !Number.isNaN(Date.parse(text));
}

function hasRalplanHandoff(state: JsonObject): boolean {
  const handoffs = objectRecord(stateField(state, 'handoff_artifacts'));
  const ralplan = objectRecord(handoffs.ralplan);
  const gate = objectRecord(stateField(state, 'ralplan_consensus_gate'));
  const execution = objectRecord(stateField(state, 'ralplan_execution_handoff'));
  const planPath = ralplan.plan_path ?? ralplan.prd_path;
  const planExists = existingRepoArtifact(state, planPath, ['plans/']);
  const reviews = approvedReview(gate.ralplan_architect_review, 'architect')
    && approvedReview(gate.ralplan_critic_review, 'critic');
  const architect = objectRecord(gate.ralplan_architect_review);
  const critic = objectRecord(gate.ralplan_critic_review);
  const authorized = execution.authorized === true || execution.authorized_by_user === true;
  const stateSession = nonEmptyString(state.session_id);
  const executionSession = nonEmptyString(execution.session_id);
  const cycle = exactInteger(state.review_cycle)
    ?? exactInteger(critic.review_cycle ?? critic.iteration);
  const executionCycle = exactInteger(execution.review_cycle);
  return gate.complete === true
    && planExists
    && reviews
    && authorized
    && Boolean(stateSession)
    && executionSession === stateSession
    && cycle !== null
    && executionCycle === cycle
    && exactInteger(architect.sequence_index) === 1
    && exactInteger(critic.sequence_index) === 2
    && exactInteger(architect.review_cycle ?? architect.iteration) === cycle
    && exactInteger(critic.review_cycle ?? critic.iteration) === cycle
    && nonEmptyString(architect.session_id) === stateSession
    && nonEmptyString(critic.session_id) === stateSession
    && validIsoTimestamp(execution.authorized_at)
    && ['autopilot', 'user'].includes(nonEmptyString(execution.source).toLowerCase())
    && (nonEmptyString(execution.source).toLowerCase() !== 'autopilot'
      || (state.active === true && normalizeAutopilotPhase(state.current_phase) === 'ultragoal'));
}

export function isAutopilotSuccessfulTerminalState(state: JsonObject): boolean {
  const phase = normalizeAutopilotPhase(state.current_phase);
  const runOutcome = inferRunOutcome(state);
  const lifecycleOutcome = inferTerminalLifecycleOutcome(state);
  if (phase === 'failed' || runOutcome === 'failed' || runOutcome === 'cancelled' || runOutcome === 'blocked_on_user') return false;
  if (lifecycleOutcome === 'failed' || lifecycleOutcome === 'blocked' || lifecycleOutcome === 'userinterlude' || lifecycleOutcome === 'askuserQuestion') return false;
  if (phase === 'complete') return true;
  if (runOutcome === 'finish') return true;
  if (lifecycleOutcome === 'finished') return true;
  if (nonEmptyString(state.completed_at)) return true;
  return state.active === false;
}

function urlLooksLikeCi(url: string): boolean {
  return /github\.com\/[^/]+\/[^/]+\/actions\/runs\//i.test(url);
}

function evidenceText(value: JsonObject, keys: string[]): string {
  return keys.map((key) => nonEmptyString(value[key]).toLowerCase()).filter(Boolean).join('\n');
}

function looksLikeUltraqaEvidence(value: JsonObject): boolean {
  return /\bultraqa\b|\bqa[_-]?verdict\b|\bqa[_-]?evidence\b/.test(
    evidenceText(value, ['source', 'artifact_path', 'url', 'review_url', 'qa_url']),
  );
}

function looksLikeCodeReviewEvidence(value: JsonObject): boolean {
  return /\bcode[-_]?review\b|\breview[_-]?verdict\b|\breview[_-]?evidence\b|\breviews\//.test(
    evidenceText(value, ['source', 'artifact_path', 'url', 'review_url', 'qa_url']),
  );
}

function hasCodeReviewLocator(value: JsonObject): boolean {
  const artifactPath = stringField(value, 'artifact_path').toLowerCase();
  const reviewUrl = stringField(value, 'review_url');
  if (artifactPath) return looksLikeCodeReviewEvidence(value);
  return reviewUrl.length > 0 || hasAnyStringField(value, ['thread_id', 'agent_id', 'tool_call_id', 'url']);
}

function hasUltraqaLocator(value: JsonObject): boolean {
  const artifactPath = stringField(value, 'artifact_path').toLowerCase();
  const qaUrl = stringField(value, 'qa_url');
  const url = stringField(value, 'url');
  if (artifactPath) return looksLikeUltraqaEvidence(value) || /\bqa\b/.test(artifactPath);
  return qaUrl.length > 0 || urlLooksLikeCi(url) || hasAnyStringField(value, ['tool_call_id', 'thread_id']);
}

function evidenceLocatorSet(value: JsonObject): Set<string> {
  return new Set(['artifact_path', 'url', 'review_url', 'qa_url', 'thread_id', 'tool_call_id', 'agent_id']
    .map((key) => nonEmptyString(value[key]))
    .filter(Boolean));
}

export function hasCleanCodeReviewEvidence(value: unknown): boolean {
  const verdict = objectRecord(value);
  if (verdict.clean !== true) return false;
  if (nonEmptyString(verdict.stage) !== 'code-review') return false;
  if (nonEmptyString(verdict.recommendation).toUpperCase() !== 'APPROVE') return false;
  if (nonEmptyString(verdict.architectural_status).toUpperCase() !== 'CLEAR') return false;
  if (looksLikeUltraqaEvidence(verdict)) return false;
  const url = nonEmptyString(verdict.url);
  if (url && urlLooksLikeCi(url)) return false;
  return hasCodeReviewLocator(verdict);
}

export function hasCleanUltraqaEvidence(value: unknown): boolean {
  const verdict = objectRecord(value);
  if (verdict.clean !== true) return false;
  if (nonEmptyString(verdict.stage) !== 'ultraqa') return false;
  const source = nonEmptyString(verdict.source).toLowerCase();
  if (source === 'leader' || source.includes('code-review')) return false;
  if (looksLikeCodeReviewEvidence(verdict)) return false;
  if (verdict.skipped === true) {
    return (
      nonEmptyString(verdict.reason).length > 0 || nonEmptyString(verdict.skip_reason).length > 0
    ) && hasUltraqaLocator(verdict);
  }
  return hasUltraqaLocator(verdict);
}

export function hasCleanAutopilotReviewAndQaEvidence(state: JsonObject): boolean {
  const review = objectRecord(stateField(state, 'review_verdict'));
  const qa = objectRecord(stateField(state, 'qa_verdict'));
  if (!hasCleanCodeReviewEvidence(review) || !hasCleanUltraqaEvidence(qa)) return false;
  const reviewLocators = evidenceLocatorSet(review);
  const qaLocators = evidenceLocatorSet(qa);
  for (const locator of reviewLocators) {
    if (qaLocators.has(locator)) return false;
  }
  return true;
}

export function validateAutopilotCompletionTransition(
  currentState: JsonObject,
  nextState: JsonObject,
  options: { allowUnknownActivePhaseCompletion?: boolean } = {},
): string | null {
  const current = { ...currentState, mode: 'autopilot' };
  const next = { ...nextState, mode: 'autopilot' };
  const currentPhase = deriveAutopilotChildPhase(current);
  const nextPhase = deriveAutopilotChildPhase(next);
  const successfulTerminal = isAutopilotSuccessfulTerminalState(next);

  if (
    successfulTerminal
    && isActiveAutopilotState(current)
    && currentPhase === null
    && options.allowUnknownActivePhaseCompletion !== true
  ) {
    return 'Cannot complete Autopilot from an unknown active phase; restore a valid Autopilot phase before terminalization.';
  }
  if (currentPhase === 'deep-interview' && successfulTerminal) {
    return 'Cannot complete Autopilot before ralplan gate: deep-interview may only advance to ralplan.';
  }
  if (currentPhase === 'deep-interview' && nextPhase === 'ralplan' && !hasDeepInterviewHandoff(nextState)) {
    return 'Cannot advance Autopilot from deep-interview to ralplan without a durable completed interview gate and handoff artifact.';
  }
  if (currentPhase === 'ralplan' && successfulTerminal) {
    return 'Cannot complete Autopilot before ultragoal gate: ralplan may only advance to ultragoal.';
  }
  if (currentPhase === 'ralplan' && nextPhase === 'ultragoal' && !hasRalplanHandoff(nextState)) {
    return 'Cannot advance Autopilot from ralplan to ultragoal without durable planning artifacts, sequential Architect and Critic approvals, and a bound execution handoff.';
  }
  if (isImplementationPhase(currentPhase) && successfulTerminal) {
    return `Cannot complete Autopilot before code-review gate: ${currentPhase} may only advance to code-review.`;
  }
  if (isImplementationPhase(currentPhase) && nextPhase === 'ultraqa') {
    return `Cannot skip Autopilot code-review gate: ${currentPhase} may only advance to code-review.`;
  }
  if (
    currentPhase
    && nextPhase
    && !ALLOWED_ACTIVE_TRANSITIONS[currentPhase].includes(nextPhase)
  ) {
    return `Cannot advance Autopilot from ${currentPhase} to ${nextPhase}; allowed next phases: ${ALLOWED_ACTIVE_TRANSITIONS[currentPhase].join(', ')}.`;
  }
  if (currentPhase === 'code-review' && successfulTerminal) {
    return 'Cannot complete Autopilot before ultraqa gate: code-review may only advance to ultraqa.';
  }
  if (currentPhase === 'ultraqa' && successfulTerminal && !hasCleanAutopilotReviewAndQaEvidence(nextState)) {
    return 'Cannot complete Autopilot from ultraqa without clean code-review and ultraqa verdict evidence.';
  }
  return null;
}
