/**
 * Team execution stage adapter for pipeline orchestrator.
 *
 * Wraps the existing team mode (tmux-based Codex CLI workers) into a
 * PipelineStage. The execution backend is always teams — this is the
 * canonical OMX execution surface.
 */

import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import type { PipelineStage, StageContext, StageResult } from '../types.js';
import { buildRepoAwareTeamExecutionPlan, type TeamDecompositionMetadata } from '../../team/repo-aware-decomposition.js';
import { buildTeamExecutionPlan, parseTeamArgs } from '../../cli/team.js';
import {
  buildFollowupStaffingPlan,
  resolveAvailableAgentTypes,
} from '../../team/followup-planner.js';
import {
  readApprovedExecutionLaunchHintOutcome,
  readPlanningArtifacts,
  type PlanningArtifacts,
} from '../../planning/artifacts.js';
import {
  buildApprovedTeamExecutionBinding,
  type ApprovedTeamExecutionBinding,
} from '../../team/approved-execution.js';
import { packageRoot, sameFilePath } from '../../utils/paths.js';

export interface TeamExecStageOptions {
  /** Number of Codex CLI workers to launch. Defaults to 2. */
  workerCount?: number;

  /** Agent type/role for workers. Defaults to 'executor'. */
  agentType?: string;

  /** Whether to use git worktrees for worker isolation. */
  useWorktrees?: boolean;

  /** Additional environment variables for worker launch. */
  extraEnv?: Record<string, string>;
}

function resolveRequestedTask(ctx: StageContext, ralplanArtifacts?: Record<string, unknown>): string {
  const ralplanTask = typeof ralplanArtifacts?.task === 'string' ? ralplanArtifacts.task.trim() : '';
  return ralplanTask || ctx.task;
}

function normalizePlanningRelativePath(rawPath: string): string {
  const trimmed = rawPath.trim().replace(/^`|`$/g, '').replace(/\\/g, '/');
  const withoutDotPrefix = trimmed.startsWith('./') ? trimmed.slice(2) : trimmed;
  return normalize(withoutDotPrefix).replace(/\\/g, '/');
}

function planningArtifactSlug(path: string, prefixPattern: RegExp): string | null {
  const file = basename(path);
  const match = file.match(prefixPattern);
  return match?.groups?.slug ?? null;
}

function matchingTestSpecPathsForPrd(artifacts: PlanningArtifacts, prdPath: string): string[] {
  const prdSlug = planningArtifactSlug(prdPath, /^prd-(?<slug>.*)\.md$/i);
  if (!prdSlug) return [];
  return artifacts.testSpecPaths.filter(
    (testSpecPath) => planningArtifactSlug(testSpecPath, /^test-?spec-(?<slug>.*)\.md$/i) === prdSlug,
  );
}

function resolvePlanningPrdPath(
  artifacts: PlanningArtifacts,
  cwd: string,
  rawPath: string,
): { matchedPath: string | null; fallbackPath: string } {
  const normalizedRawPath = rawPath.trim();
  if (isAbsolute(normalizedRawPath)) {
    const resolvedPath = resolve(normalizedRawPath);
    const matchedPath = artifacts.prdPaths.find((candidatePath) => sameFilePath(candidatePath, resolvedPath)) ?? null;
    return { matchedPath, fallbackPath: resolvedPath };
  }

  const repoRoot = dirname(dirname(artifacts.plansDir));
  const normalizedPath = normalizePlanningRelativePath(normalizedRawPath);
  const resolvedPath = resolve(cwd, normalizedPath);
  const matchedPath = artifacts.prdPaths.find((candidatePath) => {
    const artifactPath = normalizePlanningRelativePath(candidatePath);
    const repoRelativePath = normalizePlanningRelativePath(relative(repoRoot, candidatePath));
    const plansRelativePath = normalizePlanningRelativePath(relative(artifacts.plansDir, candidatePath));
    return normalizedPath === artifactPath
      || normalizedPath === repoRelativePath
      || normalizedPath === plansRelativePath;
  }) ?? artifacts.prdPaths.find((candidatePath) => sameFilePath(candidatePath, resolvedPath)) ?? null;
  return {
    matchedPath,
    fallbackPath: resolvedPath,
  };
}

