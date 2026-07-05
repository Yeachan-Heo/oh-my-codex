import { constants as fsConstants } from 'fs';
import { access, readFile } from 'fs/promises';
import { isAbsolute, relative, resolve } from 'path';
import { getAuthoritativeActiveStatePaths, getReadScopedStatePaths } from '../mcp/state-paths.js';

export type MinimaxArbiterDecision = 'pending' | 'continue' | 'revise' | 'block' | 'escalate' | 'complete';

export interface MinimaxCompletionStatus {
  complete: boolean;
  reason: string;
  arbiterDecision: MinimaxArbiterDecision | null;
  verificationEvidence: string[];
  verificationEvidencePath: string | null;
  councilArtifactPath: string | null;
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function safeObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function safeBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function safeNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function lookupObject(raw: Record<string, unknown> | null, ...keys: string[]): Record<string, unknown> | null {
  if (!raw) return null;
  for (const key of keys) {
    const value = safeObject(raw[key]);
    if (value) return value;
  }
  const nestedState = safeObject(raw.state);
  if (nestedState) {
    for (const key of keys) {
      const value = safeObject(nestedState[key]);
      if (value) return value;
    }
  }
  return null;
}

function lookupString(raw: Record<string, unknown> | null, ...keys: string[]): string {
  if (!raw) return '';
  for (const key of keys) {
    const direct = safeString(raw[key]);
    if (direct) return direct;
  }
  const nestedState = safeObject(raw.state);
  if (nestedState) {
    for (const key of keys) {
      const nested = safeString(nestedState[key]);
      if (nested) return nested;
    }
  }
  return '';
}

function lookupBoolean(raw: Record<string, unknown> | null, ...keys: string[]): boolean | null {
  if (!raw) return null;
  for (const key of keys) {
    const direct = safeBoolean(raw[key]);
    if (direct !== null) return direct;
  }
  const nestedState = safeObject(raw.state);
  if (nestedState) {
    for (const key of keys) {
      const nested = safeBoolean(nestedState[key]);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function lookupNumber(raw: Record<string, unknown> | null, ...keys: string[]): number | null {
  if (!raw) return null;
  for (const key of keys) {
    const direct = safeNumber(raw[key]);
    if (direct !== null) return direct;
  }
  const nestedState = safeObject(raw.state);
  if (nestedState) {
    for (const key of keys) {
      const nested = safeNumber(nestedState[key]);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function lookupStringArray(raw: Record<string, unknown> | null, ...keys: string[]): string[] {
  if (!raw) return [];
  for (const key of keys) {
    const direct = raw[key];
    if (Array.isArray(direct)) return direct.map(safeString).filter(Boolean);
  }
  const nestedState = safeObject(raw.state);
  if (nestedState) {
    for (const key of keys) {
      const nested = nestedState[key];
      if (Array.isArray(nested)) return nested.map(safeString).filter(Boolean);
    }
  }
  return [];
}

export function normalizeMinimaxArbiterDecision(value: unknown): MinimaxArbiterDecision | null {
  const normalized = safeString(value).toLowerCase();
  if (normalized === 'pending') return 'pending';
  if (normalized === 'continue') return 'continue';
  if (normalized === 'revise') return 'revise';
  if (normalized === 'block') return 'block';
  if (normalized === 'escalate') return 'escalate';
  if (normalized === 'complete' || normalized === 'completed') return 'complete';
  return null;
}

function resolveMaybeRelativePath(cwd: string, rawPath: string): string | null {
  if (!rawPath) return null;
  const resolved = rawPath.startsWith('/') ? rawPath : resolve(cwd, rawPath);
  const relativePath = relative(cwd, resolved);
  if (relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))) {
    return resolved;
  }
  return null;
}

async function pathExists(path: string | null): Promise<boolean> {
  if (!path) return false;
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function existingPath(cwd: string, rawPath: string): Promise<string | null> {
  const resolved = resolveMaybeRelativePath(cwd, rawPath);
  return resolved && await pathExists(resolved) ? resolved : null;
}

async function readJsonIfExists(path: string | null): Promise<Record<string, unknown> | null> {
  if (!path || !(await pathExists(path))) return null;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown;
    return safeObject(parsed);
  } catch {
    return null;
  }
}

function isPassingCouncilReviewStatus(value: unknown): boolean {
  const normalized = safeString(value).toLowerCase();
  return ['pass', 'passed', 'no_blockers', 'no-blockers'].includes(normalized);
}

function hasNoStructuredBlockers(artifact: Record<string, unknown>): boolean {
  const blockers = artifact.blockers;
  return Array.isArray(blockers) && blockers.length === 0;
}

function hasZeroReviewBlockers(artifact: Record<string, unknown>): boolean {
  const blockerCount = safeNumber(artifact.blocker_count) ?? safeNumber(artifact.blockerCount);
  return blockerCount === 0 && hasNoStructuredBlockers(artifact);
}

function hasRequiredIndependentReviewFields(artifact: Record<string, unknown>): boolean {
  const reviewerSurface = lookupString(artifact, 'reviewer_surface', 'reviewerSurface', 'reviewer');
  const scope = lookupString(artifact, 'review_scope', 'reviewScope', 'scope')
    || (safeObject(artifact.review_scope) || safeObject(artifact.reviewScope) || safeObject(artifact.scope) ? 'structured-scope' : '');
  const inputs = artifact.inputs;
  return Boolean(reviewerSurface && scope && Array.isArray(inputs) && inputs.length > 0);
}

function reviewCoverageIsComplete(artifact: Record<string, unknown>): boolean {
  if (lookupBoolean(artifact, 'degraded', 'partial_coverage', 'partialCoverage') === true) return false;
  const coverage = safeObject(artifact.coverage);
  if (lookupBoolean(coverage, 'degraded', 'partial', 'partial_coverage', 'partialCoverage') === true) return false;
  return true;
}

async function councilArtifactPasses(path: string | null): Promise<boolean> {
  const artifact = await readJsonIfExists(path);
  if (!artifact) return false;
  const schemaVersion = safeString(artifact.schema_version).toLowerCase();
  const verdict = safeObject(artifact.verdict);
  if (schemaVersion !== 'minimax-independent-review-v1') return false;
  if (!verdict || !hasRequiredIndependentReviewFields(artifact)) return false;
  return reviewCoverageIsComplete(artifact)
    && hasZeroReviewBlockers(artifact)
    && isPassingCouncilReviewStatus(verdict.status);
}

function hasInlineVerificationEvidence(rawState: Record<string, unknown> | null): string[] {
  const evidence = lookupStringArray(
    rawState,
    'verification_evidence',
    'verificationEvidence',
    'completion_evidence',
    'completionEvidence',
    'evidence',
  );
  if (evidence.length > 0) return evidence;
  const single = lookupString(
    rawState,
    'verification_evidence',
    'verificationEvidence',
    'completion_evidence',
    'completionEvidence',
    'evidence',
  );
  return single ? [single] : [];
}

function completionGateRequiresFreshEvidence(): boolean {
  return true;
}

function completionGateRequiresCouncilAfterEscalation(): boolean {
  return true;
}

function hasEscalationHistory(rawState: Record<string, unknown> | null): boolean {
  if (!rawState) return false;
  if (lookupBoolean(rawState, 'escalated', 'escalation_occurred', 'escalationOccurred') === true) return true;
  const decisions = lookupStringArray(
    rawState,
    'arbiter_history',
    'arbiterHistory',
    'arbiter_decision_history',
    'arbiterDecisionHistory',
    'escalation_history',
    'escalationHistory',
  );
  if (decisions.some((decision) => normalizeMinimaxArbiterDecision(decision) === 'escalate')) return true;
  return normalizeMinimaxArbiterDecision(lookupString(rawState, 'last_arbiter_decision', 'lastArbiterDecision')) === 'escalate'
    || normalizeMinimaxArbiterDecision(lookupString(rawState, 'min_verdict', 'minVerdict')) === 'escalate';
}

function evidenceIsFreshForCurrentStep(rawState: Record<string, unknown> | null): boolean {
  if (!completionGateRequiresFreshEvidence()) return true;
  const step = lookupNumber(rawState, 'step');
  if (step === null) return false;
  const evidenceStep = lookupNumber(
    rawState,
    'verification_evidence_step',
    'verificationEvidenceStep',
    'completion_evidence_step',
    'completionEvidenceStep',
  );
  return evidenceStep !== null && evidenceStep >= step;
}

function councilEvidenceIsFreshForCurrentStep(rawState: Record<string, unknown> | null): boolean {
  const step = lookupNumber(rawState, 'step');
  if (step === null) return false;
  const council = lookupObject(rawState, 'council');
  const councilEvidenceStep = lookupNumber(
    rawState,
    'council_evidence_step',
    'councilEvidenceStep',
  ) ?? lookupNumber(council, 'evidence_step', 'evidenceStep', 'council_evidence_step', 'councilEvidenceStep');
  return councilEvidenceStep !== null && councilEvidenceStep >= step;
}

function isPassingVerificationStatus(value: unknown): boolean {
  const normalized = safeString(value).toLowerCase();
  return ['pass', 'passed', 'success', 'succeeded', 'complete', 'completed'].includes(normalized);
}

async function verificationArtifactPasses(path: string | null, rawState: Record<string, unknown> | null): Promise<boolean> {
  const artifact = await readJsonIfExists(path);
  if (!artifact) return false;
  const schemaVersion = safeString(artifact.schema_version).toLowerCase();
  if (schemaVersion !== 'minimax-verification-v1') return false;
  const step = lookupNumber(rawState, 'step');
  const artifactStep = lookupNumber(artifact, 'step', 'verification_step', 'verificationStep');
  if (step === null || artifactStep === null || artifactStep < step) return false;
  return lookupBoolean(artifact, 'passed', 'complete', 'valid') === true
    || isPassingVerificationStatus(artifact.status)
    || isPassingVerificationStatus(safeObject(artifact.verdict)?.status);
}

export async function assessMinimaxCompletionState(
  rawState: Record<string, unknown> | null,
  cwd: string,
): Promise<MinimaxCompletionStatus> {
  if (!rawState) {
    return {
      complete: false,
      reason: 'missing_mode_state',
      arbiterDecision: null,
      verificationEvidence: [],
      verificationEvidencePath: null,
      councilArtifactPath: null,
    };
  }

  const arbiterDecision = normalizeMinimaxArbiterDecision(
    lookupString(rawState, 'arbiter_decision', 'arbiterDecision'),
  );
  const verificationEvidence = hasInlineVerificationEvidence(rawState);
  const verificationEvidencePathRaw = lookupString(
    rawState,
    'verification_evidence_path',
    'verificationEvidencePath',
    'completion_artifact_path',
    'completionArtifactPath',
  );
  const council = lookupObject(rawState, 'council');
  const councilRequiredByFlag = lookupBoolean(rawState, 'council_required', 'councilRequired') === true
    || lookupBoolean(council, 'required') === true;
  const councilRequiredByEscalation = completionGateRequiresCouncilAfterEscalation() && hasEscalationHistory(rawState);
  const councilRequired = councilRequiredByFlag || councilRequiredByEscalation;
  const councilArtifactPathRaw = lookupString(
    rawState,
    'council_artifact_path',
    'councilArtifactPath',
  ) || lookupString(council, 'artifact_path', 'artifactPath');
  const [verificationEvidencePath, councilArtifactPath] = await Promise.all([
    existingPath(cwd, verificationEvidencePathRaw),
    existingPath(cwd, councilArtifactPathRaw),
  ]);

  if (arbiterDecision !== 'complete') {
    return {
      complete: false,
      reason: 'arbiter_not_complete',
      arbiterDecision,
      verificationEvidence,
      verificationEvidencePath,
      councilArtifactPath,
    };
  }

  if (verificationEvidence.length === 0) {
    return {
      complete: false,
      reason: 'missing_verification_evidence',
      arbiterDecision,
      verificationEvidence,
      verificationEvidencePath,
      councilArtifactPath,
    };
  }

  if (!evidenceIsFreshForCurrentStep(rawState)) {
    return {
      complete: false,
      reason: 'stale_verification_evidence',
      arbiterDecision,
      verificationEvidence,
      verificationEvidencePath,
      councilArtifactPath,
    };
  }

  if (!(await verificationArtifactPasses(verificationEvidencePath, rawState))) {
    return {
      complete: false,
      reason: 'missing_or_invalid_verification_artifact',
      arbiterDecision,
      verificationEvidence,
      verificationEvidencePath,
      councilArtifactPath,
    };
  }

  if (councilRequired && !(await councilArtifactPasses(councilArtifactPath))) {
    return {
      complete: false,
      reason: 'missing_required_council_artifact',
      arbiterDecision,
      verificationEvidence,
      verificationEvidencePath,
      councilArtifactPath,
    };
  }

  if (councilRequired && !councilEvidenceIsFreshForCurrentStep(rawState)) {
    return {
      complete: false,
      reason: 'stale_council_evidence',
      arbiterDecision,
      verificationEvidence,
      verificationEvidencePath,
      councilArtifactPath,
    };
  }

  return {
    complete: true,
    reason: 'arbiter_complete_with_evidence',
    arbiterDecision,
    verificationEvidence,
    verificationEvidencePath,
    councilArtifactPath,
  };
}

async function readMinimaxModeStateFromPaths(
  candidates: string[],
): Promise<Record<string, unknown> | null> {
  for (const candidatePath of candidates) {
    if (!(await pathExists(candidatePath))) continue;
    try {
      const parsed = JSON.parse(await readFile(candidatePath, 'utf-8')) as unknown;
      return safeObject(parsed);
    } catch {
      continue;
    }
  }
  return null;
}

export async function readMinimaxModeState(
  cwd: string,
  sessionId?: string,
): Promise<Record<string, unknown> | null> {
  const candidates = await getReadScopedStatePaths('minimax', cwd, sessionId);
  return readMinimaxModeStateFromPaths(candidates);
}

export async function readMinimaxModeStateForActiveDecision(
  cwd: string,
  sessionId?: string,
): Promise<Record<string, unknown> | null> {
  const candidates = await getAuthoritativeActiveStatePaths('minimax', cwd, sessionId);
  return readMinimaxModeStateFromPaths(candidates);
}

export async function readMinimaxCompletionStatus(
  cwd: string,
  sessionId?: string,
): Promise<MinimaxCompletionStatus> {
  const state = await readMinimaxModeState(cwd, sessionId);
  return assessMinimaxCompletionState(state, cwd);
}

export async function readMinimaxCompletionStatusForActiveDecision(
  cwd: string,
  sessionId?: string,
): Promise<MinimaxCompletionStatus> {
  const state = await readMinimaxModeStateForActiveDecision(cwd, sessionId);
  return assessMinimaxCompletionState(state, cwd);
}
