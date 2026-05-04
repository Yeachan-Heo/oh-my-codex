import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  readApprovedExecutionLaunchHint,
  readPlanningArtifacts,
  type ApprovedExecutionLaunchHint,
} from '../planning/artifacts.js';
import { TEAM_NAME_SAFE_PATTERN } from './contracts.js';
import { resolveCanonicalTeamStateRoot } from './state-root.js';
import { sameFilePath } from '../utils/paths.js';

export interface ApprovedTeamExecutionBinding {
  prd_path: string;
  task: string;
  command?: string;
}

export type PersistedApprovedTeamExecutionBindingReadResult =
  | { status: 'missing' }
  | { status: 'malformed' }
  | { status: 'valid'; binding: ApprovedTeamExecutionBinding };

export type PersistedApprovedTeamExecutionContinuityState =
  | { status: 'missing' }
  | { status: 'malformed' }
  | { status: 'stale'; binding: ApprovedTeamExecutionBinding }
  | { status: 'valid'; binding: ApprovedTeamExecutionBinding; approvedHint: ApprovedExecutionLaunchHint };

export function normalizeApprovedTeamExecutionBinding(
  value: unknown,
): ApprovedTeamExecutionBinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const binding = value as Record<string, unknown>;
  if (typeof binding.prd_path !== 'string' || typeof binding.task !== 'string') {
    return null;
  }

  const prdPath = binding.prd_path.trim();
  const task = binding.task.trim();
  if (prdPath === '' || task === '') {
    return null;
  }

  const command = typeof binding.command === 'string'
    ? binding.command.trim()
    : '';

  return {
    prd_path: prdPath,
    task,
    ...(command !== '' ? { command } : {}),
  };
}

export function buildApprovedTeamExecutionBinding(
  approvedHint: ApprovedExecutionLaunchHint,
): ApprovedTeamExecutionBinding {
  return {
    prd_path: approvedHint.sourcePath,
    task: approvedHint.task,
    ...(approvedHint.command ? { command: approvedHint.command } : {}),
  };
}

function assertSafeTeamName(teamName: string): void {
  if (!TEAM_NAME_SAFE_PATTERN.test(teamName)) {
    throw new Error(`invalid_team_name:${teamName}`);
  }
}

function approvedTeamExecutionBindingPath(
  teamName: string,
  cwd: string,
  teamStateRoot?: string | null,
): string {
  assertSafeTeamName(teamName);
  const stateRoot = resolve(teamStateRoot ?? resolveCanonicalTeamStateRoot(cwd));
  return join(stateRoot, 'team', teamName, 'approved-execution.json');
}

export async function readPersistedApprovedTeamExecutionBindingState(
  teamName: string,
  cwd: string,
  teamStateRoot?: string | null,
): Promise<PersistedApprovedTeamExecutionBindingReadResult> {
  const path = approvedTeamExecutionBindingPath(teamName, cwd, teamStateRoot);
  if (!existsSync(path)) {
    return { status: 'missing' };
  }

  try {
    const raw = await readFile(path, 'utf-8');
    const binding = normalizeApprovedTeamExecutionBinding(JSON.parse(raw) as unknown);
    return binding ? { status: 'valid', binding } : { status: 'malformed' };
  } catch {
    return { status: 'malformed' };
  }
}

export function readPersistedApprovedTeamExecutionBindingStateSync(
  teamName: string,
  cwd: string,
  teamStateRoot?: string | null,
): PersistedApprovedTeamExecutionBindingReadResult {
  const path = approvedTeamExecutionBindingPath(teamName, cwd, teamStateRoot);
  if (!existsSync(path)) {
    return { status: 'missing' };
  }

  try {
    const raw = readFileSync(path, 'utf-8');
    const binding = normalizeApprovedTeamExecutionBinding(JSON.parse(raw) as unknown);
    return binding ? { status: 'valid', binding } : { status: 'malformed' };
  } catch {
    return { status: 'malformed' };
  }
}

export async function readPersistedApprovedTeamExecutionBinding(
  teamName: string,
  cwd: string,
  teamStateRoot?: string | null,
): Promise<ApprovedTeamExecutionBinding | null> {
  const state = await readPersistedApprovedTeamExecutionBindingState(teamName, cwd, teamStateRoot);
  return state.status === 'valid' ? state.binding : null;
}

export function readPersistedApprovedTeamExecutionBindingSync(
  teamName: string,
  cwd: string,
  teamStateRoot?: string | null,
): ApprovedTeamExecutionBinding | null {
  const state = readPersistedApprovedTeamExecutionBindingStateSync(teamName, cwd, teamStateRoot);
  return state.status === 'valid' ? state.binding : null;
}

export async function writePersistedApprovedTeamExecutionBinding(
  teamName: string,
  cwd: string,
  binding: ApprovedTeamExecutionBinding | null | undefined,
  teamStateRoot?: string | null,
): Promise<void> {
  const path = approvedTeamExecutionBindingPath(teamName, cwd, teamStateRoot);
  const normalized = normalizeApprovedTeamExecutionBinding(binding);
  if (!normalized) {
    await rm(path, { force: true }).catch(() => {});
    return;
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
}

export function readApprovedTeamExecutionHintFromBinding(
  cwd: string,
  binding: ApprovedTeamExecutionBinding | null | undefined,
): ApprovedExecutionLaunchHint | null {
  const normalized = normalizeApprovedTeamExecutionBinding(binding);
  if (!normalized) {
    return null;
  }

  const direct = readApprovedExecutionLaunchHint(cwd, 'team', {
    prdPath: normalized.prd_path,
    task: normalized.task,
    command: normalized.command,
  });
  if (direct) {
    return direct;
  }

  const matchedPrdPath = readPlanningArtifacts(cwd).prdPaths.find((candidatePath) =>
    sameFilePath(candidatePath, normalized.prd_path));
  if (!matchedPrdPath || matchedPrdPath === normalized.prd_path) {
    return null;
  }

  return readApprovedExecutionLaunchHint(cwd, 'team', {
    prdPath: matchedPrdPath,
    task: normalized.task,
    command: normalized.command,
  });
}

export async function resolvePersistedApprovedTeamExecutionContinuityState(
  teamName: string,
  cwd: string,
  teamStateRoot?: string | null,
): Promise<PersistedApprovedTeamExecutionContinuityState> {
  const state = await readPersistedApprovedTeamExecutionBindingState(teamName, cwd, teamStateRoot);
  if (state.status === 'missing' || state.status === 'malformed') {
    return state;
  }

  const approvedHint = readApprovedTeamExecutionHintFromBinding(cwd, state.binding);
  return approvedHint
    ? { status: 'valid', binding: state.binding, approvedHint }
    : { status: 'stale', binding: state.binding };
}

export function resolvePersistedApprovedTeamExecutionContinuityStateSync(
  teamName: string,
  cwd: string,
  teamStateRoot?: string | null,
): PersistedApprovedTeamExecutionContinuityState {
  const state = readPersistedApprovedTeamExecutionBindingStateSync(teamName, cwd, teamStateRoot);
  if (state.status === 'missing' || state.status === 'malformed') {
    return state;
  }

  const approvedHint = readApprovedTeamExecutionHintFromBinding(cwd, state.binding);
  return approvedHint
    ? { status: 'valid', binding: state.binding, approvedHint }
    : { status: 'stale', binding: state.binding };
}