function readRuntimeLatestPlanningSelection(
  artifacts: PlanningArtifacts,
  cwd: string,
  ralplanArtifacts?: Record<string, unknown>,
): { prdPath: string | null; testSpecPaths: string[] } | null {
  const drafts = Array.isArray(ralplanArtifacts?.drafts) ? ralplanArtifacts.drafts : [];
  for (let index = drafts.length - 1; index >= 0; index -= 1) {
    const draft = drafts[index];
    if (!draft || typeof draft !== 'object') continue;
    const draftRecord = draft as { planPath?: unknown };
    const draftPlanPath = typeof draftRecord.planPath === 'string'
      ? draftRecord.planPath.trim()
      : '';
    if (!draftPlanPath) continue;
    const resolvedDraftPlanPath = resolvePlanningPrdPath(artifacts, cwd, draftPlanPath).matchedPath;
    const testSpecPaths = resolvedDraftPlanPath ? matchingTestSpecPathsForPrd(artifacts, resolvedDraftPlanPath) : [];
    if (!resolvedDraftPlanPath || testSpecPaths.length === 0) continue;
    return {
      prdPath: resolvedDraftPlanPath,
      testSpecPaths,
    };
  }
  return null;
}

function readLatestApprovedPlanningSelection(
  artifacts: PlanningArtifacts,
): { prdPath: string | null; testSpecPaths: string[] } {
  for (let index = artifacts.prdPaths.length - 1; index >= 0; index -= 1) {
    const prdPath = artifacts.prdPaths[index];
    const testSpecPaths = matchingTestSpecPathsForPrd(artifacts, prdPath);
    if (testSpecPaths.length > 0) {
      return { prdPath, testSpecPaths };
    }
  }
  return { prdPath: null, testSpecPaths: [] };
}

function resolveApprovedTeamPlanPath(
  cwd: string,
  latestPlanPath: string,
  ralplanArtifacts?: Record<string, unknown>,
): string {
  const artifacts = readPlanningArtifacts(cwd);
  const resolvedLatestPlanPath = resolvePlanningPrdPath(artifacts, cwd, latestPlanPath);
  const selection = readRuntimeLatestPlanningSelection(artifacts, cwd, ralplanArtifacts)
    ?? readLatestApprovedPlanningSelection(artifacts);
  const selectedPrdPath = selection.prdPath
    ? resolvePlanningPrdPath(artifacts, cwd, selection.prdPath).matchedPath
    : null;

  if (!selectedPrdPath || selection.testSpecPaths.length === 0 || !resolvedLatestPlanPath.matchedPath) {
    throw new Error(`team_exec_approved_handoff_missing:${resolvedLatestPlanPath.fallbackPath}`);
  }
  if (selectedPrdPath !== resolvedLatestPlanPath.matchedPath) {
    throw new Error(`team_exec_approved_handoff_stale:${resolvedLatestPlanPath.matchedPath}:${selectedPrdPath}`);
  }

  return selectedPrdPath;
}

function resolveApprovedTeamLaunchFromPlanPath(
  cwd: string,
  latestPlanPath: string,
  ralplanArtifacts?: Record<string, unknown>,
): { task: string; approvedExecution: ApprovedTeamExecutionBinding } {
  const approvedPlanPath = resolveApprovedTeamPlanPath(cwd, latestPlanPath, ralplanArtifacts);
  const approvedHintOutcome = readApprovedExecutionLaunchHintOutcome(cwd, 'team', {
    prdPath: approvedPlanPath,
  });
  if (approvedHintOutcome.status === 'ambiguous') {
    throw new Error(`team_exec_approved_handoff_ambiguous:${approvedPlanPath}`);
  }
  if (approvedHintOutcome.status !== 'resolved') {
    throw new Error(`team_exec_approved_handoff_missing:${approvedPlanPath}`);
  }
  return {
    task: approvedHintOutcome.hint.task,
    approvedExecution: buildApprovedTeamExecutionBinding(approvedHintOutcome.hint),
  };
}

