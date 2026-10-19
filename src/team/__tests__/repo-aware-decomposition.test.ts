import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildRepoAwareTeamExecutionPlan } from '../repo-aware-decomposition.js';

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'omx-dag-'));
  mkdirSync(join(cwd, '.omx', 'plans'), { recursive: true });
  mkdirSync(join(cwd, 'src', 'team'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'team', 'runtime.ts'), '');
  writeFileSync(join(cwd, '.omx', 'plans', 'prd-demo.md'), '# Demo\n');
  writeFileSync(join(cwd, '.omx', 'plans', 'test-spec-demo.md'), '# Tests\n');
  return cwd;
}

const legacy = () => ({
  workerCount: 3,
  tasks: [{ subject: 'legacy', description: 'legacy', owner: 'worker-1', role: 'team-executor' }],
});

describe('buildRepoAwareTeamExecutionPlan', () => {
  it('distinguishes report file outputs from labeled analysis and evaluated alternatives', () => {
    const cwd = repo();
    writeFileSync(join(cwd, '.omx/plans/team-dag-demo.json'), JSON.stringify({
      schema_version: 1,
      nodes: [
        { id: 'report', role: 'executor', subject: 'Analyze request latency', description: 'Write findings to docs/latency-report.md' },
        { id: 'label', role: 'executor', subject: 'Task: Analyze request latency', description: 'Read existing measurements' },
        { id: 'audience', role: 'executor', subject: 'Write a report for the team in docs/latency.md', description: 'Use measurements' },
        { id: 'no-change', role: 'executor', subject: 'Please do not change any files', description: 'Only summarize the current behavior' },
        { id: 'options', role: 'executor', subject: 'Evaluate package options: replace package A, modify the adapter, or retain the current package', description: 'Report recommendations' },
        { id: 'implement', role: 'executor', subject: 'Evaluate package options: replace package A or retain it', description: 'Implement the approved option' },
        { id: 'apply', role: 'executor', subject: 'Investigate the TypeScript build failure', description: 'Apply the approved patch' },
        { id: 'question', role: 'executor', subject: 'How does the TypeScript build work, and can you please fix the compilation error?', description: 'Read measurements' },
      ],
    }));
    const plan = buildRepoAwareTeamExecutionPlan({ task: 'review', workerCount: 4, agentType: 'executor', explicitAgentType: false, explicitWorkerCount: true, cwd, buildLegacyPlan: legacy, allowDagHandoff: true });
    assert.deepEqual(plan.tasks.map(task => task.requires_code_change), [true, false, true, false, false, true, true, true]);
  });

  it('classifies DAG field boundaries and preserves explicit evidence overrides', () => {
    const cwd = repo();
    writeFileSync(join(cwd, '.omx/plans/team-dag-demo.json'), JSON.stringify({
      schema_version: 1,
      nodes: [
        { id: 'subject-code', role: 'executor', subject: 'Implement a cache fix', description: 'Analyze request latency and report findings' },
        { id: 'description-code', role: 'executor', subject: 'Analyze request latency', description: 'Implement the approved cache fix and report findings' },
        { id: 'explanation', role: 'executor', subject: 'Explain how authentication is wired', description: 'Read existing code' },
        { id: 'subordinate', role: 'executor', subject: 'Investigate authentication failures', description: 'Investigate authentication failures before implementing a fix with regression tests' },
        { id: 'localized', role: 'executor', subject: '빌드 오류 수정', description: '컴파일 오류 해결' },
        { id: 'short-analysis', role: 'executor', subject: 'Analyze request latency', description: 'Inspect measurements' },
        { id: 'mutation', role: 'executor', subject: 'Analyze request latency', description: 'Edit src/cache.ts and report findings' },
        { id: 'explicit-false', role: 'executor', subject: 'Implement the cache', description: 'Change runtime', requires_code_change: false },
        { id: 'explicit-true', role: 'verifier', subject: 'Analyze latency', description: 'Report findings', requires_code_change: true },
        { id: 'metadata-analysis', role: 'executor', subject: 'Analyze request latency', description: 'Inspect measurements', domains: ['build'], filePaths: ['fix/cache.ts'] },
        { id: 'sentence-code', role: 'executor', subject: 'Analyze request latency', description: 'Analyze measurements. Change src/cache.ts to fix it' },
      ],
    }));
    const input = { task: 'latency', workerCount: 4, agentType: 'executor', explicitAgentType: false, explicitWorkerCount: true, cwd, buildLegacyPlan: legacy, allowDagHandoff: true };
    const plan = buildRepoAwareTeamExecutionPlan(input);
    assert.deepEqual(plan.tasks.map(task => [task.symbolic_id, task.requires_code_change]), [
      ['subject-code', true], ['description-code', true], ['explanation', false], ['subordinate', true], ['localized', true], ['short-analysis', false], ['mutation', true], ['explicit-false', false], ['explicit-true', true], ['metadata-analysis', false], ['sentence-code', true],
    ]);
    const explicit = buildRepoAwareTeamExecutionPlan({ ...input, agentType: 'debugger', explicitAgentType: true });
    assert.deepEqual(explicit.tasks.map(task => task.requires_code_change), [false, false, false, false, false, false, false, false, true, false, false]);
  });

  it('defaults code-capable DAG roles to evidence and preserves explicit read-only overrides', () => {
    const cwd = repo();
    writeFileSync(join(cwd, '.omx/plans/team-dag-demo.json'), JSON.stringify({
      schema_version: 1,
      nodes: [
        { id: 'impl', role: 'executor', subject: 'Implement limiter', description: 'Change runtime' },
        { id: 'tests', role: 'test-engineer', subject: 'Write tests', description: 'Add regression tests' },
        { id: 'review', role: 'verifier', subject: 'Review', description: 'Read-only verification' },
        { id: 'explicit', role: 'executor', subject: 'Inspect', description: 'Explicit read-only task', requires_code_change: false },
      ],
    }));
    const plan = buildRepoAwareTeamExecutionPlan({
      task: 'implement', workerCount: 4, agentType: 'executor', explicitAgentType: false, explicitWorkerCount: true,
      cwd, buildLegacyPlan: legacy, allowDagHandoff: true,
    });
    assert.deepEqual(plan.tasks.map((task) => task.requires_code_change), [true, true, false, false]);
  });

  it('falls back to legacy text decomposition when no DAG exists', () => {
    const cwd = repo();
    const plan = buildRepoAwareTeamExecutionPlan({
      task: 'fix tests', workerCount: 3, agentType: 'executor', explicitAgentType: false, explicitWorkerCount: false, cwd, buildLegacyPlan: legacy,
    });
    assert.equal(plan.metadata?.decomposition_source, 'legacy_text');
    assert.equal(plan.tasks[0].subject, 'legacy');
  });

  it('imports DAG sidecar, reduces implicit worker count, and preserves symbolic dependencies for runtime remap', () => {
    const cwd = repo();
    writeFileSync(join(cwd, '.omx', 'plans', 'team-dag-demo.json'), JSON.stringify({
      schema_version: 1,
      nodes: [
        { id: 'impl', lane: 'implementation', role: 'executor', subject: 'Implement runtime', description: 'Change runtime', filePaths: ['src/team/runtime.ts'], requires_code_change: true },
        { id: 'tests', lane: 'verification', role: 'test-engineer', subject: 'Test runtime', description: 'Cover runtime', depends_on: ['impl'] },
      ],
      worker_policy: { requested_count: 3, count_source: 'plan-suggested' },
    }));
    const plan = buildRepoAwareTeamExecutionPlan({
      task: 'team', workerCount: 3, agentType: 'executor', explicitAgentType: false, explicitWorkerCount: false, cwd, buildLegacyPlan: legacy, allowDagHandoff: true,
    });
    assert.equal(plan.metadata?.decomposition_source, 'dag_sidecar');
    assert.equal(plan.workerCount, 2);
    assert.equal(plan.tasks.length, 2);
    assert.deepEqual(plan.tasks[1].blocked_by, undefined);
    assert.deepEqual(plan.tasks[1].depends_on, undefined);
    assert.deepEqual(plan.tasks[1].symbolic_depends_on, ['impl']);
    assert.equal(plan.metadata?.node_id_to_task_id, undefined);
    assert.deepEqual(plan.metadata?.node_dependencies?.tests, ['impl']);
    assert.match(plan.tasks[0].description, /File scope: src\/team\/runtime.ts/);
  });


  it('does not import a stale DAG sidecar unless the approved launch gate opts in', () => {
    const cwd = repo();
    writeFileSync(join(cwd, '.omx', 'plans', 'team-dag-demo.json'), JSON.stringify({
      schema_version: 1,
      nodes: [{ id: 'stale', subject: 'Stale sidecar', description: 'Must not override normal startup' }],
    }));
    const plan = buildRepoAwareTeamExecutionPlan({
      task: 'fix unrelated tests', workerCount: 3, agentType: 'executor', explicitAgentType: false, explicitWorkerCount: false, cwd, buildLegacyPlan: legacy,
    });
    assert.equal(plan.metadata?.decomposition_source, 'legacy_text');
    assert.equal(plan.metadata?.fallback_reason, 'dag_handoff_not_approved_for_invocation');
    assert.equal(plan.tasks[0].subject, 'legacy');
  });

  it('preserves explicit lifecycle fallback reasons when DAG handoff is disabled upstream', () => {
    const cwd = repo();
    writeFileSync(join(cwd, '.omx', 'plans', 'team-dag-demo.json'), JSON.stringify({
      schema_version: 1,
      nodes: [{ id: 'stale', subject: 'Stale sidecar', description: 'Must not override lifecycle-rejected startup' }],
    }));
    const plan = buildRepoAwareTeamExecutionPlan({
      task: 'fix unrelated tests',
      workerCount: 3,
      agentType: 'executor',
      explicitAgentType: false,
      explicitWorkerCount: false,
      cwd,
      buildLegacyPlan: legacy,
      dagFallbackReason: 'context_pack_not_followup_ready:invalid',
    });
    assert.equal(plan.metadata?.decomposition_source, 'legacy_text');
    assert.equal(plan.metadata?.fallback_reason, 'context_pack_not_followup_ready:invalid');
    assert.equal(plan.tasks[0].subject, 'legacy');
  });

  it('requires a matching approved test spec before importing an opted-in DAG sidecar', () => {
    const cwd = repo();
    writeFileSync(join(cwd, '.omx', 'plans', 'test-spec-demo.md'), '');
    writeFileSync(join(cwd, '.omx', 'plans', 'test-spec-other.md'), '# Other tests\n');
    writeFileSync(join(cwd, '.omx', 'plans', 'team-dag-demo.json'), JSON.stringify({
      schema_version: 1,
      nodes: [{ id: 'impl', subject: 'Implement', description: 'Implement from DAG' }],
    }));
    unlinkSync(join(cwd, '.omx', 'plans', 'test-spec-demo.md'));

    const plan = buildRepoAwareTeamExecutionPlan({
      task: 'team', workerCount: 3, agentType: 'executor', explicitAgentType: false, explicitWorkerCount: false, cwd, buildLegacyPlan: legacy, allowDagHandoff: true,
    });
    assert.equal(plan.metadata?.decomposition_source, 'legacy_text');
    assert.equal(plan.metadata?.fallback_reason, 'missing_matching_test_spec');
    assert.equal(plan.tasks[0].subject, 'legacy');
  });



  it('carries approved repository context summary only when the launch gate supplies it', () => {
    const cwd = repo();
    writeFileSync(join(cwd, '.omx', 'plans', 'team-dag-demo.json'), JSON.stringify({
      schema_version: 1,
      nodes: [{ id: 'impl', subject: 'Implement', description: 'Implement from DAG' }],
    }));
    const plan = buildRepoAwareTeamExecutionPlan({
      task: 'team',
      workerCount: 3,
      agentType: 'executor',
      explicitAgentType: false,
      explicitWorkerCount: false,
      cwd,
      buildLegacyPlan: legacy,
      allowDagHandoff: true,
      approvedRepositoryContextSummary: {
        sourcePath: join(cwd, '.omx', 'plans', 'repo-context-demo.md'),
        content: 'Approved context: runtime lives in src/team/runtime.ts',
        truncated: false,
      },
    });

    assert.equal(plan.metadata?.approved_context_summary?.content, 'Approved context: runtime lives in src/team/runtime.ts');
  });

  it('does not consume ambient repository context summary without an approved launch match', () => {
    const cwd = repo();
    writeFileSync(join(cwd, '.omx', 'plans', 'team-dag-demo.json'), JSON.stringify({
      schema_version: 1,
      nodes: [{ id: 'stale', subject: 'Stale', description: 'Stale DAG' }],
    }));
    const plan = buildRepoAwareTeamExecutionPlan({
      task: 'fix unrelated tests',
      workerCount: 3,
      agentType: 'executor',
      explicitAgentType: false,
      explicitWorkerCount: false,
      cwd,
      buildLegacyPlan: legacy,
    });

    assert.equal(plan.metadata?.approved_context_summary, undefined);
    assert.equal(plan.metadata?.fallback_reason, 'dag_handoff_not_approved_for_invocation');
  });

  it('honors CLI-explicit worker count beyond ready lanes', () => {
    const cwd = repo();
    writeFileSync(join(cwd, '.omx', 'plans', 'team-dag-demo.json'), JSON.stringify({
      schema_version: 1,
      nodes: [{ id: 'impl', subject: 'Implement one lane', description: 'Do it' }],
      worker_policy: { requested_count: 1, count_source: 'plan-suggested' },
    }));
    const plan = buildRepoAwareTeamExecutionPlan({
      task: 'team', workerCount: 4, agentType: 'executor', explicitAgentType: true, explicitWorkerCount: true, cwd, buildLegacyPlan: legacy, allowDagHandoff: true,
    });
    assert.equal(plan.workerCount, 4);
    assert.equal(plan.metadata?.worker_count_source, 'cli-explicit');
  });
});
