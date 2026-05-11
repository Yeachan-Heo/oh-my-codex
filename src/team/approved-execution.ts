import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  readApprovedExecutionLaunchHintOutcome,
  readPlanningArtifacts,
  type ApprovedRepositoryContextSummary,
  type ApprovedExecutionLaunchHint,
} from '../planning/artifacts.js';
import {
  groupContextPackFileRefsByRole,
  readReadyContextPackFileRefs,
  type ContextPackFileRef,
} from '../planning/context-pack-file-refs.js';
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
  | { status: 'ambiguous'; binding: ApprovedTeamExecutionBinding }
  | { status: 'valid'; binding: ApprovedTeamExecutionBinding; approvedHint: ApprovedExecutionLaunchHint };

type ApprovedTeamExecutionHintBindingOutcome =
  | { status: 'resolved'; approvedHint: ApprovedExecutionLaunchHint }
  | { status: 'stale' }
  | { status: 'ambiguous' };

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

function renderApprovedRepositoryContextSummary(
  summary: ApprovedRepositoryContextSummary,
): string[] {
  const lines = [
    `- Approved repository context summary source: ${summary.sourcePath}${summary.truncated ? ' (bounded/truncated)' : ''}`,
  ];
  const content = summary.content.trim();
  if (content !== '') {
    lines.push('', content);
  }
  return lines;
}

function renderRoleRefLine(label: string, refs: readonly string[]): string | null {
  return refs.length > 0
    ? `- ${label}: ${refs.join(', ')}`
    : null;
}

function inferApprovedExecutionRepoRoot(
  approvedHint: ApprovedExecutionLaunchHint,
): string | null {
  if (!isAbsolute(approvedHint.sourcePath)) {
    return null;
  }
  return resolve(dirname(approvedHint.sourcePath), '..', '..');
}

function displayApprovedContextFilePath(
  path: string,
  repoRoot: string | null,
): string {
  if (!repoRoot || !isAbsolute(path)) {
    return path;
  }
  const displayPath = relative(repoRoot, path).replaceAll('\\', '/');
  if (
    displayPath === ''
    || displayPath === '.'
    || displayPath.startsWith('..')
    || displayPath.startsWith('../')
    || isAbsolute(displayPath)
  ) {
    return path;
  }
  return displayPath;
}

function rebindApprovedContextFileRef(
  ref: ContextPackFileRef,
  sourceRepoRoot: string | null,
  repoRoot: string | null,
): ContextPackFileRef {
  if (!repoRoot || !sourceRepoRoot || !isAbsolute(ref.path) || !isAbsolute(ref.sourcePath)) {
    return ref;
  }

  const repoRelativePath = relative(sourceRepoRoot, ref.sourcePath).replaceAll('\\', '/');
  if (
    repoRelativePath === ''
    || repoRelativePath === '.'
    || repoRelativePath.startsWith('..')
    || repoRelativePath.startsWith('../')
    || isAbsolute(repoRelativePath)
  ) {
    return ref;
  }

  const reboundPath = join(repoRoot, repoRelativePath);
  return existsSync(reboundPath)
    ? { ...ref, path: reboundPath }
    : ref;
}

function describeApprovedContextFileRef(
  ref: ContextPackFileRef,
  repoRoot: string | null,
): string {
  return `${ref.label}=${displayApprovedContextFilePath(ref.path, repoRoot)} [${ref.delivery}]`;
}

function renderContextFileRefLine(
  label: string,
  refs: readonly ContextPackFileRef[],
  repoRoot: string | null,
): string | null {
  return refs.length > 0
    ? `- ${label}: ${refs.map((ref) => describeApprovedContextFileRef(ref, repoRoot)).join(', ')}`
    : null;
}

export interface ApprovedTeamHandoffSectionOptions {
  repoRoot?: string | null;
}