function resolveTeamExecLaunch(
  ctx: StageContext,
  ralplanArtifacts?: Record<string, unknown>,
): { task: string; approvedExecution: ApprovedTeamExecutionBinding | null } {
  const requestedTask = resolveRequestedTask(ctx, ralplanArtifacts);
  const latestPlanPath = typeof ralplanArtifacts?.latestPlanPath === 'string'
    ? ralplanArtifacts.latestPlanPath.trim()
    : '';
  if (!latestPlanPath) {
    return { task: requestedTask, approvedExecution: null };
  }
  return resolveApprovedTeamLaunchFromPlanPath(ctx.cwd, latestPlanPath, ralplanArtifacts);
}

interface BuildTeamInstructionOptions {
  platform?: NodeJS.Platform;
}

interface TeamRuntimeCliTaskInput {
  subject: string;
  description: string;
  owner?: string;
  blocked_by?: string[];
  depends_on?: string[];
  symbolic_depends_on?: string[];
  role?: string;
  requires_code_change?: boolean;
  filePaths?: string[];
  domains?: string[];
  lane?: string;
  allocation_reason?: string;
  symbolic_id?: string;
}

interface TeamRuntimeCliLaunchInput {
  teamName: string;
  task: string;
  workerCount: number;
  agentType: string;
  tasks: TeamRuntimeCliTaskInput[];
  cwd: string;
  approvedExecution: ApprovedTeamExecutionBinding | null;
  decompositionMetadata?: TeamDecompositionMetadata;
}

function quotePosixShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function quoteWindowsCmdArg(value: string): string {
  return `"${value.replace(/%/g, '%%').replace(/"/g, '""')}"`;
}

function quoteShellArg(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? quoteWindowsCmdArg(value) : quotePosixShellArg(value);
}

function buildTeamRuntimeCliLaunchInput(descriptor: TeamExecDescriptor): TeamRuntimeCliLaunchInput {
  const parsed = parseTeamArgs(
    [`${descriptor.workerCount}:${descriptor.agentType}`, descriptor.task],
    descriptor.cwd,
  );
  const executionPlan = buildRepoAwareTeamExecutionPlan({
    task: parsed.task,
    workerCount: parsed.workerCount,
    agentType: parsed.agentType,
    explicitAgentType: parsed.explicitAgentType,
    explicitWorkerCount: parsed.explicitWorkerCount,
    cwd: descriptor.cwd,
    buildLegacyPlan: buildTeamExecutionPlan,
    allowDagHandoff: parsed.allowRepoAwareDagHandoff,
    approvedRepositoryContextSummary: parsed.approvedRepositoryContextSummary,
  });
  return {
    teamName: parsed.teamName,
    task: descriptor.task,
    workerCount: executionPlan.workerCount,
    agentType: descriptor.agentType,
    tasks: executionPlan.tasks.map(({
      subject,
      description,
      owner,
      blocked_by,
      depends_on,
      symbolic_depends_on,
      role,
      requires_code_change,
      filePaths,
      domains,
      lane,
      allocation_reason,
      symbolic_id,
    }) => ({
      subject,
      description,
      ...(owner ? { owner } : {}),
      ...(blocked_by?.length ? { blocked_by } : {}),
      ...(depends_on?.length ? { depends_on } : {}),
      ...(symbolic_depends_on?.length ? { symbolic_depends_on } : {}),
      ...(role ? { role } : {}),
      ...(requires_code_change ? { requires_code_change } : {}),
      ...(filePaths?.length ? { filePaths } : {}),
      ...(domains?.length ? { domains } : {}),
      ...(lane ? { lane } : {}),
      ...(allocation_reason ? { allocation_reason } : {}),
      ...(symbolic_id ? { symbolic_id } : {}),
    })),
    cwd: descriptor.cwd,
    approvedExecution: descriptor.approvedExecution,
    ...(executionPlan.metadata ? { decompositionMetadata: executionPlan.metadata } : {}),
  };
}

