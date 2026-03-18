import { join, resolve, dirname } from 'path';
import { existsSync, appendFileSync, mkdirSync } from 'fs';
import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import { performance } from 'perf_hooks';
import { spawn, spawnSync, type ChildProcessByStdio } from 'child_process';
import type { Writable } from 'stream';
import {
  sanitizeTeamName,
  isTmuxAvailable,
  createTeamSession,
  buildWorkerProcessLaunchSpec,
  resolveTeamWorkerCli,
  type TeamWorkerCli,
  resolveTeamWorkerCliPlan,
  resolveTeamWorkerLaunchMode,
  waitForWorkerReady,
  dismissTrustPromptIfPresent,
  sleepFractionalSeconds,
  sendToWorker,
  sendToLeaderPane,
  sendToWorkerStdin,
  isWorkerAlive,
  getWorkerPanePid,
  killWorkerByPaneIdAsync,
  restoreStandaloneHudPane,
  teardownWorkerPanes,
  unregisterResizeHook,
  destroyTeamSession,
  listTeamSessions,
} from './tmux-session.js';
import {
  teamInit as initTeamState,
  DEFAULT_MAX_WORKERS,
  teamReadConfig as readTeamConfig,
  teamWriteWorkerIdentity as writeWorkerIdentity,
  teamReadWorkerHeartbeat as readWorkerHeartbeat,
  teamReadWorkerStatus as readWorkerStatus,
  teamWriteWorkerInbox as writeWorkerInbox,
  teamCreateTask as createStateTask,
  teamReadTask as readTask,
  teamListTasks as listTasks,
  teamReadManifest as readTeamManifestV2,
  teamNormalizeGovernance as normalizeTeamGovernance,
  teamNormalizePolicy as normalizeTeamPolicy,
  teamClaimTask as claimTask,
  teamReleaseTaskClaim as releaseTaskClaim,
  teamReclaimExpiredTaskClaim as reclaimExpiredTaskClaim,
  teamAppendEvent as appendTeamEvent,
  teamReadTaskApproval as readTaskApproval,
  teamListMailbox as listMailboxMessages,
  teamMarkMessageDelivered as markMessageDelivered,
  teamMarkMessageNotified as markMessageNotified,
  teamEnqueueDispatchRequest as enqueueDispatchRequest,
  teamMarkDispatchRequestNotified as markDispatchRequestNotified,
  teamTransitionDispatchRequest as transitionDispatchRequest,
  teamReadDispatchRequest as readDispatchRequest,
  teamCleanup as cleanupTeamState,
  teamSaveConfig as saveTeamConfig,
  teamWriteShutdownRequest as writeShutdownRequest,
  teamReadShutdownAck as readShutdownAck,
  teamReadMonitorSnapshot as readMonitorSnapshot,
  teamWriteMonitorSnapshot as writeMonitorSnapshot,
  teamReadPhase as readTeamPhaseState,
  teamWritePhase as writeTeamPhaseState,
  type TeamConfig,
  type WorkerInfo,
  type WorkerHeartbeat,
  type WorkerStatus,
  type TeamTask,
  type TeamManifestV2,
  type TeamMonitorSnapshotState,
  type TeamPhaseState,
  type TeamWorkerIntegrationState,
  type TeamGovernance,
  type TeamPolicy,
} from './team-ops.js';
import {
  queueInboxInstruction,
  queueDirectMailboxMessage,
  queueBroadcastMailboxMessage,
  waitForDispatchReceipt,
  type DispatchOutcome,
} from './mcp-comm.js';
import {
  generateWorkerOverlay,
  writeTeamWorkerInstructionsFile,
  removeTeamWorkerInstructionsFile,
  generateInitialInbox,
  generateTaskAssignmentInbox,
  generateShutdownInbox,
  generateTriggerMessage,
  generateMailboxTriggerMessage,
  generateLeaderMailboxTriggerMessage,
  writeWorkerRoleInstructionsFile,
} from './worker-bootstrap.js';
import { loadRolePrompt } from './role-router.js';
import { codexPromptsDir } from '../utils/paths.js';
import { type TeamPhase, type TerminalPhase } from './orchestrator.js';
import {
  isLowComplexityAgentType,
  resolveTeamWorkerLaunchArgs,
  TEAM_LOW_COMPLEXITY_DEFAULT_MODEL,
  resolveTeamLowComplexityDefaultModel,
  parseTeamWorkerLaunchArgs,
  splitWorkerLaunchArgs,
  resolveAgentReasoningEffort,
  type TeamReasoningEffort,
} from './model-contract.js';
import { resolveCanonicalTeamStateRoot } from './state-root.js';
import { inferPhaseTargetFromTaskCounts, reconcilePhaseStateForMonitor } from './phase-controller.js';
import { getTeamTmuxSessions } from '../notifications/tmux.js';
import { hasStructuredVerificationEvidence } from '../verification/verifier.js';
import { buildRebalanceDecisions } from './rebalance-policy.js';
import { readModeState, updateModeState } from '../modes/base.js';
import {
  assertCleanLeaderWorkspaceForWorkerWorktrees,
  ensureWorktree,
  isGitRepository,
  planWorktreeTarget,
  rollbackProvisionedWorktrees,
  type EnsureWorktreeResult,
  type WorktreeMode,
} from './worktree.js';

/** Snapshot of the team state at a point in time */
export interface TeamSnapshot {
  teamName: string;
  phase: TeamPhase | TerminalPhase;
  workers: Array<{
    name: string;
    alive: boolean;
    status: WorkerStatus;
    heartbeat: WorkerHeartbeat | null;
    assignedTasks: string[];
    turnsWithoutProgress: number;
  }>;
  tasks: {
    total: number;
    pending: number;
    blocked: number;
    in_progress: number;
    completed: number;
    failed: number;
    items: TeamTask[];
  };
  allTasksTerminal: boolean;
  deadWorkers: string[];
  nonReportingWorkers: string[];
  recommendations: string[];
  performance?: {
    list_tasks_ms: number;
    worker_scan_ms: number;
    mailbox_delivery_ms: number;
    total_ms: number;
    updated_at: string;
  };
}

async function syncRootTeamModeStateOnTerminalPhase(
  teamName: string,
  phase: TeamPhase | TerminalPhase,
  cwd: string,
): Promise<void> {
  if (phase !== 'complete' && phase !== 'failed' && phase !== 'cancelled') return;

  try {
    const teamState = await readModeState('team', cwd);
    if (!teamState) return;

    const stateTeamName = typeof teamState.team_name === 'string' ? teamState.team_name.trim() : '';
    if (stateTeamName && stateTeamName !== teamName) return;

    const alreadySynced = teamState.active === false
      && teamState.current_phase === phase
      && typeof teamState.completed_at === 'string'
      && teamState.completed_at.length > 0;
    if (alreadySynced) return;

    const updates: Record<string, unknown> = {
      active: false,
      current_phase: phase,
      team_name: teamName,
    };
    if (typeof teamState.completed_at !== 'string' || !teamState.completed_at) {
      updates.completed_at = new Date().toISOString();
    }

    await updateModeState('team', updates, cwd);
  } catch {
    // Best-effort compatibility sync only.
  }
}

async function syncLinkedRalphModeStateOnTerminalPhase(
  teamName: string,
  phase: TeamPhase | TerminalPhase,
  cwd: string,
  nowIso: string = new Date().toISOString(),
): Promise<void> {
  if (phase !== 'complete' && phase !== 'failed' && phase !== 'cancelled') return;

  try {
    const [teamState, ralphState] = await Promise.all([
      readModeState('team', cwd),
      readModeState('ralph', cwd),
    ]);
    if (!teamState || !ralphState) return;

    const stateTeamName = typeof teamState.team_name === 'string' ? teamState.team_name.trim() : '';
    if (stateTeamName && stateTeamName !== teamName) return;
    if (teamState.linked_ralph !== true || ralphState.linked_team !== true) return;

    const terminalAt = typeof teamState.completed_at === 'string' && teamState.completed_at
      ? teamState.completed_at
      : nowIso;
    const alreadySynced = ralphState.active === false
      && ralphState.current_phase === phase
      && ralphState.linked_team_terminal_phase === phase
      && ralphState.linked_team_terminal_at === terminalAt
      && ralphState.completed_at === terminalAt;
    if (alreadySynced) return;

    await updateModeState('ralph', {
      active: false,
      current_phase: phase,
      linked_mode: 'team',
      linked_team: true,
      linked_team_terminal_phase: phase,
      linked_team_terminal_at: terminalAt,
      completed_at: terminalAt,
      last_turn_at: nowIso,
    }, cwd);
  } catch {
    // Best-effort compatibility sync only.
  }
}

/** Runtime handle returned by startTeam */
export interface TeamRuntime {
  teamName: string;
  sanitizedName: string;
  sessionName: string;
  config: TeamConfig;
  cwd: string;
}

interface ShutdownOptions {
  force?: boolean;
  /** When true, applies ralph-specific cleanup policy: no force-kill on failure, detailed audit logging. */
  ralph?: boolean;
}

function resolveLifecycleProfile(
  config: Pick<TeamConfig, 'lifecycle_profile'> | null | undefined,
  manifest: Pick<TeamManifestV2, 'lifecycle_profile'> | null | undefined,
): 'default' | 'linked_ralph' {
  if (manifest?.lifecycle_profile === 'linked_ralph') return 'linked_ralph';
  if (config?.lifecycle_profile === 'linked_ralph') return 'linked_ralph';
  return 'default';
}

function collectProvisionedShutdownWorktrees(config: TeamConfig): EnsureWorktreeResult[] {
  const seenWorktreePaths = new Set<string>();
  const worktrees: EnsureWorktreeResult[] = [];

  for (const worker of config.workers) {
    if (worker.worktree_created !== true) continue;
    if (worker.worktree_detached !== true) continue;
    if (!worker.worktree_repo_root || !worker.worktree_path) continue;
    if (!existsSync(worker.worktree_path)) continue;

    const worktreePath = resolve(worker.worktree_path);
    if (seenWorktreePaths.has(worktreePath)) continue;
    seenWorktreePaths.add(worktreePath);

    worktrees.push({
      enabled: true,
      repoRoot: worker.worktree_repo_root,
      worktreePath,
      detached: true,
      branchName: null,
      created: true,
      reused: false,
      createdBranch: false,
    });
  }

  return worktrees;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface WorkerShutdownMergeReport {
  workerName: string;
  worktreePath: string;
  reportPath: string;
  sourceRef: string | null;
  syntheticCommit: string | null;
  diffText: string;
  summaryText: string | null;
  mergeOutcome: 'merged' | 'conflict' | 'noop' | 'skipped';
  mergeDetail: string;
}

function runCommand(command: string, args: string[], cwd: string): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf-8',
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    exitCode: result.status,
  };
}

function runGitCommand(repoRoot: string, args: string[], cwd: string = repoRoot): CommandResult {
  return runCommand('git', args, cwd);
}

function getWorktreeDiffText(worktreePath: string): string {
  const staged = runGitCommand(worktreePath, ['diff', '--cached', '--stat', '--patch'], worktreePath);
  if (staged.ok && staged.stdout) return staged.stdout;

  const unstaged = runGitCommand(worktreePath, ['diff', '--stat', '--patch'], worktreePath);
  if (unstaged.ok && unstaged.stdout) return unstaged.stdout;

  const againstHead = runGitCommand(worktreePath, ['diff', 'HEAD', '--stat', '--patch'], worktreePath);
  if (againstHead.ok && againstHead.stdout) return againstHead.stdout;

  return '';
}

function summarizeWorktreeDiffWithSparkShell(worktreePath: string): string | null {
  const shellCommand = `git diff --cached --stat --patch || git diff --stat --patch || git diff HEAD --stat --patch`;
  const result = runCommand('omx', ['sparkshell', 'sh', '-lc', shellCommand], worktreePath);
  if (!result.ok || !result.stdout) return null;
  return result.stdout;
}

function resolveWorkerHead(worktreePath: string): string | null {
  const head = runGitCommand(worktreePath, ['rev-parse', 'HEAD'], worktreePath);
  return head.ok && head.stdout ? head.stdout : null;
}

function resolveLeaderHead(repoRoot: string, leaderCwd: string): string | null {
  const head = runGitCommand(repoRoot, ['rev-parse', 'HEAD'], leaderCwd);
  return head.ok && head.stdout ? head.stdout : null;
}

