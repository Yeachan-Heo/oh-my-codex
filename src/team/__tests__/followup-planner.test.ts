import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildFollowupStaffingPlan,
  isApprovedExecutionFollowupShortcut,
  resolveAvailableAgentTypes,
} from '../followup-planner.js';

describe('followup-planner', () => {
  it('resolves available agent types from explicit prompt directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omx-followup-roster-'));
    try {
      await writeFile(join(dir, 'executor.md'), '# Executor');
      await writeFile(join(dir, 'architect.md'), '# Architect');
      await writeFile(join(dir, 'test-engineer.md'), '# Test Engineer');

      const roles = await resolveAvailableAgentTypes(process.cwd(), { promptDirs: [dir] });
      assert.deepEqual(roles, ['architect', 'executor', 'test-engineer']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });


  it('includes team-executor when the prompt is available', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omx-followup-roster-'));
    try {
      await writeFile(join(dir, 'executor.md'), '# Executor');
      await writeFile(join(dir, 'team-executor.md'), '# Team Executor');

      const roles = await resolveAvailableAgentTypes(process.cwd(), { promptDirs: [dir] });
      assert.deepEqual(roles, ['executor', 'team-executor']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('builds concrete team staffing guidance from the available roster', () => {
    const plan = buildFollowupStaffingPlan(
      'team',
      'Fix flaky integration tests and update README',
      ['executor', 'test-engineer', 'writer'],
      { workerCount: 3, fallbackRole: 'executor' },
    );

    assert.equal(plan.mode, 'team');
    assert.equal(plan.recommendedHeadcount, 3);
    assert.match(plan.staffingSummary, /test-engineer x1/);
    assert.match(plan.staffingSummary, /reasoning/);
    assert.ok(plan.allocations.every((allocation) => ['executor', 'test-engineer', 'writer'].includes(allocation.role)));
    assert.ok(
      plan.allocations.some((allocation) => allocation.reason.includes('specialist') || allocation.reason.includes('verification')),
    );
    assert.equal(plan.launchHints.shellCommand, 'omx team 3:executor "Fix flaky integration tests and update README"');
    assert.equal(plan.launchHints.skillCommand, '$team 3:executor "Fix flaky integration tests and update README"');
    assert.match(plan.verificationPlan.summary, /coordinated execution and verification owner/i);
    assert.equal(plan.verificationPlan.checkpoints.length, 3);
  });

  it('builds concrete ralph staffing guidance from the available roster', () => {
    const plan = buildFollowupStaffingPlan(
      'ralph',
      'Investigate auth regression and verify the fix',
      ['architect', 'debugger', 'executor', 'test-engineer'],
    );

    assert.equal(plan.mode, 'ralph');
    assert.equal(plan.recommendedHeadcount, 3);
    assert.match(plan.staffingSummary, /architect x1/);
    assert.match(plan.staffingSummary, /test-engineer x1/);
    assert.ok(plan.allocations.some((allocation) => allocation.reason.includes('sign-off')));
    assert.equal(plan.launchHints.shellCommand, 'omx ralph "Investigate auth regression and verify the fix"');
    assert.equal(plan.launchHints.skillCommand, '$ralph "Investigate auth regression and verify the fix"');
    assert.match(plan.verificationPlan.summary, /persistent execution and verification owner/i);
    assert.equal(plan.verificationPlan.checkpoints.length, 3);
  });

  it('applies per-agent reasoning overrides to Ralph sign-off staffing guidance', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'omx-followup-reasoning-'));
    try {
      await writeFile(join(codexHome, '.omx-config.json'), JSON.stringify({
        agentReasoning: {
          architect: 'xhigh',
        },
      }));

      const plan = buildFollowupStaffingPlan(
        'ralph',
        'Investigate auth regression and verify the fix',
        ['architect', 'debugger', 'executor', 'test-engineer'],
        { codexHomeOverride: codexHome },
      );

      assert.ok(
        plan.allocations.some(
          (allocation) => allocation.role === 'architect' && allocation.reasoningEffort === 'xhigh',
        ),
      );
      assert.match(plan.staffingSummary, /architect x1 .*xhigh reasoning/);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('allocates explore plus researcher lanes for mixed local+official-doc follow-up', () => {
    const plan = buildFollowupStaffingPlan(
      'team',
      'Find which files implement session refresh in the repo, then research the official docs and version compatibility notes for the auth SDK',
      ['executor', 'explore', 'researcher', 'verifier'],
      { workerCount: 3, fallbackRole: 'executor' },
    );

    assert.ok(plan.allocations.some((allocation) => allocation.role === 'explore' && allocation.reason.includes('primary')));
    assert.ok(plan.allocations.some((allocation) => allocation.role === 'researcher' && allocation.reason.includes('specialist')));
  });

  it('allocates explore plus dependency-expert lanes for mixed local+dependency evaluation follow-up', () => {
    const plan = buildFollowupStaffingPlan(
      'team',
      'Map which local packages currently handle logging, then compare replacement npm packages for license risk, maintenance, and migration path',
      ['dependency-expert', 'executor', 'explore', 'verifier'],
      { workerCount: 3, fallbackRole: 'executor' },
    );

    assert.ok(plan.allocations.some((allocation) => allocation.role === 'explore' && allocation.reason.includes('primary')));
    assert.ok(plan.allocations.some((allocation) => allocation.role === 'dependency-expert' && allocation.reason.includes('specialist')));
  });

  it('allocates explore first plus dependency-expert for local-usage-plus-upgrade follow-up phrasing', () => {
    const plan = buildFollowupStaffingPlan(
      'team',
      'Check how we use this SDK today and whether we should upgrade it',
      ['dependency-expert', 'executor', 'explore', 'verifier'],
      { workerCount: 3, fallbackRole: 'executor' },
    );

    assert.ok(plan.allocations.some((allocation) => allocation.role === 'explore' && allocation.reason.includes('primary')));
    assert.ok(plan.allocations.some((allocation) => allocation.role === 'dependency-expert' && allocation.reason.includes('specialist')));
  });

  it('recognizes short approved team follow-up shortcuts in English and Korean', () => {
    assert.equal(
      isApprovedExecutionFollowupShortcut('team', 'team', { planningComplete: true }),
      true,
    );
    assert.equal(
      isApprovedExecutionFollowupShortcut('team', 'team으로 해줘', { planningComplete: true }),
      true,
    );
  });

  it('rejects short follow-up shortcuts when the prior execution context conflicts', () => {
    assert.equal(
      isApprovedExecutionFollowupShortcut('team', 'team', {
        planningComplete: true,
        priorSkill: 'autopilot',
      }),
      false,
    );
  });
});
