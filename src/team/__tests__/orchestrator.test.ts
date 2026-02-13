import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canResumeTeamState,
  createTeamState,
  isTerminalPhase,
  isValidTransition,
  transitionPhase,
  type TeamState,
} from '../orchestrator.js';

function moveToVerify(initial: TeamState): TeamState {
  const prd = transitionPhase(initial, 'team-prd');
  const exec = transitionPhase(prd, 'team-exec');
  return transitionPhase(exec, 'team-verify');
}

describe('isValidTransition', () => {
  it('accepts canonical pipeline transitions', () => {
    assert.equal(isValidTransition('team-plan', 'team-prd'), true);
    assert.equal(isValidTransition('team-prd', 'team-exec'), true);
    assert.equal(isValidTransition('team-exec', 'team-verify'), true);
    assert.equal(isValidTransition('team-verify', 'team-fix'), true);
    assert.equal(isValidTransition('team-fix', 'team-exec'), true);
  });

  it('rejects invalid transitions', () => {
    assert.equal(isValidTransition('team-plan', 'team-exec'), false);
    assert.equal(isValidTransition('team-prd', 'team-verify'), false);
    assert.equal(isValidTransition('team-exec', 'complete'), false);
  });
});

describe('transitionPhase', () => {
  it('does not mutate input state when entering team-fix', () => {
    const start = createTeamState('immutable');
    const verify = moveToVerify(start);
    const beforeAttempt = verify.current_fix_attempt;

    const fix = transitionPhase(verify, 'team-fix', 'needs fixes');

    assert.equal(beforeAttempt, 0);
    assert.equal(verify.current_fix_attempt, 0);
    assert.equal(fix.current_fix_attempt, 1);
    assert.notEqual(fix, verify);
    assert.equal(fix.phase_transitions.at(-1)?.to, 'team-fix');
  });

  it('enforces bounded team-fix loop and transitions to failed with reason', () => {
    const start = createTeamState('bounded loop', 2);
    const verify1 = moveToVerify(start);
    const fix1 = transitionPhase(verify1, 'team-fix', 'attempt 1');
    const verify2 = transitionPhase(fix1, 'team-verify');
    const fix2 = transitionPhase(verify2, 'team-fix', 'attempt 2');
    const verify3 = transitionPhase(fix2, 'team-verify');
    const overflow = transitionPhase(verify3, 'team-fix', 'attempt 3');

    assert.equal(fix2.current_fix_attempt, 2);
    assert.equal(overflow.phase, 'failed');
    assert.equal(overflow.active, false);
    assert.equal(overflow.current_fix_attempt, 2);
    assert.equal(overflow.phase_transitions.at(-1)?.from, 'team-verify');
    assert.equal(overflow.phase_transitions.at(-1)?.to, 'failed');
    assert.match(
      overflow.phase_transitions.at(-1)?.reason ?? '',
      /team-fix loop limit reached \(2\)/
    );
  });

  it('prevents transitions from terminal phases', () => {
    const start = createTeamState('terminal');
    const verify = moveToVerify(start);
    const complete = transitionPhase(verify, 'complete');

    assert.equal(isTerminalPhase(complete.phase), true);
    assert.equal(canResumeTeamState(complete), false);
    assert.throws(
      () => transitionPhase(complete, 'team-fix'),
      /Cannot transition from terminal phase: complete/
    );
  });

  it('marks state non-resumable for failed and cancelled', () => {
    const failed: TeamState = {
      ...createTeamState('failed'),
      phase: 'failed',
      active: false,
    };
    const cancelled: TeamState = {
      ...createTeamState('cancelled'),
      phase: 'cancelled',
      active: false,
    };

    assert.equal(isTerminalPhase(failed.phase), true);
    assert.equal(isTerminalPhase(cancelled.phase), true);
    assert.equal(canResumeTeamState(failed), false);
    assert.equal(canResumeTeamState(cancelled), false);
  });

  it('throws on structurally invalid transition attempts', () => {
    const state = createTeamState('invalid');
    assert.throws(() => transitionPhase(state, 'team-verify'), /Invalid transition/);
  });

  it('preserves explicit reason and appends exactly one transition record', () => {
    const start = createTeamState('reason');
    const beforeLen = start.phase_transitions.length;
    const next = transitionPhase(start, 'team-prd', 'requirements clarified');

    assert.equal(start.phase_transitions.length, beforeLen);
    assert.equal(next.phase_transitions.length, beforeLen + 1);
    assert.equal(next.phase_transitions.at(-1)?.from, 'team-plan');
    assert.equal(next.phase_transitions.at(-1)?.to, 'team-prd');
    assert.equal(next.phase_transitions.at(-1)?.reason, 'requirements clarified');
    assert.ok(!Number.isNaN(Date.parse(next.phase_transitions.at(-1)?.at ?? '')));
  });

  it('marks complete as terminal and keeps fix attempt unchanged', () => {
    const start = createTeamState('complete-path', 5);
    const verify = moveToVerify(start);
    const complete = transitionPhase(verify, 'complete');

    assert.equal(complete.active, false);
    assert.equal(complete.phase, 'complete');
    assert.equal(complete.current_fix_attempt, 0);
    assert.equal(canResumeTeamState(complete), false);
  });
});

describe('canResumeTeamState', () => {
  it('returns false for non-terminal inactive state', () => {
    const paused: TeamState = {
      ...createTeamState('paused'),
      phase: 'team-exec',
      active: false,
    };
    assert.equal(isTerminalPhase(paused.phase), false);
    assert.equal(canResumeTeamState(paused), false);
  });
});
