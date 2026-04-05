/**
 * Team shutdown orchestration.
 *
 * Handles the shutdown gate, worker teardown, worktree merge reports,
 * and state cleanup.
 */
import { join, resolve, dirname } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';

import {
  sanitizeTeamName,
  destroyTeamSession,
  listTeamSessions,
  isTmuxAvailable,
  unregisterResizeHook,
  teardownWorkerPanes,
  restoreStandaloneHudPane,
  killWorkerByPaneIdAsync,
  getWorkerPanePid,
  isWorkerAlive,
} from './tmux-session.js';
import {
  type TeamConfig,
  type WorkerInfo,
  type TeamGovernance,
  teamReadConfig as readTeamConfig,
  teamReadManifest as readTeamManifestV2,
  teamNormalizeGovernance as normalizeTeamGovernance,
  teamCleanup as cleanupTeamState,
  teamListTasks as listTasks,
  teamAppendEvent as appendTeamEvent,
  teamWriteShutdownRequest as writeShutdownRequest,
  teamReadShutdownAck as readShutdownAck,
  teamSaveConfig as saveTeamConfig,
} from './team-ops.js';
import {
  generateShutdownInbox,
  generateTriggerMessage,
  removeTeamWorkerInstructionsFile,
  removeWorkerWorktreeRootAgentsFile,
} from './worker-bootstrap.js';
import { resolveCanonicalTeamStateRoot } from './state-root.js';
import { isGitRepository, rollbackProvisionedWorktrees, type EnsureWorktreeResult, type WorktreeMode } from './worktree.js';
import {
  appendTeamCommitHygieneEntries,
  buildTeamCommitHygieneContext,
  writeTeamCommitHygieneContext,
  type TeamCommitHygieneArtifactPaths,
  type TeamOperationalCommitEntry,
} from './commit-hygiene.js';
import {
  renderWorktreeMergeReport,
  type WorkerShutdownMergeReport,
  autoCommitDirtyWorktree,
  getWorktreeDiffText,
  summarizeWorktreeDiffWithSparkShell,
  resolveWorkerHead,
  resolveLeaderHead,
  type CommandResult,
} from './runtime-integration.js';
import { terminateTrackedProcessTree, teardownPromptWorker, isPromptWorkerAlive } from './runtime-prompt-worker.js';
import { dispatchCriticalInboxInstruction, resolveDispatchPolicy } from './runtime-dispatch.js';

// ── Shutdown merge report ──

