import { existsSync, readFileSync } from 'fs';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import {
  contextPackIndexPath,
  describeContextRef,
  groupContextRefsByRole,
  rebindContextRefsForRepoRoot,
  type ContextPackExecutionRef,
} from '../planning/context-packs.js';
import {
  isApprovedExecutionContextReadyStatus,
  readApprovedExecutionLaunchHint,
  type ApprovedExecutionLaunchHint,
} from '../planning/artifacts.js';
import { resolveCanonicalTeamStateRoot } from './state-root.js';
import { getReadScopedStatePathsSync } from '../mcp/state-paths.js';

export interface ApprovedTeamExecutionBinding {
  prd_path: string;
  task: string;
  command?: string;
}

export interface PersistedTeamFollowupState {
  active?: boolean;
  team_name?: string;
  team_state_root?: string;
  task?: string;
  task_description?: string;
  workerCount?: number;
  agent_count?: number;
  agentType?: string;
  agent_types?: string;
  linkedRalph?: boolean;
}

export interface BoundApprovedTeamExecutionState {
  teamState: PersistedTeamFollowupState | null;
  teamName: string | null;
  bindingConfigured: boolean;
  bindingState: PersistedApprovedTeamExecutionBindingReadResult['status'];
  approvedExecution: ApprovedTeamExecutionBinding | null;
  approvedHint: ApprovedExecutionLaunchHint | null;
}

export type PersistedApprovedTeamExecutionBindingReadResult =
  | { status: 'missing' }
  | { status: 'malformed' }
  | { status: 'valid'; binding: ApprovedTeamExecutionBinding };

export type PersistedApprovedTeamExecutionContinuityState =
  | { status: 'missing' }
  | { status: 'malformed' }
  | { status: 'stale'; binding: ApprovedTeamExecutionBinding }
  | { status: 'nonready'; binding: ApprovedTeamExecutionBinding; approvedHint: ApprovedExecutionLaunchHint }
  | { status: 'valid'; binding: ApprovedTeamExecutionBinding; approvedHint: ApprovedExecutionLaunchHint };

export function normalizeApprovedTeamExecutionBinding(value: unknown): ApprovedTeamExecutionBinding | null {
  if (!value || typeof value !== 'object') {
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
    command: approvedHint.command,
  };
}

function approvedTeamExecutionBindingPath(
  teamName: string,
  cwd: string,
  teamStateRoot?: string | null,
): string {
  const stateRoot = resolve(teamStateRoot ?? resolveCanonicalTeamStateRoot(cwd));
  return join(stateRoot, 'team', teamName, 'approved-execution.json');
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
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const binding = normalizeApprovedTeamExecutionBinding(parsed);
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
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const binding = normalizeApprovedTeamExecutionBinding(parsed);
    return binding ? { status: 'valid', binding } : { status: 'malformed' };
  } catch {
    return { status: 'malformed' };
  }
}