function listCommitRange(repoRoot: string, baseRef: string, headRef: string, cwd: string): string[] {
  if (!baseRef || !headRef || baseRef === headRef) return [];
  const range = runGitCommand(repoRoot, ['rev-list', '--reverse', `${baseRef}..${headRef}`], cwd);
  if (!range.ok || !range.stdout) return [];
  return range.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

function listConflictFiles(repoRoot: string, cwd: string): string[] {
  const result = runGitCommand(repoRoot, ['diff', '--name-only', '--diff-filter=U'], cwd);
  if (!result.ok || !result.stdout) return [];
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

async function appendIntegrationEvent(
  teamName: string,
  type: 'worker_cherry_pick_detected' | 'worker_cherry_pick_applied' | 'worker_cherry_pick_conflict' | 'worker_rebase_applied' | 'worker_rebase_conflict' | 'worker_auto_commit' | 'worker_merge_applied' | 'worker_merge_conflict' | 'worker_cross_rebase_applied' | 'worker_cross_rebase_conflict' | 'worker_cross_rebase_skipped',
  worker: WorkerInfo,
  metadata: Record<string, unknown>,
  cwd: string,
): Promise<void> {
  await appendTeamEvent(teamName, {
    type,
    worker: worker.name,
    task_id: worker.assigned_tasks[0],
    reason: typeof metadata.summary === 'string' ? metadata.summary : undefined,
    metadata,
  }, cwd);
}

async function sendIntegrationMessageToLeader(
  teamName: string,
  worker: WorkerInfo,
  body: string,
  cwd: string,
): Promise<void> {
  await sendWorkerMessage(teamName, worker.name, 'leader-fixed', body, cwd).catch(() => {});
}

function autoCommitDirtyWorktree(
  worker: WorkerInfo,
): { committed: boolean; commitHash: string | null } {
  const worktreePath = resolve(worker.worktree_path!);
  const repoRoot = resolve(worker.worktree_repo_root!);
  const status = runGitCommand(repoRoot, ['status', '--porcelain'], worktreePath);
  if (!status.ok || !status.stdout.trim()) return { committed: false, commitHash: null };

  const taskId = worker.assigned_tasks[0] || 'unknown';
  const addResult = runGitCommand(repoRoot, ['add', '-A'], worktreePath);
  if (!addResult.ok) return { committed: false, commitHash: null };

  const msg = `omx(team): auto-checkpoint ${worker.name} [${taskId}]`;
  const commitResult = runGitCommand(repoRoot, ['commit', '--no-verify', '-m', msg], worktreePath);
  if (!commitResult.ok) return { committed: false, commitHash: null };

  const head = runGitCommand(repoRoot, ['rev-parse', 'HEAD'], worktreePath);
  return { committed: true, commitHash: head.ok ? head.stdout : null };
}

function appendIntegrationReport(
  teamName: string,
  entry: {
    workerName: string;
    operation: 'merge' | 'cherry-pick' | 'rebase';
    strategy: '-X theirs' | '-X ours';
    files: string[];
    detail: string;
  },
  cwd: string,
): void {
  const teamStateRoot = resolveCanonicalTeamStateRoot(cwd);
  const reportPath = join(teamStateRoot, 'team', teamName, 'integration-report.md');
  const dir = dirname(reportPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString();
  const line = `- [${timestamp}] ${entry.workerName}: ${entry.operation} conflict auto-resolved (${entry.strategy}) on files: ${entry.files.join(', ') || 'unknown'}. ${entry.detail}\n`;

  appendFileSync(reportPath, existsSync(reportPath) ? line : `# Integration Report\n\n${line}`);
}

async function integrateWorkerCommitsIntoLeader(params: {
  teamName: string;
  config: TeamConfig;
  previous: TeamMonitorSnapshotState | null;
  cwd: string;
}): Promise<Record<string, TeamWorkerIntegrationState>> {
  const { teamName, config, previous, cwd } = params;
  const next: Record<string, TeamWorkerIntegrationState> = { ...(previous?.integrationByWorker ?? {}) };
  const leaderHeadAtCycleStart = resolveLeaderHead(resolve(config.workers[0]?.worktree_repo_root ?? cwd), cwd);
  const integratedWorkerNames = new Set<string>();

  // ── Phase A: Auto-commit dirty worktrees ──
  for (const worker of config.workers) {
    if (!worker.worktree_repo_root || !worker.worktree_path || !existsSync(worker.worktree_path)) continue;
    const { committed, commitHash } = autoCommitDirtyWorktree(worker);
    if (committed) {
      await appendIntegrationEvent(teamName, 'worker_auto_commit', worker, {
        worker_name: worker.name,
        commit_hash: commitHash,
        worktree_path: resolve(worker.worktree_path),
        summary: `auto-committed dirty worktree for ${worker.name}`,
      }, cwd);
    }
  }

  // ── Phase B: Integrate worker commits to leader (hybrid strategy) ──
  for (const worker of config.workers) {
    if (!worker.worktree_repo_root || !worker.worktree_path || !existsSync(worker.worktree_path)) continue;
    const repoRoot = resolve(worker.worktree_repo_root);
    const worktreePath = resolve(worker.worktree_path);
    const leaderHead = resolveLeaderHead(repoRoot, cwd);
    const workerHead = resolveWorkerHead(worktreePath);
    const previousState = next[worker.name] ?? {};
    const state: TeamWorkerIntegrationState = { ...previousState, last_leader_head: leaderHead ?? previousState.last_leader_head };
    if (!workerHead || !leaderHead) {
      next[worker.name] = state;
      continue;
    }

    state.last_seen_head = workerHead;
    const alreadyMerged = runGitCommand(repoRoot, ['merge-base', '--is-ancestor', workerHead, 'HEAD'], cwd).ok;
    if (alreadyMerged) {
      state.last_integrated_head = workerHead;
      state.status = 'idle';
      state.updated_at = new Date().toISOString();
      next[worker.name] = state;
      continue;
    }

    // Determine if worker is cleanly ahead of leader (merge) or diverged (cherry-pick)
    const workerIsAheadOfLeader = runGitCommand(repoRoot, ['merge-base', '--is-ancestor', leaderHead, workerHead], cwd).ok;

    if (workerIsAheadOfLeader) {
      // Worker is cleanly ahead → merge --no-ff -X theirs
      const workerBranch = runGitCommand(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
      const branchRef = workerBranch.ok && workerBranch.stdout ? workerBranch.stdout : workerHead;
      const merge = runGitCommand(repoRoot, ['merge', '--no-ff', '-X', 'theirs', '-m', `omx(team): merge ${worker.name}`, branchRef], cwd);

      if (merge.ok) {
        const newLeaderHead = resolveLeaderHead(repoRoot, cwd) ?? leaderHead;
        state.last_integrated_head = workerHead;
        state.last_leader_head = newLeaderHead;
        state.status = 'integrated';
        state.conflict_commit = undefined;
        state.conflict_files = undefined;
        state.updated_at = new Date().toISOString();
        integratedWorkerNames.add(worker.name);
        await appendIntegrationEvent(teamName, 'worker_merge_applied', worker, {
          worker_name: worker.name,
          worker_head: workerHead,
          leader_head_before: leaderHead,
          leader_head_after: newLeaderHead,
          worktree_path: worktreePath,
          summary: `merged ${worker.name} into leader via --no-ff -X theirs`,
        }, cwd);
        await sendIntegrationMessageToLeader(teamName, worker, `INTEGRATED: merged ${worker.name} (${workerHead.slice(0, 12)}) into leader HEAD ${newLeaderHead.slice(0, 12)} via merge --no-ff.`, cwd);
      } else {
        // Merge failed even with -X theirs (e.g. binary conflict) — abort and log
        const conflictFiles = listConflictFiles(repoRoot, cwd);
        runGitCommand(repoRoot, ['merge', '--abort'], cwd);
        state.status = 'cherry_pick_conflict';
        state.conflict_commit = workerHead;
        state.conflict_files = conflictFiles;
        state.updated_at = new Date().toISOString();
        await appendIntegrationEvent(teamName, 'worker_merge_conflict', worker, {
          worker_name: worker.name,
          worker_head: workerHead,
          leader_head: leaderHead,
          worktree_path: worktreePath,
          conflict_files: conflictFiles,
          stderr: merge.stderr || merge.stdout,
          summary: `merge conflict for ${worker.name} (auto-resolve failed)`,
        }, cwd);
        appendIntegrationReport(teamName, {
          workerName: worker.name,
          operation: 'merge',
          strategy: '-X theirs',
          files: conflictFiles,
          detail: `merge --no-ff -X theirs failed; aborted. stderr: ${(merge.stderr || '').slice(0, 200)}`,
        }, cwd);
        await sendIntegrationMessageToLeader(teamName, worker, `CONFLICT AUTO-RESOLVED FAILED: ${worker.name}'s merge resolved with -X theirs failed on files: ${conflictFiles.join(', ') || 'unknown'}. Consider steering ${worker.name} to review these areas.`, cwd);
      }
    } else {
      // Diverged → cherry-pick individual commits with -X theirs
      const baseline = state.last_integrated_head && runGitCommand(repoRoot, ['rev-parse', '--verify', state.last_integrated_head], worktreePath).ok
        ? state.last_integrated_head
        : leaderHead;
      const commits = listCommitRange(repoRoot, baseline, workerHead, worktreePath);
      if (commits.length === 0) {
        next[worker.name] = state;
        continue;
      }

      let allPicked = true;
      for (const commit of commits) {
        await appendIntegrationEvent(teamName, 'worker_cherry_pick_detected', worker, {
          worker_name: worker.name,
          worker_head: workerHead,
          commit,
          leader_head: resolveLeaderHead(repoRoot, cwd),
          worktree_path: worktreePath,
          summary: `detected worker commit ${commit.slice(0, 12)}`,
        }, cwd);

        const pick = runGitCommand(repoRoot, ['cherry-pick', '--allow-empty', '-X', 'theirs', commit], cwd);
        if (!pick.ok) {
          // Even -X theirs failed (binary conflict etc.) — abort this commit, log, continue
          const conflictFiles = listConflictFiles(repoRoot, cwd);
          runGitCommand(repoRoot, ['cherry-pick', '--abort'], cwd);
          state.status = 'cherry_pick_conflict';
          state.conflict_commit = commit;
          state.conflict_files = conflictFiles;
          state.updated_at = new Date().toISOString();
          await appendIntegrationEvent(teamName, 'worker_cherry_pick_conflict', worker, {
            worker_name: worker.name,
            commit,
            leader_head: leaderHead,
            worktree_path: worktreePath,
            conflict_files: conflictFiles,
            stderr: pick.stderr || pick.stdout,
            summary: `cherry-pick conflict for ${worker.name} at ${commit.slice(0, 12)} (auto-resolve failed)`,
          }, cwd);
          appendIntegrationReport(teamName, {
            workerName: worker.name,
            operation: 'cherry-pick',
            strategy: '-X theirs',
            files: conflictFiles,
            detail: `cherry-pick -X theirs ${commit.slice(0, 12)} failed; aborted. stderr: ${(pick.stderr || '').slice(0, 200)}`,
          }, cwd);
          await sendIntegrationMessageToLeader(teamName, worker, `CONFLICT AUTO-RESOLVED FAILED: ${worker.name}'s cherry-pick ${commit.slice(0, 12)} with -X theirs failed on files: ${conflictFiles.join(', ') || 'unknown'}. Consider steering ${worker.name} to review these areas.`, cwd);
          allPicked = false;
          break;
        }

        const newLeaderHead = resolveLeaderHead(repoRoot, cwd) ?? leaderHead;
        state.last_integrated_head = commit;
        state.last_leader_head = newLeaderHead;
        state.status = 'integrated';
        state.conflict_commit = undefined;
        state.conflict_files = undefined;
        state.updated_at = new Date().toISOString();
        await appendIntegrationEvent(teamName, 'worker_cherry_pick_applied', worker, {
          worker_name: worker.name,
          commit,
          leader_head_before: leaderHead,
          leader_head_after: newLeaderHead,
          worktree_path: worktreePath,
          summary: `cherry-picked ${commit.slice(0, 12)} from ${worker.name} with -X theirs`,
        }, cwd);
        await sendIntegrationMessageToLeader(teamName, worker, `INTEGRATED: cherry-picked ${commit.slice(0, 12)} from ${worker.name} into leader HEAD ${newLeaderHead.slice(0, 12)} (-X theirs).`, cwd);
      }

      if (allPicked) {
        integratedWorkerNames.add(worker.name);
      }
    }

    next[worker.name] = state;
  }

  // ── Phase C: Cross-worker rebase (idle/done/failed workers onto new leader) ──
  const newLeaderHead = resolveLeaderHead(resolve(config.workers[0]?.worktree_repo_root ?? cwd), cwd);
  if (newLeaderHead && leaderHeadAtCycleStart && newLeaderHead !== leaderHeadAtCycleStart) {
    for (const worker of config.workers) {
      if (!worker.worktree_repo_root || !worker.worktree_path || !existsSync(worker.worktree_path)) continue;
      // Note: do NOT skip integratedWorkerNames here — cherry-picked workers need
      // rebase to pick up other workers' changes that landed on leader in the same cycle.

      const repoRoot = resolve(worker.worktree_repo_root);
      const worktreePath = resolve(worker.worktree_path);

      // Only rebase idle/done/failed workers to avoid race conditions
      const workerStatus = await readWorkerStatus(teamName, worker.name, cwd);
      const rebaseEligibleStates = new Set(['idle', 'done', 'failed']);
      if (!rebaseEligibleStates.has(workerStatus.state)) {
        await appendIntegrationEvent(teamName, 'worker_cross_rebase_skipped', worker, {
          worker_name: worker.name,
          worker_state: workerStatus.state,
          leader_head: newLeaderHead,
          worktree_path: worktreePath,
          summary: `skipped cross-rebase for ${worker.name} (state: ${workerStatus.state})`,
        }, cwd);
        continue;
      }

      // Skip if worktree is dirty (will auto-commit next cycle, then rebase)
      const statusCheck = runGitCommand(repoRoot, ['status', '--porcelain'], worktreePath);
      if (statusCheck.ok && statusCheck.stdout.trim()) {
        await appendIntegrationEvent(teamName, 'worker_cross_rebase_skipped', worker, {
          worker_name: worker.name,
          reason: 'dirty_worktree',
          leader_head: newLeaderHead,
          worktree_path: worktreePath,
          summary: `skipped cross-rebase for ${worker.name} (dirty worktree)`,
        }, cwd);
        continue;
      }

      // Rebase with -X ours (in rebase context, "ours" = upstream = leader wins)
      const rebase = runGitCommand(repoRoot, ['rebase', '-X', 'ours', newLeaderHead], worktreePath);
      if (rebase.ok) {
        const state = next[worker.name] ?? {};
        state.last_rebased_leader_head = newLeaderHead;
        state.status = 'idle';
        state.conflict_commit = undefined;
        state.conflict_files = undefined;
        state.updated_at = new Date().toISOString();
        next[worker.name] = state;
        await appendIntegrationEvent(teamName, 'worker_cross_rebase_applied', worker, {
          worker_name: worker.name,
          leader_head: newLeaderHead,
          worktree_path: worktreePath,
          summary: `cross-rebased ${worker.name} onto ${newLeaderHead.slice(0, 12)} (-X ours)`,
        }, cwd);
      } else {
        // Rebase failed — abort to restore worktree, log for retry next cycle
        const conflictFiles = listConflictFiles(repoRoot, worktreePath);
        runGitCommand(repoRoot, ['rebase', '--abort'], worktreePath);
        await appendIntegrationEvent(teamName, 'worker_cross_rebase_conflict', worker, {
          worker_name: worker.name,
          leader_head: newLeaderHead,
          worktree_path: worktreePath,
          conflict_files: conflictFiles,
          stderr: rebase.stderr || rebase.stdout,
          summary: `cross-rebase conflict for ${worker.name} onto ${newLeaderHead.slice(0, 12)} (aborted, will retry)`,
        }, cwd);
        appendIntegrationReport(teamName, {
          workerName: worker.name,
          operation: 'rebase',
          strategy: '-X ours',
          files: conflictFiles,
          detail: `rebase -X ours onto ${newLeaderHead.slice(0, 12)} failed; aborted. Will retry next cycle.`,
        }, cwd);
        await sendIntegrationMessageToLeader(teamName, worker, `CONFLICT AUTO-RESOLVED FAILED: ${worker.name}'s rebase onto ${newLeaderHead.slice(0, 12)} with -X ours failed on files: ${conflictFiles.join(', ') || 'unknown'}. Consider steering ${worker.name} to review these areas.`, cwd);
      }
    }
  }

  return next;
}

function renderWorktreeMergeReport(report: WorkerShutdownMergeReport): string {
  const lines = [
    `# Worker ${report.workerName} shutdown report`,
    '',
    `- worktree: ${report.worktreePath}`,
    `- report_path: ${report.reportPath}`,
    `- source_ref: ${report.sourceRef ?? 'none'}`,
    `- synthetic_commit: ${report.syntheticCommit ?? 'none'}`,
    `- merge_outcome: ${report.mergeOutcome}`,
    `- merge_detail: ${report.mergeDetail}`,
    '',
    '## Summary',
    report.summaryText ?? 'sparkshell summary unavailable; using raw diff fallback.',
    '',
    '## Diff',
    report.diffText || '(no diff output)',
    '',
  ];
  return lines.join('\n');
}

async function prepareShutdownMergeReport(
  worker: WorkerInfo,
  leaderCwd: string,
): Promise<WorkerShutdownMergeReport | null> {
  if (!worker.worktree_repo_root || !worker.worktree_path || !existsSync(worker.worktree_path)) {
    return null;
  }

  const worktreePath = resolve(worker.worktree_path);
  const repoRoot = resolve(worker.worktree_repo_root);
  const statusBefore = runGitCommand(repoRoot, ['status', '--porcelain'], worktreePath);
  const hadChanges = statusBefore.ok && statusBefore.stdout.length > 0;

  let syntheticCommit: string | null = null;
  if (hadChanges) {
    const addResult = runGitCommand(repoRoot, ['add', '-A'], worktreePath);
    if (!addResult.ok) {
      return {
        workerName: worker.name,
        worktreePath,
        reportPath: join(worktreePath, '.omx', 'diff.md'),
        sourceRef: null,
        syntheticCommit: null,
        diffText: getWorktreeDiffText(worktreePath),
        summaryText: null,
        mergeOutcome: 'skipped',
        mergeDetail: addResult.stderr || 'git add -A failed',
      };
    }
    const commitResult = runGitCommand(
      repoRoot,
      ['commit', '--no-verify', '-m', `omx(team): checkpoint ${worker.name} shutdown changes`],
      worktreePath,
    );
    if (commitResult.ok) {
      const revParse = runGitCommand(repoRoot, ['rev-parse', 'HEAD'], worktreePath);
      syntheticCommit = revParse.ok && revParse.stdout ? revParse.stdout : null;
    } else if (!/nothing to commit/i.test(commitResult.stderr)) {
      return {
        workerName: worker.name,
        worktreePath,
        reportPath: join(worktreePath, '.omx', 'diff.md'),
        sourceRef: null,
        syntheticCommit: null,
        diffText: getWorktreeDiffText(worktreePath),
        summaryText: null,
        mergeOutcome: 'skipped',
        mergeDetail: commitResult.stderr || 'git commit failed',
      };
    }
  }

  const sourceRefResult = runGitCommand(repoRoot, ['rev-parse', 'HEAD'], worktreePath);
  const sourceRef = sourceRefResult.ok && sourceRefResult.stdout ? sourceRefResult.stdout : null;
  const diffText = getWorktreeDiffText(worktreePath);
  const summaryText = summarizeWorktreeDiffWithSparkShell(worktreePath);
  const reportPath = join(worktreePath, '.omx', 'diff.md');

  let mergeOutcome: WorkerShutdownMergeReport['mergeOutcome'] = 'skipped';
  let mergeDetail = 'worktree merge skipped';
  if (sourceRef) {
    const alreadyMerged = runGitCommand(repoRoot, ['merge-base', '--is-ancestor', sourceRef, 'HEAD'], leaderCwd);
    if (alreadyMerged.ok) {
      mergeOutcome = 'noop';
      mergeDetail = 'source already reachable from leader HEAD';
    } else {
      const mergeResult = runGitCommand(repoRoot, ['merge', '--no-ff', '--no-edit', sourceRef], leaderCwd);
      if (mergeResult.ok) {
        mergeOutcome = 'merged';
        mergeDetail = mergeResult.stdout || 'merged successfully';
      } else {
        mergeOutcome = 'conflict';
        mergeDetail = mergeResult.stderr || mergeResult.stdout || 'merge failed';
        runGitCommand(repoRoot, ['merge', '--abort'], leaderCwd);
      }
    }
  }

  const report: WorkerShutdownMergeReport = {
    workerName: worker.name,
    worktreePath,
    reportPath,
    sourceRef,
    syntheticCommit,
    diffText,
    summaryText,
    mergeOutcome,
    mergeDetail,
  };

  await mkdir(join(worktreePath, '.omx'), { recursive: true });
  await writeFile(reportPath, renderWorktreeMergeReport(report), 'utf-8');
  process.stdout.write(`${renderWorktreeMergeReport(report)}\n`);
  return report;
}

async function prepareWorkerWorktreeShutdownReports(config: TeamConfig, leaderCwd: string): Promise<void> {
  for (const worker of config.workers) {
    if (!worker.worktree_path || !worker.worktree_repo_root) continue;
    try {
      await prepareShutdownMergeReport(worker, leaderCwd);
    } catch (error) {
      const worktreePath = resolve(worker.worktree_path);
      const reportPath = join(worktreePath, '.omx', 'diff.md');
      const fallback = [
        `# Worker ${worker.name} shutdown report`,
        '',
        `- worktree: ${worktreePath}`,
        `- report_path: ${reportPath}`,
        '- merge_outcome: skipped',
        `- merge_detail: ${String(error)}`,
        '',
      ].join('\n');
      await mkdir(join(worktreePath, '.omx'), { recursive: true }).catch(() => {});
      await writeFile(reportPath, fallback, 'utf-8').catch(() => {});
      process.stdout.write(`${fallback}\n`);
    }
  }
}

export interface TeamStartOptions {
  worktreeMode?: WorktreeMode;
  /** When true, applies ralph-specific cleanup policy during startup rollback (skip branch deletion). */
  ralph?: boolean;
}

interface ShutdownGateCounts {
  total: number;
  pending: number;
  blocked: number;
  in_progress: number;
  completed: number;
  failed: number;
  allowed: boolean;
}

function resolveEffectiveTeamWorktreeMode(
  leaderCwd: string,
  requestedMode: WorktreeMode | undefined,
): WorktreeMode {
  if (!isGitRepository(leaderCwd)) {
    return { enabled: false };
  }

  if (requestedMode?.enabled) return requestedMode;

  try {
    const probe = planWorktreeTarget({
      cwd: leaderCwd,
      scope: 'team',
      mode: { enabled: true, detached: true, name: null },
      teamName: 'probe',
      workerName: 'worker-1',
    });
    if (probe.enabled) {
      return { enabled: true, detached: true, name: null };
    }
  } catch {
    // Non-git directories should keep legacy single-workspace behavior.
  }

  return { enabled: false };
}

const MODEL_INSTRUCTIONS_FILE_ENV = 'OMX_MODEL_INSTRUCTIONS_FILE';
const TEAM_STATE_ROOT_ENV = 'OMX_TEAM_STATE_ROOT';
const TEAM_LEADER_CWD_ENV = 'OMX_TEAM_LEADER_CWD';
const WORKTREE_TRIGGER_STATE_ROOT = '$OMX_TEAM_STATE_ROOT';
const STARTUP_EVIDENCE_TIMEOUT_MS = 2_000;
const STARTUP_EVIDENCE_POLL_MS = 100;

interface PromptWorkerHandle {
  child: ChildProcessByStdio<Writable, null, null>;
  pid: number;
}

const promptWorkerRegistry = new Map<string, Map<string, PromptWorkerHandle>>();
const previousModelInstructionsFileByTeam = new Map<string, string | undefined>();
const PROMPT_WORKER_SIGTERM_WAIT_MS = 3_000;
const PROMPT_WORKER_SIGKILL_WAIT_MS = 2_000;
const PROMPT_WORKER_EXIT_POLL_MS = 100;

function resolveInstructionStateRoot(worktreePath?: string | null): string | undefined {
  return worktreePath ? WORKTREE_TRIGGER_STATE_ROOT : undefined;
}

function resolveWorkerReadyTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OMX_TEAM_READY_TIMEOUT_MS;
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (Number.isFinite(parsed) && parsed >= 5_000) return parsed;
  return 45_000;
}

function parseTeamWorkerContext(raw: string | undefined): { teamName: string; workerName: string } | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const [teamName, workerName] = raw.trim().split('/');
  if (!teamName || !workerName) return null;
  return { teamName, workerName };
}

function resolveManifestLookupCwds(cwd: string): string[] {
  const candidates = new Set<string>([resolve(cwd)]);
  const leaderCwd = process.env[TEAM_LEADER_CWD_ENV];
  if (typeof leaderCwd === 'string' && leaderCwd.trim() !== '') {
    candidates.add(resolve(leaderCwd));
  }

  const teamStateRoot = process.env[TEAM_STATE_ROOT_ENV];
  if (typeof teamStateRoot === 'string' && teamStateRoot.trim() !== '') {
    candidates.add(resolve(teamStateRoot, '..', '..'));
  }

  return [...candidates];
}

function resolveGovernancePolicy(
  governance: TeamGovernance | null | undefined,
  legacyPolicy?: Partial<TeamGovernance> | null | undefined,
): TeamGovernance {
  return normalizeTeamGovernance(governance, legacyPolicy);
}

async function assertNestedTeamAllowed(cwd: string): Promise<void> {
  const workerContext = parseTeamWorkerContext(process.env.OMX_TEAM_WORKER);
  if (!workerContext) return;

  for (const candidateCwd of resolveManifestLookupCwds(cwd)) {
    const manifest = await readTeamManifestV2(workerContext.teamName, candidateCwd);
    const governance = resolveGovernancePolicy(manifest?.governance);
    if (governance.nested_teams_allowed) return;
    if (manifest) break;
  }

  throw new Error('nested_team_disallowed');
}

type WorkerStartupEvidence = 'task_claim' | 'worker_progress' | 'leader_ack' | 'none';

async function readWorkerStartupEvidence(
  teamName: string,
  workerName: string,
  cwd: string,
): Promise<WorkerStartupEvidence> {
  const status = await readWorkerStatus(teamName, workerName, cwd);
  if (typeof status.current_task_id === 'string' && status.current_task_id.trim() !== '') {
    return 'task_claim';
  }
  if (status.state === 'working' || status.state === 'blocked' || status.state === 'done' || status.state === 'failed') {
    return 'worker_progress';
  }
  const leaderMailbox = await listMailboxMessages(teamName, 'leader-fixed', cwd).catch(() => []);
  if (leaderMailbox.some((message) => message?.from_worker === workerName)) {
    return 'leader_ack';
  }
  return 'none';
}

function doesStartupEvidenceSettle(
  workerCli: TeamWorkerCli,
  evidence: WorkerStartupEvidence,
): boolean {
  if (evidence === 'none') return false;
  if (workerCli === 'codex' && evidence === 'leader_ack') return false;
  return true;
}

export async function waitForWorkerStartupEvidence(params: {
  teamName: string;
  workerName: string;
  workerCli: TeamWorkerCli;
  cwd: string;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<WorkerStartupEvidence> {
  const timeoutMs = Math.max(0, Math.floor(params.timeoutMs ?? STARTUP_EVIDENCE_TIMEOUT_MS));
  const pollMs = Math.max(25, Math.floor(params.pollMs ?? STARTUP_EVIDENCE_POLL_MS));
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const evidence = await readWorkerStartupEvidence(params.teamName, params.workerName, params.cwd);
    if (doesStartupEvidenceSettle(params.workerCli, evidence)) return evidence;
    if (Date.now() >= deadline) return 'none';
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export async function waitForClaudeStartupEvidence(params: {
  teamName: string;
  workerName: string;
  cwd: string;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<WorkerStartupEvidence> {
  return await waitForWorkerStartupEvidence({ ...params, workerCli: 'claude' });
}

function shouldSkipWorkerReadyWait(env: NodeJS.ProcessEnv): boolean {
  return env.OMX_TEAM_SKIP_READY_WAIT === '1';
}

function setTeamModelInstructionsFile(teamName: string, filePath: string): void {
  if (!previousModelInstructionsFileByTeam.has(teamName)) {
    previousModelInstructionsFileByTeam.set(teamName, process.env[MODEL_INSTRUCTIONS_FILE_ENV]);
  }
  process.env[MODEL_INSTRUCTIONS_FILE_ENV] = filePath;
}

function restoreTeamModelInstructionsFile(teamName: string): void {
  if (!previousModelInstructionsFileByTeam.has(teamName)) return;

  const previous = previousModelInstructionsFileByTeam.get(teamName);
  previousModelInstructionsFileByTeam.delete(teamName);

  if (typeof previous === 'string') {
    process.env[MODEL_INSTRUCTIONS_FILE_ENV] = previous;
    return;
  }
  delete process.env[MODEL_INSTRUCTIONS_FILE_ENV];
}

function registerPromptWorkerHandle(
  teamName: string,
  workerName: string,
  child: ChildProcessByStdio<Writable, null, null>,
): void {
  const { pid } = child;
  if (!Number.isFinite(pid) || (pid ?? 0) < 1) {
    throw new Error(`failed to spawn prompt worker process for ${workerName}`);
  }
  const processPid = pid as number;
  const existingTeamHandles = promptWorkerRegistry.get(teamName) ?? new Map<string, PromptWorkerHandle>();
  existingTeamHandles.set(workerName, { child, pid: processPid });
  promptWorkerRegistry.set(teamName, existingTeamHandles);

  child.on('exit', () => {
    const teamHandles = promptWorkerRegistry.get(teamName);
    if (!teamHandles) return;
    teamHandles.delete(workerName);
    if (teamHandles.size === 0) promptWorkerRegistry.delete(teamName);
  });
}

function getPromptWorkerHandle(teamName: string, workerName: string): PromptWorkerHandle | null {
  return promptWorkerRegistry.get(teamName)?.get(workerName) ?? null;
}

function removePromptWorkerHandle(teamName: string, workerName: string): void {
  const teamHandles = promptWorkerRegistry.get(teamName);
  if (!teamHandles) return;
  teamHandles.delete(workerName);
  if (teamHandles.size === 0) promptWorkerRegistry.delete(teamName);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    process.stderr.write(`[team/runtime] operation failed: ${err}\n`);
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  if (!isPidAlive(pid)) return true;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, PROMPT_WORKER_EXIT_POLL_MS));
    if (!isPidAlive(pid)) return true;
  }
  return !isPidAlive(pid);
}

interface PromptWorkerTeardownResult {
  terminated: boolean;
  forcedKill: boolean;
  pid: number | null;
  error?: string;
}

async function teardownPromptWorker(
  teamName: string,
  workerName: string,
  fallbackPid: number | undefined,
  cwd: string,
  context: 'startup_rollback' | 'shutdown',
): Promise<PromptWorkerTeardownResult> {
  const handle = getPromptWorkerHandle(teamName, workerName);
  const handlePid = handle?.pid;
  const pid = (typeof handlePid === 'number' && Number.isFinite(handlePid))
    ? handlePid
    : (Number.isFinite(fallbackPid) && (fallbackPid ?? 0) > 0 ? (fallbackPid as number) : null);

  if (pid === null) {
    removePromptWorkerHandle(teamName, workerName);
    return { terminated: true, forcedKill: false, pid: null };
  }

  try {
    if (handle && handle.child.exitCode === null && !handle.child.killed) {
      handle.child.kill('SIGTERM');
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
      process.stderr.write(`[team/runtime] operation failed: ${err}\n`);
    }
    // Best effort.
  }

  const exitedOnTerm = await waitForPidExit(pid, PROMPT_WORKER_SIGTERM_WAIT_MS);
  if (exitedOnTerm) {
    removePromptWorkerHandle(teamName, workerName);
    return { terminated: true, forcedKill: false, pid };
  }

  await appendTeamEvent(
    teamName,
    {
      type: 'worker_stopped',
      worker: workerName,
      reason: `prompt_force_kill:${context}:pid=${pid}`,
    },
    cwd,
  ).catch(() => {});

  try {
    if (handle && handle.child.exitCode === null) {
      handle.child.kill('SIGKILL');
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
      process.stderr.write(`[team/runtime] operation failed: ${err}\n`);
    }
    // Best effort.
  }

  const exitedOnKill = await waitForPidExit(pid, PROMPT_WORKER_SIGKILL_WAIT_MS);
  if (!exitedOnKill) {
    await appendTeamEvent(
      teamName,
      {
        type: 'worker_stopped',
        worker: workerName,
        reason: `prompt_teardown_failed:${context}:pid=${pid}`,
      },
      cwd,
    ).catch(() => {});
    return {
      terminated: false,
      forcedKill: true,
      pid,
      error: 'still_alive_after_sigkill',
    };
  }

  removePromptWorkerHandle(teamName, workerName);
  return { terminated: true, forcedKill: true, pid };
}

function isPromptWorkerAlive(config: TeamConfig, worker: WorkerInfo): boolean {
  const handle = getPromptWorkerHandle(config.name, worker.name);
  if (handle?.child.exitCode === null && !handle.child.killed) return true;
  return isPidAlive(worker.pid as number);
}

export { TEAM_LOW_COMPLEXITY_DEFAULT_MODEL };

export { resolveCanonicalTeamStateRoot };

function spawnPromptWorker(
  teamName: string,
  workerName: string,
  workerIndex: number,
  workerCwd: string,
  launchArgs: string[],
  workerEnv: Record<string, string>,
  workerCli: 'codex' | 'claude' | 'gemini',
  initialPrompt?: string,
): ChildProcessByStdio<Writable, null, null> {
  const processSpec = buildWorkerProcessLaunchSpec(
    teamName,
    workerIndex,
    launchArgs,
    workerCwd,
    workerEnv,
    workerCli,
    initialPrompt,
  );
  const child = spawn(
    processSpec.command,
    processSpec.args,
    {
      cwd: workerCwd,
      env: { ...process.env, ...processSpec.env },
      stdio: ['pipe', 'ignore', 'ignore'],
    },
  );
  registerPromptWorkerHandle(teamName, workerName, child);
  return child;
}

export function resolveWorkerLaunchArgsFromEnv(
  env: NodeJS.ProcessEnv,
  agentType: string,
  inheritedLeaderModel?: string,
  preferredReasoning?: TeamReasoningEffort,
  workerCliOverride?: TeamWorkerCli,
): string[] {
  const inheritedArgs = (typeof inheritedLeaderModel === 'string' && inheritedLeaderModel.trim() !== '')
    ? ['--model', inheritedLeaderModel.trim()]
    : [];
  const fallbackModel = isLowComplexityAgentType(agentType)
    ? resolveTeamLowComplexityDefaultModel(env.CODEX_HOME)
    : undefined;

  // Detect if an explicit reasoning override exists before resolving (for log source labelling)
  const preEnvArgs = splitWorkerLaunchArgs(env.OMX_TEAM_WORKER_LAUNCH_ARGS);
  const preAllArgs = [...preEnvArgs, ...inheritedArgs];
  const hasExplicitReasoning = parseTeamWorkerLaunchArgs(preAllArgs).reasoningOverride !== null;

  const resolved = resolveTeamWorkerLaunchArgs({
    existingRaw: env.OMX_TEAM_WORKER_LAUNCH_ARGS,
    inheritedArgs,
    fallbackModel,
    preferredReasoning,
  });

  // Extract resolved model and thinking level from result args for startup log
  const resolvedParsed = parseTeamWorkerLaunchArgs(resolved);
  const resolvedModel = resolvedParsed.modelOverride ?? fallbackModel ?? 'default';
  const reasoningMatch = resolvedParsed.reasoningOverride?.match(/model_reasoning_effort\s*=\s*"?(\w+)"?/);
  const thinkingLevel = reasoningMatch?.[1] ?? 'none';
  const source = hasExplicitReasoning
    ? 'explicit'
    : (preferredReasoning ? 'role-default' : 'none/default-none');
  const effectiveWorkerCli = workerCliOverride ?? resolveEffectiveWorkerCliForStartupLog(resolved, env);
  if (effectiveWorkerCli === 'claude') {
    console.log('[omx:team] worker startup resolution: model=claude source=local-settings');
  } else if (effectiveWorkerCli === 'gemini') {
    console.log('[omx:team] worker startup resolution: model=gemini source=local-settings');
  } else {
    console.log(`[omx:team] worker startup resolution: model=${resolvedModel} thinking_level=${thinkingLevel} source=${source}`);
  }

  return resolved;
}

function resolveEffectiveWorkerCliForStartupLog(
  resolvedLaunchArgs: string[],
  env: NodeJS.ProcessEnv,
): 'codex' | 'claude' | 'gemini' {
  const rawCliMap = String(env.OMX_TEAM_WORKER_CLI_MAP ?? '').trim();
  if (rawCliMap !== '') {
    const entries = rawCliMap
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0);
    if (entries.length > 0) {
      const autoCli = resolveTeamWorkerCli(resolvedLaunchArgs, {
        ...env,
        OMX_TEAM_WORKER_CLI: 'auto',
      });
      const resolvedMap = entries.map((entry): 'codex' | 'claude' | 'gemini' | null => {
        if (entry === 'auto') return autoCli;
        if (entry === 'codex' || entry === 'claude' || entry === 'gemini') return entry;
        return null;
      });
      if (resolvedMap.every((entry) => entry === 'claude')) return 'claude';
      if (resolvedMap.every((entry) => entry === 'gemini')) return 'gemini';
      if (resolvedMap.some((entry) => entry === 'codex')) return 'codex';
    }
  }

  return resolveTeamWorkerCli(resolvedLaunchArgs, env);
}

/**
 * Start a new team: init state, create tmux session, bootstrap workers.
 */
export async function startTeam(
  teamName: string,
  task: string,
  agentType: string,
  workerCount: number,
  tasks: Array<{ subject: string; description: string; owner?: string; blocked_by?: string[]; role?: string }>,
  cwd: string,
  options: TeamStartOptions = {},
): Promise<TeamRuntime> {
  const leaderCwd = resolve(cwd);
  await assertNestedTeamAllowed(leaderCwd);
  const effectiveWorktreeMode = resolveEffectiveTeamWorktreeMode(leaderCwd, options.worktreeMode);

  const workerLaunchMode = resolveTeamWorkerLaunchMode(process.env);
  const displayMode = workerLaunchMode === 'interactive' ? 'split_pane' : 'auto';
  if (workerLaunchMode === 'interactive') {
    if (!isTmuxAvailable()) {
      throw new Error('Team mode requires tmux. Install with: apt install tmux / brew install tmux');
    }
    if (!process.env.TMUX) {
      throw new Error('Team mode requires running inside tmux current leader pane');
    }
  }

  const sanitized = sanitizeTeamName(teamName);
  const teamStateRoot = resolveCanonicalTeamStateRoot(leaderCwd);
  const activeWorktreeMode: 'detached' | 'named' | null =
    effectiveWorktreeMode.enabled
      ? (effectiveWorktreeMode.detached ? 'detached' : 'named')
      : null;
  const workspaceMode: 'single' | 'worktree' = activeWorktreeMode ? 'worktree' : 'single';
  const workerWorkspaceByName = new Map<string, {
    cwd: string;
    worktreeRepoRoot?: string;
    worktreePath?: string;
    worktreeBranch?: string;
    worktreeDetached?: boolean;
    worktreeCreated?: boolean;
  }>();
  const provisionedWorktrees: Array<EnsureWorktreeResult | { enabled: false }> = [];
  for (let i = 1; i <= workerCount; i++) {
    workerWorkspaceByName.set(`worker-${i}`, { cwd: leaderCwd });
  }

  if (activeWorktreeMode) {
    assertCleanLeaderWorkspaceForWorkerWorktrees(leaderCwd);
    for (let i = 1; i <= workerCount; i++) {
      const workerName = `worker-${i}`;
      const planned = planWorktreeTarget({
        cwd: leaderCwd,
        scope: 'team',
        mode: effectiveWorktreeMode,
        teamName: sanitized,
        workerName,
      });
      const ensured = ensureWorktree(planned);
      provisionedWorktrees.push(ensured);
      if (ensured.enabled) {
        workerWorkspaceByName.set(workerName, {
          cwd: ensured.worktreePath,
          worktreeRepoRoot: ensured.repoRoot,
          worktreePath: ensured.worktreePath,
          worktreeBranch: ensured.branchName ?? undefined,
          worktreeDetached: ensured.detached,
          worktreeCreated: ensured.created,
        });
      }
    }
  }

  const leaderSessionId = await resolveLeaderSessionId(leaderCwd);

  // Topology guard: one active team per leader session/process context.
  const activeTeams = await findActiveTeams(leaderCwd, leaderSessionId);
  if (activeTeams.length > 0) {
    throw new Error(`leader_session_conflict: active team exists (${activeTeams.join(', ')})`);
  }

  // 2. Team name is already sanitized above.
  let sessionName = `omx-team-${sanitized}`;
  const overlay = generateWorkerOverlay(sanitized);
  let workerInstructionsPath: string | null = null;
  let sessionCreated = false;
  const createdWorkerPaneIds: string[] = [];
  let createdLeaderPaneId: string | undefined;
  let config: TeamConfig | null = null;
  const sharedWorkerLaunchArgs = resolveTeamWorkerLaunchArgs({
    existingRaw: process.env.OMX_TEAM_WORKER_LAUNCH_ARGS,
    fallbackModel: isLowComplexityAgentType(agentType)
      ? resolveTeamLowComplexityDefaultModel(process.env.CODEX_HOME)
      : undefined,
  });
  const workerCliPlan = resolveTeamWorkerCliPlan(workerCount, sharedWorkerLaunchArgs, process.env);
  const workerReadyTimeoutMs = resolveWorkerReadyTimeoutMs(process.env);
  const skipWorkerReadyWait = shouldSkipWorkerReadyWait(process.env);

  try {
    // 3. Init state directory + config
    config = await initTeamState(
      sanitized,
      task,
      agentType,
      workerCount,
      leaderCwd,
      DEFAULT_MAX_WORKERS,
      { ...process.env, OMX_TEAM_DISPLAY_MODE: displayMode, OMX_TEAM_WORKER_LAUNCH_MODE: workerLaunchMode },
      {
        leader_cwd: leaderCwd,
        team_state_root: teamStateRoot,
        workspace_mode: workspaceMode,
      },
      options.ralph === true ? 'linked_ralph' : 'default',
    );
    if (!config) {
      throw new Error('failed to initialize team config');
    }
    config.leader_cwd = leaderCwd;
    config.team_state_root = teamStateRoot;
    config.workspace_mode = workspaceMode;

    // 4. Create tasks
    for (const t of tasks) {
      await createStateTask(sanitized, {
        subject: t.subject,
        description: t.description,
        status: 'pending',
        owner: t.owner,
        blocked_by: t.blocked_by,
        role: t.role,
      }, leaderCwd);
    }

    // 5. Write team-scoped worker instructions file (no mutation of project AGENTS.md)
    workerInstructionsPath = await writeTeamWorkerInstructionsFile(sanitized, leaderCwd, overlay);
    setTeamModelInstructionsFile(sanitized, workerInstructionsPath);

    const allTasks = await listTasks(sanitized, leaderCwd);
    const workerBootstrapPlans = [] as Array<{
      workerName: string;
      workerWorkspace: {
        cwd: string;
        worktreeRepoRoot?: string;
        worktreePath?: string;
        worktreeBranch?: string;
        worktreeDetached?: boolean;
        worktreeCreated?: boolean;
      };
      workerTasks: TeamTask[];
      workerRole: string;
      rolePromptContent: string | null;
      instructionsFilePath: string;
      inbox: string;
      trigger: string;
      initialPrompt?: string;
      workerLaunchArgs: string[];
      workerCli: TeamWorkerCli;
    }>;

    for (let i = 1; i <= workerCount; i++) {
      const workerName = `worker-${i}`;
      const workerWorkspace = workerWorkspaceByName.get(workerName) ?? { cwd: leaderCwd };
      const workerTasks = allTasks.filter(t => t.owner === workerName);
      const taskRoles = workerTasks.map(t => t.role).filter(Boolean) as string[];
      const uniqueTaskRoles = new Set(taskRoles);
      const workerRole = taskRoles.length > 0 && uniqueTaskRoles.size === 1
        ? taskRoles[0]
        : agentType;
      const rolePromptContent = await loadRolePrompt(workerRole, join(leaderCwd, '.codex', 'prompts'))
        ?? await loadRolePrompt(workerRole, codexPromptsDir());
      const instructionsFilePath = rolePromptContent
        ? await writeWorkerRoleInstructionsFile(sanitized, workerName, leaderCwd, workerInstructionsPath, workerRole, rolePromptContent)
        : workerInstructionsPath;
      const inbox = generateInitialInbox(workerName, sanitized, agentType, workerTasks, {
        teamStateRoot,
        leaderCwd,
        workerRole,
        rolePromptContent: rolePromptContent ?? undefined,
      });
      const trigger = generateTriggerMessage(
        workerName,
        sanitized,
        resolveInstructionStateRoot(workerWorkspace.worktreePath),
      );
      const preferredReasoning = resolveAgentReasoningEffort(workerRole) ?? resolveAgentReasoningEffort(agentType);
      const workerLaunchArgs = resolveWorkerLaunchArgsFromEnv(
        process.env,
        agentType,
        undefined,
        preferredReasoning,
        workerCliPlan[i - 1],
      );
      const initialPrompt = workerCliPlan[i - 1] === 'gemini' ? trigger : undefined;
      if (initialPrompt) {
        await writeWorkerInbox(sanitized, workerName, inbox, leaderCwd);
      }
      workerBootstrapPlans.push({
        workerName,
        workerWorkspace,
        workerTasks,
        workerRole,
        rolePromptContent,
        instructionsFilePath,
        inbox,
        trigger,
        initialPrompt,
        workerLaunchArgs,
        workerCli: workerCliPlan[i - 1],
      });
    }

    const workerStartups = workerBootstrapPlans.map((plan) => {
      const env: Record<string, string> = {
        [TEAM_STATE_ROOT_ENV]: teamStateRoot,
        [TEAM_LEADER_CWD_ENV]: leaderCwd,
        [MODEL_INSTRUCTIONS_FILE_ENV]: plan.instructionsFilePath,
      };
      if (plan.workerWorkspace.worktreePath) {
        env.OMX_TEAM_WORKTREE_PATH = plan.workerWorkspace.worktreePath;
      }
      if (plan.workerWorkspace.worktreeBranch) {
        env.OMX_TEAM_WORKTREE_BRANCH = plan.workerWorkspace.worktreeBranch;
      }
      if (typeof plan.workerWorkspace.worktreeDetached === 'boolean') {
        env.OMX_TEAM_WORKTREE_DETACHED = plan.workerWorkspace.worktreeDetached ? '1' : '0';
      }
      return {
        cwd: plan.workerWorkspace.cwd,
        env,
        initialPrompt: plan.initialPrompt,
        launchArgs: plan.workerLaunchArgs,
        workerCli: plan.workerCli,
      };
    });

    const workerPaneIds = Array.from({ length: workerCount }, () => undefined as string | undefined);

    // 6. Create worker runtime (interactive tmux panes or prompt-mode child processes)
    if (workerLaunchMode === 'interactive') {
      const createdSession = createTeamSession(sanitized, workerCount, leaderCwd, sharedWorkerLaunchArgs, workerStartups);
      sessionName = createdSession.name;
      sessionCreated = true;
      createdWorkerPaneIds.push(...createdSession.workerPaneIds);
      createdLeaderPaneId = createdSession.leaderPaneId;
      config.tmux_session = sessionName;
      config.leader_pane_id = createdSession.leaderPaneId;
      config.hud_pane_id = createdSession.hudPaneId;
      config.resize_hook_name = createdSession.resizeHookName;
      config.resize_hook_target = createdSession.resizeHookTarget;
      for (let i = 0; i < createdSession.workerPaneIds.length; i++) {
        workerPaneIds[i] = createdSession.workerPaneIds[i];
      }
    } else {
      config.tmux_session = `prompt-${sanitized}`;
      config.leader_pane_id = null;
      config.hud_pane_id = null;
      config.resize_hook_name = null;
      config.resize_hook_target = null;
      for (let i = 1; i <= workerCount; i++) {
        const startup = workerStartups[i - 1] || {};
        const workerName = `worker-${i}`;
        const child = spawnPromptWorker(
          sanitized,
          workerName,
          i,
          startup.cwd || leaderCwd,
          startup.launchArgs || sharedWorkerLaunchArgs,
          startup.env || {},
          startup.workerCli || workerCliPlan[i - 1],
          startup.initialPrompt,
        );
        if (config.workers[i - 1]) {
          config.workers[i - 1].pid = child.pid;
        }
      }
    }
    await saveTeamConfig(config, leaderCwd);

    // 7. Wait for all workers to be ready (interactive mode), then bootstrap them
    const manifest = await readTeamManifestV2(sanitized, leaderCwd);
    const dispatchPolicy = resolveDispatchPolicy(manifest?.policy, workerLaunchMode);
    for (let i = 1; i <= workerCount; i++) {
      const bootstrapPlan = workerBootstrapPlans[i - 1];
      if (!bootstrapPlan) {
        throw new Error(`missing bootstrap plan for worker-${i}`);
      }
      const { workerName, paneId, workerTasks, workerRole, inbox, trigger, initialPrompt } = {
        workerName: bootstrapPlan.workerName,
        paneId: workerPaneIds[i - 1],
        workerTasks: bootstrapPlan.workerTasks,
        workerRole: bootstrapPlan.workerRole,
        inbox: bootstrapPlan.inbox,
        trigger: bootstrapPlan.trigger,
        initialPrompt: bootstrapPlan.initialPrompt,
      };
      const workerWorkspace = bootstrapPlan.workerWorkspace;

      if (workerTasks.map(t => t.role).filter(Boolean).length > 0 && new Set(workerTasks.map(t => t.role).filter(Boolean)).size > 1) {
        console.log(`[omx:team] ${workerName}: mixed task roles [${[...new Set(workerTasks.map(t => t.role).filter(Boolean))].join(', ')}], falling back to ${agentType}`);
      }

      // Write worker identity
      const identity: WorkerInfo = {
        name: workerName,
        index: i,
        role: workerRole,
        worker_cli: workerCliPlan[i - 1],
        assigned_tasks: workerTasks.map(t => t.id),
        working_dir: workerWorkspace.cwd,
        worktree_repo_root: workerWorkspace.worktreeRepoRoot,
        worktree_path: workerWorkspace.worktreePath,
        worktree_branch: workerWorkspace.worktreeBranch,
        worktree_detached: workerWorkspace.worktreeDetached,
        worktree_created: workerWorkspace.worktreeCreated,
        team_state_root: teamStateRoot,
      };

      // Get pane PID and store it (interactive mode) or process PID (prompt mode)
      if (workerLaunchMode === 'interactive') {
        const panePid = getWorkerPanePid(sessionName, i);
        if (panePid) identity.pid = panePid;
      } else if (config.workers[i - 1]?.pid) {
        identity.pid = config.workers[i - 1].pid;
      }
      if (paneId) identity.pane_id = paneId;
      if (config.workers[i - 1]) {
        config.workers[i - 1].pane_id = paneId;
        config.workers[i - 1].role = workerRole;
        config.workers[i - 1].worker_cli = workerCliPlan[i - 1];
        config.workers[i - 1].working_dir = workerWorkspace.cwd;
        config.workers[i - 1].worktree_repo_root = workerWorkspace.worktreeRepoRoot;
        config.workers[i - 1].worktree_path = workerWorkspace.worktreePath;
        config.workers[i - 1].worktree_branch = workerWorkspace.worktreeBranch;
        config.workers[i - 1].worktree_detached = workerWorkspace.worktreeDetached;
        config.workers[i - 1].worktree_created = workerWorkspace.worktreeCreated;
        config.workers[i - 1].team_state_root = teamStateRoot;
      }

      await writeWorkerIdentity(sanitized, workerName, identity, leaderCwd);

      // Wait for worker readiness
      if (workerLaunchMode === 'interactive' && !skipWorkerReadyWait && !initialPrompt) {
        const ready = waitForWorkerReady(sessionName, i, workerReadyTimeoutMs, paneId);
        if (!ready) {
          throw new Error(`Worker ${workerName} did not become ready in tmux session ${sessionName}`);
        }
      }

      // Queue inbox via MCP/state then notify worker via tmux transport.
      // Retry dispatch up to 3 times to handle Codex trust prompts that may
      // block the worker pane during startup (fixes #393).
      const maxStartupDispatchRetries = 3;
      const startupRetryDelayS = 3;
      let dispatchOutcome: DispatchOutcome = initialPrompt
        ? { ok: true, transport: 'none', reason: 'startup_prompt_delivered_at_launch' }
        : { ok: false, transport: 'none', reason: 'not_attempted' };
      if (!initialPrompt) {
        for (let attempt = 1; attempt <= maxStartupDispatchRetries; attempt++) {
          dispatchOutcome = await dispatchCriticalInboxInstruction({
            teamName: sanitized,
            config: config!,
            workerName,
            workerIndex: i,
            paneId,
            workerCli: workerCliPlan[i - 1],
            inbox,
            triggerMessage: trigger,
            cwd: leaderCwd,
            dispatchPolicy,
            inboxCorrelationKey: `startup:${workerName}`,
            requireWorkerStartupEvidence: true,
          });
          if (dispatchOutcome.ok) break;
          if (attempt < maxStartupDispatchRetries) {
            // Check for trust prompt blocking the worker and dismiss it before retry
            if (workerLaunchMode === 'interactive') {
              if (dismissTrustPromptIfPresent(sessionName, i, paneId)) {
                waitForWorkerReady(sessionName, i, workerReadyTimeoutMs, paneId);
              } else {
                sleepFractionalSeconds(startupRetryDelayS);
              }
            } else {
              sleepFractionalSeconds(startupRetryDelayS);
            }
          }
        }
      }
      if (!dispatchOutcome.ok) {
        throw new Error(`worker_notify_failed:${workerName}`);
      }
    }
    await saveTeamConfig(config, leaderCwd);

    return {
      teamName: sanitized,
      sanitizedName: sanitized,
      sessionName,
      config,
      cwd: leaderCwd,
    };
  } catch (error) {
    const rollbackErrors: string[] = [];

    if (sessionCreated) {
      if (config?.resize_hook_name && config.resize_hook_target) {
        try {
          const unregistered = unregisterResizeHook(config.resize_hook_target, config.resize_hook_name);
          if (!unregistered) {
            rollbackErrors.push('unregisterResizeHook: returned false');
          }
        } catch (cleanupError) {
          rollbackErrors.push(`unregisterResizeHook: ${String(cleanupError)}`);
        }
      }

      if (config) {
        config.resize_hook_name = null;
        config.resize_hook_target = null;
        try {
          await saveTeamConfig(config, leaderCwd);
        } catch (cleanupError) {
          rollbackErrors.push(`saveTeamConfig(clear resize hook): ${String(cleanupError)}`);
        }
      }

      // In split-pane topology, we must not kill the entire tmux session; kill only created panes.
      if (sessionName.includes(':')) {
        for (const paneId of createdWorkerPaneIds) {
          try {
            await killWorkerByPaneIdAsync(paneId, createdLeaderPaneId);
          } catch (err) {
            process.stderr.write(`[team/runtime] operation failed: ${err}\n`);
          }
        }
        if (config?.hud_pane_id) {
          try {
            await killWorkerByPaneIdAsync(config.hud_pane_id, createdLeaderPaneId);
          } catch (err) {
            process.stderr.write(`[team/runtime] operation failed: ${err}\n`);
          }
        }
      } else {
        try {
          destroyTeamSession(sessionName);
        } catch (cleanupError) {
          rollbackErrors.push(`destroyTeamSession: ${String(cleanupError)}`);
        }
      }
    }
    if (workerLaunchMode === 'prompt' && config) {
      const promptTeardownFailures: string[] = [];
      for (const worker of config.workers) {
        const teardown = await teardownPromptWorker(
          sanitized,
          worker.name,
          worker.pid as number | undefined,
          leaderCwd,
          'startup_rollback',
        );
        if (!teardown.terminated) {
          promptTeardownFailures.push(`${worker.name}:${teardown.error || 'unknown_error'}`);
        }
      }
      if (promptTeardownFailures.length > 0) {
        rollbackErrors.push(`promptTeardown:${promptTeardownFailures.join(',')}`);
      }
    }

    if (workerInstructionsPath) {
      try {
        await removeTeamWorkerInstructionsFile(sanitized, leaderCwd);
      } catch (cleanupError) {
        rollbackErrors.push(`removeTeamWorkerInstructionsFile: ${String(cleanupError)}`);
      }
    }
    restoreTeamModelInstructionsFile(sanitized);

    try {
      await cleanupTeamState(sanitized, leaderCwd);
    } catch (cleanupError) {
      rollbackErrors.push(`cleanupTeamState: ${String(cleanupError)}`);
    }
    if (provisionedWorktrees.length > 0) {
      try {
        await rollbackProvisionedWorktrees(provisionedWorktrees, {
          skipBranchDeletion: options.ralph === true,
        });
      } catch (cleanupError) {
        rollbackErrors.push(`rollbackProvisionedWorktrees: ${String(cleanupError)}`);
      }
    }

    if (rollbackErrors.length > 0) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}; rollback encountered errors: ${rollbackErrors.join(' | ')}`);
    }

    throw error;
  }
}

/**
 * Monitor team state by polling files. Returns a snapshot.
 */
export async function monitorTeam(teamName: string, cwd: string): Promise<TeamSnapshot | null> {
  const monitorStartMs = performance.now();
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) return null;
  const manifest = await readTeamManifestV2(sanitized, cwd);
  const dispatchPolicy = resolveDispatchPolicy(manifest?.policy, config.worker_launch_mode);
  const previousSnapshot = await readMonitorSnapshot(sanitized, cwd);

  const sessionName = config.tmux_session;
  const listTasksStartMs = performance.now();
  const allTasks = await listTasks(sanitized, cwd);
  const listTasksMs = performance.now() - listTasksStartMs;

  const reclaimedTaskIds: string[] = [];
  for (const task of allTasks) {
    if (task.status !== 'in_progress' || !task.claim?.leased_until) continue;
    if (new Date(task.claim.leased_until) > new Date()) continue;
    const reclaimed = await reclaimExpiredTaskClaim(sanitized, task.id, cwd);
    if (reclaimed.ok && reclaimed.reclaimed) reclaimedTaskIds.push(task.id);
  }
  let taskView = reclaimedTaskIds.length > 0 ? await listTasks(sanitized, cwd) : allTasks;
  const taskById = new Map(taskView.map((task) => [task.id, task] as const));
  const inProgressByOwner = new Map<string, TeamTask[]>();
  for (const task of taskView) {
    if (task.status !== 'in_progress' || !task.owner) continue;
    const existing = inProgressByOwner.get(task.owner) || [];
    existing.push(task);
    inProgressByOwner.set(task.owner, existing);
  }

  const workers: TeamSnapshot['workers'] = [];
  const deadWorkers: string[] = [];
  const nonReportingWorkers: string[] = [];
  const recommendations: string[] = [];

  const workerScanStartMs = performance.now();
  const workerSignals = await Promise.all(
    config.workers.map(async (worker) => {
      const alive = config.worker_launch_mode === 'prompt'
        ? isPromptWorkerAlive(config, worker)
        : isWorkerAlive(sessionName, worker.index, worker.pane_id);
      const [status, heartbeat] = await Promise.all([
        readWorkerStatus(sanitized, worker.name, cwd),
        readWorkerHeartbeat(sanitized, worker.name, cwd),
      ]);
      return { worker, alive, status, heartbeat };
    })
  );
  const workerScanMs = performance.now() - workerScanStartMs;

  for (const { worker: w, alive, status, heartbeat } of workerSignals) {
    const currentTask = status.current_task_id ? taskById.get(status.current_task_id) ?? null : null;
    const previousTurns = previousSnapshot ? (previousSnapshot.workerTurnCountByName[w.name] ?? 0) : null;
    const previousTaskId = previousSnapshot?.workerTaskIdByName[w.name] ?? '';
    const currentTaskId = status.current_task_id ?? '';
    const turnsWithoutProgress =
      heartbeat &&
      previousTurns !== null &&
      status.state === 'working' &&
      currentTask &&
      (currentTask.status === 'pending' || currentTask.status === 'in_progress') &&
      currentTaskId !== '' &&
      previousTaskId === currentTaskId
        ? Math.max(0, heartbeat.turn_count - previousTurns)
        : 0;

    workers.push({
      name: w.name,
      alive,
      status,
      heartbeat,
      assignedTasks: w.assigned_tasks,
      turnsWithoutProgress,
    });

    if (!alive) {
      deadWorkers.push(w.name);
      // Find in-progress tasks owned by this dead worker
      const deadWorkerTasks = inProgressByOwner.get(w.name) || [];
      for (const t of deadWorkerTasks) {
        recommendations.push(`Reassign task-${t.id} from dead ${w.name}`);
      }
    }

    if (alive && turnsWithoutProgress > 5) {
      nonReportingWorkers.push(w.name);
      recommendations.push(`Send reminder to non-reporting ${w.name}`);
    }
  }

  for (const taskId of reclaimedTaskIds) {
    recommendations.push(`Reclaimed expired claim for task-${taskId}`);
  }
  const rebalanceDecisions = buildRebalanceDecisions({
    tasks: taskView,
    workers: workers.map((worker) => ({
      name: worker.name,
      role: config.workers.find((entry) => entry.name === worker.name)?.role,
      alive: worker.alive,
      status: worker.status,
    })),
    reclaimedTaskIds,
  });

  let assignedDuringMonitor = false;
  for (const decision of rebalanceDecisions) {
    if (decision.type === 'assign' && decision.taskId && decision.workerName) {
      try {
        await assignTask(sanitized, decision.workerName, decision.taskId, cwd);
        recommendations.push(`Assigned task-${decision.taskId} to ${decision.workerName}: ${decision.reason}`);
        assignedDuringMonitor = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recommendations.push(`Unable to assign task-${decision.taskId} to ${decision.workerName}: ${message}`);
      }
    } else {
      recommendations.push(decision.reason);
    }
  }

  if (assignedDuringMonitor) {
    taskView = await listTasks(sanitized, cwd);
  }

  // Count tasks
  const taskCounts = {
    total: taskView.length,
    pending: taskView.filter(t => t.status === 'pending').length,
    blocked: taskView.filter(t => t.status === 'blocked').length,
    in_progress: taskView.filter(t => t.status === 'in_progress').length,
    completed: taskView.filter(t => t.status === 'completed').length,
    failed: taskView.filter(t => t.status === 'failed').length,
  };

  const verificationPendingTasks = taskView.filter(
    (task) => task.status === 'completed'
      && task.requires_code_change === true
      && !hasStructuredVerificationEvidence(task.result),
  );
  if (verificationPendingTasks.length > 0) {
    for (const task of verificationPendingTasks) {
      recommendations.push(`Verification evidence missing for task-${task.id}; require structured PASS/FAIL evidence before terminal success`);
    }
  }

  const allTasksTerminal = taskCounts.pending === 0 && taskCounts.blocked === 0 && taskCounts.in_progress === 0;
  const deadWorkerStall =
    config.worker_launch_mode === 'prompt'
    && config.workers.length > 0
    && deadWorkers.length >= config.workers.length
    && !allTasksTerminal;

  const persistedPhase = await readTeamPhaseState(sanitized, cwd);
  const targetPhase = deadWorkerStall
    ? 'failed'
    : inferPhaseTargetFromTaskCounts(taskCounts, {
      verificationPending: verificationPendingTasks.length > 0,
    });
  const phaseState: TeamPhaseState = reconcilePhaseStateForMonitor(persistedPhase, targetPhase);
  await writeTeamPhaseState(sanitized, phaseState, cwd);
  const phase: TeamPhase | TerminalPhase = phaseState.current_phase;
  await syncRootTeamModeStateOnTerminalPhase(sanitized, phase, cwd);
  await syncLinkedRalphModeStateOnTerminalPhase(sanitized, phase, cwd);

  if (deadWorkerStall) {
    recommendations.push('All workers are dead while work remains; mark the team failed or restart with fresh workers.');
  }

  await emitMonitorDerivedEvents(sanitized, taskView, workers, previousSnapshot, config.worker_launch_mode, cwd);
  const integrationByWorker = await integrateWorkerCommitsIntoLeader({
    teamName: sanitized,
    config,
    previous: previousSnapshot,
    cwd,
  });
  const mailboxDeliveryStartMs = performance.now();
  const mailboxNotifiedByMessageId = await deliverPendingMailboxMessages(
    sanitized,
    config,
    workers,
    previousSnapshot?.mailboxNotifiedByMessageId ?? {},
    dispatchPolicy,
    cwd
  );
  const mailboxDeliveryMs = performance.now() - mailboxDeliveryStartMs;

  // Prune ephemeral status messages from leader mailbox (TTL: 60s)
  try {
    const leaderMailbox = await listMailboxMessages(sanitized, 'leader-fixed', cwd);
    const now = Date.now();
    for (const msg of leaderMailbox) {
      if (msg.from_worker === 'system' && msg.created_at) {
        const age = now - new Date(msg.created_at).getTime();
        if (age > 60_000) {
          await markMessageDelivered(sanitized, 'leader-fixed', msg.message_id, cwd);
        }
      }
    }
  } catch (err) {
    process.stderr.write(`[team/runtime] operation failed: ${err}\n`);
  }

  const updatedAt = new Date().toISOString();
  const totalMs = performance.now() - monitorStartMs;
  await writeMonitorSnapshot(
    sanitized,
      {
        taskStatusById: Object.fromEntries(taskView.map((t) => [t.id, t.status])),
        workerAliveByName: Object.fromEntries(workers.map((w) => [w.name, w.alive])),
        workerStateByName: Object.fromEntries(workers.map((w) => [w.name, w.status.state])),
        workerTurnCountByName: Object.fromEntries(workers.map((w) => [w.name, w.heartbeat?.turn_count ?? 0])),
        workerTaskIdByName: Object.fromEntries(workers.map((w) => [w.name, w.status.current_task_id ?? ''])),
        mailboxNotifiedByMessageId,
        completedEventTaskIds: previousSnapshot?.completedEventTaskIds ?? {},
        integrationByWorker,
        monitorTimings: {
          list_tasks_ms: Number(listTasksMs.toFixed(2)),
          worker_scan_ms: Number(workerScanMs.toFixed(2)),
          mailbox_delivery_ms: Number(mailboxDeliveryMs.toFixed(2)),
          total_ms: Number(totalMs.toFixed(2)),
          updated_at: updatedAt,
        },
      },
      cwd
  );

  return {
    teamName: sanitized,
    phase,
    workers,
    tasks: {
      ...taskCounts,
      items: taskView,
    },
    allTasksTerminal,
    deadWorkers,
    nonReportingWorkers,
    recommendations,
    performance: {
      list_tasks_ms: Number(listTasksMs.toFixed(2)),
      worker_scan_ms: Number(workerScanMs.toFixed(2)),
      mailbox_delivery_ms: Number(mailboxDeliveryMs.toFixed(2)),
      total_ms: Number(totalMs.toFixed(2)),
      updated_at: updatedAt,
    },
  };
}

/**
 * Assign a task to a worker by writing inbox and sending trigger.
 */
export async function assignTask(
  teamName: string,
  workerName: string,
  taskId: string,
  cwd: string,
): Promise<void> {
  const sanitized = sanitizeTeamName(teamName);
  const task = await readTask(sanitized, taskId, cwd);
  if (!task) throw new Error(`Task ${taskId} not found`);
  const manifest = await readTeamManifestV2(sanitized, cwd);
  const governance = resolveGovernancePolicy(manifest?.governance);

  if (governance.delegation_only && workerName === 'leader-fixed') {
    throw new Error('delegation_only_violation');
  }

  if (governance.plan_approval_required && task.requires_code_change === true) {
    const approved = await isTaskApprovedForExecution(sanitized, taskId, cwd);
    if (!approved) {
      throw new Error('plan_approval_required');
    }
  }
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) throw new Error(`Team ${sanitized} not found`);
  const workerInfo = config.workers.find(w => w.name === workerName);
  if (!workerInfo) throw new Error(`Worker ${workerName} not found in team`);
  const dispatchPolicy = resolveDispatchPolicy(manifest?.policy, config.worker_launch_mode);

  const claim = await claimTask(sanitized, taskId, workerName, task.version ?? 1, cwd);
  if (!claim.ok) {
    if (claim.error === 'blocked_dependency') {
      throw new Error(`blocked_dependency:${(claim.dependencies ?? []).join(',')}`);
    }
    throw new Error(claim.error);
  }

  try {
    // Retry dispatch up to 2 times to handle trust prompts during assignment (fixes #393).
    const inbox = generateTaskAssignmentInbox(workerName, sanitized, taskId, task.description);
    const maxAssignRetries = 2;
    const assignRetryDelayS = 2;
    let outcome: DispatchOutcome = { ok: false, transport: 'none', reason: 'not_attempted' };
    for (let attempt = 1; attempt <= maxAssignRetries; attempt++) {
      outcome = await dispatchCriticalInboxInstruction({
        teamName: sanitized,
        config,
        workerName,
        workerIndex: workerInfo.index,
        paneId: workerInfo.pane_id,
        inbox,
        triggerMessage: generateTriggerMessage(
          workerName,
          sanitized,
          resolveInstructionStateRoot(workerInfo.worktree_path),
        ),
        cwd,
        dispatchPolicy,
        inboxCorrelationKey: `assign:${taskId}:${workerName}`,
      });
      if (outcome.ok) break;
      if (attempt < maxAssignRetries && config.worker_launch_mode === 'interactive' && config.tmux_session) {
        if (dismissTrustPromptIfPresent(config.tmux_session, workerInfo.index, workerInfo.pane_id)) {
          waitForWorkerReady(
            config.tmux_session,
            workerInfo.index,
            resolveWorkerReadyTimeoutMs(process.env),
            workerInfo.pane_id,
          );
        } else {
          await new Promise<void>(r => setTimeout(r, assignRetryDelayS * 1000));
        }
      }
    }
    if (!outcome.ok) {
      throw new Error('worker_notify_failed');
    }
  } catch (error) {
    // Roll back claim to avoid stuck in_progress tasks on any post-claim dispatch failure.
    const released = await releaseTaskClaim(sanitized, taskId, claim.claimToken, workerName, cwd);

    const reason = error instanceof Error && error.message.trim() !== ''
      ? error.message
      : 'worker_assignment_failed';

    try {
      await writeWorkerInbox(
        sanitized,
        workerName,
        `# Assignment Cancelled\n\nTask ${taskId} was not dispatched due to ${reason}.\nDo not execute this task from prior inbox content.`,
        cwd,
      );
    } catch (err) {
      process.stderr.write(`[team/runtime] operation failed: ${err}\n`);
      // best effort
    }

    if (!released.ok) {
      throw new Error(`${reason}:${released.error}`);
    }

    if (reason === 'worker_notify_failed') throw new Error('worker_notify_failed');
    throw new Error(`worker_assignment_failed:${reason}`);
  }
}

