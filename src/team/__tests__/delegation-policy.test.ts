import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeDelegationPlan } from '../delegation-policy.js';
import type { TeamTask } from '../state.js';

function task(overrides: Partial<TeamTask>): TeamTask {
  return {
    id: '1',
    subject: 'subject',
    description: 'description',
    status: 'pending',
    created_at: new Date(0).toISOString(),
    ...overrides,
  };
}

describe('synthesizeDelegationPlan', () => {
  let originalChildModel: string | undefined;
  let originalFrontierModel: string | undefined;

  beforeEach(() => {
    originalChildModel = process.env.OMX_TEAM_CHILD_MODEL;
    originalFrontierModel = process.env.OMX_DEFAULT_FRONTIER_MODEL;
    delete process.env.OMX_TEAM_CHILD_MODEL;
    delete process.env.OMX_DEFAULT_FRONTIER_MODEL;
  });

  afterEach(() => {
    if (typeof originalChildModel === 'string') process.env.OMX_TEAM_CHILD_MODEL = originalChildModel;
    else delete process.env.OMX_TEAM_CHILD_MODEL;
    if (typeof originalFrontierModel === 'string') process.env.OMX_DEFAULT_FRONTIER_MODEL = originalFrontierModel;
    else delete process.env.OMX_DEFAULT_FRONTIER_MODEL;
  });

  it('auto-delegates broad investigation tasks to gpt-5.4-mini child agents', () => {
    process.env.OMX_DEFAULT_FRONTIER_MODEL = 'frontier-expensive';
    const plan = synthesizeDelegationPlan(task({
      subject: 'Investigate flaky runtime behavior',
      description: 'Search the repo, debug root cause, and propose tests across runtime modules',
      role: 'debugger',
    }));

    assert.equal(plan.mode, 'auto');
    assert.equal(plan.max_parallel_subtasks, 3);
    assert.equal(plan.required_parallel_probe, true);
    assert.equal(plan.spawn_before_serial_search_threshold, 3);
    assert.equal(plan.child_model_policy, 'standard');
    assert.equal(plan.child_model, 'gpt-5.4-mini');
    assert.equal(plan.child_report_format, 'bullets');
    assert.equal(plan.skip_allowed_reason_required, true);
    assert.ok((plan.subtask_candidates ?? []).some((candidate) => /debug|root-cause/i.test(candidate)));
  });

  it('keeps narrow typo/copy tasks quiet', () => {
    const plan = synthesizeDelegationPlan(task({
      subject: 'Fix typo',
      description: 'Fix one typo in README.md',
    }));

    assert.deepEqual(plan, { mode: 'none' });
  });

  it('falls back to optional delegation for ordinary implementation work and honors child override', () => {
    process.env.OMX_TEAM_CHILD_MODEL = 'standard-child-override';
    const plan = synthesizeDelegationPlan(task({
      subject: 'Add parser option',
      description: 'Implement parser option and update docs',
    }));

    assert.equal(plan.mode, 'optional');
    assert.equal(plan.max_parallel_subtasks, 2);
    assert.equal(plan.child_model_policy, 'standard');
    assert.equal(plan.child_model, 'standard-child-override');
  });
});