export async function writePersistedApprovedTeamExecutionBinding(
  teamName: string,
  cwd: string,
  binding: ApprovedTeamExecutionBinding | null | undefined,
  teamStateRoot?: string | null,
): Promise<void> {
  const path = approvedTeamExecutionBindingPath(teamName, cwd, teamStateRoot);
  const normalizedBinding = normalizeApprovedTeamExecutionBinding(binding);
  if (!normalizedBinding) {
    await rm(path, { force: true }).catch(() => {});
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(normalizedBinding, null, 2)}\n`, 'utf8');
}

export async function readPersistedApprovedTeamExecutionHint(
  teamName: string,
  cwd: string,
  teamStateRoot?: string | null,
): Promise<ApprovedExecutionLaunchHint | null> {
  const binding = await readPersistedApprovedTeamExecutionBinding(teamName, cwd, teamStateRoot);
  return hydrateApprovedTeamExecutionHintFromBinding(cwd, binding);
}

export function readPersistedApprovedTeamExecutionHintSync(
  teamName: string,
  cwd: string,
  teamStateRoot?: string | null,
): ApprovedExecutionLaunchHint | null {
  const binding = readPersistedApprovedTeamExecutionBindingSync(teamName, cwd, teamStateRoot);
  return hydrateApprovedTeamExecutionHintFromBinding(cwd, binding);
}

export async function resolvePersistedApprovedTeamExecutionContinuityState(
  teamName: string,
  cwd: string,
  teamStateRoot?: string | null,
): Promise<PersistedApprovedTeamExecutionContinuityState> {
  const bindingState = await readPersistedApprovedTeamExecutionBindingState(teamName, cwd, teamStateRoot);
  if (bindingState.status === 'missing' || bindingState.status === 'malformed') {
    return bindingState;
  }

  const approvedHint = resolveApprovedTeamExecutionHint(cwd, {
    approvedExecution: bindingState.binding,
  });
  if (!approvedHint) {
    return {
      status: 'stale',
      binding: bindingState.binding,
    };
  }
  if (!isApprovedExecutionContextReadyStatus(approvedHint.contextPackStatus)) {
    return {
      status: 'nonready',
      binding: bindingState.binding,
      approvedHint,
    };
  }
  return {
    status: 'valid',
    binding: bindingState.binding,
    approvedHint,
  };
}

function hasActiveTeamIdentity(
  state: PersistedTeamFollowupState | null | undefined,
): state is PersistedTeamFollowupState & { active: true; team_name: string } {
  return state?.active === true
    && typeof state.team_name === 'string'
    && state.team_name.trim() !== '';
}

function readScopedTeamFollowupStateSync(path: string): PersistedTeamFollowupState | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PersistedTeamFollowupState;
  } catch {
    return null;
  }
}

export function readPersistedTeamFollowupState(cwd: string): PersistedTeamFollowupState | null {
  const paths = getReadScopedStatePathsSync('team', cwd);
  for (const path of paths) {
    const state = readScopedTeamFollowupStateSync(path);
    if (!state || state.active !== true) {
      continue;
    }
    if (!hasActiveTeamIdentity(state)) {
      continue;
    }
    return state;
  }
  return null;
}

export function readBoundApprovedTeamExecutionState(
  cwd: string,
  teamStateRoot?: string | null,
): BoundApprovedTeamExecutionState {
  const teamState = readPersistedTeamFollowupState(cwd);
  const teamName = hasActiveTeamIdentity(teamState)
    ? teamState.team_name.trim()
    : null;
  if (!teamName) {
    return {
      teamState,
      teamName: null,
      bindingConfigured: false,
      bindingState: 'missing',
      approvedExecution: null,
      approvedHint: null,
    };
  }

  const persistedTeamStateRoot = typeof teamState?.team_state_root === 'string'
    && teamState.team_state_root.trim() !== ''
    ? teamState.team_state_root.trim()
    : null;
  const effectiveTeamStateRoot = teamStateRoot ?? persistedTeamStateRoot;
  const bindingPath = approvedTeamExecutionBindingPath(teamName, cwd, effectiveTeamStateRoot);
  if (!existsSync(bindingPath)) {
    return {
      teamState,
      teamName,
      bindingConfigured: false,
      bindingState: 'missing',
      approvedExecution: null,
      approvedHint: null,
    };
  }

  const bindingState = readPersistedApprovedTeamExecutionBindingStateSync(
    teamName,
    cwd,
    effectiveTeamStateRoot,
  );
  const approvedExecution = bindingState.status === 'valid'
    ? bindingState.binding
    : null;
  return {
    teamState,
    teamName,
    bindingConfigured: true,
    bindingState: bindingState.status,
    approvedExecution,
    approvedHint: readApprovedTeamExecutionHintFromBinding(cwd, approvedExecution),
  };
}

export function readApprovedTeamExecutionHintFromBinding(
  cwd: string,
  binding: ApprovedTeamExecutionBinding | null | undefined,
): ApprovedExecutionLaunchHint | null {
  const normalizedBinding = normalizeApprovedTeamExecutionBinding(binding);
  if (!normalizedBinding) {
    return null;
  }
  return readApprovedExecutionLaunchHint(cwd, 'team', {
    prdPath: normalizedBinding.prd_path,
    command: normalizedBinding.command,
    task: normalizedBinding.task,
  });
}

export function hydrateApprovedTeamExecutionHintFromBinding(
  cwd: string,
  binding: ApprovedTeamExecutionBinding | null | undefined,
): ApprovedExecutionLaunchHint | null {
  const normalizedBinding = normalizeApprovedTeamExecutionBinding(binding);
  if (!normalizedBinding) {
    return null;
  }

  const approvedHint = readApprovedTeamExecutionHintFromBinding(cwd, normalizedBinding);
  if (!approvedHint || approvedHint.contextPackStatus !== 'ready') {
    return approvedHint;
  }

  return readApprovedExecutionLaunchHint(cwd, 'team', {
    prdPath: normalizedBinding.prd_path,
    command: normalizedBinding.command,
    task: normalizedBinding.task,
    materializeContextRefs: true,
  }) ?? approvedHint;
}

export function resolveApprovedTeamExecutionHint(
  cwd: string,
  options: {
    approvedExecution?: ApprovedTeamExecutionBinding | null;
    task?: string;
  } = {},
): ApprovedExecutionLaunchHint | null {
  const approvedExecution = normalizeApprovedTeamExecutionBinding(options.approvedExecution);
  if (approvedExecution) {
    return hydrateApprovedTeamExecutionHintFromBinding(cwd, approvedExecution);
  }

  const task = options.task?.trim();
  if (!task) {
    return null;
  }

  const matchedHint = readApprovedExecutionLaunchHint(cwd, 'team', {
    task,
  });
  if (!matchedHint) {
    return null;
  }

  return hydrateApprovedTeamExecutionHintFromBinding(cwd, buildApprovedTeamExecutionBinding(matchedHint))
    ?? matchedHint;
}

function inferApprovedExecutionRepoRoot(
  approvedHint: ApprovedExecutionLaunchHint,
): string | null {
  if (approvedHint.contextPack?.path && isAbsolute(approvedHint.contextPack.path)) {
    const contextDir = dirname(approvedHint.contextPack.path);
    const omxDir = dirname(contextDir);
    if (basename(contextDir) === 'context' && basename(omxDir) === '.omx') {
      return dirname(omxDir);
    }
  }

  if (!isAbsolute(approvedHint.sourcePath)) {
    return null;
  }
  const plansDir = dirname(approvedHint.sourcePath);
  const omxDir = dirname(plansDir);
  if (basename(plansDir) !== 'plans' || basename(omxDir) !== '.omx') {
    return null;
  }
  return dirname(omxDir);
}

export function buildApprovedTeamHandoffSection(
  approvedHint: ApprovedExecutionLaunchHint | null | undefined,
  repoRoot?: string,
): string | undefined {
  if (!approvedHint) {
    return undefined;
  }

  const sourceRepoRoot = inferApprovedExecutionRepoRoot(approvedHint);
  const rebindRepoArtifactPath = (path: string): string => {
    if (!repoRoot || !sourceRepoRoot || !isAbsolute(path)) {
      return path;
    }
    const repoRelativePath = relative(sourceRepoRoot, path).replaceAll('\\', '/');
    if (
      repoRelativePath === ''
      || repoRelativePath === '.'
      || repoRelativePath.startsWith('..')
      || repoRelativePath.startsWith('../')
      || isAbsolute(repoRelativePath)
    ) {
      return path;
    }
    const reboundPath = join(repoRoot, repoRelativePath);
    return existsSync(reboundPath) ? reboundPath : path;
  };
  const describeTeamContextRef = (ref: ContextPackExecutionRef): string => {
    if (!repoRoot) {
      return describeContextRef(ref);
    }
    const displayPath = relative(repoRoot, ref.path).replaceAll('\\', '/');
    if (
      displayPath === ''
      || displayPath.startsWith('..')
      || displayPath.startsWith('../')
      || isAbsolute(displayPath)
    ) {
      return describeContextRef(ref);
    }
    return `${ref.label}=${displayPath} [${ref.delivery}]`;
  };

  const approvedPlanPath = rebindRepoArtifactPath(approvedHint.sourcePath);
  const projectedTestSpecPaths = approvedHint.testSpecPaths.map(rebindRepoArtifactPath);
  const projectedDeepInterviewSpecPaths = approvedHint.deepInterviewSpecPaths.map(rebindRepoArtifactPath);
  const projectedContextPackPath = approvedHint.contextPack
    ? rebindRepoArtifactPath(approvedHint.contextPack.path)
    : null;
  const projectedContextRefs = sourceRepoRoot && repoRoot
    ? rebindContextRefsForRepoRoot(approvedHint.contextRefs, sourceRepoRoot, repoRoot)
    : approvedHint.contextRefs;
  const lines = [
    `- Approved plan: ${approvedPlanPath}`,
  ];
  if (projectedTestSpecPaths.length > 0) {
    lines.push(`- Test specs: ${projectedTestSpecPaths.join(', ')}`);
  }
  if (projectedDeepInterviewSpecPaths.length > 0) {
    lines.push(`- Deep-interview specs: ${projectedDeepInterviewSpecPaths.join(', ')}`);
  }
  if (projectedContextPackPath) {
    lines.push(`- Context pack: ${projectedContextPackPath}`);
  }

  const contextRefs = projectedContextRefs;
  const groupedRefs = groupContextRefsByRole(contextRefs);
  const contextPackIndex = projectedContextPackPath
    ? contextPackIndexPath(projectedContextPackPath)
    : null;
  const hasContextPackIndex = contextPackIndex != null && (!isAbsolute(contextPackIndex) || existsSync(contextPackIndex));
  if (approvedHint.contextPackStatus === 'ready') {
    if (hasContextPackIndex) {
      lines.push(`- Context pack index: ${contextPackIndex}`);
    }
    if ((groupedRefs.build?.length ?? 0) > 0) {
      lines.push(`- Build refs (read first): ${groupedRefs.build!.map(describeTeamContextRef).join(', ')}`);
    }
    if ((groupedRefs.verify?.length ?? 0) > 0) {
      lines.push(`- Verify refs: ${groupedRefs.verify!.map(describeTeamContextRef).join(', ')}`);
    }
    if ((groupedRefs.scope?.length ?? 0) > 0) {
      lines.push(`- Scope refs: ${groupedRefs.scope!.map(describeTeamContextRef).join(', ')}`);
    }
    if (contextRefs.length > 0) {
      lines.push(hasContextPackIndex
        ? '- Read the build refs above before broader repo exploration. If they are insufficient, open the pack index or query the canonical pack by role/tag/label to inspect alternate views and relation paths before broadening context.'
        : '- Read the build refs above before broader repo exploration. If they are insufficient, query the canonical pack by role/tag/label to inspect alternate views and relation paths before broadening context.');
    } else {
      lines.push(hasContextPackIndex
        ? '- No generated context refs were declared for this handoff, so open the context pack index before broadening context.'
        : '- No generated context refs were declared for this handoff, so query the canonical pack by role/tag/label before broadening context.');
    }
    return lines.join('\n');
  }

  if (approvedHint.contextPackStatus === 'incomplete') {
    if (approvedHint.contextPackIssues.length > 0) {
      lines.push(`- Incomplete context-pack issues: ${approvedHint.contextPackIssues.join(' | ')}`);
    } else {
      lines.push(`- Missing required context roles: ${approvedHint.missingRequiredContextPackRoles.join(', ')}`);
    }
    lines.push('- Fallback: use the approved plan, matching test specs, and any deep-interview artifacts only as repair inputs; repair or recreate the canonical context pack with required role coverage, then sync it before broader context loading.');
    return lines.join('\n');
  }

  if (approvedHint.contextPackStatus === 'invalid') {
    lines.push(`- Invalid context pack issues: ${approvedHint.contextPackIssues.join(' | ')}`);
    lines.push('- Fallback: use the approved plan, matching test specs, and any deep-interview artifacts only as repair inputs; repair or recreate the canonical context pack, then sync it before broader context loading.');
    return lines.join('\n');
  }

  if (approvedHint.contextPackStatus === 'missing-baseline') {
    lines.push(`- Missing-baseline issues: ${approvedHint.contextPackIssues.join(' | ')}`);
    lines.push('- Fallback: the latest approved plan is missing its matching test spec, so use the surfaced plan as lineage guidance only and restore the missing baseline before broader context loading or execution.');
    return lines.join('\n');
  }

  lines.push('- Plan-only fallback: context packs were not declared in the approved plan, so use the approved plan, matching test specs, and any deep-interview artifacts as pre-context-pack repair inputs, then create or refresh the canonical context pack and sync it before broadening context.');
  return lines.join('\n');
}