/**
 * Reassign a task from one worker to another.
 */
export async function reassignTask(
  teamName: string,
  taskId: string,
  _fromWorker: string,
  toWorker: string,
  cwd: string,
): Promise<void> {
  await assignTask(teamName, toWorker, taskId, cwd);
}

/**
 * Graceful shutdown: send shutdown inbox to all workers, wait, force kill, cleanup.
 */
export async function shutdownTeam(teamName: string, cwd: string, options: ShutdownOptions = {}): Promise<void> {
  const force = options.force === true;
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) {
    // No config -- just try to kill tmux session and clean up
    try {
      destroyTeamSession(`omx-team-${sanitized}`);
    } catch (err) {
      process.stderr.write(`[team/runtime] operation failed: ${err}\n`);
    }
    await cleanupTeamState(sanitized, cwd);
    restoreTeamModelInstructionsFile(sanitized);
    return;
  }
  const manifest = await readTeamManifestV2(sanitized, cwd);
  const lifecycleProfile = resolveLifecycleProfile(config, manifest);
  const ralph = options.ralph === true || lifecycleProfile === 'linked_ralph';
  const governance = resolveGovernancePolicy(
    manifest?.governance,
    manifest?.policy as Partial<TeamGovernance> | undefined,
  );

  if (!force) {
    const allTasks = await listTasks(sanitized, cwd);
    const gate: ShutdownGateCounts = {
      total: allTasks.length,
      pending: allTasks.filter((t) => t.status === 'pending').length,
      blocked: allTasks.filter((t) => t.status === 'blocked').length,
      in_progress: allTasks.filter((t) => t.status === 'in_progress').length,
      completed: allTasks.filter((t) => t.status === 'completed').length,
      failed: allTasks.filter((t) => t.status === 'failed').length,
      allowed: false,
    };
    gate.allowed = governance.cleanup_requires_all_workers_inactive !== true
      || (gate.pending === 0 && gate.blocked === 0 && gate.in_progress === 0 && gate.failed === 0);

    await appendTeamEvent(
      sanitized,
      {
        type: 'shutdown_gate',
        worker: 'leader-fixed',
        reason: `allowed=${gate.allowed} total=${gate.total} pending=${gate.pending} blocked=${gate.blocked} in_progress=${gate.in_progress} completed=${gate.completed} failed=${gate.failed} cleanup_requires_all_workers_inactive=${governance.cleanup_requires_all_workers_inactive}${ralph ? ' policy=ralph' : ''}`,
      },
      cwd,
    ).catch(() => {});

    if (!gate.allowed) {
      const hasActiveWork = gate.pending > 0 || gate.blocked > 0 || gate.in_progress > 0;
      if (ralph && !hasActiveWork) {
        // Ralph policy: bypass on failure-only scenarios (no pending/blocked/in_progress tasks).
        // This allows the ralph loop to retry rather than leaving stale team state.
        await appendTeamEvent(
          sanitized,
          {
            type: 'ralph_cleanup_policy',
            worker: 'leader-fixed',
            reason: `gate_bypassed:pending=${gate.pending},blocked=${gate.blocked},in_progress=${gate.in_progress},failed=${gate.failed}`,
          },
          cwd,
        ).catch(() => {});
      } else {
        throw new Error(
          `shutdown_gate_blocked:pending=${gate.pending},blocked=${gate.blocked},in_progress=${gate.in_progress},failed=${gate.failed}`,
        );
      }
    }
  }

  if (force) {
    await appendTeamEvent(sanitized, {
      type: 'shutdown_gate_forced',
      worker: 'leader-fixed',
      reason: 'force_bypass',
    }, cwd).catch(() => {});
  }

  const sessionName = config.tmux_session;
  const dispatchPolicy = resolveDispatchPolicy(manifest?.policy, config.worker_launch_mode);
  const shutdownRequestTimes = new Map<string, string>();

  // 1. Send shutdown inbox to each worker
  for (const w of config.workers) {
    try {
      const requestedAt = new Date().toISOString();
      await writeShutdownRequest(sanitized, w.name, 'leader-fixed', cwd);
      shutdownRequestTimes.set(w.name, requestedAt);
      await dispatchCriticalInboxInstruction({
        teamName: sanitized,
        config,
        workerName: w.name,
        workerIndex: w.index,
        paneId: w.pane_id,
        inbox: generateShutdownInbox(sanitized, w.name),
        triggerMessage: generateTriggerMessage(
          w.name,
          sanitized,
          resolveInstructionStateRoot(w.worktree_path),
        ),
        cwd,
        dispatchPolicy,
        inboxCorrelationKey: `shutdown:${w.name}`,
      });
    } catch (err) {
      process.stderr.write(`[team/runtime] operation failed: ${err}\n`);
    }
  }

  // 2. Wait up to 15s for workers to exit and collect acks
  const deadline = Date.now() + 15_000;
  const rejected: Array<{ worker: string; reason: string }> = [];
  const ackedWorkers = new Set<string>();
  while (Date.now() < deadline) {
    for (const w of config.workers) {
      const ack = await readShutdownAck(sanitized, w.name, cwd, shutdownRequestTimes.get(w.name));
      if (ack && !ackedWorkers.has(w.name)) {
        ackedWorkers.add(w.name);
        await appendTeamEvent(sanitized, {
          type: 'shutdown_ack',
          worker: w.name,
          reason: ack.status === 'reject' ? `reject:${ack.reason || 'no_reason'}` : 'accept',
        }, cwd);
      }
      if (ack?.status === 'reject') {
        if (!rejected.some((r) => r.worker === w.name)) {
          rejected.push({ worker: w.name, reason: ack.reason || 'no_reason' });
        }
      }
    }
    if (rejected.length > 0 && !force) {
      const detail = rejected.map(r => `${r.worker}:${r.reason}`).join(',');
      throw new Error(`shutdown_rejected:${detail}`);
    }

    const anyAlive = config.workers.some((w) => (
      config.worker_launch_mode === 'prompt'
        ? isPromptWorkerAlive(config, w)
        : isWorkerAlive(sessionName, w.index, w.pane_id)
    ));
    if (!anyAlive) break;
    // Sleep 2s
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  const anyAliveAfterWait = config.workers.some((w) => (
    config.worker_launch_mode === 'prompt'
      ? isPromptWorkerAlive(config, w)
      : isWorkerAlive(sessionName, w.index, w.pane_id)
  ));
  if (anyAliveAfterWait && !force) {
    // Workers may have accepted shutdown but not exited (Codex TUI requires explicit exit).
    // In this case, proceed to force kill panes (next step) rather than failing and leaving state around.
  }

  // 3. Force kill remaining workers
  const leaderPaneId = config.leader_pane_id;
  const hudPaneId = config.hud_pane_id;
  if (config.worker_launch_mode === 'interactive') {
    let resizeHookWarning: string | null = null;
    if (config.resize_hook_name && config.resize_hook_target) {
      const resizeHookName = config.resize_hook_name;
      const unregistered = unregisterResizeHook(config.resize_hook_target, resizeHookName);
      if (!unregistered && isTmuxAvailable()) {
        const baseSession = sessionName.split(':')[0];
        const sessionStillActive = listTeamSessions().includes(baseSession);
        if (sessionStillActive) {
          resizeHookWarning = `failed to unregister resize hook ${resizeHookName}`;
        }
      }
    }
    config.resize_hook_name = null;
    config.resize_hook_target = null;
    await saveTeamConfig(config, cwd);
    if (resizeHookWarning) {
      console.warn(`[team shutdown] ${sanitized}: ${resizeHookWarning}; continuing teardown`);
    }
    const workerPaneIds = config.workers
      .map((w) => w.pane_id)
      .filter((paneId): paneId is string => typeof paneId === 'string' && paneId.trim().length > 0);
    await teardownWorkerPanes(workerPaneIds, {
      leaderPaneId,
      hudPaneId,
    });
    if (hudPaneId) {
      await killWorkerByPaneIdAsync(hudPaneId, leaderPaneId ?? undefined);
      if (sessionName.includes(':')) {
        const restoredHudPaneId = restoreStandaloneHudPane(leaderPaneId, cwd);
        if (!restoredHudPaneId) {
          console.warn(`[team shutdown] ${sanitized}: failed to restore standalone HUD pane`);
        }
      }
    }

    // 4. Destroy tmux session
    if (!sessionName.includes(':')) {
      try {
        destroyTeamSession(sessionName);
      } catch (err) {
        process.stderr.write(`[team/runtime] operation failed: ${err}\n`);
      }
    }
  } else {
    const promptTeardownFailures: string[] = [];
    for (const w of config.workers) {
      const teardown = await teardownPromptWorker(
        sanitized,
        w.name,
        w.pid as number | undefined,
        cwd,
        'shutdown',
      );
      if (!teardown.terminated) {
        promptTeardownFailures.push(`${w.name}:${teardown.error || 'unknown_error'}`);
      }
    }
    if (promptTeardownFailures.length > 0) {
      throw new Error(`shutdown_prompt_teardown_failed:${promptTeardownFailures.join(',')}`);
    }
  }

  await prepareWorkerWorktreeShutdownReports(config, cwd);

  // 5. Remove team-scoped worker instructions file (no mutation of project AGENTS.md)
  try {
    await removeTeamWorkerInstructionsFile(sanitized, cwd);
  } catch (err) {
    process.stderr.write(`[team/runtime] operation failed: ${err}\n`);
  }
  restoreTeamModelInstructionsFile(sanitized);

  // 6. Ralph stricter completion logging
  if (ralph) {
    const finalTasks = await listTasks(sanitized, cwd).catch(() => [] as Awaited<ReturnType<typeof listTasks>>);
    const completed = finalTasks.filter((t) => t.status === 'completed').length;
    const failed = finalTasks.filter((t) => t.status === 'failed').length;
    const pending = finalTasks.filter((t) => t.status === 'pending').length;
    await appendTeamEvent(
      sanitized,
      {
        type: 'ralph_cleanup_summary',
        worker: 'leader-fixed',
        reason: `total=${finalTasks.length} completed=${completed} failed=${failed} pending=${pending} force=${force}`,
      },
      cwd,
    ).catch(() => {});
    await syncLinkedRalphModeStateOnTerminalPhase(sanitized, 'cancelled', cwd);
  }

  const cleanupErrors: string[] = [];
  const provisionedWorktrees = collectProvisionedShutdownWorktrees(config);
  if (provisionedWorktrees.length > 0) {
    try {
      await rollbackProvisionedWorktrees(provisionedWorktrees, {
        skipBranchDeletion: options.ralph === true,
      });
    } catch (err) {
      cleanupErrors.push(`rollbackProvisionedWorktrees: ${String(err)}`);
    }
  }

  // 7. Cleanup state
  try {
    await cleanupTeamState(sanitized, cwd);
  } catch (err) {
    cleanupErrors.push(`cleanupTeamState: ${String(err)}`);
  }

  if (cleanupErrors.length > 0) {
    throw new Error(cleanupErrors.join(' | '));
  }
}

