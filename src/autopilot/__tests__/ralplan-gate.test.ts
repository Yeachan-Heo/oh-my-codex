import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  buildAutopilotRalplanUltragoalGateError,
  canAdvanceAutopilotRalplanToUltragoal,
} from '../ralplan-gate.js';
import { buildRalplanConsensusGateFromSources } from '../../ralplan/consensus-gate.js';
import { subagentTrackingPath } from '../../subagents/tracker.js';

const approvingLocalConsensus = {
  complete: true,
  sequence: ['architect-review', 'critic-review'],
  ralplan_architect_review: {
    agent_role: 'architect',
    verdict: 'approve',
    completed_at: '2026-06-12T10:02:00.000Z',
    thread_id: 'architect-local-lifecycle',
    provenance_kind: 'native_subagent',
  },
  ralplan_critic_review: {
    agent_role: 'critic',
    verdict: 'approve',
    completed_at: '2026-06-12T10:03:00.000Z',
    thread_id: 'critic-local-lifecycle',
    provenance_kind: 'native_subagent',
  },
};

function lifecycleConsensus(reviewCycle: number, criticVerdict: 'approve' | 'iterate' = 'approve') {
  return {
    complete: true,
    sequence: ['architect-review', 'critic-review'],
    ralplan_architect_review: {
      agent_role: 'architect',
      verdict: 'approve',
      review_cycle: reviewCycle,
      completed_at: '2026-06-12T10:02:00.000Z',
      thread_id: `architect-lifecycle-${reviewCycle}`,
      provenance_kind: 'native_subagent',
    },
    ralplan_critic_review: {
      agent_role: 'critic',
      verdict: criticVerdict,
      review_cycle: reviewCycle,
      completed_at: '2026-06-12T10:03:00.000Z',
      thread_id: `critic-lifecycle-${reviewCycle}`,
      provenance_kind: 'native_subagent',
    },
  };
}

function writeConsensusTracker(
  cwd: string,
  sessionId: string,
  consensus: typeof approvingLocalConsensus,
): void {
  const architectReview = consensus.ralplan_architect_review;
  const criticReview = consensus.ralplan_critic_review;
  const trackerPath = subagentTrackingPath(cwd);
  mkdirSync(dirname(trackerPath), { recursive: true });
  writeFileSync(trackerPath, JSON.stringify({
    schemaVersion: 1,
    sessions: {
      [sessionId]: {
        session_id: sessionId,
        updated_at: criticReview.completed_at,
        threads: {
          [architectReview.thread_id]: {
            thread_id: architectReview.thread_id,
            kind: 'subagent',
            role: 'architect',
            provenance_kind: 'native_subagent',
            first_seen_at: architectReview.completed_at,
            last_seen_at: architectReview.completed_at,
            completed_at: architectReview.completed_at,
            turn_count: 1,
          },
          [criticReview.thread_id]: {
            thread_id: criticReview.thread_id,
            kind: 'subagent',
            role: 'critic',
            provenance_kind: 'native_subagent',
            first_seen_at: criticReview.completed_at,
            last_seen_at: criticReview.completed_at,
            completed_at: criticReview.completed_at,
            turn_count: 1,
          },
        },
      },
    },
  }));
}