async function prepareShutdownMergeReport(
  worker: WorkerInfo,
  leaderCwd: string,
): Promise<WorkerShutdownMergeReport | null> {
  if (!worker.worktree_repo_root || !worker.worktree_path || !existsSync(worker.worktree_path)) {
    return null;
  }

  const worktreePath = resolve(worker.worktree_path);
  const repoRoot = resolve(worker.worktree_repo_root);

  function runGitCommand(args: string[], cwd: string = repoRoot): CommandResult {
    const { spawnSync } = require('child_process');
    const result = spawnSync('git', args, { cwd: cwd as any, encoding: 'utf-8' as const, windowsHide: true });
    return {
      ok: result.status === 0,
      stdout: (result.stdout || '').trim(),
      stderr: (result.stderr || '').trim(),
      exitCode: result.status,
    };
  }

  const statusBefore = runGitCommand(['status', '--porcelain'], worktreePath);
  const hadChanges = statusBefore.ok && statusBefore.stdout.length > 0;

  let syntheticCommit: string | null = null;
  if (hadChanges) {
    const addResult = runGitCommand(['add', '-A'], worktreePath);
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
        leaderHeadBefore: resolveLeaderHead(repoRoot, leaderCwd),
        leaderHeadAfter: resolveLeaderHead(repoRoot, leaderCwd),
      };
    }
    const commitResult = runGitCommand(
      ['commit', '--no-verify', '-m', `omx(team): checkpoint ${worker.name} shutdown changes`],
      worktreePath,
    );
    if (commitResult.ok) {
      const revParse = runGitCommand(['rev-parse', 'HEAD'], worktreePath);
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
        leaderHeadBefore: resolveLeaderHead(repoRoot, leaderCwd),
        leaderHeadAfter: resolveLeaderHead(repoRoot, leaderCwd),
      };
    }
  }

  const sourceRefResult = runGitCommand(['rev-parse', 'HEAD'], worktreePath);
  const sourceRef = sourceRefResult.ok && sourceRefResult.stdout ? sourceRefResult.stdout : null;
  const diffText = getWorktreeDiffText(worktreePath);
  const summaryText = summarizeWorktreeDiffWithSparkShell(worktreePath);
  const reportPath = join(worktreePath, '.omx', 'diff.md');
  const leaderHeadBefore = resolveLeaderHead(repoRoot, leaderCwd);

  let mergeOutcome: WorkerShutdownMergeReport['mergeOutcome'] = 'skipped';
  let mergeDetail = 'worktree merge skipped';
  let leaderHeadAfter = leaderHeadBefore;
  if (sourceRef) {
    const alreadyMerged = runGitCommand(['merge-base', '--is-ancestor', sourceRef, 'HEAD'], leaderCwd);
    if (alreadyMerged.ok) {
      mergeOutcome = 'noop';
      mergeDetail = 'source already reachable from leader HEAD';
    } else {
      const mergeResult = runGitCommand(['merge', '--no-ff', '--no-edit', sourceRef], leaderCwd);
      if (mergeResult.ok) {
        mergeOutcome = 'merged';
        mergeDetail = mergeResult.stdout || 'merged successfully';
        leaderHeadAfter = resolveLeaderHead(repoRoot, leaderCwd) ?? leaderHeadBefore;
      } else {
        mergeOutcome = 'conflict';
        mergeDetail = mergeResult.stderr || mergeResult.stdout || 'merge failed';
        runGitCommand(['merge', '--abort'], leaderCwd);
        leaderHeadAfter = resolveLeaderHead(repoRoot, leaderCwd) ?? leaderHeadBefore;
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
    leaderHeadBefore,
    leaderHeadAfter,
  };

  await mkdir(join(worktreePath, '.omx'), { recursive: true });
  await writeFile(reportPath, renderWorktreeMergeReport(report), 'utf-8');
  process.stdout.write(`${renderWorktreeMergeReport(report)}\n`);
  return report;
}

async function prepareWorkerWorktreeShutdownReports(config: TeamConfig, leaderCwd: string): Promise<WorkerShutdownMergeReport[]> {
  const reports: WorkerShutdownMergeReport[] = []
  for (const worker of config.workers) {
    if (!worker.worktree_path || !worker.worktree_repo_root) continue;
    try {
      const report = await prepareShutdownMergeReport(worker, leaderCwd);
      if (report) reports.push(report);
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
  return reports;
}

// ── Shutdown gate ──

interface ShutdownGateCounts {
  total: number;
  pending: number;
  blocked: number;
  in_progress: number;
  completed: number;
  failed: number;
  allowed: boolean;
}

function resolveGovernancePolicy(
  governance: TeamGovernance | null | undefined,
  legacyPolicy?: Partial<TeamGovernance> | null | undefined,
): TeamGovernance {
  return normalizeTeamGovernance(governance, legacyPolicy);
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
    const { planWorktreeTarget } = require('./worktree.js');
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

interface ShutdownOptions {
  force?: boolean;
}

export interface TeamShutdownSummary {
  commitHygieneArtifacts: TeamCommitHygieneArtifactPaths | null;
}

// Forward reference — instruction state resolver lives on the runtime side
let _resolveInstructionStateRoot: ((path?: string | null) => string | undefined) | undefined;

export function injectResolveInstructionStateRoot(fn: typeof _resolveInstructionStateRoot): void {
  _resolveInstructionStateRoot = fn;
}

// ── Main entry point ──

export async function shutdownTeam(
  teamName: string,
  cwd: string,
  options: ShutdownOptions = {},
): Promise<TeamShutdownSummary> {
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
    return { commitHygieneArtifacts: null };
  }
  const manifest = await readTeamManifestV2(sanitized, cwd);
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
        reason: `allowed=${gate.allowed} total=${gate.total} pending=${gate.pending} blocked=${gate.blocked} in_progress=${gate.in_progress} completed=${gate.completed} failed=${gate.failed} cleanup_requires_all_workers_inactive=${governance.cleanup_requires_all_workers_inactive}`,
      },
      cwd,
    ).catch(() => {});

    if (!gate.allowed) {
      throw new Error(
        `shutdown_gate_blocked:pending=${gate.pending},blocked=${gate.blocked},in_progress=${gate.in_progress},failed=${gate.failed}`,
      );
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
          _resolveInstructionStateRoot?.(w.worktree_path),
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
    const workerPanePids = config.workers
      .map((w) => getWorkerPanePid(sessionName, w.index, w.pane_id))
      .filter((pid): pid is number => typeof pid === 'number' && Number.isFinite(pid) && pid > 0);
    for (const panePid of workerPanePids) {
      await terminateTrackedProcessTree(panePid);
    }

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

  const shutdownReports = await prepareWorkerWorktreeShutdownReports(config, cwd);

  const commitHygieneEntries: TeamOperationalCommitEntry[] = [];
  for (const report of shutdownReports) {
    const worker = config.workers.find((entry) => entry.name === report.workerName);
    if (report.syntheticCommit) {
      commitHygieneEntries.push({
        recorded_at: new Date().toISOString(),
        operation: 'shutdown_checkpoint',
        worker_name: report.workerName,
        task_id: worker?.assigned_tasks[0],
        status: 'applied',
        operational_commit: report.syntheticCommit,
        source_commit: report.sourceRef,
        worktree_path: report.worktreePath,
        report_path: report.reportPath,
        detail: 'Runtime created a shutdown checkpoint commit to preserve worker worktree changes.',
      });
    }

    if (report.sourceRef && report.mergeOutcome !== 'skipped') {
      commitHygieneEntries.push({
        recorded_at: new Date().toISOString(),
        operation: 'shutdown_merge',
        worker_name: report.workerName,
        task_id: worker?.assigned_tasks[0],
        status: report.mergeOutcome === 'merged' ? 'applied' : report.mergeOutcome,
        operational_commit: report.mergeOutcome === 'merged' ? report.leaderHeadAfter : null,
        source_commit: report.sourceRef,
        leader_head_before: report.leaderHeadBefore,
        leader_head_after: report.leaderHeadAfter,
        worktree_path: report.worktreePath,
        report_path: report.reportPath,
        detail: report.mergeDetail,
      });
    }
  }

  const artifactCwd = config.leader_cwd ?? cwd;
  const ledger = await appendTeamCommitHygieneEntries(sanitized, commitHygieneEntries, artifactCwd);
  const taskView = await listTasks(sanitized, cwd).catch(() => [])
  const commitHygieneContext = buildTeamCommitHygieneContext({
    teamName: sanitized,
    tasks: taskView,
    ledger,
  })
  const commitHygieneArtifacts = await writeTeamCommitHygieneContext(sanitized, commitHygieneContext, artifactCwd)

  // 5. Remove worker worktree-root instructions and team-scoped fallback instructions.
  for (const worker of config.workers) {
    if (!worker.worktree_path || !worker.team_state_root) continue;
    try {
      await removeWorkerWorktreeRootAgentsFile(
        sanitized,
        worker.name,
        worker.team_state_root,
        worker.worktree_path,
      );
    } catch (err) {
      process.stderr.write(`[team/runtime] operation failed: ${err}\n`);
    }
  }
  try {
    await removeTeamWorkerInstructionsFile(sanitized, cwd);
  } catch (err) {
    process.stderr.write(`[team/runtime] operation failed: ${err}\n`);
  }

  const cleanupErrors: string[] = [];
  const provisionedWorktrees = collectProvisionedShutdownWorktrees(config);
  if (provisionedWorktrees.length > 0) {
    try {
      await rollbackProvisionedWorktrees(provisionedWorktrees, {
        skipBranchDeletion: false,
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

  return { commitHygieneArtifacts };
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

// ── Re-Exports ──

export { resolveEffectiveTeamWorktreeMode };
