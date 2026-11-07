import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { teamReadTask, teamRenewTaskClaim, teamSendMessage, type RenewTaskClaimResult, type TeamTask } from '../../team/team-ops.js';
import { resolveCanonicalTeamStateRoot } from '../../team/state-root.js';

type WorkerTaskLeaseRenewalResult = RenewTaskClaimResult
  | { ok: false; error: string }
  // Local automatic-hook outcome only: terminal handoff grants no lease or editing authority.
  | { ok: true; task: TeamTask; terminalHandoff: true };

/** Heartbeats carry the worker's captured token, never a token looked up from the current task. */
export async function renewWorkerTaskLease(
  stateRoot: string,
  teamName: string,
  workerName: string,
): Promise<WorkerTaskLeaseRenewalResult | null> {
  let status: { state?: string; current_task_id?: string; current_claim_token?: string };
  try {
    status = JSON.parse(await readFile(join(stateRoot, 'team', teamName, 'workers', workerName, 'status.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
    return { ok: false, error: `renewal_error:${String(error)}` };
  }
  if (!status) return null;
  if (status.state !== 'working' || typeof status.current_task_id !== 'string' || typeof status.current_claim_token !== 'string'
    || !status.current_task_id || !status.current_claim_token) return null;
  try {
    const config = JSON.parse(await readFile(join(stateRoot, 'team', teamName, 'config.json'), 'utf8'));
    const cwd = typeof config.leader_cwd === 'string' && config.leader_cwd ? config.leader_cwd : resolve(stateRoot, '../..');
    // Do not let a cross-worktree hook renew a different team's local state.
    if (resolveCanonicalTeamStateRoot(cwd) !== resolve(stateRoot)) return null;
    const renewal = await teamRenewTaskClaim(teamName, status.current_task_id, workerName, status.current_claim_token, cwd);
    if (!renewal.ok && renewal.error === 'already_terminal') {
      const task = await teamReadTask(teamName, status.current_task_id, cwd);
      if (task && (task.status === 'completed' || task.status === 'failed') && task.owner === workerName && !task.claim) {
        return { ok: true, task, terminalHandoff: true };
      }
    }
    return renewal;
  } catch (error) {
    // Automatic callers must report STOP, not lose renewal exceptions in their outer hook catch.
    return { ok: false, error: `renewal_error:${String(error)}` };
  }
}

/** Keep lease loss visible even when notify treats hook errors as non-critical. */
export async function reportWorkerTaskLeaseLoss(
  stateRoot: string,
  teamName: string,
  workerName: string,
  error: string,
): Promise<string> {
  const message = `LEASE LOST: ${teamName}/${workerName} renewal rejected (${error}). STOP editing and claim-dependent work; contact the leader. Do not adopt another token or revive an expired claim.`;
  const warn = (detail = ''): void => {
    try { process.stderr.write(`${message}${detail}\n`); } catch { /* Diagnostics must not erase the returned STOP. */ }
  };
  warn();
  const config = await readFile(join(stateRoot, 'team', teamName, 'config.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  const cwd = typeof config?.leader_cwd === 'string' && config.leader_cwd ? config.leader_cwd : resolve(stateRoot, '../..');
  await writeFile(join(stateRoot, 'team', teamName, 'workers', workerName, 'lease-loss.json'), JSON.stringify({ message, error, updated_at: new Date().toISOString() })).catch((cause) => {
    warn(` Lease-loss record failed: ${String(cause)}`);
  });
  for (const recipient of [workerName, 'leader-fixed']) {
    await teamSendMessage(teamName, workerName, recipient, message, cwd).catch((cause) => {
      warn(` Notification to ${recipient} failed: ${String(cause)}`);
    });
  }
  return message;
}
