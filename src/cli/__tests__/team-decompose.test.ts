import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTeamExecutionPlan, decomposeTaskString } from '../team.js';

describe('decomposeTaskString', () => {
  it('splits conjunction-separated tasks', () => {
    const tasks = decomposeTaskString('fix tests, build UI, and write docs', 3, 'executor', false);
    assert.equal(tasks.length, 3);
    assert.match(tasks[0].subject, /fix tests/i);
    assert.match(tasks[1].subject, /build UI/i);
    assert.match(tasks[2].subject, /write docs/i);
  });

  it('assigns different roles to split tasks via heuristic routing', () => {
    const tasks = decomposeTaskString('fix tests, build UI component, and write documentation', 3, 'executor', false);
    const roles = tasks.map(t => t.role);
    const uniqueRoles = new Set(roles);
    assert.ok(uniqueRoles.size >= 2, `Expected at least 2 distinct roles, got: ${[...uniqueRoles].join(', ')}`);
  });

  it('splits numbered list tasks', () => {
    const tasks = decomposeTaskString('1. add auth 2. write tests 3. update docs', 3, 'executor', false);
    assert.equal(tasks.length, 3);
    assert.match(tasks[0].description, /add auth/i);
    assert.match(tasks[1].description, /write tests/i);
    assert.match(tasks[2].description, /update docs/i);
  });

  it('splits bulleted task lists without relying on sentence heuristics', () => {
    const tasks = decomposeTaskString('- implement worker preview\n- add verification coverage\n- update docs', 3, 'executor', false);
    assert.equal(tasks.length, 3);
    assert.match(tasks[0].description, /implement worker preview/i);
    assert.match(tasks[1].description, /verification coverage/i);
    assert.match(tasks[2].description, /update docs/i);
  });

  it('creates aspect sub-tasks for atomic tasks when the worker count is explicit', () => {
    const tasks = decomposeTaskString('implement user login', 3, 'executor', false, true);
    assert.equal(tasks.length, 3);
    assert.match(tasks[0].subject, /implement/i);
    assert.match(tasks[1].subject, /test/i);
    assert.match(tasks[2].subject, /review|document/i);
  });

  it('round-robins generated aspect subtasks when explicit same-role fanout is requested', () => {
    const tasks = decomposeTaskString('implement user login', 3, 'executor', true, true);
    assert.equal(tasks.length, 3);
    assert.deepEqual(tasks.map((task) => task.owner), ['worker-1', 'worker-2', 'worker-3']);
    assert.deepEqual(new Set(tasks.map((task) => task.role)), new Set(['executor']));
  });

  it('assigns all workers the explicit agentType when explicitAgentType=true', () => {
    const tasks = decomposeTaskString('fix tests, build UI, and write docs', 3, 'executor', true);
    assert.equal(tasks.length, 3);
    for (const t of tasks) {
      assert.equal(t.role, 'executor');
    }
  });

  it('distributes explicit same-role tasks across workers instead of collapsing to worker-1', () => {
    const tasks = decomposeTaskString('task A, task B, task C, task D', 2, 'executor', true);
    assert.equal(tasks.length, 4);
    assert.deepEqual(tasks.map((task) => task.owner), ['worker-1', 'worker-2', 'worker-1', 'worker-2']);
  });

  it('distributes explicit same-role verifier review tasks across all workers', () => {
    const tasks = decomposeTaskString(
      'review landed coverage; inspect heavy/manual doc residual risks; report blind spots and verification evidence',
      3,
      'verifier',
      true,
    );
    assert.equal(tasks.length, 3);
    assert.deepEqual(tasks.map((task) => task.owner), ['worker-1', 'worker-2', 'worker-3']);
  });

  it('clusters same-role work to preserve specialization when routing is mixed', () => {
    const tasks = decomposeTaskString('write docs, build UI component, update docs, and fix tests', 3, 'executor', false);
    assert.equal(tasks.length, 4);
    const docOwners = tasks.filter((task) => task.role === 'writer').map((task) => task.owner);
    assert.ok(docOwners.length >= 2);
    assert.equal(new Set(docOwners).size, 1);
  });

  it('handles single worker with single task', () => {
    const tasks = decomposeTaskString('fix the login bug', 1, 'executor', false);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].owner, 'worker-1');
    assert.match(tasks[0].description, /fix the login bug/);
  });

  it('handles semicolon-separated tasks', () => {
    const tasks = decomposeTaskString('analyze perf; fix bottleneck; write benchmark', 3, 'executor', false);
    assert.equal(tasks.length, 3);
    assert.match(tasks[0].description, /analyze perf/);
    assert.match(tasks[1].description, /fix bottleneck/);
    assert.match(tasks[2].description, /write benchmark/);
  });

  it('keeps long analytic prose prompts in a single-worker lane by default', () => {
    const task = 'Analyze OMX team mode reliability/efficiency weaknesses, focusing on orchestration progress detection, heartbeat/task-state coupling, tmux/state-plane brittleness, and verification gaps. Produce concrete findings with root cause, user impact, evidence pointers, and actionable recommendations suitable for a GitHub issue.';
    const plan = buildTeamExecutionPlan(task, 3, 'executor', false);
    assert.equal(plan.workerCount, 1);
    assert.equal(plan.tasks.length, 1);
    assert.equal(plan.tasks[0].owner, 'worker-1');
    assert.match(plan.tasks[0].description, /Analyze OMX team mode reliability\/efficiency weaknesses/i);
  });

  it('preserves backward compat: explicit agentType overrides routing', () => {
    const tasks = decomposeTaskString('write tests and build UI', 2, 'debugger', true);
    assert.equal(tasks[0].role, 'debugger');
    assert.equal(tasks[1].role, 'debugger');
  });

  it('uses team-executor for implicit default low-confidence team work', () => {
    const tasks = decomposeTaskString('Do the thing', 2, 'executor', false);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].role, 'team-executor');
  });

  it('keeps explicit worker-count small tasks conservative only when count is implicit', () => {
    const implicitTasks = decomposeTaskString('fix typo in README', 3, 'executor', false, false);
    assert.equal(implicitTasks.length, 1);
    assert.equal(implicitTasks[0].owner, 'worker-1');

    const explicitTasks = decomposeTaskString('fix typo in README', 3, 'executor', false, true);
    assert.equal(explicitTasks.length, 3);
  });

  it('keeps medium-sized coupled implementation prompts single-lane by default', () => {
    const task = 'Implement a staffing preview in omx team so the leader can inspect decomposition, role routing, and fanout reasons before launch.';
    const plan = buildTeamExecutionPlan(task, 3, 'executor', false);
    assert.equal(plan.workerCount, 1);
    assert.equal(plan.tasks.length, 1);
    assert.equal(plan.tasks[0].owner, 'worker-1');
  });

  it('still fans out atomic cross-cutting work when code-scoped parallelization signals are present', () => {
    const task = 'Refactor cross-cutting staffing logic across src/cli/team.ts src/team/role-router.ts src/team/runtime.ts and `buildTeamExecutionPlan` to keep verification explanations aligned.';
    const plan = buildTeamExecutionPlan(task, 3, 'executor', false);
    assert.equal(plan.workerCount, 3);
    assert.equal(plan.tasks.length, 3);
    assert.match(plan.tasks[0].subject, /^Implement:/i);
  });

  it('preserves explicit worker-count fanout for analytic prompts', () => {
    const task = 'Analyze OMX team mode reliability/efficiency weaknesses, focusing on orchestration progress detection, heartbeat/task-state coupling, tmux/state-plane brittleness, and verification gaps. Produce concrete findings with root cause, user impact, evidence pointers, and actionable recommendations suitable for a GitHub issue.';
    const plan = buildTeamExecutionPlan(task, 3, 'executor', false, true);
    assert.equal(plan.workerCount, 3);
    assert.equal(plan.tasks.length, 3);
    assert.match(plan.tasks[0].subject, /^Implement:/i);
  });

  it('keeps explicit numbered tasks fanned out even on implicit default team runs', () => {
    const tasks = decomposeTaskString('1. add team brain overlay 2. add team-executor prompt 3. add tests', 3, 'executor', false);
    assert.equal(tasks.length, 3);
  });
});
