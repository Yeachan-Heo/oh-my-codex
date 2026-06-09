import { deriveAutopilotChildPhase, normalizeAutopilotPhase, type AutopilotChildPhase } from './fsm.js';
import { inferRunOutcome, inferTerminalLifecycleOutcome } from '../runtime/run-outcome.js';

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

function hasAnyStringField(value: JsonObject, keys: string[]): boolean {
  return keys.some((key) => nonEmptyString(value[key]).length > 0);
}

function stringField(value: JsonObject, key: string): string {
  return nonEmptyString(value[key]);
}

function isImplementationPhase(phase: AutopilotChildPhase | null): boolean {
  return phase === 'ultragoal' || phase === 'team' || phase === 'ralph';
}

function isActiveAutopilotState(state: JsonObject): boolean {
  return state.mode === 'autopilot' && state.active === true;
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
  if (currentPhase === 'ralplan' && successfulTerminal) {
    return 'Cannot complete Autopilot before ultragoal gate: ralplan may only advance to ultragoal.';
  }
  if (isImplementationPhase(currentPhase) && successfulTerminal) {
    return `Cannot complete Autopilot before code-review gate: ${currentPhase} may only advance to code-review.`;
  }
  if (isImplementationPhase(currentPhase) && nextPhase === 'ultraqa') {
    return `Cannot skip Autopilot code-review gate: ${currentPhase} may only advance to code-review.`;
  }
  if (currentPhase === 'code-review' && successfulTerminal) {
    return 'Cannot complete Autopilot before ultraqa gate: code-review may only advance to ultraqa.';
  }
  if (currentPhase === 'ultraqa' && successfulTerminal && !hasCleanAutopilotReviewAndQaEvidence(nextState)) {
    return 'Cannot complete Autopilot from ultraqa without clean code-review and ultraqa verdict evidence.';
  }
  return null;
}
