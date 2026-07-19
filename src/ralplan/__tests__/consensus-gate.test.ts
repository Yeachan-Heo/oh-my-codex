import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRalplanConsensusGateFromSources } from '../consensus-gate.js';

const nativeLifecycleReviews = {
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
      provenance_kind: 'native_subagent',
      thread_id: 'critic-thread',
      sequence_index: 2,
    },
  },
};

function withReviews(
  architect: Record<string, unknown>,
  critic: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ralplan_consensus_gate: {
      complete: true,
      sequence: ['architect-review', 'critic-review'],
      ralplan_architect_review: architect,
      ralplan_critic_review: critic,
    },
  };
}

describe('ralplan consensus gate', () => {
  it('fails closed when locally supplied lifecycle evidence claims consensus', () => {
    const gate = buildRalplanConsensusGateFromSources([{
      source: 'same-user-state',
      value: { ...nativeLifecycleReviews, official_host_consensus_receipt: { issuer: 'same-user', approved: true } },
    }]);

    assert.equal(gate.complete, false);
    assert.equal(gate.blockedReason, 'documented_host_consensus_receipt_unavailable');
    assert.deepEqual(gate.blockedDetails, ['official host consensus receipt verifier is unavailable']);
  });

  it('retains typed Architect and Critic lifecycle routing for diagnostics', () => {
    const gate = buildRalplanConsensusGateFromSources([{
      source: 'same-user-state',
      value: nativeLifecycleReviews,
    }]);

    assert.equal(gate.source, 'same-user-state');
    assert.equal(gate.ralplan_architect_review?.agent_role, 'architect');
    assert.equal(gate.ralplan_architect_review?.sequence_index, 1);
    assert.equal(gate.ralplan_critic_review?.agent_role, 'critic');
    assert.equal(gate.ralplan_critic_review?.sequence_index, 2);
  });

  it('retains newer invalid lifecycle diagnostics ahead of older native lifecycle evidence', () => {
    const gate = buildRalplanConsensusGateFromSources([
      { source: 'older-native', value: nativeLifecycleReviews },
      { source: 'newer-invalid', value: withReviews(
        { ...nativeLifecycleReviews.ralplan_consensus_gate.ralplan_architect_review, sequence_index: 4 },
        { ...nativeLifecycleReviews.ralplan_consensus_gate.ralplan_critic_review, sequence_index: 3 },
      ) },
    ]);

    assert.equal(gate.complete, false);
    assert.equal(gate.source, 'newer-invalid');
    assert.equal(gate.ralplan_architect_review?.sequence_index, 4);
    assert.equal(gate.ralplan_critic_review?.sequence_index, 3);
  });

  for (const [name, value] of [
    ['adapted provenance', withReviews(
      { ...nativeLifecycleReviews.ralplan_consensus_gate.ralplan_architect_review, provenance_kind: 'omx_adapted' },
      nativeLifecycleReviews.ralplan_consensus_gate.ralplan_critic_review,
    )],
    ['roleless review', withReviews(
      { ...nativeLifecycleReviews.ralplan_consensus_gate.ralplan_architect_review, agent_role: undefined },
      nativeLifecycleReviews.ralplan_consensus_gate.ralplan_critic_review,
    )],
    ['same thread', withReviews(
      nativeLifecycleReviews.ralplan_consensus_gate.ralplan_architect_review,
      { ...nativeLifecycleReviews.ralplan_consensus_gate.ralplan_critic_review, thread_id: 'architect-thread' },
    )],
    ['reversed order', withReviews(
      { ...nativeLifecycleReviews.ralplan_consensus_gate.ralplan_architect_review, sequence_index: 2 },
      { ...nativeLifecycleReviews.ralplan_consensus_gate.ralplan_critic_review, sequence_index: 1 },
    )],
    ['history evidence', {
      review_history: [{
        architect_review: nativeLifecycleReviews.ralplan_consensus_gate.ralplan_architect_review,
        critic_review: nativeLifecycleReviews.ralplan_consensus_gate.ralplan_critic_review,
      }],
    }],
  ] as const) {
    it(`keeps ${name} inert unless it is an ordered native lifecycle pair`, () => {
      const gate = buildRalplanConsensusGateFromSources([{ source: name, value }]);
      assert.equal(gate.complete, false);
      assert.equal(gate.source, name);
      if (name !== 'history evidence') {
        assert.ok(gate.ralplan_architect_review);
        assert.ok(gate.ralplan_critic_review);
      }
    });
  }
});
