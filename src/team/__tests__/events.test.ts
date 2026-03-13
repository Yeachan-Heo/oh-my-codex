import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initTeamState, appendTeamEvent } from '../state.js';
import { readTeamEvents, waitForTeamEvent } from '../state/events.js';

async function setupTeam(name: string): Promise<{ cwd: string; cleanup: () => Promise<void> }> {
  const cwd = await mkdtemp(join(tmpdir(), `omx-team-events-${name}-`));
  await initTeamState(name, 'event test', 'executor', 2, cwd);
  return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}

describe('team/state/events', () => {
  it('reads canonical filtered events', async () => {
    const { cwd, cleanup } = await setupTeam('canonical-filter');
    try {
      const baseline = await appendTeamEvent('canonical-filter', {
        type: 'task_completed',
        worker: 'worker-2',
        task_id: '2',
      }, cwd);
      await appendTeamEvent('canonical-filter', {
        type: 'worker_idle',
        worker: 'worker-1',
        task_id: '1',
        prev_state: 'working',
      }, cwd);

      const events = await readTeamEvents('canonical-filter', cwd, {
        afterEventId: baseline.event_id,
        type: 'worker_idle',
        worker: 'worker-1',
        taskId: '1',
      });

      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, 'worker_state_changed');
      assert.equal(events[0]?.source_type, 'worker_idle');
      assert.equal(events[0]?.worker, 'worker-1');
      assert.equal(events[0]?.task_id, '1');
    } finally {
      await cleanup();
    }
  });



  it('treats merge conflicts and stale alerts as wakeable while keeping diff reports audit-only', async () => {
    const { cwd, cleanup } = await setupTeam('wakeable-matrix');
    try {
      const baseline = await appendTeamEvent('wakeable-matrix', {
        type: 'worker_diff_report',
        worker: 'worker-1',
        task_id: '1',
        reason: 'diff persisted',
        metadata: {
          worktree_path: '/tmp/team/worktrees/worker-1',
          diff_path: '/tmp/team/worktrees/worker-1/.omx/diff.md',
        },
      }, cwd);
      await appendTeamEvent('wakeable-matrix', {
        type: 'worker_merge_conflict',
        worker: 'worker-1',
        task_id: '1',
        reason: 'merge conflict',
        metadata: {
          worktree_path: '/tmp/team/worktrees/worker-1',
          diff_path: '/tmp/team/worktrees/worker-1/.omx/diff.md',
        },
      }, cwd);
      await appendTeamEvent('wakeable-matrix', {
        type: 'worker_stale_stdout',
        worker: 'worker-2',
        reason: 'stdout stale',
        metadata: {
          stale_window_ms: 30000,
        },
      }, cwd);

      const wakeable = await readTeamEvents('wakeable-matrix', cwd, {
        afterEventId: baseline.event_id,
        wakeableOnly: true,
      });
      assert.deepEqual(
        wakeable.map((event) => event.type),
        ['worker_merge_conflict', 'worker_stale_stdout'],
      );
      assert.equal(wakeable[0]?.metadata?.diff_path, '/tmp/team/worktrees/worker-1/.omx/diff.md');
      assert.equal(wakeable[1]?.metadata?.stale_window_ms, 30000);

      const all = await readTeamEvents('wakeable-matrix', cwd, {
        afterEventId: baseline.event_id,
        wakeableOnly: false,
      });
      assert.deepEqual(
        all.map((event) => event.type),
        ['worker_merge_conflict', 'worker_stale_stdout'],
      );
    } finally {
      await cleanup();
    }
  });

  it('waits for the next matching filtered event', async () => {
    const { cwd, cleanup } = await setupTeam('await-filter');
    try {
      const waitPromise = waitForTeamEvent('await-filter', cwd, {
        timeoutMs: 500,
        pollMs: 25,
        wakeableOnly: false,
        type: 'task_completed',
        worker: 'worker-1',
        taskId: '1',
      });

      setTimeout(() => {
        void appendTeamEvent('await-filter', {
          type: 'worker_state_changed',
          worker: 'worker-2',
          task_id: '2',
          state: 'working',
        }, cwd);
      }, 25);

      setTimeout(() => {
        void appendTeamEvent('await-filter', {
          type: 'task_completed',
          worker: 'worker-1',
          task_id: '1',
        }, cwd);
      }, 60);

      const result = await waitPromise;
      assert.equal(result.status, 'event');
      assert.equal(result.event?.type, 'task_completed');
      assert.equal(result.event?.worker, 'worker-1');
      assert.equal(result.event?.task_id, '1');
    } finally {
      await cleanup();
    }
  });

  it('preserves metadata for diff and merge events while filtering wakeable events correctly', async () => {
    const { cwd, cleanup } = await setupTeam('metadata-wakeable');
    try {
      await appendTeamEvent('metadata-wakeable', {
        type: 'worker_diff_report',
        worker: 'worker-1',
        metadata: {
          summary: 'worker diff report',
          worktree_path: '/tmp/team/worktrees/worker-1',
          diff_path: '/tmp/team/worktrees/worker-1/.omx/diff.md',
          full_diff_available: true,
        },
      }, cwd);
      await appendTeamEvent('metadata-wakeable', {
        type: 'worker_merge_conflict',
        worker: 'worker-1',
        metadata: {
          summary: 'merge conflict',
          worktree_path: '/tmp/team/worktrees/worker-1',
          conflict_files: ['src/team/runtime.ts'],
        },
      }, cwd);
      await appendTeamEvent('metadata-wakeable', {
        type: 'worker_stale_stdout',
        worker: 'worker-1',
        metadata: {
          summary: 'stdout stale',
          stale_window_ms: 60_000,
        },
      }, cwd);

      const allEvents = await readTeamEvents('metadata-wakeable', cwd, { wakeableOnly: false });
      const diffReport = allEvents.find((event) => event.type === 'worker_diff_report');
      const mergeConflict = allEvents.find((event) => event.type === 'worker_merge_conflict');
      const staleStdout = allEvents.find((event) => event.type === 'worker_stale_stdout');

      assert.equal(diffReport?.metadata?.summary, 'worker diff report');
      assert.equal(diffReport?.metadata?.diff_path, '/tmp/team/worktrees/worker-1/.omx/diff.md');
      assert.equal(mergeConflict?.metadata?.summary, 'merge conflict');
      assert.deepEqual(mergeConflict?.metadata?.conflict_files, ['src/team/runtime.ts']);
      assert.equal(staleStdout?.metadata?.stale_window_ms, 60_000);

      const wakeableEvents = await readTeamEvents('metadata-wakeable', cwd, { wakeableOnly: true });
      assert.equal(wakeableEvents.some((event) => event.type === 'worker_diff_report'), false);
      assert.equal(wakeableEvents.some((event) => event.type === 'worker_merge_conflict'), true);
      assert.equal(wakeableEvents.some((event) => event.type === 'worker_stale_stdout'), true);
    } finally {
      await cleanup();
    }
  });
});
