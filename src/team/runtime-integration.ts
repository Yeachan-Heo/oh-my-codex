/**
 * Worker → Leader Git integration logic.
 *
 * Handles the three-phase commit integration pipeline:
 * Phase A: Auto-commit dirty worker worktrees
 * Phase B: Merge or cherry-pick worker commits into leader
 * Phase C: Cross-worker rebase onto the updated leader
 */
import { join, resolve, dirname } from 'path';
import { existsSync, appendFileSync } from 'fs';
import { spawnSync } from 'child_process';

import { appendTeamEvent, type WorkerInfo, type TeamConfig, type TeamMonitorSnapshotState, type TeamOperationalCommitEntry, type TeamWorkerIntegrationState } from './team-ops.js';
import { resolveCanonicalTeamStateRoot } from './state-root.js';
import type { TeamCommitHygieneArtifactPaths } from './commit-hygiene.js';

// ── Shared types ──

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface WorkerShutdownMergeReport {
  workerName: string;
  worktreePath: string;
  reportPath: string;
  sourceRef: string | null;
  syntheticCommit: string | null;
  diffText: string;
  summaryText: string | null;
  mergeOutcome: 'merged' | 'conflict' | 'noop' | 'skipped';
  mergeDetail: string;
  leaderHeadBefore: string | null;
  leaderHeadAfter: string | null;
}

// ── Git utilities ──

function runCommand(command: string, args: string[], cwd: string): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf-8',
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    exitCode: result.status,
  };
}

export function runGitCommand(repoRoot: string, args: string[], cwd: string = repoRoot): CommandResult {
  return runCommand('git', args, cwd);
}

export function getWorktreeDiffText(worktreePath: string): string {
  const staged = runGitCommand(worktreePath, ['diff', '--cached', '--stat', '--patch'], worktreePath);
  if (staged.ok && staged.stdout) return staged.stdout;

  const unstaged = runGitCommand(worktreePath, ['diff', '--stat', '--patch'], worktreePath);
  if (unstaged.ok && unstaged.stdout) return unstaged.stdout;

  const againstHead = runGitCommand(worktreePath, ['diff', 'HEAD', '--stat', '--patch'], worktreePath);
  if (againstHead.ok && againstHead.stdout) return againstHead.stdout;

  return '';
}

export function summarizeWorktreeDiffWithSparkShell(worktreePath: string): string | null {
  const shellCommand = `git diff --cached --stat --patch || git diff --stat --patch || git diff HEAD --stat --patch`;
  const result = runCommand('omx', ['sparkshell', 'sh', '-lc', shellCommand], worktreePath);
  if (!result.ok || !result.stdout) return null;
  return result.stdout;
}

export function resolveWorkerHead(worktreePath: string): string | null {
  const head = runGitCommand(worktreePath, ['rev-parse', 'HEAD'], worktreePath);
  return head.ok && head.stdout ? head.stdout : null;
}

export function resolveLeaderHead(repoRoot: string, leaderCwd: string): string | null {
  const head = runGitCommand(repoRoot, ['rev-parse', 'HEAD'], leaderCwd);
  return head.ok && head.stdout ? head.stdout : null;
}