export function buildApprovedTeamHandoffSection(
  approvedHint: ApprovedExecutionLaunchHint | null | undefined,
  options: ApprovedTeamHandoffSectionOptions = {},
): string | undefined {
  if (
    !approvedHint
    || approvedHint.mode !== 'team'
    || approvedHint.contextPackStatus !== 'ready'
    || !approvedHint.contextPackRoleRefs
  ) {
    return undefined;
  }

  const { build, verify, scope } = approvedHint.contextPackRoleRefs;
  if (build.length === 0 && verify.length === 0 && scope.length === 0) {
    return undefined;
  }

  const lines = [`- Approved plan: ${approvedHint.sourcePath}`];
  if (approvedHint.testSpecPaths.length > 0) {
    lines.push(`- Test specs: ${approvedHint.testSpecPaths.join(', ')}`);
  }
  if (approvedHint.contextPack) {
    lines.push(`- Approved context pack: ${approvedHint.contextPack.path}`);
  }
  if (approvedHint.repositoryContextSummary) {
    lines.push(...renderApprovedRepositoryContextSummary(approvedHint.repositoryContextSummary));
  }

  const sourceRepoRoot = inferApprovedExecutionRepoRoot(approvedHint);
  const displayRepoRoot = options.repoRoot ?? sourceRepoRoot;
  // File refs are additive in this row. If private entry metadata is unavailable,
  // keep the older grouped-path handoff without changing ready/nonready behavior.
  const contextFileRefs =
    approvedHint.contextPack && sourceRepoRoot
      ? readReadyContextPackFileRefs(approvedHint.contextPack.path, sourceRepoRoot)
      : { refs: [], issues: ['Approved Team handoff could not resolve the source repo root.'] };
  const groupedContextFileRefs =
    contextFileRefs.issues.length === 0
      ? groupContextPackFileRefsByRole(
        contextFileRefs.refs.map((ref) =>
          rebindApprovedContextFileRef(ref, sourceRepoRoot, options.repoRoot ?? null)),
      )
      : null;

  const buildLine =
    groupedContextFileRefs
      ? renderContextFileRefLine('Build refs (read first)', groupedContextFileRefs.build ?? [], displayRepoRoot)
      : renderRoleRefLine('Build refs (read first)', build);
  const verifyLine =
    groupedContextFileRefs
      ? renderContextFileRefLine('Verify refs', groupedContextFileRefs.verify ?? [], displayRepoRoot)
      : renderRoleRefLine('Verify refs', verify);
  const scopeLine =
    groupedContextFileRefs
      ? renderContextFileRefLine('Scope refs', groupedContextFileRefs.scope ?? [], displayRepoRoot)
      : renderRoleRefLine('Scope refs', scope);
  if (buildLine) {
    lines.push(buildLine);
  }
  if (verifyLine) {
    lines.push(verifyLine);
  }
  if (scopeLine) {
    lines.push(scopeLine);
  }

  lines.push(
    build.length > 0
      ? '- Read the build refs above before broader repo exploration.'
      : '- Read the approved refs above before broader repo exploration.',
  );
  return lines.join('\n');
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

function readApprovedTeamExecutionHintOutcomeForPrdPath(
  cwd: string,
  binding: ApprovedTeamExecutionBinding,
  prdPath: string,
): ApprovedTeamExecutionHintBindingOutcome {
  const outcome = readApprovedExecutionLaunchHintOutcome(cwd, 'team', {
    prdPath,
    task: binding.task,
    command: binding.command,
  });
  if (outcome.status === 'resolved') {
    return { status: 'resolved', approvedHint: outcome.hint };
  }
  if (outcome.status === 'ambiguous') {
    return { status: 'ambiguous' };
  }
  return { status: 'stale' };
}

export function readApprovedTeamExecutionHintOutcomeFromBinding(
  cwd: string,
  binding: ApprovedTeamExecutionBinding | null | undefined,
): ApprovedTeamExecutionHintBindingOutcome | null {
  const normalized = normalizeApprovedTeamExecutionBinding(binding);
  if (!normalized) {
    return null;
  }

  const direct = readApprovedTeamExecutionHintOutcomeForPrdPath(cwd, normalized, normalized.prd_path);
  if (direct.status !== 'stale') {
    return direct;
  }

  const matchedPrdPath = readPlanningArtifacts(cwd).prdPaths.find((candidatePath) =>
    sameFilePath(candidatePath, normalized.prd_path));
  if (!matchedPrdPath || matchedPrdPath === normalized.prd_path) {
    return direct;
  }

  return readApprovedTeamExecutionHintOutcomeForPrdPath(cwd, normalized, matchedPrdPath);
}

export function readApprovedTeamExecutionHintFromBinding(
  cwd: string,
  binding: ApprovedTeamExecutionBinding | null | undefined,
): ApprovedExecutionLaunchHint | null {
  const outcome = readApprovedTeamExecutionHintOutcomeFromBinding(cwd, binding);
  return outcome?.status === 'resolved' ? outcome.approvedHint : null;
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

  const approvedHintOutcome = readApprovedTeamExecutionHintOutcomeFromBinding(cwd, state.binding);
  if (!approvedHintOutcome || approvedHintOutcome.status === 'stale') {
    return { status: 'stale', binding: state.binding };
  }
  if (approvedHintOutcome.status === 'ambiguous') {
    return { status: 'ambiguous', binding: state.binding };
  }
  return { status: 'valid', binding: state.binding, approvedHint: approvedHintOutcome.approvedHint };
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

  const approvedHintOutcome = readApprovedTeamExecutionHintOutcomeFromBinding(cwd, state.binding);
  if (!approvedHintOutcome || approvedHintOutcome.status === 'stale') {
    return { status: 'stale', binding: state.binding };
  }
  if (approvedHintOutcome.status === 'ambiguous') {
    return { status: 'ambiguous', binding: state.binding };
  }
  return { status: 'valid', binding: state.binding, approvedHint: approvedHintOutcome.approvedHint };
}
