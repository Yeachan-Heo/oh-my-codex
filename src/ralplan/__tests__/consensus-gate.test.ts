import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { subagentTrackingPath } from '../../subagents/tracker.js';
import { buildRalplanConsensusGateFromSources } from '../consensus-gate.js';

const nativeLifecycleReviews = {
  started_at: '2026-08-05T09:59:00.000Z',
  ralplan_consensus_gate: {
    complete: true,
    sequence: ['architect-review', 'critic-review'],
    ralplan_architect_review: {
      agent_role: 'architect',
      verdict: 'approve',
      provenance_kind: 'native_subagent',
      thread_id: 'architect-thread',
      sequence_index: 1,
      completed_at: '2026-08-05T10:00:00.000Z',
    },
    ralplan_critic_review: {
      agent_role: 'critic',
      verdict: 'approve',
      provenance_kind: 'native_subagent',
      thread_id: 'critic-thread',
      sequence_index: 2,
      completed_at: '2026-08-05T10:01:00.000Z',
    },
  },
};

function withReviews(
  architect: Record<string, unknown>,
  critic: Record<string, unknown>,
): Record<string, unknown> {
  return {
    started_at: '2026-08-05T09:59:00.000Z',
    ralplan_consensus_gate: {
      complete: true,
      sequence: ['architect-review', 'critic-review'],
      ralplan_architect_review: architect,
      ralplan_critic_review: critic,
    },
  };
}

function writeNativeTracker(
  cwd: string,
  sessionId: string,
  mutate: (threads: Record<string, Record<string, unknown>>) => void = () => {},
): void {
  const architectCompletedAt = '2026-08-05T10:00:00.000Z';
  const criticCompletedAt = '2026-08-05T10:01:00.000Z';
  const threads: Record<string, Record<string, unknown>> = {
    'architect-thread': {
      thread_id: 'architect-thread',
      kind: 'subagent',
      role: 'architect',
      provenance_kind: 'native_subagent',
      first_seen_at: architectCompletedAt,
      last_seen_at: architectCompletedAt,
      completed_at: architectCompletedAt,
      turn_count: 1,
    },
    'critic-thread': {
      thread_id: 'critic-thread',
      kind: 'subagent',
      role: 'critic',
      provenance_kind: 'native_subagent',
      first_seen_at: criticCompletedAt,
      last_seen_at: criticCompletedAt,
      completed_at: criticCompletedAt,
      turn_count: 1,
    },
  };
  mutate(threads);
  const trackerPath = subagentTrackingPath(cwd);
  mkdirSync(dirname(trackerPath), { recursive: true });
  writeFileSync(trackerPath, JSON.stringify({
    schemaVersion: 1,
    sessions: {
      [sessionId]: {
        session_id: sessionId,
        updated_at: criticCompletedAt,
        threads,
      },
    },
  }));
}

