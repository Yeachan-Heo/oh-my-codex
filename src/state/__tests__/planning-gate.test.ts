import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluatePreToolUseGate,
  isImplementationToolCall,
  isPlanningGateBypassActive,
  containsBypassPlanningGatePhrase,
  computeBypassExpiry,
  buildPlanningGateLogEvent,
  PLANNING_GATE_BYPASS_TTL_MS,
  BYPASS_PLANNING_GATE_PHRASE,
  type PlanningGateState,
  type PreToolUseGateInput,
} from '../workflow-transition.js';
import {
  DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS,
  DEEP_INTERVIEW_INPUT_LOCK_MESSAGE,
} from '../../hooks/keyword-detector.js';
import { evaluateWorkflowTransition } from '../workflow-transition.js';

describe('planning gate: tool classification', () => {
  it('classifies Edit, Write, NotebookEdit as implementation tools', () => {
    assert.equal(isImplementationToolCall({ tool_name: 'Edit' }), true);
    assert.equal(isImplementationToolCall({ tool_name: 'Write' }), true);
    assert.equal(isImplementationToolCall({ tool_name: 'NotebookEdit' }), true);
  });

  it('classifies Bash with git push / gh pr create / gh pr merge as implementation tools', () => {
    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: 'git push origin main' }), true);
    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: 'gh pr create --title "fix"' }), true);
    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: 'gh pr merge 42' }), true);
  });

  it('does not classify Read, Glob, Grep, or safe Bash as implementation tools', () => {
    assert.equal(isImplementationToolCall({ tool_name: 'Read' }), false);
    assert.equal(isImplementationToolCall({ tool_name: 'Glob' }), false);
    assert.equal(isImplementationToolCall({ tool_name: 'Grep' }), false);
    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: 'git status' }), false);
    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: 'npm test' }), false);
    assert.equal(isImplementationToolCall({ tool_name: 'Bash', tool_input: 'ls -la' }), false);
  });

  it('does not classify Bash without tool_input as implementation tool', () => {
    assert.equal(isImplementationToolCall({ tool_name: 'Bash' }), false);
  });
});

describe('planning gate: downstream_authority=plan_then_execute + no ralplan consensus artifact', () => {
  const gateState: PlanningGateState = {
    downstream_authority: 'plan_then_execute',
  };

  it('denies Edit when no ralplan consensus artifact exists', () => {
    const decision = evaluatePreToolUseGate({ tool_name: 'Edit' }, gateState, false);
    assert.equal(decision.allowed, false);
    assert.equal(decision.gate_fired, true);
    assert.match(decision.reason!, /plan_then_execute/);
    assert.match(decision.reason!, /Edit denied/);
  });

  it('denies Write when no ralplan consensus artifact exists', () => {
    const decision = evaluatePreToolUseGate({ tool_name: 'Write' }, gateState, false);
    assert.equal(decision.allowed, false);
    assert.equal(decision.gate_fired, true);
    assert.match(decision.reason!, /Write denied/);
  });

  it('denies Bash(git push) when no ralplan consensus artifact exists', () => {
    const decision = evaluatePreToolUseGate(
      { tool_name: 'Bash', tool_input: 'git push origin fix/branch' },
      gateState,
      false,
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.gate_fired, true);
    assert.match(decision.reason!, /Bash denied/);
  });

  it('denies Bash(gh pr create) when no ralplan consensus artifact exists', () => {
    const decision = evaluatePreToolUseGate(
      { tool_name: 'Bash', tool_input: 'gh pr create --title "feature"' },
      gateState,
      false,
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.gate_fired, true);
  });

  it('allows Read when no ralplan consensus artifact exists', () => {
    const decision = evaluatePreToolUseGate({ tool_name: 'Read' }, gateState, false);
    assert.equal(decision.allowed, true);
    assert.equal(decision.gate_fired, undefined);
  });

  it('allows Glob when no ralplan consensus artifact exists', () => {
    const decision = evaluatePreToolUseGate({ tool_name: 'Glob' }, gateState, false);
    assert.equal(decision.allowed, true);
  });

  it('allows Grep when no ralplan consensus artifact exists', () => {
    const decision = evaluatePreToolUseGate({ tool_name: 'Grep' }, gateState, false);
    assert.equal(decision.allowed, true);
  });

  it('allows safe Bash commands when no ralplan consensus artifact exists', () => {
    const decision = evaluatePreToolUseGate(
      { tool_name: 'Bash', tool_input: 'npm test -- src/state/' },
      gateState,
      false,
    );
    assert.equal(decision.allowed, true);
  });
});

