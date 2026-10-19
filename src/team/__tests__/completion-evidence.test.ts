import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimTask, createTask, initTeamState, readMonitorSnapshot, readTask, releaseTaskClaim, saveTeamConfig, transitionTaskStatus, updateTask, teamEventLogPath } from '../state.js';
import { executeTeamApiOperation } from '../api-interop.js';
import { monitorTeam } from '../runtime.js';
import { buildTeamExecutionPlan } from '../../cli/team.js';

describe('worker completion evidence', () => {
  it('enforces report output evidence while allowing labeled analysis and evaluated options', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-review-evidence-'));
    try {
      await initTeamState('proof', 'review', 'executor', 4, cwd);
      for (const [prompt, required] of [
        ['Analyze request latency and write findings to docs/latency-report.md', true],
        ['Write a report for the team in docs/latency.md', true],
        ['Write a report for the owners of this project in docs/latency.md', true],
        ['Write a report about retry support for requests in src/api.ts without changing files', false],
        ['Do not make any code changes', false],
        ['Do not touch any files; only summarize the current behavior', false],
        ['Analyze latency and touch docs/report.md to record findings', true],
        ['Do not implement anything', false],
        ['Never apply a patch', false],
        ['Do not apply the patch; only summarize the current behavior', false],
        ['Write a report about latency for the team in docs/latency.md', true],
        ['Write a report for the team about the API in src/api.ts', false],
        ['Write findings for reviewers at `docs/latency and findings.md`', true],
        ['Please do not change any files; only summarize the current behavior', false],
        ["Don't modify files; just summarize the current behavior", false],
        ['Do not change any files', false],
        ['Just summarize the current behavior', false],
        ['Only please summarize the current behavior', false],
        ['Write a report of retry support for requests in src/api.ts without changing files', false],
        ['Write a report of retry support for requests in src/api.ts without changing the files', false],
        ['Only analyze latency; then apply the approved patch', true],
        ['How does caching work, just apply the approved patch', true],
        ['How does caching work, only apply the approved patch', true],
        ['Analyze these subsystems:\n- API latency\n- cache latency', false],
        ['Analyze these subsystems:\n1. API latency\n2. cache latency', false],
        ['Analyze these subsystems:\n- API latency\n- cache latency\nThen implement the approved cache fix', true],
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
        ['Write a report about the API in the file src/api.ts without changing any files', false],
        ['Write a report about retry support for requests in src/api.ts without changing the file', false],
        ['Write a report for the team in the file docs/latency.md', true],
        ['Evaluate package options:\n- replace package A\n- modify the adapter\n- retain the current package', false],
        ['Evaluate package options: 1. replace package A 2. modify the adapter 3. retain the current package', false],
        ['Evaluate package options:\n- replace package A\n- retain the current package\nThen implement the approved option', true],
        ['Task: Analyze request latency', false],
        ['Evaluate package options: replace package A, modify the adapter, or retain the current package', false],
        ['Evaluate package options: replace package A or retain it, then implement the approved option', true],
      ] as const) {
        for (const count of [1, 4]) {
          const plan = buildTeamExecutionPlan(prompt, count, 'executor', false, true);
          assert.equal(plan.tasks.some(task => task.requires_code_change), required, prompt);
          for (const planned of plan.tasks) {
            const task = await createTask('proof', { ...planned, status: 'pending' }, cwd);
            const claim = await claimTask('proof', task.id, planned.owner, null, cwd);
            assert.ok(claim.ok);
            const result = await transitionTaskStatus('proof', task.id, 'in_progress', 'completed', claim.claimToken, cwd);
            assert.equal(result.ok, !planned.requires_code_change, planned.description);
            if (!result.ok) assert.equal(result.error, 'invalid_completion_evidence');
          }
        }
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('requires evidence for generated implementation and test tasks while preserving read-only plans', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-generated-evidence-'));
    try {
      await initTeamState('proof', 'implement', 'executor', 1, cwd);
      for (const [role, prompt, explicitRole, required] of [
        ['executor', 'Implement login limiter', true, true],
        ['test-engineer', 'Write limiter regression tests', true, true],
        ['executor', 'Fix TypeScript build errors', false, true],
        ['executor', 'Repair compilation errors', false, true],
        ['executor', 'Fix the login regression', false, true],
        ['executor', 'Implement a fix for compilation errors', false, true],
        ['executor', 'Please fix TypeScript compile errors in src/index.ts by changing the return type', false, true],
        ['executor', 'Could you repair compilation errors', false, true],
        ['executor', 'Could you please fix TypeScript compilation errors', false, true],
        ['executor', 'Please help me repair compilation errors', false, true],
        ['executor', 'Analyze request latency and report the findings', false, false],
        ['executor', 'Could you please analyze request latency and report the findings', false, false],
        ['executor', 'Analyze request latency and implement a fix with regression tests', false, true],
        ['executor', 'Analyze request latency', false, false],
        ['executor', '빌드 오류 수정', false, true],
        ['executor', 'Explain how authentication is wired', false, false],
        ['executor', 'Investigate authentication failures before implementing a fix with regression tests', false, true],
        ['executor', 'Change src/index.ts to fix TypeScript compilation errors', false, true],
        ['executor', 'Review the authentication flow and implement the necessary fixes with regression tests', false, true],
        ['executor', 'Analyze request latency\nFix the cache', false, true],
        ['executor', 'Analyze request latency and write a new cache module in src/cache.ts with regression tests', false, true],
        ['executor', 'Analyze request latency and create src/reports with regression tests', false, true],
        ['executor', 'Analyze request latency without changing implementation and create a concise report of findings', false, false],
        ['executor', 'Investigate compilation errors and recommend a fix', false, false],
        ['executor', 'Review the proposed fix for compilation errors', false, false],
        ['executor', 'Create a dependency comparison report', false, false],
        ['debugger', 'Fix TypeScript build errors', true, false],
        ['verifier', 'Review limiter behavior', true, false],
      ] as const) {
        const planned = buildTeamExecutionPlan(prompt, 1, role, explicitRole, true).tasks[0];
        assert.equal(planned.requires_code_change, required, prompt);
        const task = await createTask('proof', { ...planned, status: 'pending' }, cwd);
        const claim = await claimTask('proof', task.id, 'worker-1', null, cwd);
        assert.ok(claim.ok);
        const result = await transitionTaskStatus('proof', task.id, 'in_progress', 'completed', claim.claimToken, cwd);
        assert.equal(result.ok, !required);
        if (!result.ok) assert.equal(result.error, 'invalid_completion_evidence');
        assert.equal((await readTask('proof', task.id, cwd))?.status, required ? 'in_progress' : 'completed');
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('requires evidence for generated implementation and test aspects across worker counts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-fanout-evidence-'));
    try {
      const scenarios = [
        [2, false, 'Fix TypeScript build errors', true],
        [4, false, 'Fix TypeScript build errors', true],
        [5, false, 'Fix TypeScript build errors', true],
        [4, false, 'Could you please fix TypeScript compilation errors', true],
        [4, false, 'Analyze request latency and report the findings', false],
        [4, false, 'Could you please analyze request latency and report the findings', false],
        [4, false, 'Analyze request latency and implement a fix with regression tests', true],
        [4, false, 'Analyze request latency', false],
        [4, false, '빌드 오류 수정', true],
        [4, false, 'Explain how to fix the cache, then implement the approved fix with regression tests', true],
        [4, false, 'Investigate how to resolve authentication failures before implementing a fix with regression tests', true],
        [4, false, 'Explain how authentication is wired', false],
        [4, false, 'Explain these steps:\n- add retries\n- update tests', false, 2, [false, false]],
        [4, false, 'Explain how to: 1. add retries 2. update tests', false, 2, [false, false]],
        [4, false, 'Explain these steps: 1. Implement a cache; 2. Add regression tests', false, 2, [false, false]],
        [4, false, 'Explain these steps: 1. add retries 2. upgrade to Node 22. Then implement the approved fix', true, 2, [false, true]],
        [4, false, 'Explain these steps: 1. add retries 2. upgrade to Node 22. Implement the approved fix', true, 2, [false, true]],
        [4, false, 'Explain this step: 1. Inspect HTTP/2. Implement the approved fix', true],
        [4, false, 'Explain these steps:\n1. upgrade to version 2. Implement the approved fix\n2. update the docs', true, 2, [true, false]],
        [4, false, 'Explain these steps: 1. add retries 2. update tests, and then implement the approved fix', true, 2, [false, true]],
        [4, false, 'Explain these steps: 1. add retries 2. update tests. Then implement the approved fix', true, 2, [false, true]],
        [4, false, 'Explain these steps:\n- add retries\n- update tests; then implement the approved fix', true, 2, [false, true]],
        [4, false, 'Investigate how to fix the cache and update the tests', false],
        [4, false, 'Investigate whether to implement retries and update the tests', false],
        [4, false, 'Investigate authentication failures before implementing a fix with regression tests', true],
        [4, false, 'Analyze latency and create a concise report of findings', false, 2],
        [4, false, 'Change src/index.ts to fix TypeScript compilation errors', true],
        [4, false, 'Analyze request latency\nFix the cache', true],
        [4, false, 'Analyze request latency and create src/reports with regression tests', true],
        [4, false, 'Analyze request latency without changing implementation and create a concise report of findings', false],
        [4, true, 'Fix TypeScript build errors', false],
        [4, false, 'Review limiter behavior', false],
        [4, false, 'Investigate compilation errors and recommend a fix', false],
        [4, false, 'Create a dependency comparison report', false],
      ] as const;
      for (const [scenario, [count, explicitRole, prompt, coding, expectedTaskCount = count, expectedFlags]] of scenarios.entries()) {
        const team = `proof-${scenario}`;
        await initTeamState(team, prompt, 'debugger', count, cwd);
        const plan = buildTeamExecutionPlan(prompt, count, explicitRole ? 'debugger' : 'executor', explicitRole, true);
        const required = expectedFlags ?? (coding ? [true, true, false, true, true].slice(0, count) : Array(expectedTaskCount).fill(false));
        assert.equal(plan.tasks.length, expectedTaskCount);
        assert.deepEqual(plan.tasks.map(task => task.requires_code_change), required);
        for (const [index, planned] of plan.tasks.entries()) {
          const task = await createTask(team, { ...planned, status: 'pending' }, cwd);
          const claim = await claimTask(team, task.id, planned.owner, null, cwd);
          assert.ok(claim.ok);
          const result = await transitionTaskStatus(team, task.id, 'in_progress', 'completed', claim.claimToken, cwd);
          assert.equal(result.ok, !required[index], planned.subject);
          if (!result.ok) assert.equal(result.error, 'invalid_completion_evidence');
          assert.equal((await readTask(team, task.id, cwd))?.status, required[index] ? 'in_progress' : 'completed');
        }
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects enabling evidence on terminal tasks through the public API without reclassifying them', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-completion-evidence-'));
    try {
      await initTeamState('proof', 'review', 'executor', 1, cwd);
      const malformedFlag = await executeTeamApiOperation('create-task', {
        team_name: 'proof', subject: 'code', description: 'implement', requires_code_change: 'true',
      }, cwd);
      assert.equal(malformedFlag.ok, false);
      if (!malformedFlag.ok) {
        assert.equal(malformedFlag.error.code, 'invalid_input');
        assert.match(malformedFlag.error.message, /requires_code_change must be a boolean/);
      }
      for (const entry of [
        { status: 'completed' as const, requires_code_change: false, result: 'Reviewed the implementation' },
        { status: 'completed' as const, requires_code_change: undefined, result: 'Verification: PASS review' },
        { status: 'failed' as const, requires_code_change: false, result: undefined },
      ]) {
        const task = await createTask('proof', { subject: 'review', description: 'read only', status: 'pending', requires_code_change: entry.requires_code_change }, cwd);
        const claim = await claimTask('proof', task.id, 'worker-1', null, cwd);
        assert.ok(claim.ok);
        assert.equal((await transitionTaskStatus('proof', task.id, 'in_progress', entry.status, claim.claimToken, cwd, { result: entry.result })).ok, true);
        const before = await readTask('proof', task.id, cwd);
        const response = await executeTeamApiOperation('update-task', {
          team_name: 'proof', task_id: task.id, requires_code_change: true,
        }, cwd);
        assert.equal(response.ok, false);
        if (!response.ok) {
          assert.equal(response.error.code, 'operation_failed');
          assert.match(response.error.message, /Cannot enable/);
        }
        assert.deepEqual(await readTask('proof', task.id, cwd), before);
        assert.ok(await updateTask('proof', task.id, { description: 'Review notes updated' }, cwd));
      }
      assert.equal((await monitorTeam('proof', cwd))?.phase, 'team-fix');
      const pending = await createTask('proof', { subject: 'code', description: 'implement', status: 'pending', requires_code_change: false }, cwd);
      const enabled = await executeTeamApiOperation('update-task', { team_name: 'proof', task_id: pending.id, requires_code_change: true }, cwd);
      assert.equal(enabled.ok, true);
      assert.ok(await updateTask('proof', pending.id, { requires_code_change: true }, cwd));
      const claim = await claimTask('proof', pending.id, 'worker-1', null, cwd);
      assert.ok(claim.ok);
      const rejected = await transitionTaskStatus('proof', pending.id, 'in_progress', 'completed', claim.claimToken, cwd);
      assert.ok(!rejected.ok && rejected.error === 'invalid_completion_evidence');

      const bypass = await createTask('proof', { subject: 'code', description: 'implement', status: 'pending', requires_code_change: false }, cwd);
      const beforeBypass = await readTask('proof', bypass.id, cwd);
      await assert.rejects(
        updateTask('proof', bypass.id, { status: 'completed', requires_code_change: true }, cwd),
        /transition-task-status/,
      );
      assert.deepEqual(await readTask('proof', bypass.id, cwd), beforeBypass);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects marker-only results and accepts valid dot-prefixed evidence through team verification', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-completion-evidence-'));
    try {
      await initTeamState('proof', 'implement', 'executor', 1, cwd);
      const task = await createTask('proof', { subject: 'code', description: 'implement', status: 'pending', requires_code_change: true }, cwd);
      const claim = await claimTask('proof', task.id, 'worker-1', null, cwd);
      assert.ok(claim.ok);
      await mkdir(join(cwd, '.omx/evidence'), { recursive: true });
      await writeFile(join(cwd, '.omx/evidence/test-results.json'), JSON.stringify({
        teamName: 'proof', taskId: task.id,
        claimTokenSha256: createHash('sha256').update(claim.claimToken).digest('hex'),
        summary: 'Fix addition and exercise positive and negative inputs',
        verification: [{ command: 'node --test', result: 'passed', output: '2 tests passed' }], unverified: [],
      }));
      const marker = 'EVIDENCE_RECORDED: .omx/evidence/test-results.json';
      for (const result of [marker, `Verification:\n${marker}`, `Verification:\n ${marker}`]) {
        const rejected = await transitionTaskStatus('proof', task.id, 'in_progress', 'completed', claim.claimToken, cwd, { result });
        assert.ok(!rejected.ok && rejected.error === 'invalid_completion_evidence');
        assert.match(rejected.reason ?? '', /Verification/);
        assert.equal((await readTask('proof', task.id, cwd))?.status, 'in_progress');
        assert.equal((await readMonitorSnapshot('proof', cwd))?.completedEventTaskIds?.[task.id], undefined);
      }
      const completed = await transitionTaskStatus('proof', task.id, 'in_progress', 'completed', claim.claimToken, cwd, { result: `Verification:\n- PASS node --test: 2 tests passed\n${marker}` });
      assert.equal(completed.ok, true);
      assert.ok(await updateTask('proof', task.id, { requires_code_change: true }, cwd));
      for (let poll = 0; poll < 2; poll += 1) {
        const snapshot = await monitorTeam('proof', cwd);
        assert.equal(snapshot?.phase, 'complete');
        assert.ok(!snapshot?.recommendations.some((recommendation) => recommendation.includes('Verification evidence missing')));
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('cannot disable evidence through the public API before claiming or after releasing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-completion-evidence-'));
    try {
      await initTeamState('proof', 'implement', 'executor', 1, cwd);
      const task = await createTask('proof', { subject: 'code', description: 'implement', status: 'pending', requires_code_change: true }, cwd);
      const disable = () => executeTeamApiOperation('update-task', {
        team_name: 'proof', task_id: task.id, requires_code_change: false,
      }, cwd);
      assert.equal((await disable()).ok, false);
      const claim = await claimTask('proof', task.id, 'worker-1', null, cwd);
      assert.ok(claim.ok);
      const released = await executeTeamApiOperation('release-task-claim', {
        team_name: 'proof', task_id: task.id, worker: 'worker-1', claim_token: claim.claimToken,
      }, cwd);
      assert.ok(released.ok && released.data.ok);
      assert.equal((await disable()).ok, false);
      const next = await claimTask('proof', task.id, 'worker-1', null, cwd);
      assert.ok(next.ok);
      const completed = await executeTeamApiOperation('transition-task-status', {
        team_name: 'proof', task_id: task.id, from: 'in_progress', to: 'completed', claim_token: next.claimToken,
      }, cwd);
      assert.ok(completed.ok);
      assert.equal(completed.data.error, 'invalid_completion_evidence');
      assert.equal((await readTask('proof', task.id, cwd))?.status, 'in_progress');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses the assigned worker directory and rejects evidence from an earlier claim', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-completion-evidence-'));
    try {
      const config = await initTeamState('proof', 'implement', 'executor', 1, cwd);
      const workerCwd = join(cwd, 'worker');
      config.workers[0]!.working_dir = workerCwd;
      await saveTeamConfig(config, cwd);
      const task = await createTask('proof', { subject: 'code', description: 'implement', status: 'pending', requires_code_change: true }, cwd);
      const claim = await claimTask('proof', task.id, 'worker-1', null, cwd);
      assert.ok(claim.ok);
      const evidence = {
        teamName: 'proof', taskId: task.id,
        claimTokenSha256: createHash('sha256').update(claim.claimToken).digest('hex'),
        summary: 'Implement multiplication',
        verification: [{ command: 'node --test', result: 'passed', output: '3 tests passed' }], unverified: ['Manual UI check'],
      };
      assert.ok((await releaseTaskClaim('proof', task.id, claim.claimToken, 'worker-1', cwd)).ok);
      const next = await claimTask('proof', task.id, 'worker-1', null, cwd);
      assert.ok(next.ok);
      const path = '.omx/evidence/task.json';
      await mkdir(join(workerCwd, '.omx/evidence'), { recursive: true });
      await writeFile(join(workerCwd, path), JSON.stringify(evidence));
      const complete = () => transitionTaskStatus('proof', task.id, 'in_progress', 'completed', next.claimToken, cwd, { result: `Verification: PASS\nEVIDENCE_RECORDED: ${path}` });
      const rejected = await complete();
      assert.ok(!rejected.ok && rejected.error === 'invalid_completion_evidence');
      evidence.claimTokenSha256 = createHash('sha256').update(next.claimToken).digest('hex');
      await writeFile(join(workerCwd, path), JSON.stringify(evidence));
      assert.equal((await complete()).ok, true);
      const readOnly = await createTask('proof', { subject: 'review', description: 'read only', status: 'pending', requires_code_change: false }, cwd);
      const readClaim = await claimTask('proof', readOnly.id, 'worker-1', null, cwd);
      assert.ok(readClaim.ok);
      assert.equal((await transitionTaskStatus('proof', readOnly.id, 'in_progress', 'completed', readClaim.claimToken, cwd)).ok, true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses the API caller directory when worker and team state roots differ', async () => {
    const stateCwd = await mkdtemp(join(tmpdir(), 'omx-completion-evidence-state-'));
    const callerCwd = await mkdtemp(join(tmpdir(), 'omx-completion-evidence-caller-'));
    const previousStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    try {
      const config = await initTeamState('proof', 'implement', 'executor', 1, stateCwd);
      delete config.workers[0]!.working_dir;
      await saveTeamConfig(config, stateCwd);
      process.env.OMX_TEAM_STATE_ROOT = join(stateCwd, '.omx', 'state');
      const task = await createTask('proof', { subject: 'code', description: 'implement', status: 'pending', requires_code_change: true }, stateCwd);
      const claim = await claimTask('proof', task.id, 'worker-1', null, stateCwd);
      assert.ok(claim.ok);
      const path = '.omx/evidence/task.json';
      await mkdir(join(callerCwd, '.omx/evidence'), { recursive: true });
      await writeFile(join(callerCwd, path), JSON.stringify({
        teamName: 'proof', taskId: task.id,
        claimTokenSha256: createHash('sha256').update(claim.claimToken).digest('hex'),
        summary: 'Implement division',
        verification: [{ command: 'node --test', result: 'passed', output: '4 tests passed' }],
        unverified: [],
      }));
      const result = await executeTeamApiOperation('transition-task-status', {
        team_name: 'proof', task_id: task.id, from: 'in_progress', to: 'completed',
        claim_token: claim.claimToken, result: `Verification: PASS\nEVIDENCE_RECORDED: ${path}`,
      }, callerCwd);
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.data.ok, true);
      assert.equal((await readTask('proof', task.id, stateCwd))?.status, 'completed');
    } finally {
      if (previousStateRoot === undefined) delete process.env.OMX_TEAM_STATE_ROOT;
      else process.env.OMX_TEAM_STATE_ROOT = previousStateRoot;
      await rm(stateCwd, { recursive: true, force: true });
      await rm(callerCwd, { recursive: true, force: true });
    }
  });

  it('rejects missing, escaped, stale, mismatched and placeholder reports without completing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-completion-evidence-'));
    try {
      await initTeamState('proof', 'implement', 'executor', 1, cwd);
      const task = await createTask('proof', { subject: 'code', description: 'implement', status: 'pending', requires_code_change: true }, cwd);
      const claim = await claimTask('proof', task.id, 'worker-1', null, cwd);
      assert.ok(claim.ok);
      const evidence = {
        teamName: 'proof', taskId: task.id,
        claimTokenSha256: createHash('sha256').update(claim.claimToken).digest('hex'),
        summary: 'Implement addition and exercise negative numbers',
        verification: [{ command: 'node --test', result: 'passed', output: '2 tests passed' }], unverified: [],
      };
      await mkdir(join(cwd, '.omx/evidence'), { recursive: true });
      const path = '.omx/evidence/task.json';
      const complete = (result?: string) => transitionTaskStatus('proof', task.id, 'in_progress', 'completed', claim.claimToken, cwd, { result });
      const reject = async (result?: string) => {
        const response = await complete(`Verification: PASS\n${result ?? ''}`);
        assert.equal(response.ok, false);
        if (!response.ok) assert.equal(response.error, 'invalid_completion_evidence');
        assert.equal((await readTask('proof', task.id, cwd))?.status, 'in_progress');
        assert.equal((await readMonitorSnapshot('proof', cwd))?.completedEventTaskIds?.[task.id], undefined);
      };
      await reject('Tests passed');
      await reject(`EVIDENCE_RECORDED: ${path}`);
      await writeFile(join(cwd, path), '{}');
      await reject(`EVIDENCE_RECORDED: ${path}`);
      await writeFile(join(cwd, path), '{');
      await reject(`EVIDENCE_RECORDED: ${path}`);
      await writeFile(join(cwd, path), JSON.stringify({ ...evidence, taskId: 'other-task' }));
      await reject(`EVIDENCE_RECORDED: ${path}`);
      await writeFile(join(cwd, path), JSON.stringify({ ...evidence, claimTokenSha256: 'old-claim' }));
      await reject(`EVIDENCE_RECORDED: ${path}`);
      await writeFile(join(cwd, path), JSON.stringify({ ...evidence, verification: [{ command: 'node --test', result: 'passed', output: 'TODO' }] }));
      await reject(`EVIDENCE_RECORDED: ${path}`);
      await writeFile(join(cwd, path), JSON.stringify(evidence));
      await utimes(join(cwd, path), new Date(0), new Date(0));
      await reject(`EVIDENCE_RECORDED: ${path}`);
      await writeFile(join(cwd, '.omx/outside.json'), JSON.stringify(evidence));
      await reject('EVIDENCE_RECORDED: .omx/outside.json');
      await symlink(join(cwd, '.omx/outside.json'), join(cwd, '.omx/evidence/link.json'));
      await reject('EVIDENCE_RECORDED: .omx/evidence/link.json');
      await symlink(join(cwd, '.omx'), join(cwd, '.omx/evidence/linked-dir'));
      await reject('EVIDENCE_RECORDED: .omx/evidence/linked-dir/outside.json');
      await assert.rejects(updateTask('proof', task.id, { status: 'completed' }, cwd), /transition-task-status/);
      await assert.rejects(updateTask('proof', task.id, { requires_code_change: false }, cwd), /Cannot disable/);
      await writeFile(join(cwd, path), JSON.stringify(evidence));
      assert.equal((await complete(`Verification: PASS\nEVIDENCE_RECORDED: ${path}`)).ok, true);
      assert.equal((await readTask('proof', task.id, cwd))?.status, 'completed');
      assert.match((await readFile(teamEventLogPath('proof', cwd), 'utf8')), /task_completed/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
