import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { getAuthoritativeActiveStatePaths, getReadScopedStatePaths } from '../mcp/state-paths.js';

export type AutoresearchValidationMode = 'mission-validator-script' | 'prompt-architect-artifact';

export interface AutoresearchCompletionStatus {
  complete: boolean;
  reason: string;
  validationMode: AutoresearchValidationMode | null;
  artifactPath: string | null;
  outputArtifactPath?: string | null;
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function safeObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function safeBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
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

export function normalizeAutoresearchValidationMode(value: unknown): AutoresearchValidationMode | null {
  const normalized = safeString(value).toLowerCase();
  if (normalized === 'mission-validator-script') return 'mission-validator-script';
  if (normalized === 'prompt-architect-artifact') return 'prompt-architect-artifact';
  return null;
}

function resolveMaybeRelativePath(cwd: string, rawPath: string): string {
  if (!rawPath) return rawPath;
  return rawPath.startsWith('/') ? rawPath : join(cwd, rawPath);
}

function deriveDefaultArtifactPath(cwd: string, rawState: Record<string, unknown> | null): string | null {
  const slug = lookupString(rawState, 'slug', 'mission_slug', 'missionSlug');
  if (!slug) return null;
  return join(cwd, '.omx', 'specs', `autoresearch-${slug}`, 'completion.json');
}

function resolveArtifactPath(cwd: string, rawState: Record<string, unknown> | null): string | null {
  const explicit = lookupString(
    rawState,
    'completion_artifact_path',
    'completionArtifactPath',
    'validator_artifact_path',
    'validatorArtifactPath',
  );
  if (explicit) return resolveMaybeRelativePath(cwd, explicit);
  return deriveDefaultArtifactPath(cwd, rawState);
}

async function readJsonIfExists(path: string | null): Promise<Record<string, unknown> | null> {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isPassingStatus(value: unknown): boolean {
  const normalized = safeString(value).toLowerCase();
  return ['pass', 'passed', 'complete', 'completed', 'success', 'succeeded', 'approved'].includes(normalized);
}

function hasArchitectApproval(artifact: Record<string, unknown> | null): boolean {
  if (!artifact) return false;
  const direct = lookupBoolean(artifact, 'architect_approved', 'architectApproved', 'approved');
  if (direct === true) return true;
  const architectReview = safeObject(artifact.architect_review) ?? safeObject(artifact.architectReview);
  const architectValidation = safeObject(artifact.architect_validation) ?? safeObject(artifact.architectValidation);
  return isPassingStatus(architectReview?.verdict) || isPassingStatus(architectValidation?.verdict);
}

function resolveOutputArtifactPath(
  cwd: string,
  rawState: Record<string, unknown> | null,
  artifact: Record<string, unknown> | null,
): string | null {
  const explicit = lookupString(rawState, 'output_artifact_path', 'outputArtifactPath')
    || lookupString(artifact, 'output_artifact_path', 'outputArtifactPath');
  if (!explicit) return null;
  return resolveMaybeRelativePath(cwd, explicit);
}

export async function assessAutoresearchCompletionState(
  rawState: Record<string, unknown> | null,
  cwd: string,
): Promise<AutoresearchCompletionStatus> {
  const validationMode = normalizeAutoresearchValidationMode(
    lookupString(rawState, 'validation_mode', 'validationMode'),
  );
  if (!rawState) {
    return { complete: false, reason: 'missing_mode_state', validationMode: null, artifactPath: null };
  }
  if (!validationMode) {
    return { complete: false, reason: 'missing_validation_mode', validationMode: null, artifactPath: resolveArtifactPath(cwd, rawState) };
  }

  const artifactPath = resolveArtifactPath(cwd, rawState);
  const artifact = await readJsonIfExists(artifactPath);
  if (!artifactPath) {
    return { complete: false, reason: 'missing_completion_artifact_path', validationMode, artifactPath: null };
  }
  if (!artifact) {
    return { complete: false, reason: 'missing_or_invalid_completion_artifact', validationMode, artifactPath };
  }

  if (validationMode === 'mission-validator-script') {
    const validatorCommand = lookupString(rawState, 'mission_validator_command', 'missionValidatorCommand')
      || lookupString(safeObject(rawState.mission_validator), 'command');
    if (!validatorCommand) {
      return { complete: false, reason: 'missing_mission_validator_command', validationMode, artifactPath };
    }
    if (lookupBoolean(artifact, 'passed', 'complete', 'completed', 'valid') === true || isPassingStatus(artifact.status)) {
      return { complete: true, reason: 'validator_passed', validationMode, artifactPath };
    }
    return { complete: false, reason: 'validator_not_passed', validationMode, artifactPath };
  }

  const validatorPrompt = lookupString(rawState, 'validator_prompt', 'validatorPrompt')
    || lookupString(artifact, 'validator_prompt', 'validatorPrompt');
  if (!validatorPrompt) {
    return { complete: false, reason: 'missing_validator_prompt', validationMode, artifactPath };
  }
  const outputArtifactPath = resolveOutputArtifactPath(cwd, rawState, artifact);
  if (!outputArtifactPath || !existsSync(outputArtifactPath)) {
    return { complete: false, reason: 'missing_output_artifact', validationMode, artifactPath, outputArtifactPath };
  }
  if (!hasArchitectApproval(artifact)) {
    return { complete: false, reason: 'missing_architect_approval', validationMode, artifactPath, outputArtifactPath };
  }
  return { complete: true, reason: 'architect_approved', validationMode, artifactPath, outputArtifactPath };
}

async function readAutoresearchModeStateFromPaths(
  candidates: string[],
): Promise<Record<string, unknown> | null> {
  for (const candidatePath of candidates) {
    if (!existsSync(candidatePath)) continue;
    try {
      return JSON.parse(await readFile(candidatePath, 'utf-8')) as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return null;
}

export async function readAutoresearchModeState(
  cwd: string,
  sessionId?: string,
): Promise<Record<string, unknown> | null> {
  const candidates = await getReadScopedStatePaths('autoresearch', cwd, sessionId);
  return readAutoresearchModeStateFromPaths(candidates);
}

export async function readAutoresearchModeStateForActiveDecision(
  cwd: string,
  sessionId?: string,
): Promise<Record<string, unknown> | null> {
  const candidates = await getAuthoritativeActiveStatePaths('autoresearch', cwd, sessionId);
  return readAutoresearchModeStateFromPaths(candidates);
}

export async function readAutoresearchCompletionStatus(
  cwd: string,
  sessionId?: string,
): Promise<AutoresearchCompletionStatus> {
  const state = await readAutoresearchModeState(cwd, sessionId);
  return assessAutoresearchCompletionState(state, cwd);
}