/**
 * Resume monitoring an existing team.
 */
export async function resumeTeam(teamName: string, cwd: string): Promise<TeamRuntime | null> {
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) return null;
  const manifest = await readTeamManifestV2(sanitized, cwd);
  config.lifecycle_profile = resolveLifecycleProfile(config, manifest);

  if (config.worker_launch_mode === 'prompt') {
    const hasLivePromptWorker = config.workers.some((worker) => isPromptWorkerAlive(config, worker));
    if (!hasLivePromptWorker) return null;

    const missingHandles = config.workers
      .filter((worker) => {
        if (!Number.isFinite(worker.pid) || (worker.pid ?? 0) <= 0) return false;
        return isPidAlive(worker.pid as number);
      })
      .filter((worker) => !getPromptWorkerHandle(sanitized, worker.name));
    if (missingHandles.length > 0) {
      const detail = missingHandles.map((worker) => `${worker.name}:${worker.pid ?? 'unknown'}`).join(',');
      await appendTeamEvent(
        sanitized,
        {
          type: 'worker_stopped',
          worker: 'leader-fixed',
          reason: `prompt_resume_unavailable:missing_handle:${detail}`,
        },
        cwd,
      ).catch(() => {});
      return null;
    }
  } else {
    // Check if tmux session still exists
    const baseSession = config.tmux_session.split(':')[0];
    const teamSessions = getTeamTmuxSessions(sanitized);
    if (!teamSessions.includes(baseSession)) return null;
  }

  return {
    teamName: sanitized,
    sanitizedName: sanitized,
    sessionName: config.tmux_session,
    config,
    cwd,
  };
}