export function listCommitRange(repoRoot: string, baseRef: string, headRef: string, cwd: string): string[] {
  if (!baseRef || !headRef || baseRef === headRef) return [];
  const range = runGitCommand(repoRoot, ['rev-list', '--reverse', `${baseRef}..${headRef}`], cwd);
  if (!range.ok || !range.stdout) return [];
  return range.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

export function listConflictFiles(repoRoot: string, cwd: string): string[] {
  const result = runGitCommand(repoRoot, ['diff', '--name-only', '--diff-filter=U'], cwd);
  if (!result.ok || !result.stdout) return [];
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

export function leaderContainsCommit(repoRoot: string, cwd: string, commit: string): boolean {
  return runGitCommand(repoRoot, ['merge-base', '--is-ancestor', commit, 'HEAD'], cwd).ok;
}

// ── Integration events & reporting ──

export type IntegrationEventType =
  | 'worker_cherry_pick_detected'
  | 'worker_cherry_pick_applied'
  | 'worker_cherry_pick_conflict'
  | 'worker_rebase_applied'
  | 'worker_rebase_conflict'
  | 'worker_auto_commit'
  | 'worker_merge_applied'
  | 'worker_merge_conflict'
  | 'worker_cross_rebase_applied'
  | 'worker_cross_rebase_conflict'
  | 'worker_cross_rebase_skipped';

export async function appendIntegrationEvent(
  teamName: string,
  type: IntegrationEventType,
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

// Forward reference — will be assigned from runtime.ts to avoid circular dep
let _sendWorkerMessage: ((teamName: string, workerName: string, target: string, body: string, cwd: string) => Promise<unknown>) | null = null;

export function injectSendWorkerMessage(fn: typeof _sendWorkerMessage): void {
  _sendWorkerMessage = fn;
}

export async function sendIntegrationMessageToLeader(
  teamName: string,
  worker: WorkerInfo,
  body: string,
  cwd: string,
): Promise<void> {
  if (!_sendWorkerMessage) return;
  await _sendWorkerMessage(teamName, worker.name, 'leader-fixed', body, cwd).catch(() => {});
}

export function autoCommitDirtyWorktree(
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

export function appendIntegrationReport(
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
  const reportDir = dirname(reportPath);
  if (!existsSync(reportDir)) {
    // eslint-disable-next-line no-restricted-modules-sync
    require('fs').mkdirSync(reportDir, { recursive: true });
  }

  const timestamp = new Date().toISOString();
  const line = `- [${timestamp}] ${entry.workerName}: ${entry.operation} conflict auto-resolved (${entry.strategy}) on files: ${entry.files.join(', ') || 'unknown'}. ${entry.detail}\n`;

  appendFileSync(reportPath, existsSync(reportPath) ? line : `# Integration Report\n\n${line}`);
}

export function resolveWorkerMergeRef(branchResult: CommandResult, workerHead: string): string {
  const branchRef = branchResult.ok ? branchResult.stdout.trim() : '';
  if (!branchRef || branchRef === 'HEAD') return workerHead;
  return branchRef;
}

// ── Core integration pipeline ──

export async function integrateWorkerCommitsIntoLeader(params: {
  teamName: string;
  config: TeamConfig;
  previous: TeamMonitorSnapshotState | null;
  cwd: string;
}): Promise<Record<string, TeamWorkerIntegrationState>> {
  const { teamName, config, previous, cwd } = params;
  // Lazy import to avoid circular dep with runtime-shutdown.ts
  const { readWorkerStatus } = await import('./team-ops.js');
  const next: Record<string, TeamWorkerIntegrationState> = { ...(previous?.integrationByWorker ?? {}) };
  const leaderHeadAtCycleStart = resolveLeaderHead(resolve(config.workers[0]?.worktree_repo_root ?? cwd), cwd);
  const integratedWorkerNames = new Set<string>();
  const commitHygieneEntries: TeamOperationalCommitEntry[] = [];
  const artifactCwd = config.leader_cwd ?? cwd;

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
      commitHygieneEntries.push({
        recorded_at: new Date().toISOString(),
        operation: 'auto_checkpoint',
        worker_name: worker.name,
        task_id: worker.assigned_tasks[0],
        status: 'applied',
        operational_commit: commitHash,
        worktree_path: resolve(worker.worktree_path),
        detail: 'Dirty worker worktree checkpointed before runtime integration.',
      });
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
      const branchRef = resolveWorkerMergeRef(workerBranch, workerHead);
      const merge = runGitCommand(repoRoot, ['merge', '--no-ff', '-X', 'theirs', '-m', `omx(team): merge ${worker.name}`, branchRef], cwd);

      if (merge.ok) {
        const newLeaderHead = resolveLeaderHead(repoRoot, cwd) ?? leaderHead;
        const workerIntegrated = leaderContainsCommit(repoRoot, cwd, workerHead);
        const leaderAdvanced = newLeaderHead !== leaderHead;
        if (workerIntegrated && leaderAdvanced) {
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
          commitHygieneEntries.push({
            recorded_at: new Date().toISOString(),
            operation: 'integration_merge',
            worker_name: worker.name,
            task_id: worker.assigned_tasks[0],
            status: 'applied',
            operational_commit: newLeaderHead,
            source_commit: workerHead,
            leader_head_before: leaderHead,
            leader_head_after: newLeaderHead,
            worktree_path: worktreePath,
            detail: 'Leader created a runtime merge commit to integrate worker history.',
          });
        } else {
          state.last_leader_head = newLeaderHead;
          state.status = 'idle';
          state.updated_at = new Date().toISOString();
          appendIntegrationReport(teamName, {
            workerName: worker.name,
            operation: 'merge',
            strategy: '-X theirs',
            files: [],
            detail: `merge reported success but leader HEAD did not advance cleanly (leader_before=${leaderHead.slice(0, 12)}, leader_after=${newLeaderHead.slice(0, 12)}, worker_integrated=${workerIntegrated}, merge_ref=${branchRef}).`,
          }, cwd);
          await sendIntegrationMessageToLeader(teamName, worker, `INTEGRATION NO-OP: merge for ${worker.name} using ${branchRef.slice(0, 12)} reported success but leader HEAD stayed ${newLeaderHead.slice(0, 12)}. Inspect ${worktreePath}.`, cwd);
          commitHygieneEntries.push({
            recorded_at: new Date().toISOString(),
            operation: 'integration_merge',
            worker_name: worker.name,
            task_id: worker.assigned_tasks[0],
            status: 'skipped',
            operational_commit: newLeaderHead,
            source_commit: workerHead,
            leader_head_before: leaderHead,
            leader_head_after: newLeaderHead,
            worktree_path: worktreePath,
            detail: 'Merge command reported success but leader HEAD did not advance or contain the worker commitment; runtime refused to report false integration.',
          });
        }
      } else {
        // Merge failed even with -X theirs
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
          summary: `detected worker commitment ${commit.slice(0, 12)}`,
        }, cwd);

        const pick = runGitCommand(repoRoot, ['cherry-pick', '--allow-empty', '-X', 'theirs', commit], cwd);
        if (!pick.ok) {
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
        commitHygieneEntries.push({
          recorded_at: new Date().toISOString(),
          operation: 'integration_cherry_pick',
          worker_name: worker.name,
          task_id: worker.assigned_tasks[0],
          status: 'applied',
          operational_commit: newLeaderHead,
          source_commit: commit,
          leader_head_before: leaderHead,
          leader_head_after: newLeaderHead,
          worktree_path: worktreePath,
          detail: 'Leader created a runtime cherry-pick commitment while integrating diverged worker history.',
        });
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
      const workerHeadBeforeRebase = resolveWorkerHead(worktreePath);
      const rebase = runGitCommand(repoRoot, ['rebase', '-X', 'ours', newLeaderHead], worktreePath);
      if (rebase.ok) {
        const workerHeadAfterRebase = resolveWorkerHead(worktreePath);
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
        commitHygieneEntries.push({
          recorded_at: new Date().toISOString(),
          operation: 'cross_rebase',
          worker_name: worker.name,
          task_id: worker.assigned_tasks[0],
          status: 'applied',
          operational_commit: workerHeadAfterRebase,
          leader_head_after: newLeaderHead,
          worker_head_before: workerHeadBeforeRebase,
          worker_head_after: workerHeadAfterRebase,
          worktree_path: worktreePath,
          detail: 'Runtime rebase rewrote worker history onto the updated leader head.',
        });
      } else {
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

  if (commitHygieneEntries.length > 0) {
    const { appendTeamCommitHygieneEntries } = await import('./commit-hygiene.js');
    await appendTeamCommitHygieneEntries(teamName, commitHygieneEntries, artifactCwd);
  }

  return next;
}

// Re-export for renderWorktreeMergeReport (used in runtime-shutdown.ts)
export function renderWorktreeMergeReport(report: WorkerShutdownMergeReport): string {
  const lines = [
    `# Worker ${report.workerName} shutdown report`,
    '',
    `- worktree: ${report.worktreePath}`,
    `- report_path: ${report.reportPath}`,
    `- source_ref: ${report.sourceRef ?? 'none'}`,
    `- synthetic_commit: ${report.syntheticCommit ?? 'none'}`,
    `- merge_outcome: ${report.mergeOutcome}`,
    `- merge_detail: ${report.mergeDetail}`,
    `- leader_head_before: ${report.leaderHeadBefore ?? 'none'}`,
    `- leader_head_after: ${report.leaderHeadAfter ?? 'none'}`,
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
