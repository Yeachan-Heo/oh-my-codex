import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import { allocateTasksToWorkers, chooseTaskOwner } from '../allocation-policy.js';

describe('allocation-policy', () => {
  it('prefers matching worker role when no prior assignments exist', () => {
    const decision = chooseTaskOwner(
      { subject: 'write docs', description: 'document the feature', role: 'writer' },
      [
        { name: 'worker-1', role: 'executor' },
        { name: 'worker-2', role: 'writer' },
      ],
      [],
    );

    assert.equal(decision.owner, 'worker-2');
    assert.match(decision.reason, /matches worker role writer/);
  });

  it('clusters same-role tasks on a specialized lane before spilling over', () => {
    const assignments = allocateTasksToWorkers(
      [
        { subject: 'write docs 1', description: 'd1', role: 'writer' },
        { subject: 'write docs 2', description: 'd2', role: 'writer' },
        { subject: 'implement feature', description: 'd3', role: 'executor' },
      ],
      [
        { name: 'worker-1', role: 'executor' },
        { name: 'worker-2', role: 'writer' },
        { name: 'worker-3', role: 'test-engineer' },
      ],
    );

    assert.equal(assignments[0].owner, 'worker-2');
    assert.equal(assignments[1].owner, 'worker-2');
    assert.equal(assignments[2].owner, 'worker-1');
  });

  it('falls back to load balancing when roles do not differentiate the work', () => {
    const assignments = allocateTasksToWorkers(
      [
        { subject: 'task a', description: 'a' },
        { subject: 'task b', description: 'b' },
        { subject: 'task c', description: 'c' },
      ],
      [
        { name: 'worker-1' },
        { name: 'worker-2' },
      ],
    );

    assert.deepEqual(assignments.map((task) => task.owner), ['worker-1', 'worker-2', 'worker-1']);
  });
});