async function findActiveTeams(cwd: string, leaderSessionId: string): Promise<string[]> {
  const root = join(cwd, '.omx', 'state', 'team');
  if (!existsSync(root)) return [];
  const sessions = new Set(listTeamSessions());
  const entries = await readdir(root, { withFileTypes: true });
  const active: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const teamName = e.name;
    const cfg = await readTeamConfig(teamName, cwd);
    const manifest = await readTeamManifestV2(teamName, cwd);
    const governance = resolveGovernancePolicy(manifest?.governance);
    if (governance.one_team_per_leader_session === false) continue;
    const workerLaunchMode = cfg?.worker_launch_mode
      ?? manifest?.policy?.worker_launch_mode
      ?? 'interactive';
    const tmuxSession = (manifest?.tmux_session || cfg?.tmux_session || `omx-team-${teamName}`).split(':')[0];
    if (leaderSessionId) {
      const ownerSessionId = manifest?.leader?.session_id?.trim() ?? '';
      if (ownerSessionId && ownerSessionId !== leaderSessionId) continue;
    }
    if (workerLaunchMode === 'prompt') {
      if ((cfg?.workers ?? []).some((worker) => isPromptWorkerAlive(cfg!, worker))) {
        active.push(teamName);
      }
      continue;
    }
    if (sessions.has(tmuxSession)) active.push(teamName);
  }
  return active;
}

