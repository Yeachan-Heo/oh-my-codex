import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decomposeTaskString } from '../team.js';

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
    // Should have at least 2 distinct roles (test-related, UI-related, doc-related)
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

  it('creates aspect sub-tasks for atomic tasks with multiple workers', () => {
    const tasks = decomposeTaskString('implement user login', 3, 'executor', false);
    assert.equal(tasks.length, 3);
    assert.match(tasks[0].subject, /implement/i);
    assert.match(tasks[1].subject, /test/i);
    assert.match(tasks[2].subject, /review|document/i);
  });

  it('assigns all workers the explicit agentType when explicitAgentType=true', () => {
    const tasks = decomposeTaskString('fix tests, build UI, and write docs', 3, 'executor', true);
    assert.equal(tasks.length, 3);
    for (const t of tasks) {
      assert.equal(t.role, 'executor');
    }
  });

  it('distributes tasks across workers round-robin', () => {
    const tasks = decomposeTaskString('task A, task B, task C, task D', 2, 'executor', true);
    assert.equal(tasks.length, 4);
    assert.equal(tasks[0].owner, 'worker-1');
    assert.equal(tasks[1].owner, 'worker-2');
    assert.equal(tasks[2].owner, 'worker-1');
    assert.equal(tasks[3].owner, 'worker-2');
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

  it('keeps long prose prompts intact instead of shattering them into sentence fragments', () => {
    const task = 'Analyze OMX team mode reliability/efficiency weaknesses, focusing on orchestration progress detection, heartbeat/task-state coupling, tmux/state-plane brittleness, and verification gaps. Produce concrete findings with root cause, user impact, evidence pointers, and actionable recommendations suitable for a GitHub issue.';
    const tasks = decomposeTaskString(task, 3, 'executor', false);
    assert.equal(tasks.length, 3);
    assert.match(tasks[0].subject, /^Implement:/i);
    assert.match(tasks[1].subject, /^Test:/i);
    assert.match(tasks[2].subject, /^Review and document:/i);
  });

  it('preserves backward compat: explicit agentType overrides routing', () => {
    const tasks = decomposeTaskString('write tests and build UI', 2, 'debugger', true);
    assert.equal(tasks[0].role, 'debugger');
    assert.equal(tasks[1].role, 'debugger');
  });
});
