import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  advance,
  createInitialState,
  isTerminal,
  LINEAR_GATE_ORDER,
  type UpgradePhase,
} from '../phase-controller.js';

const NOW = () => '2026-01-01T00:00:00.000Z';

function advanceThrough(phases: Iterable<{ event: Parameters<typeof advance>[1]; expected: UpgradePhase }>) {
  let state = createInitialState({ now: NOW });
  for (const { event, expected } of phases) {
    state = advance(state, event, { now: NOW });
    assert.equal(state.phase, expected, `expected ${expected}, got ${state.phase}`);
  }
  return state;
}

describe('bumpkin/phase-controller', () => {
  it('starts in plan phase with no transitions and no fix attempts', () => {
    const state = createInitialState({ now: NOW });
    assert.equal(state.phase, 'plan');
    assert.equal(state.fixAttempts, 0);
    assert.equal(state.failedGate, null);
    assert.equal(state.escalationReason, null);
    assert.deepEqual(state.transitions, []);
  });

  it('advances plan → prd → exec → verify-tests on phase-done events', () => {
    advanceThrough([
      { event: { kind: 'phase-done' }, expected: 'prd' },
      { event: { kind: 'phase-done' }, expected: 'exec' },
      { event: { kind: 'phase-done' }, expected: 'verify-tests' },
    ]);
  });

  it('runs all gates in order when each passes and terminates in ship', () => {
    const postExec = [
      { event: { kind: 'phase-done' as const }, expected: 'prd' as UpgradePhase },
      { event: { kind: 'phase-done' as const }, expected: 'exec' as UpgradePhase },
      { event: { kind: 'phase-done' as const }, expected: 'verify-tests' as UpgradePhase },
    ];
    const gateTransitions = LINEAR_GATE_ORDER.slice(1).map((expected) => ({
      event: { kind: 'gate-pass' as const },
      expected,
    }));
    const state = advanceThrough([...postExec, ...gateTransitions]);
    assert.equal(state.phase, 'ship');
    assert.ok(isTerminal(state.phase));
  });

  it('routes a failing gate to fix and returns to the same gate after fix-success', () => {
    let state = createInitialState({ now: NOW });
    state = advance(state, { kind: 'phase-done' }, { now: NOW });
    state = advance(state, { kind: 'phase-done' }, { now: NOW });
    state = advance(state, { kind: 'phase-done' }, { now: NOW });
    assert.equal(state.phase, 'verify-tests');

    state = advance(state, { kind: 'gate-fail', reason: 'tests failed' }, { now: NOW });
    assert.equal(state.phase, 'fix');
    assert.equal(state.fixAttempts, 0, 'no fix attempts have failed yet');
    assert.equal(state.failedGate, 'verify-tests');

    state = advance(state, { kind: 'fix-success' }, { now: NOW });
    assert.equal(state.phase, 'verify-tests');
    assert.equal(state.fixAttempts, 0);
  });

  it('escalates with max-fix-attempts-exceeded after maxFixAttempts fix-fail events', () => {
    let state = createInitialState({ maxFixAttempts: 2, now: NOW });
    state = advance(state, { kind: 'phase-done' }, { now: NOW });
    state = advance(state, { kind: 'phase-done' }, { now: NOW });
    state = advance(state, { kind: 'phase-done' }, { now: NOW });
    state = advance(state, { kind: 'gate-fail', reason: 'x' }, { now: NOW });
    assert.equal(state.phase, 'fix');

    state = advance(state, { kind: 'fix-fail' }, { now: NOW });
    assert.equal(state.phase, 'fix');
    assert.equal(state.fixAttempts, 1);

    state = advance(state, { kind: 'fix-fail' }, { now: NOW });
    assert.equal(state.phase, 'escalated');
    assert.equal(state.escalationReason, 'max-fix-attempts-exceeded');
  });

  it('routes llm-review rejection back to fix with failedGate=llm-review', () => {
    let state = createInitialState({ now: NOW });
    state.phase = 'llm-review';
    state = advance(state, { kind: 'review-reject', reason: 'semantically wrong' }, { now: NOW });
    assert.equal(state.phase, 'fix');
    assert.equal(state.failedGate, 'llm-review');
  });

  it('hard-escalates on blast-radius-check failure', () => {
    let state = createInitialState({ now: NOW });
    state.phase = 'blast-radius-check';
    state = advance(state, { kind: 'gate-fail', reason: 'diff touches unrelated files' }, { now: NOW });
    assert.equal(state.phase, 'escalated');
    assert.equal(state.escalationReason, 'blast-radius-exceeded');
  });

  it('hard-escalates on category-check failure (safety-critical path)', () => {
    let state = createInitialState({ now: NOW });
    state.phase = 'category-check';
    state = advance(state, { kind: 'gate-fail', reason: 'touches auth/' }, { now: NOW });
    assert.equal(state.phase, 'escalated');
    assert.equal(state.escalationReason, 'safety-critical-category');
  });

  it('treats terminal phases as absorbing — advance is a no-op', () => {
    for (const phase of ['ship', 'escalated', 'failed'] as const) {
      const state = createInitialState({ now: NOW });
      state.phase = phase;
      const next = advance(state, { kind: 'phase-done' }, { now: NOW });
      assert.equal(next.phase, phase);
      assert.equal(next, state, 'terminal state should be returned unchanged');
    }
  });

  it('records transitions with from/to/reason metadata', () => {
    let state = createInitialState({ now: NOW });
    state = advance(state, { kind: 'phase-done' }, { now: NOW });
    assert.equal(state.transitions.length, 1);
    assert.deepEqual(state.transitions[0], {
      from: 'plan',
      to: 'prd',
      at: NOW(),
      reason: undefined,
    });
  });

  it('isTerminal correctly identifies terminal phases', () => {
    assert.equal(isTerminal('ship'), true);
    assert.equal(isTerminal('escalated'), true);
    assert.equal(isTerminal('failed'), true);
    assert.equal(isTerminal('plan'), false);
    assert.equal(isTerminal('verify-tests'), false);
    assert.equal(isTerminal('fix'), false);
  });
});