async function resolveLeaderSessionId(cwd: string): Promise<string> {
  const fromEnv = process.env.OMX_SESSION_ID || process.env.CODEX_SESSION_ID || process.env.SESSION_ID;
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim();

  const p = join(cwd, '.omx', 'state', 'session.json');
  if (!existsSync(p)) return '';
  try {
    const raw = await readFile(p, 'utf-8');
    const parsed = JSON.parse(raw) as { session_id?: unknown };
    if (typeof parsed.session_id === 'string' && parsed.session_id.trim() !== '') return parsed.session_id.trim();
  } catch (err) {
    process.stderr.write(`[team/runtime] operation failed: ${err}\n`);
    return '';
  }
  return '';
}

async function isTaskApprovedForExecution(teamName: string, taskId: string, cwd: string): Promise<boolean> {
  const record = await readTaskApproval(teamName, taskId, cwd);
  return record?.status === 'approved';
}

async function emitMonitorDerivedEvents(
  teamName: string,
  tasks: TeamTask[],
  workers: TeamSnapshot['workers'],
  previous: TeamMonitorSnapshotState | null,
  workerLaunchMode: TeamConfig['worker_launch_mode'],
  cwd: string,
): Promise<void> {
  for (const task of tasks) {
    const prevStatus = previous?.taskStatusById[task.id];
    if (prevStatus && prevStatus !== 'completed' && task.status === 'completed') {
      // Skip if a task_completed event was already emitted by transitionTaskStatus (issue #161).
      if (previous?.completedEventTaskIds?.[task.id]) continue;
      await appendTeamEvent(
        teamName,
        {
          type: 'task_completed',
          worker: task.owner || 'unknown',
          task_id: task.id,
          message_id: null,
          reason: undefined,
        },
        cwd
      );
    }
  }

  for (const worker of workers) {
    const prevAlive = previous?.workerAliveByName[worker.name];
    const shouldEmitInitialPromptWorkerStop = workerLaunchMode === 'prompt' && prevAlive === undefined;
    if ((prevAlive === true || shouldEmitInitialPromptWorkerStop) && worker.alive === false) {
      await appendTeamEvent(
        teamName,
        {
          type: 'worker_stopped',
          worker: worker.name,
          task_id: worker.status.current_task_id,
          message_id: null,
          reason: worker.status.reason,
        },
        cwd
      );
    }

    const prevState = previous?.workerStateByName[worker.name];
    if (prevState && prevState !== worker.status.state) {
      await appendTeamEvent(
        teamName,
        {
          type: 'worker_state_changed',
          worker: worker.name,
          task_id: worker.status.current_task_id,
          message_id: null,
          reason: worker.status.reason,
          state: worker.status.state,
          prev_state: prevState,
        },
        cwd
      );
    }

    if (prevState && prevState !== 'idle' && worker.status.state === 'idle') {
      await appendTeamEvent(
        teamName,
        {
          type: 'worker_idle',
          worker: worker.name,
          task_id: worker.status.current_task_id,
          message_id: null,
          reason: undefined,
          prev_state: prevState,
          state: 'idle',
          source_type: 'worker_idle',
        },
        cwd
      );
    }
  }
}

