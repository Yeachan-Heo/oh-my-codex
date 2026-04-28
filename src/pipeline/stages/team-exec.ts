/**
 * Team execution stage adapter for pipeline orchestrator.
 *
 * Wraps the existing team mode (tmux-based Codex CLI workers) into a
 * PipelineStage. The execution backend is always teams — this is the
 * canonical OMX execution surface.
 */

import { join } from 'node:path';
import type { PipelineStage, StageContext, StageResult } from '../types.js';
import { buildTeamExecutionPlan, deriveTeamNameFromTask } from '../../cli/team.js';
import {
  buildFollowupStaffingPlan,
  resolveAvailableAgentTypes,
} from '../../team/followup-planner.js';
import { buildApprovedTeamExecutionBinding, type ApprovedTeamExecutionBinding } from '../../team/approved-execution.js';
import {
  isApprovedExecutionContextReadyStatus,
  isApprovedExecutionFollowupReadyStatus,
  readApprovedExecutionLaunchHintOutcome,
} from '../../planning/artifacts.js';
import { packageRoot } from '../../utils/paths.js';

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

function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function quoteWindowsCmdArg(value: string): string {
  return `"${value.replaceAll('%', '%%').replaceAll('"', '""')}"`;
}

function quoteShellArg(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? quoteWindowsCmdArg(value) : quotePosixShellArg(value);
}

function resolveApprovedExecutionForTeamExec(
  cwd: string,
  requestedTask: string,
  planningArtifacts?: Record<string, unknown>,
): { task: string; approvedExecution: ApprovedTeamExecutionBinding | null } {
  if (!planningArtifacts) {
    return { task: requestedTask, approvedExecution: null };
  }
  const latestPlanPath = typeof planningArtifacts.latestPlanPath === 'string' && planningArtifacts.latestPlanPath.trim() !== ''
    ? planningArtifacts.latestPlanPath
    : undefined;
  if (!latestPlanPath) {
    return { task: requestedTask, approvedExecution: null };
  }

  const approvedHintOutcome = readApprovedExecutionLaunchHintOutcome(cwd, 'team', {
    prdPath: latestPlanPath,
  });
  if (approvedHintOutcome.status === 'absent') {
    throw new Error(`team_exec_approved_handoff_missing:${latestPlanPath}`);
  }
  if (approvedHintOutcome.status === 'ambiguous') {
    throw new Error(`team_exec_approved_handoff_ambiguous:${latestPlanPath}`);
  }
  const approvedHint = approvedHintOutcome.hint;
  if (isApprovedExecutionContextReadyStatus(approvedHint.contextPackStatus)) {
    return {
      task: approvedHint.task,
      approvedExecution: buildApprovedTeamExecutionBinding(approvedHint),
    };
  }
  if (isApprovedExecutionFollowupReadyStatus(approvedHint.contextPackStatus)) {
    return { task: approvedHint.task, approvedExecution: null };
  }
  if (!isApprovedExecutionFollowupReadyStatus(approvedHint.contextPackStatus)) {
    throw new Error(`team_exec_approved_handoff_not_ready:${approvedHint.contextPackStatus}:${approvedHint.sourcePath}`);
  }
  return { task: approvedHint.task, approvedExecution: null };
}

/**
 * Create a team-exec pipeline stage.
 *
 * This stage delegates to the existing `omx team` infrastructure, which
 * starts real Codex CLI workers in tmux panes. The execution task remains
 * the approved task text; upstream planning artifacts ride alongside it as
 * descriptor metadata rather than being injected into the runnable command.
 */
export function createTeamExecStage(options: TeamExecStageOptions = {}): PipelineStage {
  const workerCount = options.workerCount ?? 2;
  const agentType = options.agentType ?? 'executor';

  return {
    name: 'team-exec',

    async run(ctx: StageContext): Promise<StageResult> {
      const startTime = Date.now();

      try {
        const ralplanArtifacts = ctx.artifacts['ralplan'] as Record<string, unknown> | undefined;
        const requestedTask = typeof ralplanArtifacts?.task === 'string' && ralplanArtifacts.task.trim() !== ''
          ? ralplanArtifacts.task
          : ctx.task;
        const approvedLaunch = resolveApprovedExecutionForTeamExec(ctx.cwd, requestedTask, ralplanArtifacts);
        const approvedTask = approvedLaunch.task;
        const executionPlan = buildTeamExecutionPlan(approvedTask, workerCount, agentType, true, true);
        const availableAgentTypes = await resolveAvailableAgentTypes(ctx.cwd);
        const staffingPlan = buildFollowupStaffingPlan('team', approvedTask, availableAgentTypes, {
          workerCount,
          fallbackRole: agentType,
        });

        // Build team execution descriptor
        const teamDescriptor: TeamExecDescriptor = {
          teamName: deriveTeamNameFromTask(approvedTask),
          task: approvedTask,
          tasks: executionPlan.tasks,
          workerCount,
          agentType,
          availableAgentTypes,
          staffingPlan,
          useWorktrees: options.useWorktrees ?? false,
          cwd: ctx.cwd,
          extraEnv: options.extraEnv,
          approvedExecution: approvedLaunch.approvedExecution,
          planningArtifacts: ralplanArtifacts,
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
  teamName: string;
  task: string;
  tasks: Array<{ subject: string; description: string; owner: string; role?: string }>;
  workerCount: number;
  agentType: string;
  availableAgentTypes: string[];
  staffingPlan: ReturnType<typeof buildFollowupStaffingPlan>;
  useWorktrees: boolean;
  cwd: string;
  extraEnv?: Record<string, string>;
  approvedExecution: ApprovedTeamExecutionBinding | null;
  planningArtifacts?: Record<string, unknown>;
}

interface TeamRuntimeCliTaskInput {
  subject: string;
  description: string;
  owner: string;
  role?: string;
}

interface TeamRuntimeCliLaunchInput {
  teamName: string;
  task: string;
  workerCount: number;
  agentType: string;
  tasks: TeamRuntimeCliTaskInput[];
  cwd: string;
  approvedExecution: ApprovedTeamExecutionBinding | null;
  useWorktrees: boolean;
}

interface BuildTeamInstructionOptions {
  platform?: NodeJS.Platform;
}

function buildTeamRuntimeCliLaunchInput(descriptor: TeamExecDescriptor): TeamRuntimeCliLaunchInput {
  return {
    teamName: descriptor.teamName,
    task: descriptor.task,
    workerCount: descriptor.workerCount,
    agentType: descriptor.agentType,
    tasks: descriptor.tasks.map(({ subject, description, owner, role }) => ({
      subject,
      description,
      owner,
      ...(role ? { role } : {}),
    })),
    cwd: descriptor.cwd,
    approvedExecution: descriptor.approvedExecution,
    useWorktrees: descriptor.useWorktrees,
  };
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
  return `${launchCommand} # staffing=${descriptor.staffingPlan.staffingSummary} # verify=${descriptor.staffingPlan.verificationPlan.summary}`;
}
