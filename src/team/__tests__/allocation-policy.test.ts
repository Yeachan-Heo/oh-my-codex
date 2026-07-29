import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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

  it('prefers a lighter lane for blocked work', () => {
    const decision = chooseTaskOwner(
      { subject: 'resolve merge', description: 'blocked on task 1', blocked_by: ['1'] },
      [
        { name: 'worker-1', role: 'executor' },
        { name: 'worker-2', role: 'executor' },
      ],
      [
        { owner: 'worker-1', role: 'executor' },
        { owner: 'worker-1', role: 'executor' },
      ],
    );

    assert.equal(decision.owner, 'worker-2');
    assert.match(decision.reason, /lighter lane/);
  });

  it('load-balances same-role work when every worker shares the same role', () => {
    const assignments = allocateTasksToWorkers(
      [
        { subject: 'alpha', description: 'd1', role: 'executor' },
        { subject: 'beta', description: 'd2', role: 'executor' },
        { subject: 'gamma', description: 'd3', role: 'executor' },
      ],
      [
        { name: 'worker-1', role: 'executor' },
        { name: 'worker-2', role: 'executor' },
      ],
    );

    assert.deepEqual(assignments.map((task) => task.owner), ['worker-1', 'worker-2', 'worker-1']);
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

  it('does not let shared prose collapse independent generic-worker lanes', () => {
    const assignments = allocateTasksToWorkers(
      [
        { subject: 'Foundation', description: 'Implement shared light theme tokens and navigation', role: 'designer' },
        { subject: 'Console', description: 'Implement light theme surfaces for console navigation', role: 'designer' },
        { subject: 'Public proof', description: 'Apply the shared light theme to proof surfaces', role: 'researcher' },
        { subject: 'Metrics', description: 'Apply the shared light theme to metrics surfaces', role: 'quality-reviewer' },
      ],
      [
        { name: 'worker-1' },
        { name: 'worker-2' },
        { name: 'worker-3' },
        { name: 'worker-4' },
      ],
    );

    assert.deepEqual(assignments.map((task) => task.owner), ['worker-1', 'worker-2', 'worker-3', 'worker-4']);
  });

  it('preserves short explicit domain affinity as generic-worker load grows', () => {
    const assignments = allocateTasksToWorkers(
      [
        { subject: 'alpha', description: 'first lane', domains: ['ui'] },
        { subject: 'beta', description: 'second lane', domains: ['ui'] },
        { subject: 'gamma', description: 'third lane', domains: ['ui'] },
      ],
      [
        { name: 'worker-1' },
        { name: 'worker-2' },
      ],
    );

    assert.deepEqual(assignments.map((task) => task.owner), ['worker-1', 'worker-1', 'worker-1']);
    assert.match(assignments[2].allocation_reason, /file\/domain ownership/);
  });

  it('preserves explicit file affinity after repeated generic-worker assignments', () => {
    const assignments = allocateTasksToWorkers(
      Array.from({ length: 6 }, (_, index) => ({
        subject: `runtime lane ${index + 1}`,
        description: `unique work item ${index + 1}`,
        filePaths: ['src/team/runtime.ts'],
      })),
      [
        { name: 'worker-1' },
        { name: 'worker-2' },
      ],
    );

    assert.deepEqual(assignments.map((task) => task.owner), Array(6).fill('worker-1'));
  });

  it('canonicalizes equivalent structured and prose path spellings before assigning affinity', () => {
    const assignments = allocateTasksToWorkers(
      [
        { subject: 'parser first', description: 'first lane', filePaths: ['./src/parser.ts'] },
        { subject: 'parser second', description: 'second lane', filePaths: ['src/./parser.ts'] },
        { subject: 'parser third', description: 'Continue src/parser.ts.' },
        { subject: 'parser fourth', description: 'Continue ./src/parser.ts' },
        { subject: 'parser fifth', description: 'Continue src\\parser.ts.' },
      ],
      [
        { name: 'worker-1' },
        { name: 'worker-2' },
        { name: 'worker-3' },
        { name: 'worker-4' },
        { name: 'worker-5' },
      ],
    );

    assert.deepEqual(assignments.map((task) => task.owner), Array(5).fill('worker-1'));
  });

  it('distributes different exact paths that share only a basename hint', () => {
    const assignments = allocateTasksToWorkers(
      [
        { subject: 'client entry', description: 'client lane', filePaths: ['src/client/index.ts'] },
        { subject: 'server entry', description: 'server lane', filePaths: ['src/server/index.ts'] },
      ],
      [
        { name: 'worker-1' },
        { name: 'worker-2' },
      ],
    );

    assert.deepEqual(assignments.map((task) => task.owner), ['worker-1', 'worker-2']);
  });

  it('keeps related file-path work on the same worker to reduce overlap', () => {
    const assignments = allocateTasksToWorkers(
      [
        {
          subject: 'Runtime integration lane',
          description: 'Implement incremental integration in src/team/runtime.ts and src/team/mcp-comm.ts',
          role: 'executor',
        },
        {
          subject: 'Runtime follow-up lane',
          description: 'Add more runtime coverage for src/team/runtime.ts conflict handling',
          role: 'executor',
        },
        {
          subject: 'Allocation lane',
          description: 'Adjust heuristics in src/team/allocation-policy.ts',
          role: 'executor',
        },
      ],
      [
        { name: 'worker-1', role: 'executor' },
        { name: 'worker-2', role: 'executor' },
        { name: 'worker-3', role: 'executor' },
      ],
    );

    assert.equal(assignments[0].owner, 'worker-1');
    assert.equal(assignments[1].owner, 'worker-1');
    assert.equal(assignments[2].owner, 'worker-2');
    assert.match(assignments[1].allocation_reason, /low-overlap file\/domain ownership/);
  });

  it('uses explicit file and domain hints when available', () => {
    const decision = chooseTaskOwner(
      {
        subject: 'follow-up',
        description: 'continue work',
        role: 'executor',
        filePaths: ['src/team/runtime.ts'],
        domains: ['notifications'],
      },
      [
        { name: 'worker-1', role: 'executor' },
        { name: 'worker-2', role: 'executor' },
      ],
      [
        {
          owner: 'worker-2',
          role: 'executor',
          subject: 'notifications',
          description: 'Update notify handling',
          filePaths: ['src/team/runtime.ts'],
          domains: ['notifications'],
        },
      ],
    );

    assert.equal(decision.owner, 'worker-2');
    assert.match(decision.reason, /low-overlap file\/domain ownership/);
  });
});
