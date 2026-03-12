import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { initTeamState, createTask, claimTask, readTask, writeAtomic } from '../state.js';
import { monitorTeam } from '../runtime.js';
import { planWorktreeTarget, ensureWorktree } from '../worktree.js';

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-team-hardening-e2e-repo-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
  await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
  return cwd;
}

describe('team hardening e2e', () => {
  it('reopens an expired in-progress task and allows the next worker to complete the flow', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-hardening-e2e-'));
    try {
      await initTeamState('team-hardening-e2e', 'recover stuck work', 'executor', 2, cwd);
      const task = await createTask('team-hardening-e2e', { subject: 'recover me', description: 'd', status: 'pending' }, cwd);
      const firstClaim = await claimTask('team-hardening-e2e', task.id, 'worker-1', task.version ?? 1, cwd);
      assert.equal(firstClaim.ok, true);
      if (!firstClaim.ok) return;

      const taskPath = join(cwd, '.omx', 'state', 'team', 'team-hardening-e2e', 'tasks', `task-${task.id}.json`);
      const current = JSON.parse(await readFile(taskPath, 'utf-8')) as any;
      current.claim.leased_until = new Date(Date.now() - 1_000).toISOString();
      await writeAtomic(taskPath, JSON.stringify(current, null, 2));

      const snapshot = await monitorTeam('team-hardening-e2e', cwd);
      assert.ok(snapshot);
      assert.equal(snapshot?.recommendations.some((r) => r.includes(`task-${task.id}`) && r.includes('Reclaimed expired claim')), true);

      const reopened = await readTask('team-hardening-e2e', task.id, cwd);
      assert.equal(reopened?.status, 'pending');
      assert.equal(reopened?.claim, undefined);

      const secondClaim = await claimTask('team-hardening-e2e', task.id, 'worker-2', reopened?.version ?? null, cwd);
      assert.equal(secondClaim.ok, true);
      assert.equal((secondClaim.ok && secondClaim.task.owner) || null, 'worker-2');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('refuses dirty worktree reuse in a realistic git-backed flow', async () => {
    const repo = await initRepo();
    try {
      const plan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: true, name: null },
      });
      assert.equal(plan.enabled, true);
      if (!plan.enabled) return;

      const first = ensureWorktree(plan);
      assert.equal(first.enabled, true);
      if (!first.enabled) return;

      await writeFile(join(first.worktreePath, 'DIRTY.txt'), 'dirty\n', 'utf-8');
      assert.throws(() => ensureWorktree(plan), /worktree_dirty/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
