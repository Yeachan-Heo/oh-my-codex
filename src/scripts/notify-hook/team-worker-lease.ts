import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { teamRenewTaskClaim, teamSendMessage, type RenewTaskClaimResult } from '../../team/team-ops.js';
import { resolveCanonicalTeamStateRoot } from '../../team/state-root.js';

/** Heartbeats carry the worker's captured token, never a token looked up from the current task. */
export async function renewWorkerTaskLease(
  stateRoot: string,
  teamName: string,
  workerName: string,
): Promise<RenewTaskClaimResult | null> {
  let status: { state?: string; current_task_id?: string; current_claim_token?: string };
  let config: { leader_cwd?: string };
  try {
    [status, config] = await Promise.all([
      readFile(join(stateRoot, 'team', teamName, 'workers', workerName, 'status.json'), 'utf8').then(JSON.parse),
      readFile(join(stateRoot, 'team', teamName, 'config.json'), 'utf8').then(JSON.parse),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
  if (!status || !config) return null;
  if (status.state !== 'working' || typeof status.current_task_id !== 'string' || typeof status.current_claim_token !== 'string'
    || !status.current_task_id || !status.current_claim_token) return null;
  const cwd = typeof config.leader_cwd === 'string' && config.leader_cwd ? config.leader_cwd : resolve(stateRoot, '../..');
  // Do not let a cross-worktree hook renew a different team's local state.
  if (resolveCanonicalTeamStateRoot(cwd) !== resolve(stateRoot)) return null;
  return teamRenewTaskClaim(teamName, status.current_task_id, workerName, status.current_claim_token, cwd);
}

/** Keep lease loss visible even when notify treats hook errors as non-critical. */
export async function reportWorkerTaskLeaseLoss(
  stateRoot: string,
  teamName: string,
  workerName: string,
  error: string,
): Promise<string> {
  const message = `LEASE LOST: ${teamName}/${workerName} renewal rejected (${error}). STOP editing and claim-dependent work; contact the leader. Do not adopt another token or revive an expired claim.`;
  process.stderr.write(`${message}\n`);
  const config = await readFile(join(stateRoot, 'team', teamName, 'config.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  const cwd = typeof config.leader_cwd === 'string' && config.leader_cwd ? config.leader_cwd : resolve(stateRoot, '../..');
  await writeFile(join(stateRoot, 'team', teamName, 'workers', workerName, 'lease-loss.json'), JSON.stringify({ message, error, updated_at: new Date().toISOString() })).catch((cause) => {
    process.stderr.write(`${message} Lease-loss record failed: ${String(cause)}\n`);
  });
  for (const recipient of [workerName, 'leader-fixed']) {
    await teamSendMessage(teamName, workerName, recipient, message, cwd).catch((cause) => {
      process.stderr.write(`${message} Notification to ${recipient} failed: ${String(cause)}\n`);
    });
  }
  return message;
}
