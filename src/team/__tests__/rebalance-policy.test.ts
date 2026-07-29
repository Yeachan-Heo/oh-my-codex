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
        {
          id: '3',
          subject: 'Third UI lane',
          description: 'Implement the third surface',
          status: 'pending',
          domains: ['ui'],
          created_at: '2026-03-11T00:00:02.000Z',
        },
      ],
      workers: [
        {
          name: 'worker-1',
          alive: true,
          status: { state: 'idle', updated_at: '2026-03-11T00:00:03.000Z' },
        },
        {
          name: 'worker-2',
          alive: true,
          status: { state: 'idle', updated_at: '2026-03-11T00:00:03.000Z' },
        },
      ],
    });

    assert.deepEqual(decisions.map((decision) => decision.workerName), ['worker-1', 'worker-1', 'worker-1']);
    assert.match(decisions[1]?.reason ?? '', /file\/domain ownership/);
  });

  it('canonicalizes equivalent structured and prose path spellings during rebalance', () => {
    const decisions = buildRebalanceDecisions({
      reclaimedTaskIds: [],
      tasks: [
        {
          id: '1',
          subject: 'Parser first',
          description: 'first lane',
          status: 'pending',
          filePaths: ['./src/parser.ts'],
          created_at: '2026-03-11T00:00:00.000Z',
        },
        {
          id: '2',
          subject: 'Parser second',
          description: 'second lane',
          status: 'pending',
          filePaths: ['src/./parser.ts'],
          created_at: '2026-03-11T00:00:01.000Z',
        },
        {
          id: '3',
          subject: 'Parser third',
          description: 'Continue src/parser.ts.',
          status: 'pending',
          created_at: '2026-03-11T00:00:02.000Z',
        },
        {
          id: '4',
          subject: 'Parser fourth',
          description: 'Continue ./src/parser.ts',
          status: 'pending',
          created_at: '2026-03-11T00:00:03.000Z',
        },
        {
          id: '5',
          subject: 'Parser fifth',
          description: 'Continue src\\parser.ts.',
          status: 'pending',
          created_at: '2026-03-11T00:00:04.000Z',
        },
      ],
      workers: Array.from({ length: 5 }, (_, index) => ({
        name: `worker-${index + 1}`,
        alive: true,
        status: { state: 'idle' as const, updated_at: '2026-03-11T00:00:05.000Z' },
      })),
    });

    assert.deepEqual(decisions.map((decision) => decision.workerName), Array(5).fill('worker-1'));
  });

  it('distributes rebalance work whose exact paths share only a basename', () => {
    const decisions = buildRebalanceDecisions({
      reclaimedTaskIds: [],
      tasks: [
        {
          id: '1',
          subject: 'Client entry',
          description: 'client lane',
          status: 'pending',
          filePaths: ['src/client/index.ts'],
          created_at: '2026-03-11T00:00:00.000Z',
        },
        {
          id: '2',
          subject: 'Server entry',
          description: 'server lane',
          status: 'pending',
          filePaths: ['src/server/index.ts'],
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

    assert.deepEqual(decisions.map((decision) => decision.workerName), ['worker-1', 'worker-2']);
  });

  it('preserves exact file affinity under repeated rebalance load', () => {
    const decisions = buildRebalanceDecisions({
      reclaimedTaskIds: [],
      tasks: Array.from({ length: 6 }, (_, index) => ({
        id: String(index + 1),
        subject: `Runtime lane ${index + 1}`,
        description: `unique work item ${index + 1}`,
        status: 'pending' as const,
        filePaths: ['src/team/runtime.ts'],
        created_at: `2026-03-11T00:00:0${index}.000Z`,
      })),
      workers: [
        {
          name: 'worker-1',
          alive: true,
          status: { state: 'idle', updated_at: '2026-03-11T00:00:06.000Z' },
        },
        {
          name: 'worker-2',
          alive: true,
          status: { state: 'idle', updated_at: '2026-03-11T00:00:06.000Z' },
        },
      ],
    });

    assert.deepEqual(decisions.map((decision) => decision.workerName), Array(6).fill('worker-1'));
  });

  it('preserves seeded in-flight file and short-domain affinity during rebalance', () => {
    const decisions = buildRebalanceDecisions({
      reclaimedTaskIds: [],
      tasks: [
        {
          id: '9',
          subject: 'Existing UI runtime lane',
          description: 'Current in-flight ownership',
          status: 'in_progress',
          owner: 'worker-1',
          filePaths: ['src/team/runtime.ts'],
          domains: ['ui'],
          created_at: '2026-03-11T00:00:00.000Z',
        },
        {
          id: '1',
          subject: 'UI follow-up',
          description: 'Continue the UI domain',
          status: 'pending',
          domains: ['ui'],
          created_at: '2026-03-11T00:00:01.000Z',
        },
        {
          id: '2',
          subject: 'Runtime follow-up',
          description: 'Continue the runtime file',
          status: 'pending',
          filePaths: ['src/team/runtime.ts'],
          created_at: '2026-03-11T00:00:02.000Z',
        },
      ],
      workers: [
        {
          name: 'worker-1',
          alive: true,
          status: { state: 'idle', updated_at: '2026-03-11T00:00:03.000Z' },
        },
        {
          name: 'worker-2',
          alive: true,
          status: { state: 'idle', updated_at: '2026-03-11T00:00:03.000Z' },
        },
      ],
    });

    assert.deepEqual(decisions.map((decision) => decision.workerName), ['worker-1', 'worker-1']);
    assert.match(decisions[0]?.reason ?? '', /file\/domain ownership/);
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
