import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorkflowTransitionMessage,
  buildWorkflowTransitionError,
  evaluateWorkflowTransition,
} from '../workflow-transition.js';

describe('workflow transition rules', () => {
  it('allows the approved overlap matrix and denies unsupported combinations', () => {
    const cases: Array<{
      current: string[];
      requested: 'team' | 'ralph' | 'ultrawork' | 'autopilot' | 'autoresearch';
      allowed: boolean;
      resulting: string[];
    }> = [
      { current: [], requested: 'team', allowed: true, resulting: ['team'] },
      { current: ['team'], requested: 'ralph', allowed: true, resulting: ['team', 'ralph'] },
      { current: ['ralph'], requested: 'team', allowed: true, resulting: ['ralph', 'team'] },
      { current: ['team'], requested: 'ultrawork', allowed: true, resulting: ['team', 'ultrawork'] },
      { current: ['ultrawork'], requested: 'team', allowed: true, resulting: ['ultrawork', 'team'] },
      { current: ['ralph'], requested: 'ultrawork', allowed: true, resulting: ['ralph', 'ultrawork'] },
      { current: ['ultrawork'], requested: 'ralph', allowed: true, resulting: ['ultrawork', 'ralph'] },
      { current: ['autopilot'], requested: 'team', allowed: false, resulting: ['autopilot'] },
      { current: ['team'], requested: 'autopilot', allowed: false, resulting: ['team'] },
      { current: ['autoresearch'], requested: 'ralph', allowed: false, resulting: ['autoresearch'] },
      { current: ['team', 'ralph'], requested: 'ultrawork', allowed: true, resulting: ['team', 'ralph', 'ultrawork'] },
      { current: ['team', 'ultrawork'], requested: 'ralph', allowed: true, resulting: ['team', 'ultrawork', 'ralph'] },
    ];

    for (const testCase of cases) {
      const decision = evaluateWorkflowTransition(testCase.current, testCase.requested);
      assert.equal(decision.allowed, testCase.allowed, `${testCase.current.join(',')} -> ${testCase.requested}`);
      assert.deepEqual(decision.resultingModes, testCase.resulting, `${testCase.current.join(',')} -> ${testCase.requested}`);
    }
  });

  it('builds actionable denial guidance that names both clearing paths', () => {
    const error = buildWorkflowTransitionError(['team'], 'autopilot', 'start');
    assert.match(error, /Cannot start autopilot: team is already active\./);
    assert.match(error, /Unsupported workflow overlap: team \+ autopilot\./);
    assert.match(error, /Current state is unchanged\./);
    assert.match(error, /Clear incompatible workflow state yourself via/);
    assert.match(error, /`omx state clear --mode <mode>`/);
    assert.match(error, /`omx_state\.\*` MCP tools/);
  });

  it('returns auto-complete decisions for allowlisted forward transitions', () => {
    const interviewToRalplan = evaluateWorkflowTransition(['deep-interview'], 'ralplan');
    assert.equal(interviewToRalplan.allowed, true);
    assert.equal(interviewToRalplan.kind, 'auto-complete');
    assert.deepEqual(interviewToRalplan.autoCompleteModes, ['deep-interview']);
    assert.deepEqual(interviewToRalplan.resultingModes, ['ralplan']);
    assert.equal(interviewToRalplan.transitionMessage, 'mode transiting: deep-interview -> ralplan');

    const ralplanToRalph = evaluateWorkflowTransition(['ralplan', 'ultrawork'], 'ralph');
    assert.equal(ralplanToRalph.allowed, true);
    assert.equal(ralplanToRalph.kind, 'auto-complete');
    assert.deepEqual(ralplanToRalph.autoCompleteModes, ['ralplan']);
    assert.deepEqual(ralplanToRalph.resultingModes, ['ultrawork', 'ralph']);

    const autopilotToRalph = evaluateWorkflowTransition(['autopilot'], 'ralph');
    assert.equal(autopilotToRalph.allowed, true);
    assert.equal(autopilotToRalph.kind, 'auto-complete');
    assert.deepEqual(autopilotToRalph.autoCompleteModes, ['autopilot']);
    assert.deepEqual(autopilotToRalph.resultingModes, ['ralph']);
    assert.equal(autopilotToRalph.transitionMessage, 'mode transiting: autopilot -> ralph');
  });

  it('builds rollback denial guidance for execution-to-planning transitions', () => {
    const error = buildWorkflowTransitionError(['autopilot'], 'ralplan', 'start');
    assert.match(error, /Execution-to-planning rollback auto-complete is not allowed\./);
    assert.match(error, /First clear current state first and retry if this action is intended\./);
    assert.match(error, /Clear incompatible workflow state yourself via/);
  });

  it('formats transition audit messages', () => {
    assert.equal(
      buildWorkflowTransitionMessage('ralplan', 'ralph'),
      'mode transiting: ralplan -> ralph',
    );
  });
});