describe('autopilot ralplan gate', () => {
  it('uses local owner lifecycle authority even when receipt-shaped local input is present', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-autopilot-hostile-artifact-'));
    const sessionId = 'hostile-local-artifacts';
    try {
      writeConsensusTracker(cwd, sessionId, approvingLocalConsensus);
      const evidence = buildRalplanConsensusGateFromSources([{
        source: 'hostile-local-artifacts',
        sessionId,
        value: {
          started_at: '2026-06-12T10:01:00.000Z',
          documented_host_consensus_receipt: { issuer: 'official-host', verdict: 'approve' },
          ralplan_consensus_gate: approvingLocalConsensus,
        },
      }], { cwd, sessionId });

      assert.equal(evidence.complete, true, evidence.blockedDetails?.join('; ') ?? 'unexpected blocker');
      assert.equal(evidence.authority_policy, 'local_owner_lifecycle');
      assert.equal(evidence.source, 'hostile-local-artifacts');
      assert.equal(evidence.blockedReason, null);
      assert.equal(evidence.blockedDetails, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('allows the ralplan to ultragoal transition on valid local lifecycle evidence', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-autopilot-consensus-'));
    const sessionId = 'hostile-local-consensus';
    try {
      writeConsensusTracker(cwd, sessionId, approvingLocalConsensus);
      const decision = canAdvanceAutopilotRalplanToUltragoal({
        cwd,
        sessionId,
        currentState: {
          current_phase: 'ralplan',
          started_at: '2026-06-12T10:01:00.000Z',
          handoff_artifacts: { ralplan_consensus_gate: approvingLocalConsensus },
        },
      });

      assert.equal(decision.allowed, true, decision.evidence?.blockedDetails?.join('; ') ?? decision.reason);
      assert.equal(decision.evidence?.authority_policy, 'local_owner_lifecycle');
      assert.match(decision.reason, /local owner authority/i);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('retains the fail-closed diagnostic for malformed local lifecycle evidence', () => {
    const evidence = buildRalplanConsensusGateFromSources([{
      source: 'malformed-local-lifecycle',
      value: {
        ralplan_consensus_gate: {
          complete: true,
          sequence: ['critic-review', 'architect-review'],
          ralplan_architect_review: { agent_role: 'critic', verdict: 'approve' },
          ralplan_critic_review: { agent_role: 'architect', verdict: 'iterate' },
        },
      },
    }]);

    assert.equal(evidence.complete, false);
    assert.equal(evidence.authority_policy, null);
    assert.equal(evidence.blockedReason, 'non_approving_ralplan_consensus_review');
  });

  it('retains current-state lifecycle diagnostics when next state has no consensus source', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-autopilot-current-consensus-'));
    const sessionId = 'current-lifecycle-consensus';
    const consensus = lifecycleConsensus(1);
    try {
      writeConsensusTracker(cwd, sessionId, consensus);
      const decision = canAdvanceAutopilotRalplanToUltragoal({
        cwd,
        sessionId,
        currentState: {
          started_at: '2026-06-12T10:01:00.000Z',
          ralplan_consensus_gate: consensus,
        },
        nextState: { current_phase: 'ultragoal' },
      });

      assert.equal(decision.allowed, true, decision.evidence?.blockedDetails?.join('; ') ?? decision.reason);
      assert.equal(decision.evidence?.authority_policy, 'local_owner_lifecycle');
      assert.equal(decision.evidence?.source, 'current-autopilot-state');
      assert.equal(decision.evidence?.ralplan_architect_review?.review_cycle, 1);
      assert.equal(decision.evidence?.ralplan_critic_review?.review_cycle, 1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('keeps a newer invalid next-state lifecycle record ahead of older current-state reviews', () => {
    const decision = canAdvanceAutopilotRalplanToUltragoal({
      cwd: process.cwd(),
      currentState: { ralplan_consensus_gate: lifecycleConsensus(1) },
      nextState: { ralplan_consensus_gate: lifecycleConsensus(2, 'iterate') },
    });

    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'ralplan consensus gate contains non-approving architect or critic review evidence');
    assert.equal(decision.evidence?.authority_policy, null);
    assert.equal(decision.evidence?.source, 'next-autopilot-state');
    assert.equal(decision.evidence?.ralplan_architect_review?.review_cycle, 2);
    assert.equal(decision.evidence?.ralplan_critic_review?.verdict, 'iterate');
    assert.match(buildAutopilotRalplanUltragoalGateError(decision), /non-approving/i);
  });

  it('does not fall back to old current approval when next state explicitly resets the lifecycle', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-autopilot-next-reset-'));
    const sessionId = 'next-reset-consensus';
    try {
      writeConsensusTracker(cwd, sessionId, approvingLocalConsensus);
      const decision = canAdvanceAutopilotRalplanToUltragoal({
        cwd,
        sessionId,
        currentState: {
          started_at: '2026-06-12T10:01:00.000Z',
          ralplan_consensus_gate: approvingLocalConsensus,
        },
        nextState: {
          current_phase: 'ralplan',
          ralplan_pass_started_at: '2026-06-12T10:04:00.000Z',
          ralplan_consensus_gate: { complete: false },
        },
      });

      assert.equal(decision.allowed, false);
      assert.equal(decision.evidence?.source, 'next-autopilot-state');
      assert.match(decision.evidence?.blockedDetails?.join('; ') ?? '', /consensus gate is incomplete/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('does not fall back to old current approval when next state explicitly clears the lifecycle', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-autopilot-next-clear-'));
    const sessionId = 'next-clear-consensus';
    try {
      writeConsensusTracker(cwd, sessionId, approvingLocalConsensus);
      const decision = canAdvanceAutopilotRalplanToUltragoal({
        cwd,
        sessionId,
        currentState: {
          started_at: '2026-06-12T10:01:00.000Z',
          ralplan_consensus_gate: approvingLocalConsensus,
        },
        nextState: {
          current_phase: 'ralplan',
          ralplan_pass_started_at: '2026-06-12T10:04:00.000Z',
          ralplan_consensus_gate: null,
        },
      });

      assert.equal(decision.allowed, false);
      assert.equal(decision.evidence?.source, null);
      assert.equal(decision.evidence?.blockedReason, 'native_subagent_consensus_evidence_missing');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