describe('planning gate: downstream_authority=plan_then_execute + fresh ralplan consensus artifact', () => {
  const gateState: PlanningGateState = {
    downstream_authority: 'plan_then_execute',
  };

  it('allows Edit when ralplan consensus artifact is present', () => {
    const decision = evaluatePreToolUseGate({ tool_name: 'Edit' }, gateState, true);
    assert.equal(decision.allowed, true);
  });

  it('allows Write when ralplan consensus artifact is present', () => {
    const decision = evaluatePreToolUseGate({ tool_name: 'Write' }, gateState, true);
    assert.equal(decision.allowed, true);
  });

  it('allows Bash(git push) when ralplan consensus artifact is present', () => {
    const decision = evaluatePreToolUseGate(
      { tool_name: 'Bash', tool_input: 'git push origin main' },
      gateState,
      true,
    );
    assert.equal(decision.allowed, true);
  });
});

describe('planning gate: bypass planning gate phrase + TTL', () => {
  it('detects bypass planning gate phrase case-insensitively', () => {
    assert.equal(containsBypassPlanningGatePhrase('please bypass planning gate for now'), true);
    assert.equal(containsBypassPlanningGatePhrase('BYPASS PLANNING GATE'), true);
    assert.equal(containsBypassPlanningGatePhrase('Bypass Planning Gate please'), true);
    assert.equal(containsBypassPlanningGatePhrase('just do it'), false);
  });

  it('allows implementation tools within TTL after bypass', () => {
    const now = new Date('2026-05-24T10:00:00.000Z');
    const gateState: PlanningGateState = {
      downstream_authority: 'plan_then_execute',
      bypass_planning_gate_until: new Date('2026-05-24T10:05:00.000Z').toISOString(),
    };

    const decision = evaluatePreToolUseGate({ tool_name: 'Edit' }, gateState, false, now);
    assert.equal(decision.allowed, true);
    assert.match(decision.reason!, /bypass_planning_gate active/);
  });

  it('denies implementation tools after TTL expires', () => {
    const now = new Date('2026-05-24T10:15:00.000Z');
    const gateState: PlanningGateState = {
      downstream_authority: 'plan_then_execute',
      bypass_planning_gate_until: new Date('2026-05-24T10:05:00.000Z').toISOString(),
    };

    const decision = evaluatePreToolUseGate({ tool_name: 'Edit' }, gateState, false, now);
    assert.equal(decision.allowed, false);
    assert.equal(decision.gate_fired, true);
  });

  it('computeBypassExpiry produces a TTL of 10 minutes', () => {
    const now = new Date('2026-05-24T10:00:00.000Z');
    const expiry = computeBypassExpiry(now);
    const expiryMs = Date.parse(expiry);
    assert.equal(expiryMs - now.getTime(), PLANNING_GATE_BYPASS_TTL_MS);
    assert.equal(PLANNING_GATE_BYPASS_TTL_MS, 10 * 60 * 1000);
  });

  it('isPlanningGateBypassActive returns false for empty or invalid bypass timestamps', () => {
    assert.equal(isPlanningGateBypassActive({ downstream_authority: 'plan_then_execute' }), false);
    assert.equal(
      isPlanningGateBypassActive({ downstream_authority: 'plan_then_execute', bypass_planning_gate_until: '' }),
      false,
    );
    assert.equal(
      isPlanningGateBypassActive({ downstream_authority: 'plan_then_execute', bypass_planning_gate_until: 'not-a-date' }),
      false,
    );
  });

  it('denies again after mode transition clears bypass (simulated by removing bypass field)', () => {
    const gateStateWithoutBypass: PlanningGateState = {
      downstream_authority: 'plan_then_execute',
    };

    const decision = evaluatePreToolUseGate(
      { tool_name: 'Edit' },
      gateStateWithoutBypass,
      false,
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.gate_fired, true);
  });
});

