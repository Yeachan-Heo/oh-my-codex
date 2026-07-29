import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRebalanceDecisions } from '../rebalance-policy.js';

describe('rebalance-policy', () => {
  it('prioritizes reclaimed pending work and emits explicit assign actions with reasons', () => {
    const decisions = buildRebalanceDecisions({
      reclaimedTaskIds: ['2'],
      tasks: [
        {
          id: '1',
          subject: 'Existing UI work',
          description: 'continue designer lane',
          status: 'in_progress',
          owner: 'worker-1',
          role: 'designer',
          created_at: '2026-03-11T00:00:00.000Z',
        },
        {
          id: '2',
          subject: 'Recovered test task',
          description: 'reclaimed after lease expiry',
          status: 'pending',
          role: 'test-engineer',
          created_at: '2026-03-11T00:00:01.000Z',
        },
        {
          id: '3',
          subject: 'Unowned UI polish',
          description: 'idle pickup candidate',
          status: 'pending',
          role: 'designer',
          created_at: '2026-03-11T00:00:02.000Z',
        },
      ],
      workers: [
        {
          name: 'worker-1',
          alive: true,
          status: { state: 'working', current_task_id: '1', updated_at: '2026-03-11T00:00:00.000Z' },
        },
        {
          name: 'worker-2',
          alive: true,
          status: { state: 'idle', updated_at: '2026-03-11T00:00:00.000Z' },
        },
      ],
    });

    assert.deepEqual(decisions, [
      {
        type: 'assign',
        taskId: '2',
        workerName: 'worker-2',
        reason: 'reclaimed work is ready; balances current load',
      },
      {
        type: 'assign',
        taskId: '3',
        workerName: 'worker-2',
        reason: 'idle worker pickup; balances current load',
      },
    ]);
  });

  it('skips pending work whose dependencies are not yet completed', () => {
    const decisions = buildRebalanceDecisions({
      reclaimedTaskIds: [],
      tasks: [
        {
          id: '1',
          subject: 'Blocked follow-up',
          description: 'waits for task 9',
          status: 'pending',
          role: 'executor',
          depends_on: ['9'],
          created_at: '2026-03-11T00:00:00.000Z',
        },
        {
          id: '9',
          subject: 'Prerequisite',
          description: 'still running',
          status: 'in_progress',
          owner: 'worker-1',
          role: 'executor',
          created_at: '2026-03-11T00:00:01.000Z',
        },
      ],
      workers: [
        {
          name: 'worker-2',
          alive: true,
          status: { state: 'idle', updated_at: '2026-03-11T00:00:00.000Z' },
        },
      ],
    });

    assert.deepEqual(decisions, []);
  });

  it('prefers specialized lanes for reclaimed work before lighter generic lanes', () => {
    const decisions = buildRebalanceDecisions({
      reclaimedTaskIds: ['7'],
      tasks: [
        {
          id: '1',
          subject: 'Existing docs lane',
          description: 'writer still active',
          status: 'in_progress',
          owner: 'worker-1',
          role: 'writer',
          created_at: '2026-03-11T00:00:00.000Z',
        },
        {
          id: '7',
          subject: 'Recovered docs follow-up',
          description: 'same writer domain',
          status: 'pending',
          role: 'writer',
          created_at: '2026-03-11T00:00:01.000Z',
        },
      ],
      workers: [
        {
          name: 'worker-1',
          alive: true,
          status: { state: 'idle', updated_at: '2026-03-11T00:00:02.000Z' },
          role: 'writer',
        },
        {
          name: 'worker-2',
          alive: true,
          status: { state: 'idle', updated_at: '2026-03-11T00:00:02.000Z' },
          role: 'executor',
        },
      ],
    });

    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.type, 'assign');
    assert.equal(decisions[0]?.taskId, '7');
    assert.equal(decisions[0]?.workerName, 'worker-1');
    assert.match(decisions[0]?.reason ?? '', /reclaimed work is ready; (keeps writer work grouped|matches worker role writer)/);
  });

  it('preserves short explicit domain affinity across rebalance decisions', () => {
    const decisions = buildRebalanceDecisions({
      reclaimedTaskIds: [],
      tasks: [
        {
          id: '1',
          subject: 'First UI lane',
          description: 'Implement the first surface',
          status: 'pending',
          domains: ['ui'],
          created_at: '2026-03-11T00:00:00.000Z',
        },
        {
          id: '2',
          subject: 'Second UI lane',
          description: 'Implement the second surface',
          status: 'pending',
          domains: ['ui'],
          created_at: '2026-03-11T00:00:01.000Z',
        },
      ],
      workers: [
        {
          name: 'worker-1',
          alive: true,
          status: { state: 'idle', updated_at: '2026-03-11T00:00:02.000Z' },
        },
        {
          name: 'worker-2',
          alive: true,
          status: { state: 'idle', updated_at: '2026-03-11T00:00:02.000Z' },
        },
      ],
    });

    assert.deepEqual(decisions.map((decision) => decision.workerName), ['worker-1', 'worker-1']);
    assert.match(decisions[1]?.reason ?? '', /file\/domain ownership/);
  });

  it('does not assign work when no live idle worker is available', () => {
    const decisions = buildRebalanceDecisions({
      reclaimedTaskIds: ['4'],
      tasks: [
        {
          id: '4',
          subject: 'Recovered task',
          description: 'should wait for a worker',
          status: 'pending',
          role: 'executor',
          created_at: '2026-03-11T00:00:00.000Z',
        },
      ],
      workers: [
        {
          name: 'worker-1',
          alive: false,
          status: { state: 'unknown', updated_at: '2026-03-11T00:00:00.000Z' },
        },
        {
          name: 'worker-2',
          alive: true,
          status: { state: 'working', current_task_id: '1', updated_at: '2026-03-11T00:00:00.000Z' },
        },
      ],
    });

    assert.deepEqual(decisions, []);
  });
});
