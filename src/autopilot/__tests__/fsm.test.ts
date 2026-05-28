import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deriveAutopilotChildPhase,
  deriveAutopilotStageLabel,
  isAutopilotSupervising,
  isAutopilotSupervisingChild,
  normalizeAutopilotPhase,
} from '../fsm.js';

describe('autopilot supervisor FSM helpers', () => {
  it('normalizes only known Autopilot runtime phases', () => {
    assert.equal(normalizeAutopilotPhase('deep_interview'), 'deep-interview');
    assert.equal(normalizeAutopilotPhase('waiting_for_user'), 'waiting-for-user');
    assert.equal(normalizeAutopilotPhase('team'), 'team');
    assert.equal(normalizeAutopilotPhase('ralph'), 'ralph');
    assert.equal(normalizeAutopilotPhase('completed'), 'complete');
    assert.equal(normalizeAutopilotPhase('planning'), 'ralplan');
  });

  it('derives child-stage labels only from Autopilot supervisor state', () => {
    const autopilotState = {
      mode: 'autopilot',
      active: true,
      current_phase: 'deep-interview',
    };

    assert.equal(isAutopilotSupervising(autopilotState), true);
    assert.equal(isAutopilotSupervisingChild(autopilotState, 'deep-interview'), true);
    assert.equal(deriveAutopilotChildPhase(autopilotState), 'deep-interview');
    assert.equal(deriveAutopilotStageLabel(autopilotState), 'autopilot:deep-interview');
  });

  it('maps waiting-for-user back to the supervised deep-interview child stage', () => {
    const waitingState = {
      mode: 'autopilot',
      active: true,
      current_phase: 'waiting-for-user',
      state: {
        deep_interview_question: {
          status: 'waiting_for_user',
          previous_phase: 'deep-interview',
        },
      },
    };

    assert.equal(isAutopilotSupervising(waitingState), true);
    assert.equal(isAutopilotSupervisingChild(waitingState, 'deep-interview'), true);
    assert.equal(deriveAutopilotStageLabel(waitingState), 'autopilot:deep-interview');
  });

  it('recognizes documented conditional and legacy supervised phases', () => {
    assert.equal(deriveAutopilotStageLabel({
      mode: 'autopilot',
      active: true,
      current_phase: 'team',
    }), 'autopilot:team');
    assert.equal(deriveAutopilotStageLabel({
      mode: 'autopilot',
      active: true,
      current_phase: 'ralph',
    }), 'autopilot:ralph');
    assert.equal(deriveAutopilotStageLabel({
      mode: 'autopilot',
      active: true,
      current_phase: 'planning',
    }), 'autopilot:ralplan');
  });

  it('does not derive standalone workflow states as Autopilot stage labels', () => {
    const standaloneDeepInterview = {
      mode: 'deep-interview',
      active: true,
      current_phase: 'intent-first',
    };

    assert.equal(isAutopilotSupervising(standaloneDeepInterview), false);
    assert.equal(deriveAutopilotStageLabel(standaloneDeepInterview), null);

    const standaloneRalplan = {
      mode: 'ralplan',
      active: true,
      current_phase: 'ralplan',
    };

    assert.equal(isAutopilotSupervising(standaloneRalplan), false);
    assert.equal(deriveAutopilotChildPhase(standaloneRalplan), null);
    assert.equal(deriveAutopilotStageLabel(standaloneRalplan), null);
  });
});
