import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildFollowupStaffingPlan,
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
    assert.ok(plan.allocations.every((allocation) => ['executor', 'test-engineer', 'writer'].includes(allocation.role)));
    assert.ok(
      plan.allocations.some((allocation) => allocation.reason.includes('specialist') || allocation.reason.includes('verification')),
    );
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
  });
});
