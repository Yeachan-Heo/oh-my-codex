import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWorkflowTransition, isTrackedWorkflowMode } from '../workflow-transition.js';

describe('goal-harness workflow transition policy', () => {
  it('tracks goal-harness as an execution workflow that can follow planning', () => {
    assert.equal(isTrackedWorkflowMode('goal-harness'), true);

    const fromDeepInterview = evaluateWorkflowTransition(['deep-interview'], 'goal-harness');
    assert.equal(fromDeepInterview.allowed, true);
    assert.equal(fromDeepInterview.kind, 'auto-complete');
    assert.deepEqual(fromDeepInterview.resultingModes, ['goal-harness']);

    const fromRalplan = evaluateWorkflowTransition(['ralplan'], 'goal-harness');
    assert.equal(fromRalplan.allowed, true);
    assert.equal(fromRalplan.kind, 'auto-complete');
    assert.deepEqual(fromRalplan.resultingModes, ['goal-harness']);
  });

  it('allows goal-harness to overlap with team because workers are evidence lanes', () => {
    const decision = evaluateWorkflowTransition(['goal-harness'], 'team');

    assert.equal(decision.allowed, true);
    assert.equal(decision.kind, 'overlap');
    assert.deepEqual(decision.resultingModes, ['goal-harness', 'team']);
  });
});