describe('planning gate: execute_now downstream authority', () => {
  it('allows all tools when downstream_authority is execute_now', () => {
    const gateState: PlanningGateState = {
      downstream_authority: 'execute_now',
    };

    assert.equal(evaluatePreToolUseGate({ tool_name: 'Edit' }, gateState, false).allowed, true);
    assert.equal(evaluatePreToolUseGate({ tool_name: 'Write' }, gateState, false).allowed, true);
    assert.equal(
      evaluatePreToolUseGate({ tool_name: 'Bash', tool_input: 'git push' }, gateState, false).allowed,
      true,
    );
  });

  it('allows all tools when no gate state exists', () => {
    assert.equal(evaluatePreToolUseGate({ tool_name: 'Edit' }, null, false).allowed, true);
    assert.equal(evaluatePreToolUseGate({ tool_name: 'Write' }, undefined, false).allowed, true);
  });
});

describe('planning gate: telemetry log event', () => {
  it('builds a structured log event when gate fires', () => {
    const gateState: PlanningGateState = {
      downstream_authority: 'plan_then_execute',
    };
    const toolInput: PreToolUseGateInput = { tool_name: 'Edit' };
    const decision = evaluatePreToolUseGate(toolInput, gateState, false);
    const logEvent = buildPlanningGateLogEvent(decision, toolInput, gateState);

    assert.equal(logEvent.event, 'planning-gate-fired');
    assert.equal(logEvent.tool_name, 'Edit');
    assert.equal(logEvent.allowed, false);
    assert.equal(logEvent.downstream_authority, 'plan_then_execute');
    assert.equal(logEvent.bypass_active, false);
    assert.ok(logEvent.timestamp);
  });
});

describe('regression: explicit $ralplan top-level entry path is unaffected', () => {
  it('allows ralplan activation from empty state', () => {
    const decision = evaluateWorkflowTransition([], 'ralplan');
    assert.equal(decision.allowed, true);
    assert.equal(decision.kind, 'allow');
    assert.deepEqual(decision.resultingModes, ['ralplan']);
  });

  it('allows deep-interview -> ralplan auto-complete transition', () => {
    const decision = evaluateWorkflowTransition(['deep-interview'], 'ralplan');
    assert.equal(decision.allowed, true);
    assert.equal(decision.kind, 'auto-complete');
    assert.deepEqual(decision.autoCompleteModes, ['deep-interview']);
    assert.deepEqual(decision.resultingModes, ['ralplan']);
  });

  it('planning gate does not interfere with workflow transitions', () => {
    const gateState: PlanningGateState = {
      downstream_authority: 'plan_then_execute',
    };
    const readDecision = evaluatePreToolUseGate({ tool_name: 'Read' }, gateState, false);
    assert.equal(readDecision.allowed, true);

    const transitionDecision = evaluateWorkflowTransition([], 'ralplan');
    assert.equal(transitionDecision.allowed, true);
  });
});

describe('regression: existing DEEP_INTERVIEW_INPUT_LOCK_MESSAGE behavior unchanged', () => {
  it('DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS contains the expected blocked inputs', () => {
    assert.ok(DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS.includes('yes'));
    assert.ok(DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS.includes('y'));
    assert.ok(DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS.includes('proceed'));
    assert.ok(DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS.includes('continue'));
    assert.ok(DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS.includes('ok'));
    assert.ok(DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS.includes('sure'));
    assert.ok(DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS.includes('go ahead'));
    assert.ok(DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS.includes('next i should'));
  });

  it('DEEP_INTERVIEW_INPUT_LOCK_MESSAGE is the expected string', () => {
    assert.equal(
      DEEP_INTERVIEW_INPUT_LOCK_MESSAGE,
      'Deep interview is active; auto-approval shortcuts are blocked until the interview finishes.',
    );
  });

  it('planning gate is orthogonal to input lock — gate evaluates tool calls, not user inputs', () => {
    const gateState: PlanningGateState = {
      downstream_authority: 'plan_then_execute',
    };
    for (const blockedInput of DEEP_INTERVIEW_BLOCKED_APPROVAL_INPUTS) {
      assert.equal(typeof blockedInput, 'string');
    }
    const decision = evaluatePreToolUseGate({ tool_name: 'Read' }, gateState, false);
    assert.equal(decision.allowed, true);
  });
});
