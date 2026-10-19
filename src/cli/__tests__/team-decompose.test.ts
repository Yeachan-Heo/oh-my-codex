import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTeamExecutionPlan, decomposeTaskString } from '../team.js';

describe('decomposeTaskString', () => {
  it('preserves analysis list items and carries their header into each task', () => {
    for (const header of ['Analyze these subsystems:', 'Analyze API latency and cache latency:', 'Analyze release', 'Analyze Node']) {
      for (const items of ['- API latency\n- cache latency', '1. API latency\n2. cache latency']) {
        for (const count of [1, 4]) {
          const plan = buildTeamExecutionPlan(`${header}\n${items}`, count, 'executor', false, true);
          assert.deepEqual(plan.tasks.map(task => task.subject), ['API latency', 'cache latency']);
          assert.ok(plan.tasks.every(task => task.description.startsWith(`${header}\n`)));
          assert.ok(plan.tasks.every(task => task.requires_code_change === false));
        }
      }
    }
  });

  it('preserves a follow-up implementation request after the final analysis list item', () => {
    for (const items of ['- API latency\n- cache latency', '1. API latency\n2. cache latency']) {
      for (const count of [1, 4]) {
        const prompt = `Analyze these subsystems:\n${items}\nThen implement the approved cache fix`;
        const plan = buildTeamExecutionPlan(prompt, count, 'executor', false, true);
        assert.equal(plan.tasks.length, 2);
        assert.deepEqual(plan.tasks.map(task => task.requires_code_change), [false, true]);
        assert.ok(plan.tasks.every(task => task.description.startsWith('Analyze these subsystems:\n')));
        assert.equal(plan.tasks.filter(task => task.description.includes('Then implement the approved cache fix')).length, 1);
      }
    }
  });

  it('keeps quoted report destinations intact during task splitting', () => {
    const prompt = 'Write a report to "latency and update findings.md"';
    for (const count of [1, 4]) {
      const plan = buildTeamExecutionPlan(prompt, count, 'executor', false, true);
      assert.ok(plan.tasks.every(task => task.description.includes('"latency and update findings.md"')));
    }
  });

  it('keeps labels and options read-only while gating repository report writes', () => {
    for (const [prompt, required] of [
      ['Analyze request latency and write findings to docs/latency-report.md', true],
      ['Write findings to README.', true],
      ['Task: Write findings to README.', true],
      ['Write a report to "latency and findings.md"', true],
      ['Write a report to "Latency Report. Final.md"', true],
      ['Write a report to "latency and update findings.md"', true],
      ['Explain how caching works, but please apply the approved fix', true],
      ['Explain how caching works, but apply the approved fix', true],
      ['Explain how caching works but apply the approved fix', true],
      ['How does caching work but fix the broken cache with regression tests', false],
      ['Explain why we add retries but remove failed jobs', false],
      ['How does caching work, but fix the broken cache with regression tests', true],
      ['Explain these steps: 1. add retries 2. update tests, but apply the approved fix', true],
      ['How does caching work, but why does it fail?', false],
      ['Explain why caching improves latency but updating tests does not improve runtime performance', false],
      ['Explain why refactoring improves maintainability, but adding caches increases memory usage', false],
      ['Why do we add retries but remove failed jobs?', false],
      ['Why does the server add retries but remove failed jobs?', false],
      ['Why does it add retries but remove failed jobs?', false],
      ['How does the server add retries but remove failed jobs?', false],
      ['When does the server add retries but remove failed jobs?', false],
      ['Evaluate options: retain the package but modify the adapter', false],
      ['Evaluate options: 1. retain the package but modify the adapter', false],
      ['Explain these steps: 1. add retries 2. update tests, but please apply the approved fix', true],
      ['Investigate the TypeScript build failure and apply the approved patch', true],
      ['How does the TypeScript build work, and can you please fix the compilation error?', true],
      ['Write findings to README', true],
      ['Write findings to: docs/report.md', true],
      ['Write findings to:\ndocs/report.md', true],
      ['Write a report to "latency report.md"', true],
      ['Write a report to `latency report.md`', true],
      ['Write findings to a Markdown file named report.md', true],
      ['Write findings to a file', true],
      ['Analyze request latency and save the findings to docs/latency-report.md', true],
      ['Write a report about the API in src/api.ts without changing files', false],
      ['Evaluate package options:\n- replace package A\n- modify the adapter\n- retain the current package', false],
      ['Evaluate package options: 1. replace package A 2. modify the adapter 3. retain the current package', false],
      ['Evaluate package options:\n- replace package A\n- retain the current package\nThen implement the approved option', true],
      ['Task: Analyze request latency', false],
      ['Task: Explain how to fix the cache and update tests', false],
      ['Evaluate package options: replace package A, modify the adapter, or retain the current package', false],
      ['Evaluate package options: replace package A or retain it, then implement the approved option', true],
    ] as const) {
      for (const count of [1, 4]) {
        const plan = buildTeamExecutionPlan(prompt, count, 'executor', false, true);
        assert.equal(plan.tasks.some(task => task.requires_code_change), required, prompt);
      }
    }
  });

  it('classifies localized mutations, explanatory questions, and subordinate coding requests', () => {
    for (const [prompt, required, expectedFlags] of [
      ['빌드 오류 수정', true],
      ['Investigate how to resolve authentication failures before implementing a fix with regression tests', true],
      ['Explain how to fix the cache, then implement the approved fix with regression tests', true],
      ['컴파일 오류 해결', true],
      ['Explain how authentication is wired', false],
      ['Explain these steps:\n- add retries\n- update tests', false, [false, false]],
      ['Explain how to: 1. add retries 2. update tests', false, [false, false]],
      ['Explain these steps: 1. Implement a cache; 2. Add regression tests', false, [false, false]],
      ['Explain these steps: 1) Implement a cache; 2) Add regression tests', false, [false, false]],
      ['Explain these steps: 1. add retries 2. upgrade to Node 22. Then implement the approved fix', true, [false, true]],
      ['Explain these steps: 1. add retries 2. upgrade to Node 22. Implement the approved fix', true, [false, true]],
      ['Explain this step: 1. Inspect HTTP/2. Implement the approved fix', true],
      ['Explain these steps:\n1. upgrade to version 2. Implement the approved fix\n2. update the docs', true, [true, false]],
      ['Explain these steps: 1. add retries 2. update tests, and then implement the approved fix', true, [false, true]],
      ['Analyze failures:\n- implement a fix\n- add regression tests', true, [true, true]],
      ['Explain these steps:\n- add retries\n- update tests\nThen implement the approved fix', true, [false, true]],
      ['Explain these steps: 1. add retries 2. update tests. Then implement the approved fix', true, [false, true]],
      ['Explain these steps:\n- add retries\n- update tests; then implement the approved fix', true, [false, true]],
      ['Investigate how to fix the cache and update the tests', false],
      ['Investigate whether to implement retries and update the tests', false],
      ['Analyze how to fix the cache and update regression tests', false],
      ['How does authentication work?', false],
      ['Investigate authentication failures before implementing a fix with regression tests', true],
    ] as const) {
      assert.equal(buildTeamExecutionPlan(prompt, 1, 'executor', false).tasks.some(task => task.requires_code_change), required, prompt);
      assert.deepEqual(buildTeamExecutionPlan(prompt, 4, 'executor', false, true).tasks.map(task => task.requires_code_change), expectedFlags ?? (required ? [true, true, false, true] : [false, false, false, false]), prompt);
      assert.ok(buildTeamExecutionPlan(prompt, 4, 'debugger', true, true).tasks.every(task => task.requires_code_change === false), prompt);
    }
  });

  it('keeps short analysis optional and honors explicit analysis roles for mutation prompts', () => {
    for (const prompt of ['Analyze request latency', 'Could you please analyze request latency', 'Review the authentication flow']) {
      for (const count of [1, 4]) {
        assert.ok(buildTeamExecutionPlan(prompt, count, 'executor', false, true).tasks.every(task => task.requires_code_change === false), prompt);
      }
    }
    for (const role of ['debugger', 'verifier', 'code-reviewer']) {
      assert.ok(buildTeamExecutionPlan('Fix TypeScript build errors', 4, role, true, true).tasks.every(task => task.requires_code_change === false), role);
    }
  });

  it('requires evidence for common mutation verbs across implicit role routes', () => {
    for (const prompt of [
      'Change src/index.ts to fix TypeScript compilation errors',
      'Analyze request latency and edit src/cache.ts, then report the findings',
      'Analyze request latency and remove the broken cache with regression tests',
      'Review the authentication flow and implement the necessary fixes with regression tests',
      'Analyze request latency and replace the cache implementation with a report of findings',
      'Review the authentication flow. Fix the discovered defects with tests',
      'Analyze request latency\nFix the cache',
      'Analyze request latency with current production measurements and optimize the cache implementation in src/cache.ts with regression tests',
      'Analyze request latency and improve the cache implementation in src/cache.ts with regression tests',
      'Analyze request latency and write a new cache module in src/cache.ts with regression tests',
      'Analyze request latency and add /api/reports with regression tests',
      'Analyze request latency and create src/reports with regression tests',
    ]) {
      assert.ok(buildTeamExecutionPlan(prompt, 1, 'executor', false).tasks.every(task => task.requires_code_change === true), prompt);
      assert.deepEqual(buildTeamExecutionPlan(prompt, 4, 'executor', false, true).tasks.map(task => task.requires_code_change), [true, true, false, true], prompt);
    }
  });

  it('requires evidence for repair requests with stacked courtesy prefixes', () => {
    for (const prefix of ['Could you please', 'Would you please', 'Please help me', 'Can you please help me']) {
      const task = `${prefix} fix TypeScript compilation errors`;
      assert.equal(buildTeamExecutionPlan(task, 1, 'executor', false).tasks[0].requires_code_change, true, task);
      assert.deepEqual(buildTeamExecutionPlan(task, 4, 'executor', false, true).tasks.map(task => task.requires_code_change), [true, true, false, true]);
      assert.equal(buildTeamExecutionPlan(task, 1, 'debugger', true).tasks[0].requires_code_change, false);
    }
  });

  it('keeps recognized analysis deliverables optional despite execution fallback routing', () => {
    for (const task of [
      'Analyze request latency and report the findings',
      'Could you please analyze request latency and report the findings',
      'Summarize request latency evidence in a report',
      'Analyze latency and create a concise report of findings',
      'Analyze latency and write a detailed summary with findings',
      'Analyze request latency and report how to fix regressions with evidence',
      'Investigate compilation errors and recommend a fix without changing implementation',
      'Analyze request latency without changing implementation and create a concise report of findings',
      'Analyze request latency without changing implementation and make a report of findings',
      'Analyze request latency without changing implementation and update the detailed summary with findings',
      'Analyze request latency without changing implementation and write a detailed report with findings',
      'Analyze the current request latency across all production-facing services and their dependencies without changing implementation and report the findings',
    ]) {
      assert.ok(buildTeamExecutionPlan(task, 1, 'executor', false).tasks.every(task => task.requires_code_change === false), task);
      assert.ok(buildTeamExecutionPlan(task, 4, 'executor', false, true).tasks.every(task => task.requires_code_change === false), task);
      assert.ok(buildTeamExecutionPlan(task, 1, 'executor', true).tasks.every(task => task.requires_code_change === true), task);
    }
  });

  it('keeps implementation evidence required for mixed analysis and coding requests', () => {
    for (const task of [
      'Analyze request latency and implement a fix with regression tests',
      'Analyze request latency with current measurements and then implement a cache',
      'Analyze compilation errors and then please fix the errors with regression tests',
      'Analyze request latency and write regression tests with coverage',
      'Analyze request latency and create a cache with a report of findings',
      'Analyze request latency and build a report generator with regression tests',
      'Analyze request latency and update code to produce a report with findings',
    ]) {
      assert.equal(buildTeamExecutionPlan(task, 1, 'executor', false).tasks[0].requires_code_change, true, task);
      const plan = buildTeamExecutionPlan(task, 4, 'executor', false, true);
      assert.equal(plan.tasks.length, 4);
      assert.deepEqual(plan.tasks.map(task => task.requires_code_change), [true, true, false, true], task);
    }
  });

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
    const implicitPlan = buildTeamExecutionPlan('fix typo in README', 3, 'executor', false, false);
    assert.equal(implicitPlan.workerCount, 1);
    assert.equal(implicitPlan.tasks.length, 1);
    assert.equal(implicitPlan.tasks[0].owner, 'worker-1');
    assert.equal(implicitPlan.overOrchestrationNotice?.code, 'team_over_orchestration_warning');
    assert.match(implicitPlan.overOrchestrationNotice?.message ?? '', /solo execution path/i);

    const explicitPlan = buildTeamExecutionPlan('fix typo in README', 3, 'executor', false, true);
    assert.equal(explicitPlan.workerCount, 3);
    assert.equal(explicitPlan.tasks.length, 3);
    assert.equal(explicitPlan.overOrchestrationNotice?.code, 'explicit_team_override_acknowledged');
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

  it('treats short analysis prompts as evidence-optional', () => {
    const shortAnalysisTasks = [
      'Analyze request latency',
      'Investigate compilation errors',
      'Research cache behavior',
      'Audit security vulnerability',
      'Review authentication flow',
      'Summarize findings',
    ];
    for (const task of shortAnalysisTasks) {
      assert.equal(buildTeamExecutionPlan(task, 1, 'executor', false).tasks[0].requires_code_change, false, task);
      assert.equal(buildTeamExecutionPlan(task, 1, 'debugger', true).tasks[0].requires_code_change, false, `explicit debugger: ${task}`);
    }
  });

  it('requires evidence for common mutation verbs', () => {
    const mutationVerbs = ['change', 'edit', 'remove', 'modify', 'create', 'build', 'fix', 'implement'];
    for (const verb of mutationVerbs) {
      const task = `${verb} src/index.ts to fix the error`;
      assert.equal(buildTeamExecutionPlan(task, 1, 'executor', false).tasks[0].requires_code_change, true, task);
    }
  });
});
