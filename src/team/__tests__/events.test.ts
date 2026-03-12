import { describe, it } from 'bun:test';
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
});
