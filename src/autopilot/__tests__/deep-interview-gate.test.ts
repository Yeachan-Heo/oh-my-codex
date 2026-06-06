import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canAdvanceAutopilotDeepInterviewToRalplan } from '../deep-interview-gate.js';

function validExecutionContract(stride: 'task' | 'deliverable' | 'milestone'): Record<string, unknown> {
  const perStride = {
    task: {
      allow_task_shrink: true,
      acceptance_coverage_scope: 'task',
      shrink_policy: 'allowed',
      completion_unit: 'One focused task',
      stop_condition: 'Stop after that task is implemented and verified',
    },
    deliverable: {
      allow_task_shrink: false,
      acceptance_coverage_scope: 'deliverable',
      shrink_policy: 'ask_before_shrink',
      completion_unit: 'The named deliverable',
      stop_condition: 'Stop after the deliverable is complete and verified',
    },
    milestone: {
      allow_task_shrink: false,
      acceptance_coverage_scope: 'milestone',
      shrink_policy: 'deny_unless_blocked',
      completion_unit: 'The approved milestone',
      stop_condition: 'Stop after the milestone is complete unless blocked',
    },
  } as const;

  return {
    version: 1,
    execution_stride: stride,
    source: 'deep-interview',
    selected_by: 'user',
    ...perStride[stride],
  };
}

describe('autopilot deep-interview gate execution contract', () => {
  it('falls back to persisted contract state when nextState is partial', async () => {
    const persistedState = {
      current_phase: 'deep-interview',
      state: {
        deep_interview_gate: {
          status: 'complete',
          rationale: 'Persisted gate and contract are ready for ralplan.',
        },
        handoff_artifacts: {
          deep_interview: {
            summary: 'Persisted handoff contract is canonical.',
            execution_contract_required: true,
            execution_contract: validExecutionContract('milestone'),
          },
        },
      },
    };

    const decision = await canAdvanceAutopilotDeepInterviewToRalplan({
      cwd: process.cwd(),
      currentState: persistedState,
      nextState: {
        active: true,
        current_phase: 'ralplan',
      },
    });

    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, 'record-backed deep-interview completion gate');
  });

  it('rejects an invalid contract explicitly supplied by nextState before persisted fallback', async () => {
    const persistedState = {
      current_phase: 'deep-interview',
      state: {
        deep_interview_gate: {
          status: 'complete',
          rationale: 'Persisted gate and contract are ready for ralplan.',
        },
        handoff_artifacts: {
          deep_interview: {
            summary: 'Persisted handoff contract is canonical.',
            execution_contract_required: true,
            execution_contract: validExecutionContract('milestone'),
          },
        },
      },
    };

    const decision = await canAdvanceAutopilotDeepInterviewToRalplan({
      cwd: process.cwd(),
      currentState: persistedState,
      nextState: {
        active: true,
        current_phase: 'ralplan',
        execution_contract: {
          ...validExecutionContract('milestone'),
          shrink_policy: 'allowed',
        },
      },
    });

    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /execution_contract/i);
    assert.equal(decision.evidence?.execution_contract_status, 'invalid');
  });

  it('rejects a placeholder contract explicitly supplied by nextState before persisted fallback', async () => {
    const persistedState = {
      current_phase: 'deep-interview',
      state: {
        deep_interview_gate: {
          status: 'complete',
          rationale: 'Persisted gate and contract are ready for ralplan.',
        },
        handoff_artifacts: {
          deep_interview: {
            summary: 'Persisted handoff contract is canonical.',
            execution_contract_required: true,
            execution_contract: validExecutionContract('milestone'),
          },
        },
      },
    };

    const decision = await canAdvanceAutopilotDeepInterviewToRalplan({
      cwd: process.cwd(),
      currentState: persistedState,
      nextState: {
        active: true,
        current_phase: 'ralplan',
        execution_contract: {},
      },
    });

    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /execution_contract/i);
    assert.equal(decision.evidence?.execution_contract_status, 'invalid');
  });

  it('rejects a non-object contract explicitly supplied by nextState before persisted fallback', async () => {
    const persistedState = {
      current_phase: 'deep-interview',
      state: {
        deep_interview_gate: {
          status: 'complete',
          rationale: 'Persisted gate and contract are ready for ralplan.',
        },
        handoff_artifacts: {
          deep_interview: {
            summary: 'Persisted handoff contract is canonical.',
            execution_contract_required: true,
            execution_contract: validExecutionContract('milestone'),
          },
        },
      },
    };

    const decision = await canAdvanceAutopilotDeepInterviewToRalplan({
      cwd: process.cwd(),
      currentState: persistedState,
      nextState: {
        active: true,
        current_phase: 'ralplan',
        execution_contract: 'placeholder',
      },
    });

    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /execution_contract/i);
    assert.equal(decision.evidence?.execution_contract_status, 'invalid');
  });

  it('rejects a non-object handoff-local contract before compatibility fallback', async () => {
    const decision = await canAdvanceAutopilotDeepInterviewToRalplan({
      cwd: process.cwd(),
      currentState: {
        current_phase: 'deep-interview',
        execution_contract: validExecutionContract('deliverable'),
        state: {
          deep_interview_gate: {
            status: 'complete',
            rationale: 'Compatibility direct contract is available.',
          },
          handoff_artifacts: {
            deep_interview: {
              summary: 'Handoff-local malformed contract must fail before direct fallback.',
              execution_contract_required: true,
              execution_contract: [],
            },
          },
        },
      },
      nextState: {
        active: true,
        current_phase: 'ralplan',
      },
    });

    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /execution_contract/i);
    assert.equal(decision.evidence?.execution_contract_status, 'invalid');
  });

  it('allows a direct compatibility contract to satisfy a handoff required marker', async () => {
    const decision = await canAdvanceAutopilotDeepInterviewToRalplan({
      cwd: process.cwd(),
      currentState: {
        current_phase: 'deep-interview',
        execution_contract: validExecutionContract('deliverable'),
        state: {
          deep_interview_gate: {
            status: 'complete',
            rationale: 'Compatibility direct contract is available.',
          },
          handoff_artifacts: {
            deep_interview: {
              summary: 'Marker is canonical; contract came from a compatibility location.',
              execution_contract_required: true,
            },
          },
        },
      },
      nextState: {
        active: true,
        current_phase: 'ralplan',
      },
    });

    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, 'record-backed deep-interview completion gate');
  });
});