async function notifyWorkerOutcome(config: TeamConfig, workerIndex: number, message: string, workerPaneId?: string): Promise<DispatchOutcome> {
  const worker = config.workers.find((candidate) => candidate.index === workerIndex);
  if (!worker) return { ok: false, transport: 'none', reason: 'worker_not_found' };

  if (config.worker_launch_mode === 'prompt') {
    const handle = getPromptWorkerHandle(config.name, worker.name);
    if (!handle) return { ok: false, transport: 'prompt_stdin', reason: 'prompt_worker_handle_missing' };
    try {
      sendToWorkerStdin(handle.child.stdin, message);
      return { ok: true, transport: 'prompt_stdin', reason: 'prompt_stdin_sent' };
    } catch (error) {
      return {
        ok: false,
        transport: 'prompt_stdin',
        reason: `prompt_stdin_failed:${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (!config.tmux_session || !isTmuxAvailable()) {
    return { ok: false, transport: 'tmux_send_keys', reason: 'tmux_unavailable' };
  }
  try {
    await sendToWorker(config.tmux_session, workerIndex, message, workerPaneId, worker.worker_cli);
    return { ok: true, transport: 'tmux_send_keys', reason: 'tmux_send_keys_sent' };
  } catch (error) {
    return {
      ok: false,
      transport: 'tmux_send_keys',
      reason: `tmux_send_keys_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function resolveDispatchPolicy(
  manifestPolicy: TeamPolicy | null | undefined,
  workerLaunchMode: TeamConfig['worker_launch_mode'],
): TeamPolicy {
  return normalizeTeamPolicy(manifestPolicy, {
    display_mode: manifestPolicy?.display_mode === 'split_pane' ? 'split_pane' : 'auto',
    worker_launch_mode: workerLaunchMode,
  });
}

function isLeaderPaneMissingMailboxPersistedOutcome(params: {
  workerName: string;
  paneId?: string;
  outcome: DispatchOutcome;
}): boolean {
  const { workerName, paneId, outcome } = params;
  return workerName === 'leader-fixed'
    && !paneId
    && outcome.ok
    && outcome.reason === 'leader_pane_missing_mailbox_persisted';
}

async function markDispatchRequestLeaderPaneMissingDeferred(params: {
  teamName: string;
  requestId: string;
  messageId?: string;
  cwd: string;
}): Promise<void> {
  const { teamName, requestId, messageId, cwd } = params;
  const current = await readDispatchRequest(teamName, requestId, cwd);
  if (!current) return;
  if (current.status !== 'pending') return;

  await transitionDispatchRequest(
    teamName,
    requestId,
    current.status,
    current.status,
    {
      message_id: messageId ?? current.message_id,
      last_reason: 'leader_pane_missing_deferred',
    },
    cwd,
  ).catch(() => {});
}

async function dispatchCriticalInboxInstruction(params: {
  teamName: string;
  config: TeamConfig;
  workerName: string;
  workerIndex: number;
  paneId?: string;
  workerCli?: TeamWorkerCli;
  inbox: string;
  triggerMessage: string;
  cwd: string;
  dispatchPolicy: TeamPolicy;
  inboxCorrelationKey: string;
  requireWorkerStartupEvidence?: boolean;
}): Promise<DispatchOutcome> {
  const {
    teamName,
    config,
    workerName,
    workerIndex,
    paneId,
    workerCli,
    inbox,
    triggerMessage,
    cwd,
    dispatchPolicy,
    inboxCorrelationKey,
    requireWorkerStartupEvidence,
  } = params;

  if (config.worker_launch_mode === 'prompt') {
    return await queueInboxInstruction({
      teamName,
      workerName,
      workerIndex,
      paneId,
      inbox,
      triggerMessage,
      cwd,
      transportPreference: 'prompt_stdin',
      fallbackAllowed: false,
      inboxCorrelationKey,
      notify: (_target, message) => notifyWorkerOutcome(config, workerIndex, message, paneId),
    });
  }

  if (dispatchPolicy.dispatch_mode === 'transport_direct') {
    return await queueInboxInstruction({
      teamName,
      workerName,
      workerIndex,
      paneId,
      inbox,
      triggerMessage,
      cwd,
      transportPreference: 'transport_direct',
      fallbackAllowed: false,
      inboxCorrelationKey,
      notify: (_target, message) => notifyWorkerOutcome(config, workerIndex, message, paneId),
    });
  }

  const queued = await queueInboxInstruction({
    teamName,
    workerName,
    workerIndex,
    paneId,
    inbox,
    triggerMessage,
    cwd,
    transportPreference: 'hook_preferred_with_fallback',
    fallbackAllowed: true,
    inboxCorrelationKey,
    notify: () => ({ ok: true, transport: 'hook', reason: 'queued_for_hook_dispatch' }),
  });

  if (!queued.request_id) return { ...queued, ok: false, reason: 'dispatch_request_missing_id' };

  const receipt = await waitForDispatchReceipt(teamName, queued.request_id, cwd, {
    timeoutMs: dispatchPolicy.dispatch_ack_timeout_ms,
    pollMs: 50,
  });
  if (receipt?.status === 'delivered') {
    return { ok: true, transport: 'hook', reason: 'hook_receipt_delivered', request_id: queued.request_id };
  }
  const requiresObservedStartupEvidence = requireWorkerStartupEvidence === true
    && (workerCli === 'claude' || workerCli === 'codex');
  let startupEvidence: WorkerStartupEvidence = 'none';
  if (receipt?.status === 'notified') {
    if (!requiresObservedStartupEvidence) {
      return { ok: true, transport: 'hook', reason: 'hook_receipt_notified', request_id: queued.request_id };
    }
    startupEvidence = await waitForWorkerStartupEvidence({
      teamName,
      workerName,
      workerCli,
      cwd,
    });
    if (startupEvidence !== 'none') {
      return {
        ok: true,
        transport: 'hook',
        reason: `hook_receipt_notified_with_${startupEvidence}`,
        request_id: queued.request_id,
      };
    }
  }
  if (receipt?.status === 'failed') {
    const fallback = await notifyWorkerOutcome(config, workerIndex, triggerMessage, paneId);
    if (fallback.ok) {
      await transitionDispatchRequest(
        teamName,
        queued.request_id,
        'failed',
        'failed',
        { last_reason: `fallback_confirmed_after_failed_receipt:${fallback.reason}` },
        cwd,
      ).catch(() => {});
      return {
        ok: true,
        transport: fallback.transport,
        reason: `fallback_confirmed_after_failed_receipt:${fallback.reason}`,
        request_id: queued.request_id,
      };
    }
    await transitionDispatchRequest(
      teamName,
      queued.request_id,
      receipt.status,
      'failed',
      { last_reason: `fallback_attempted_but_unconfirmed:${fallback.reason}` },
      cwd,
    ).catch(() => {});
    return {
      ok: false,
      transport: fallback.transport,
      reason: `fallback_attempted_but_unconfirmed:${fallback.reason}`,
      request_id: queued.request_id,
    };
  }

  const fallback = await notifyWorkerOutcome(config, workerIndex, triggerMessage, paneId);
  const startupFallbackLabel = receipt?.status === 'notified' && requiresObservedStartupEvidence
    ? `${workerCli}_startup_no_evidence`
    : null;
  const fallbackFailureReason = startupFallbackLabel
    ? `${startupFallbackLabel}_fallback_failed:${fallback.reason}`
    : `fallback_attempted_but_unconfirmed:${fallback.reason}`;
  if (fallback.ok) {
    const marked = await markDispatchRequestNotified(
      teamName,
      queued.request_id,
      { last_reason: `fallback_confirmed:${fallback.reason}` },
      cwd,
    );
    if (!marked) {
      await transitionDispatchRequest(
        teamName,
        queued.request_id,
        'failed',
        'failed',
        { last_reason: `fallback_confirmed_after_failed_receipt:${fallback.reason}` },
        cwd,
      ).catch(() => {});
    }
    return {
      ok: true,
      transport: fallback.transport,
      reason: startupFallbackLabel
        ? `${startupFallbackLabel}_fallback_confirmed:${fallback.reason}`
        : `hook_timeout_fallback_confirmed:${fallback.reason}`,
      request_id: queued.request_id,
    };
  }

  const current = await readDispatchRequest(teamName, queued.request_id, cwd);
  if (current && current.status !== 'failed') {
    await transitionDispatchRequest(
      teamName,
      queued.request_id,
      current.status,
      'failed',
      { last_reason: fallbackFailureReason },
      cwd,
    ).catch(() => {});
  }
  return {
    ok: false,
    transport: fallback.transport,
    reason: fallbackFailureReason,
    request_id: queued.request_id,
  };
}

async function finalizeHookPreferredMailboxDispatch(params: {
  teamName: string;
  requestId: string;
  workerName: string;
  workerIndex?: number;
  paneId?: string;
  messageId: string;
  triggerMessage: string;
  config: TeamConfig;
  dispatchPolicy: TeamPolicy;
  cwd: string;
  fallbackNotify?: () => DispatchOutcome | Promise<DispatchOutcome>;
}): Promise<DispatchOutcome> {
  const {
    teamName,
    requestId,
    workerName,
    workerIndex,
    paneId,
    messageId,
    triggerMessage,
    config,
    dispatchPolicy,
    cwd,
    fallbackNotify,
  } = params;
  const receipt = await waitForDispatchReceipt(teamName, requestId, cwd, {
    timeoutMs: dispatchPolicy.dispatch_ack_timeout_ms,
    pollMs: 50,
  });
  if (receipt && (receipt.status === 'notified' || receipt.status === 'delivered')) {
    await markMessageNotified(teamName, workerName, messageId, cwd).catch(() => false);
    return { ok: true, transport: 'hook', reason: `hook_receipt_${receipt.status}`, request_id: requestId, message_id: messageId };
  }

  const fallback: DispatchOutcome = fallbackNotify
    ? await fallbackNotify()
    : (typeof workerIndex === 'number'
      ? await notifyWorkerOutcome(config, workerIndex, triggerMessage, paneId)
      : { ok: false, transport: 'none', reason: 'missing_worker_index' });
  if (receipt?.status === 'failed') {
    if (fallback.ok) {
      await markMessageNotified(teamName, workerName, messageId, cwd).catch(() => false);
      await transitionDispatchRequest(
        teamName,
        requestId,
        'failed',
        'failed',
        { message_id: messageId, last_reason: `fallback_confirmed_after_failed_receipt:${fallback.reason}` },
        cwd,
      ).catch(() => {});
      return {
        ok: true,
        transport: fallback.transport,
        reason: `fallback_confirmed_after_failed_receipt:${fallback.reason}`,
        request_id: requestId,
        message_id: messageId,
      };
    }
    await transitionDispatchRequest(
      teamName,
      requestId,
      'failed',
      'failed',
      { message_id: messageId, last_reason: `fallback_attempted_but_unconfirmed:${fallback.reason}` },
      cwd,
    ).catch(() => {});
    return {
      ok: false,
      transport: fallback.transport,
      reason: `fallback_attempted_but_unconfirmed:${fallback.reason}`,
      request_id: requestId,
      message_id: messageId,
    };
  }

  if (fallback.ok) {
    if (isLeaderPaneMissingMailboxPersistedOutcome({ workerName, paneId, outcome: fallback })) {
      await markDispatchRequestLeaderPaneMissingDeferred({
        teamName,
        requestId,
        messageId,
        cwd,
      });
      return {
        ok: true,
        transport: fallback.transport,
        reason: 'leader_pane_missing_mailbox_persisted',
        request_id: requestId,
        message_id: messageId,
      };
    }

    await markMessageNotified(teamName, workerName, messageId, cwd).catch(() => false);
    const marked = await markDispatchRequestNotified(
      teamName,
      requestId,
      { message_id: messageId, last_reason: `fallback_confirmed:${fallback.reason}` },
      cwd,
    );
    if (!marked) {
      await transitionDispatchRequest(
        teamName,
        requestId,
        'failed',
        'failed',
        { message_id: messageId, last_reason: `fallback_confirmed_after_failed_receipt:${fallback.reason}` },
        cwd,
      ).catch(() => {});
    }
    return {
      ok: true,
      transport: fallback.transport,
      reason: `hook_timeout_fallback_confirmed:${fallback.reason}`,
      request_id: requestId,
      message_id: messageId,
    };
  }

  const current = await readDispatchRequest(teamName, requestId, cwd);
  if (current) {
    await transitionDispatchRequest(
      teamName,
      requestId,
      current.status,
      'failed',
      { message_id: messageId, last_reason: `fallback_attempted_but_unconfirmed:${fallback.reason}` },
      cwd,
    ).catch(() => {});
  }
  return {
    ok: false,
    transport: fallback.transport,
    reason: `fallback_attempted_but_unconfirmed:${fallback.reason}`,
    request_id: requestId,
    message_id: messageId,
  };
}

async function notifyLeaderAsync(config: TeamConfig, message: string, cwd: string): Promise<DispatchOutcome> {
  // Primary: inject directly into the leader pane via tmux send-keys.
  // This is the fallback path when hook-based dispatch timed out, so the
  // leader needs a direct tmux notification to wake up. Fixes #437.
  if (config.leader_pane_id && isTmuxAvailable()) {
    try {
      await sendToLeaderPane(config.leader_pane_id, message);
      return { ok: true, transport: 'tmux_send_keys', reason: 'leader_pane_notified' };
    } catch (err) {
      process.stderr.write(`[team/runtime] operation failed: ${err}\n`);
      // Fall through to mailbox
    }
  }
  // Fallback: write to leader mailbox (leader picks up on next hook cycle)
  const { notifyLeaderMailboxAsync } = await import('./tmux-session.js');
  const persisted = await notifyLeaderMailboxAsync(config.name, 'system', message, cwd);
  if (!persisted) {
    return { ok: false, transport: 'mailbox', reason: 'leader_mailbox_notify_failed' };
  }
  if (!config.leader_pane_id) {
    return { ok: true, transport: 'mailbox', reason: 'leader_pane_missing_mailbox_persisted' };
  }
  return { ok: true, transport: 'mailbox', reason: 'leader_mailbox_notified' };
}

async function deliverPendingMailboxMessages(
  teamName: string,
  config: TeamConfig,
  workers: TeamSnapshot['workers'],
  previousNotifications: Record<string, string>,
  dispatchPolicy: TeamPolicy,
  cwd: string,
): Promise<Record<string, string>> {
  const nextNotifications: Record<string, string> = {};
  const pendingIdsAcrossTeam = new Set<string>();

  for (const worker of workers) {
    const workerInfo = config.workers.find((w) => w.name === worker.name);
    if (!workerInfo) continue;
    const mailbox = await listMailboxMessages(teamName, worker.name, cwd);
    const pending = mailbox.filter((m) => !m.delivered_at);
    if (pending.length === 0) continue;

    const pendingIds = pending.map((m) => m.message_id);
    for (const id of pendingIds) pendingIdsAcrossTeam.add(id);

    // Preserve already-tracked notification timestamps in the next snapshot.
    for (const msg of pending) {
      nextNotifications[msg.message_id] = msg.notified_at || previousNotifications[msg.message_id] || '';
    }

    // Only notify for messages that have never been successfully notified.
    // Using a message-ID set prevents re-notification on every monitor poll
    // (issue #116). A message is considered notified when either:
    //   - notified_at is set in the mailbox file (persisted by markMessageNotified), or
    //   - the message_id exists in previousNotifications from the last snapshot.
    // Both checks use Boolean() so an empty-string value is treated as unnotified.
    const unnotified = pending.filter(
      (m) => !m.notified_at && !previousNotifications[m.message_id],
    );
    if (unnotified.length === 0) continue;
    if (!worker.alive) continue;

    for (const msg of unnotified) {
      const triggerMessage = generateMailboxTriggerMessage(
        worker.name,
        teamName,
        1,
        resolveInstructionStateRoot(workerInfo.worktree_path),
      );
      const transportPreference = config.worker_launch_mode === 'prompt'
        ? 'prompt_stdin'
        : (dispatchPolicy.dispatch_mode === 'transport_direct' ? 'transport_direct' : 'hook_preferred_with_fallback');
      const fallbackAllowed = transportPreference === 'hook_preferred_with_fallback';
      const queued = await enqueueDispatchRequest(
        teamName,
        {
          kind: 'mailbox',
          to_worker: worker.name,
          worker_index: workerInfo.index,
          pane_id: workerInfo.pane_id,
          trigger_message: triggerMessage,
          message_id: msg.message_id,
          transport_preference: transportPreference,
          fallback_allowed: fallbackAllowed,
        },
        cwd,
      );

      let outcome: DispatchOutcome;
      if (transportPreference === 'hook_preferred_with_fallback') {
        outcome = await finalizeHookPreferredMailboxDispatch({
          teamName,
          requestId: queued.request.request_id,
          workerName: worker.name,
          workerIndex: workerInfo.index,
          paneId: workerInfo.pane_id,
          messageId: msg.message_id,
          triggerMessage,
          config,
          dispatchPolicy,
          cwd,
        });
      } else {
        const direct = await notifyWorkerOutcome(config, workerInfo.index, triggerMessage, workerInfo.pane_id);
        outcome = { ...direct, request_id: queued.request.request_id, message_id: msg.message_id };
        if (outcome.ok) {
          await markMessageNotified(teamName, worker.name, msg.message_id, cwd).catch(() => false);
          await markDispatchRequestNotified(
            teamName,
            queued.request.request_id,
            { message_id: msg.message_id, last_reason: outcome.reason },
            cwd,
          ).catch(() => null);
        }
      }

      if (outcome.ok) {
        nextNotifications[msg.message_id] = new Date().toISOString();
      }
    }
  }

  const pruned: Record<string, string> = {};
  for (const [messageId, ts] of Object.entries(nextNotifications)) {
    if (pendingIdsAcrossTeam.has(messageId) && ts) pruned[messageId] = ts;
  }
  return pruned;
}

export async function sendWorkerMessage(
  teamName: string,
  fromWorker: string,
  toWorker: string,
  body: string,
  cwd: string,
): Promise<void> {
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) throw new Error(`Team ${sanitized} not found`);
  const manifest = await readTeamManifestV2(sanitized, cwd);
  const dispatchPolicy = resolveDispatchPolicy(manifest?.policy, config.worker_launch_mode);
  if (toWorker === 'leader-fixed') {
    const leaderTriggerMessage = generateLeaderMailboxTriggerMessage(sanitized, fromWorker);
    const leaderTransportPreference = dispatchPolicy.dispatch_mode === 'transport_direct'
      ? 'transport_direct'
      : 'hook_preferred_with_fallback';
    const outcome = await queueDirectMailboxMessage({
      teamName: sanitized,
      fromWorker,
      toWorker,
      toPaneId: config.leader_pane_id ?? undefined,
      body,
      triggerMessage: leaderTriggerMessage,
      cwd,
      transportPreference: leaderTransportPreference,
      fallbackAllowed: leaderTransportPreference === 'hook_preferred_with_fallback',
      notify: async (_target, message) => (
        leaderTransportPreference === 'hook_preferred_with_fallback'
          ? { ok: true, transport: 'hook', reason: 'queued_for_hook_dispatch' }
          : await notifyLeaderAsync(config, message, cwd)
      ),
    });
    let finalOutcome = outcome;
    if (leaderTransportPreference === 'hook_preferred_with_fallback' && !config.leader_pane_id) {
      if (outcome.request_id) {
        await markDispatchRequestLeaderPaneMissingDeferred({
          teamName: sanitized,
          requestId: outcome.request_id,
          messageId: outcome.message_id,
          cwd,
        });
      }
      finalOutcome = {
        ...outcome,
        ok: true,
        transport: 'mailbox',
        reason: 'leader_pane_missing_mailbox_persisted',
      };
    }
    const canLeaderFallbackDirectly = Boolean(config.leader_pane_id) && isTmuxAvailable();
    if (leaderTransportPreference === 'hook_preferred_with_fallback' && canLeaderFallbackDirectly) {
      if (!outcome.request_id || !outcome.message_id) {
        throw new Error('mailbox_notify_failed:dispatch_request_missing_id');
      }
      finalOutcome = await finalizeHookPreferredMailboxDispatch({
        teamName: sanitized,
        requestId: outcome.request_id,
        workerName: 'leader-fixed',
        paneId: config.leader_pane_id ?? undefined,
        messageId: outcome.message_id,
        triggerMessage: leaderTriggerMessage,
        config,
        dispatchPolicy,
        cwd,
        fallbackNotify: async () => await notifyLeaderAsync(config, leaderTriggerMessage, cwd),
      });
    }
    if (!finalOutcome.ok) throw new Error(`mailbox_notify_failed:${finalOutcome.reason}`);
    return;
  }

  const recipient = config.workers.find((w) => w.name === toWorker);
  if (!recipient) throw new Error(`Worker ${toWorker} not found in team`);

  const triggerMessage = generateMailboxTriggerMessage(
    toWorker,
    sanitized,
    1,
    resolveInstructionStateRoot(recipient.worktree_path),
  );
  const transportPreference = config.worker_launch_mode === 'prompt'
    ? 'prompt_stdin'
    : (dispatchPolicy.dispatch_mode === 'transport_direct' ? 'transport_direct' : 'hook_preferred_with_fallback');
  const outcome = await queueDirectMailboxMessage({
    teamName: sanitized,
    fromWorker,
    toWorker,
    toWorkerIndex: recipient.index,
    toPaneId: recipient.pane_id,
    body,
    triggerMessage,
    cwd,
    transportPreference,
    fallbackAllowed: transportPreference === 'hook_preferred_with_fallback',
    notify: async (_target, message) => (
      transportPreference === 'hook_preferred_with_fallback'
        ? { ok: true, transport: 'hook', reason: 'queued_for_hook_dispatch' }
        : await notifyWorkerOutcome(config, recipient.index, message, recipient.pane_id)
    ),
  });
  let finalOutcome = outcome;
  if (transportPreference === 'hook_preferred_with_fallback') {
    if (!outcome.request_id || !outcome.message_id) {
      throw new Error('mailbox_notify_failed:dispatch_request_missing_id');
    }
    finalOutcome = await finalizeHookPreferredMailboxDispatch({
      teamName: sanitized,
      requestId: outcome.request_id,
      workerName: recipient.name,
      workerIndex: recipient.index,
      paneId: recipient.pane_id,
      messageId: outcome.message_id,
      triggerMessage,
      config,
      dispatchPolicy,
      cwd,
    });
  }
  if (!finalOutcome.ok) throw new Error(`mailbox_notify_failed:${finalOutcome.reason}`);
}

export async function broadcastWorkerMessage(
  teamName: string,
  fromWorker: string,
  body: string,
  cwd: string,
): Promise<void> {
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) throw new Error(`Team ${sanitized} not found`);
  const manifest = await readTeamManifestV2(sanitized, cwd);
  const dispatchPolicy = resolveDispatchPolicy(manifest?.policy, config.worker_launch_mode);
  const transportPreference = config.worker_launch_mode === 'prompt'
    ? 'prompt_stdin'
    : (dispatchPolicy.dispatch_mode === 'transport_direct' ? 'transport_direct' : 'hook_preferred_with_fallback');

  const outcomes = await queueBroadcastMailboxMessage({
    teamName: sanitized,
    fromWorker,
    recipients: config.workers.map((w) => ({ workerName: w.name, workerIndex: w.index, paneId: w.pane_id })),
    body,
    cwd,
    triggerFor: (workerName) => generateMailboxTriggerMessage(
      workerName,
      sanitized,
      1,
      resolveInstructionStateRoot(config.workers.find((worker) => worker.name === workerName)?.worktree_path),
    ),
    transportPreference,
    fallbackAllowed: transportPreference === 'hook_preferred_with_fallback',
    notify: async (target, message) =>
      transportPreference === 'hook_preferred_with_fallback'
        ? { ok: true, transport: 'hook', reason: 'queued_for_hook_dispatch' }
        : (typeof target.workerIndex === 'number'
        ? await notifyWorkerOutcome(config, target.workerIndex, message, target.paneId)
        : { ok: false, transport: 'none', reason: 'missing_worker_index' }),
  });
  const finalizedOutcomes: DispatchOutcome[] = [];
  for (const outcome of outcomes) {
    if (transportPreference !== 'hook_preferred_with_fallback') {
      finalizedOutcomes.push(outcome);
      continue;
    }
    if (!outcome.request_id || !outcome.message_id) {
      finalizedOutcomes.push({ ...outcome, ok: false, reason: 'dispatch_request_missing_id' });
      continue;
    }
    const target = outcome.to_worker
      ? (config.workers.find((w) => w.name === outcome.to_worker) ?? null)
      : null;
    if (!target) {
      finalizedOutcomes.push({ ...outcome, ok: false, reason: 'missing_worker_index' });
      continue;
    }
    finalizedOutcomes.push(await finalizeHookPreferredMailboxDispatch({
      teamName: sanitized,
      requestId: outcome.request_id,
      workerName: target.name,
      workerIndex: target.index,
      paneId: target.pane_id,
      messageId: outcome.message_id,
      triggerMessage: generateMailboxTriggerMessage(
        target.name,
        sanitized,
        1,
        resolveInstructionStateRoot(target.worktree_path),
      ),
      config,
      dispatchPolicy,
      cwd,
    }));
  }
  const results = transportPreference === 'hook_preferred_with_fallback' ? finalizedOutcomes : outcomes;
  if (results.some((result) => !result.ok)) {
    const firstFailure = results.find((result) => !result.ok);
    throw new Error(`mailbox_notify_failed:${firstFailure?.reason ?? 'unknown'}`);
  }
}