describe('ralplan consensus gate', () => {
  it('accepts ordered native Architect then Critic evidence under local owner authority', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-consensus-positive-'));
    const sessionId = 'session-native-consensus';
    try {
      writeNativeTracker(cwd, sessionId);
      const gate = buildRalplanConsensusGateFromSources([{
        source: 'same-user-state',
        sessionId,
        value: { ...nativeLifecycleReviews, official_host_consensus_receipt: { issuer: 'same-user', approved: true } },
      }], { cwd, sessionId });

      assert.equal(gate.complete, true, gate.blockedDetails?.join('; ') ?? 'unexpected blocker');
      assert.equal(gate.authority_policy, 'local_owner_lifecycle');
      assert.equal(gate.blockedReason, null);
      assert.equal(gate.blockedDetails, undefined);
      assert.equal(gate.source, 'same-user-state');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
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
    assert.equal(gate.complete, false);
    assert.equal(gate.blockedReason, 'native_subagent_consensus_evidence_missing');
  });

  it('retains newer invalid lifecycle diagnostics ahead of older native lifecycle evidence', () => {
    const gate = buildRalplanConsensusGateFromSources([
      { source: 'newer-invalid', value: withReviews(
        { ...nativeLifecycleReviews.ralplan_consensus_gate.ralplan_architect_review, sequence_index: 4 },
        { ...nativeLifecycleReviews.ralplan_consensus_gate.ralplan_critic_review, sequence_index: 3 },
      ) },
      { source: 'older-native', value: nativeLifecycleReviews },
    ]);

    assert.equal(gate.complete, false);
    assert.equal(gate.authority_policy, null);
    assert.equal(gate.source, 'newer-invalid');
    assert.equal(gate.ralplan_architect_review?.sequence_index, 4);
    assert.equal(gate.ralplan_critic_review?.sequence_index, 3);
  });

  it('blocks a newer incomplete Critic iterate gate instead of falling back to older approval', () => {
    const newerIncomplete = withReviews(
      {
        ...nativeLifecycleReviews.ralplan_consensus_gate.ralplan_architect_review,
        review_cycle: 2,
        sequence_index: 3,
      },
      {
        ...nativeLifecycleReviews.ralplan_consensus_gate.ralplan_critic_review,
        verdict: 'iterate',
        review_cycle: 2,
        sequence_index: 4,
      },
    );
    (newerIncomplete.ralplan_consensus_gate as Record<string, unknown>).complete = false;

    const gate = buildRalplanConsensusGateFromSources([
      { source: 'newer-incomplete', value: newerIncomplete },
      { source: 'older-valid', value: nativeLifecycleReviews },
    ]);

    assert.equal(gate.complete, false);
    assert.equal(gate.source, 'newer-incomplete');
    assert.equal(gate.blockedReason, 'non_approving_ralplan_consensus_review');
    assert.equal(gate.ralplan_critic_review?.verdict, 'iterate');
    assert.ok(gate.blockedDetails?.includes('consensus gate is incomplete'));
  });

  it('requires tracker-backed session-bound native role completion on the default path', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-consensus-native-tracker-'));
    const sessionId = 'session-native-consensus';
    try {
      writeNativeTracker(cwd, sessionId);
      const gate = buildRalplanConsensusGateFromSources([{
        source: 'tracked-native',
        sessionId,
        value: nativeLifecycleReviews,
      }], { cwd, sessionId, requireNativeSubagents: false });

      assert.equal(gate.complete, true, gate.blockedDetails?.join('; ') ?? 'unexpected native tracker blocker');
      assert.equal(gate.authority_policy, 'local_owner_lifecycle');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('cannot disable the compiled tracker requirement with a caller flag', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-consensus-no-tracker-'));
    const sessionId = 'session-native-consensus';
    try {
      const gate = buildRalplanConsensusGateFromSources([{
        source: 'untracked-default-path',
        sessionId,
        value: nativeLifecycleReviews,
      }], { cwd, sessionId, requireNativeSubagents: false });

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'native_subagent_consensus_evidence_missing');
      assert.match(gate.blockedDetails?.join('; ') ?? '', /native tracker is missing/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  for (const [name, mutate, expected] of [
    ['equal', (threads: Record<string, Record<string, unknown>>) => {
      threads['critic-thread']!.completed_at = '2026-08-05T10:00:00.000Z';
    }, /not strictly architect-before-critic/],
    ['reversed', (threads: Record<string, Record<string, unknown>>) => {
      threads['architect-thread']!.completed_at = '2026-08-05T10:02:00.000Z';
    }, /not strictly architect-before-critic/],
  ] as const) {
    it(`rejects ${name} tracker completion order regardless of review-authored order`, () => {
      const cwd = mkdtempSync(join(tmpdir(), `omx-consensus-${name}-order-`));
      const sessionId = 'session-native-consensus';
      try {
        writeNativeTracker(cwd, sessionId, mutate);
        const gate = buildRalplanConsensusGateFromSources([{
          source: `${name}-tracker-order`,
          sessionId,
          value: nativeLifecycleReviews,
        }], { cwd, sessionId });

        assert.equal(gate.complete, false);
        assert.match(gate.blockedDetails?.join('; ') ?? '', expected);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }

  it('rejects stale tracker completions despite artificially advanced review fields', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-consensus-stale-completions-'));
    const sessionId = 'session-native-consensus';
    try {
      writeNativeTracker(cwd, sessionId);
      const advanced = withReviews(
        {
          ...nativeLifecycleReviews.ralplan_consensus_gate.ralplan_architect_review,
          review_cycle: 9,
          sequence_index: 99,
        },
        {
          ...nativeLifecycleReviews.ralplan_consensus_gate.ralplan_critic_review,
          review_cycle: 9,
          sequence_index: 100,
        },
      );
      advanced.review_cycle = 9;
      advanced.ralplan_pass_started_at = '2026-08-05T10:02:00.000Z';
      const gate = buildRalplanConsensusGateFromSources([{
        source: 'advanced-review-fields',
        sessionId,
        value: advanced,
      }], { cwd, sessionId });

      assert.equal(gate.complete, false);
      assert.match(gate.blockedDetails?.join('; ') ?? '', /completion predates ralplan_pass_started_at/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  for (const [name, prepare, sourceSessionId, expectedDetail] of [
    ['missing tracker', () => {}, 'session-native-consensus', /native tracker is missing/],
    ['foreign session', (cwd: string) => writeNativeTracker(cwd, 'other-session'), 'session-native-consensus', /session_id=session-native-consensus is missing/],
    ['forged untracked ids', (cwd: string) => writeNativeTracker(cwd, 'session-native-consensus', (threads) => {
      delete threads['architect-thread'];
    }), 'session-native-consensus', /architect thread_id=architect-thread is not tracked/],
    ['leader-kind review', (cwd: string) => writeNativeTracker(cwd, 'session-native-consensus', (threads) => {
      threads['architect-thread']!.kind = 'leader';
    }), 'session-native-consensus', /kind=leader is not subagent/],
    ['adapted tracked review', (cwd: string) => writeNativeTracker(cwd, 'session-native-consensus', (threads) => {
      threads['architect-thread']!.provenance_kind = 'omx_adapted';
    }), 'session-native-consensus', /provenance_kind=omx_adapted is not native_subagent/],
    ['wrong tracked role', (cwd: string) => writeNativeTracker(cwd, 'session-native-consensus', (threads) => {
      threads['critic-thread']!.role = 'architect';
    }), 'session-native-consensus', /critic thread_id=critic-thread role=architect is not critic/],
    ['missing completion', (cwd: string) => writeNativeTracker(cwd, 'session-native-consensus', (threads) => {
      delete threads['critic-thread']!.completed_at;
    }), 'session-native-consensus', /critic thread_id=critic-thread has no completion evidence/],
    ['mismatched source session', (cwd: string) => writeNativeTracker(cwd, 'session-native-consensus'), 'other-session', /source session_id=other-session does not match/],
  ] as const) {
    it(`blocks ${name} native evidence`, () => {
      const cwd = mkdtempSync(join(tmpdir(), 'omx-consensus-native-invalid-'));
      const sessionId = 'session-native-consensus';
      try {
        prepare(cwd);
        const gate = buildRalplanConsensusGateFromSources([{
          source: name,
          sessionId: sourceSessionId,
          value: nativeLifecycleReviews,
        }], { cwd, sessionId, requireNativeSubagents: true });

        assert.equal(gate.complete, false);
        assert.equal(gate.authority_policy, null);
        assert.equal(gate.blockedReason, 'native_subagent_consensus_evidence_missing');
        assert.match(gate.blockedDetails?.join('; ') ?? '', expectedDetail);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }

  it('blocks self-declared review session binding that disagrees with the tracked session', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-consensus-native-self-declared-'));
    const sessionId = 'session-native-consensus';
    try {
      writeNativeTracker(cwd, sessionId);
      const selfDeclared = withReviews(
        {
          ...nativeLifecycleReviews.ralplan_consensus_gate.ralplan_architect_review,
          session_id: 'forged-session',
        },
        nativeLifecycleReviews.ralplan_consensus_gate.ralplan_critic_review,
      );
      const gate = buildRalplanConsensusGateFromSources([{
        source: 'self-declared-session',
        sessionId,
        value: selfDeclared,
      }], { cwd, sessionId, requireNativeSubagents: true });

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'native_subagent_consensus_evidence_missing');
      assert.match(gate.blockedDetails?.join('; ') ?? '', /architect review session_id=forged-session does not match/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
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
  ] as const) {
    it(`keeps ${name} inert unless it is an ordered native lifecycle pair`, () => {
      const gate = buildRalplanConsensusGateFromSources([{ source: name, value }]);
      assert.equal(gate.complete, false);
      assert.equal(gate.source, name);
      assert.equal(gate.authority_policy, null);
      assert.ok(gate.ralplan_architect_review);
      assert.ok(gate.ralplan_critic_review);
    });
  }

  it('accepts an ordered native pair preserved in review history', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-consensus-history-'));
    const sessionId = 'session-native-consensus';
    try {
      writeNativeTracker(cwd, sessionId);
      const gate = buildRalplanConsensusGateFromSources([{ source: 'history evidence', sessionId, value: {
        started_at: nativeLifecycleReviews.started_at,
        review_history: [{
          architect_review: nativeLifecycleReviews.ralplan_consensus_gate.ralplan_architect_review,
          critic_review: nativeLifecycleReviews.ralplan_consensus_gate.ralplan_critic_review,
        }],
      } }], { cwd, sessionId });

      assert.equal(gate.complete, true, gate.blockedDetails?.join('; ') ?? 'unexpected blocker');
      assert.equal(gate.authority_policy, 'local_owner_lifecycle');
      assert.equal(gate.blockedReason, null);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  for (const [name, value, blockedReason] of [
    ['missing evidence', {}, 'native_subagent_consensus_evidence_missing'],
    ['architect iterate', withReviews(
      { ...nativeLifecycleReviews.ralplan_consensus_gate.ralplan_architect_review, verdict: 'iterate' },
      nativeLifecycleReviews.ralplan_consensus_gate.ralplan_critic_review,
    ), 'non_approving_ralplan_consensus_review'],
    ['critic iterate', withReviews(
      nativeLifecycleReviews.ralplan_consensus_gate.ralplan_architect_review,
      { ...nativeLifecycleReviews.ralplan_consensus_gate.ralplan_critic_review, verdict: 'iterate' },
    ), 'non_approving_ralplan_consensus_review'],
  ] as const) {
    it(`blocks ${name} without local owner authority`, () => {
      const gate = buildRalplanConsensusGateFromSources([{ source: name, value }]);
      assert.equal(gate.complete, false);
      assert.equal(gate.authority_policy, null);
      assert.equal(gate.blockedReason, blockedReason);
    });
  }
});
