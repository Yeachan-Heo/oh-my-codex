import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inferPhaseTargetFromTaskCounts, reconcilePhaseStateForMonitor } from '../phase-controller.js';

describe('phase-controller', () => {
  it('infers complete when all tasks terminal and none failed', () => {
    assert.equal(
      inferPhaseTargetFromTaskCounts({ pending: 0, blocked: 0, in_progress: 0, failed: 0 }),
      'complete',
    );
  });

  it('infers team-fix when all tasks terminal but failures exist', () => {
    assert.equal(
      inferPhaseTargetFromTaskCounts({ pending: 0, blocked: 0, in_progress: 0, failed: 2 }),
      'team-fix',
    );
  });

  it('advances team-exec to complete via verify stage', () => {
    const next = reconcilePhaseStateForMonitor(
      {
        current_phase: 'team-exec',
        max_fix_attempts: 3,
        current_fix_attempt: 0,
        transitions: [],
        updated_at: new Date().toISOString(),
      },
      'complete',
    );

    assert.equal(next.current_phase, 'complete');
    assert.ok(next.transitions.some((t) => t.to === 'team-verify'));
    assert.ok(next.transitions.some((t) => t.to === 'complete'));
  });
});
