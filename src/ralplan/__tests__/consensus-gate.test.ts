import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRalplanConsensusGateFromSources } from '../consensus-gate.js';

const orderedLifecycleReviews = {
  ralplan_consensus_gate: {
    complete: true,
    sequence: ['architect-review', 'critic-review'],
    ralplan_architect_review: {
      agent_role: 'architect',
      verdict: 'approve',
      provenance_kind: 'native_subagent',
      thread_id: 'architect-thread',
      sequence_index: 1,
    },
    ralplan_critic_review: {
      agent_role: 'critic',
      verdict: 'approve',
      provenance_kind: 'omx_adapted',
      thread_id: 'critic-thread',
      sequence_index: 2,
    },
  },
};

describe('ralplan consensus gate', () => {
  it('fails closed when locally supplied lifecycle evidence claims consensus', () => {
    const gate = buildRalplanConsensusGateFromSources([{
      source: 'same-user-state',
      value: { ...orderedLifecycleReviews, official_host_consensus_receipt: { issuer: 'same-user', approved: true } },
    }]);

    assert.equal(gate.complete, false);
    assert.equal(gate.blockedReason, 'documented_host_consensus_receipt_unavailable');
    assert.deepEqual(gate.blockedDetails, ['official host consensus receipt verifier is unavailable']);
  });

  it('retains typed Architect and Critic lifecycle routing for diagnostics', () => {
    const gate = buildRalplanConsensusGateFromSources([{
      source: 'same-user-state',
      value: orderedLifecycleReviews,
    }]);

    assert.equal(gate.source, 'same-user-state');
    assert.equal(gate.ralplan_architect_review?.agent_role, 'architect');
    assert.equal(gate.ralplan_architect_review?.sequence_index, 1);
    assert.equal(gate.ralplan_critic_review?.agent_role, 'critic');
    assert.equal(gate.ralplan_critic_review?.sequence_index, 2);
  });
});