/**
 * Create a team-exec pipeline stage.
 *
 * This stage delegates to the existing `omx team` infrastructure, which
 * starts real Codex CLI workers in tmux panes. When RALPLAN names a
 * concrete approved PRD handoff, team-exec reuses that exact task text;
 * otherwise it stays on the generic request-task path.
 */
export function createTeamExecStage(options: TeamExecStageOptions = {}): PipelineStage {
  const workerCount = options.workerCount ?? 2;
  const agentType = options.agentType ?? 'executor';

  return {
    name: 'team-exec',

    async run(ctx: StageContext): Promise<StageResult> {
      const startTime = Date.now();

      try {
        const ralplanArtifacts = typeof ctx.artifacts['ralplan'] === 'object' && ctx.artifacts['ralplan'] !== null
          ? ctx.artifacts['ralplan'] as Record<string, unknown>
          : undefined;
        const launch = resolveTeamExecLaunch(ctx, ralplanArtifacts);
        const task = launch.task;
        const availableAgentTypes = await resolveAvailableAgentTypes(ctx.cwd);
        const staffingPlan = buildFollowupStaffingPlan('team', task, availableAgentTypes, {
          workerCount,
          fallbackRole: agentType,
        });

        // Build team execution descriptor
        const teamDescriptor: TeamExecDescriptor = {
          task,
          workerCount,
          agentType,
          availableAgentTypes,
          staffingPlan,
          useWorktrees: options.useWorktrees ?? false,
          cwd: ctx.cwd,
          extraEnv: options.extraEnv,
          approvedExecution: launch.approvedExecution,
        };

        return {
          status: 'completed',
          artifacts: {
            teamDescriptor,
            workerCount,
            agentType,
            availableAgentTypes,
            staffingPlan,
            stage: 'team-exec',
            instruction: buildTeamInstruction(teamDescriptor),
          },
          duration_ms: Date.now() - startTime,
        };
      } catch (err) {
        return {
          status: 'failed',
          artifacts: {},
          duration_ms: Date.now() - startTime,
          error: `Team execution stage failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Team execution descriptor
// ---------------------------------------------------------------------------

/**
 * Descriptor for a team execution run, consumed by the team runtime.
 */
export interface TeamExecDescriptor {
  task: string;
  workerCount: number;
  agentType: string;
  availableAgentTypes: string[];
  staffingPlan: ReturnType<typeof buildFollowupStaffingPlan>;
  useWorktrees: boolean;
  cwd: string;
  approvedExecution: ApprovedTeamExecutionBinding | null;
  extraEnv?: Record<string, string>;
}

/**
 * Build the `omx team` CLI instruction from a descriptor.
 */
export function buildTeamInstruction(
  descriptor: TeamExecDescriptor,
  options: BuildTeamInstructionOptions = {},
): string {
  const runtimeCliInput = buildTeamRuntimeCliLaunchInput(descriptor);
  const runtimeCliPath = join(packageRoot(), 'dist', 'team', 'runtime-cli.js');
  const platform = options.platform ?? process.platform;
  const encodedInput = Buffer.from(JSON.stringify(runtimeCliInput), 'utf-8').toString('base64url');
  const launchCommand = `${quoteShellArg(process.execPath, platform)} ${quoteShellArg(runtimeCliPath, platform)} --input-json-base64 ${encodedInput}`;
  if (platform === 'win32') {
    return launchCommand;
  }
  return `${launchCommand} # task=${JSON.stringify(descriptor.task)} # staffing=${descriptor.staffingPlan.staffingSummary} # verify=${descriptor.staffingPlan.verificationPlan.summary}`;
}
