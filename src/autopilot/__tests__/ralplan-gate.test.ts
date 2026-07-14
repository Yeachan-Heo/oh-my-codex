import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { subagentTrackingPath } from '../../subagents/tracker.js';
import {
  buildAutopilotRalplanUltragoalGateError,
  canAdvanceAutopilotRalplanToUltragoal,
} from '../ralplan-gate.js';
import { buildRalplanConsensusGateFromSources } from '../../ralplan/consensus-gate.js';

describe('autopilot ralplan gate', () => {
  it('rejects direct consensus when architect review is not approving', () => {
    const evidence = buildRalplanConsensusGateFromSources([{
      source: 'direct-architect-comment',
      value: {
        ralplan_consensus_gate: {
          complete: true,
          sequence: ['architect-review', 'critic-review'],
          ralplan_architect_review: {
            agent_role: 'architect',
            verdict: 'comment',
          },
          ralplan_critic_review: {
            agent_role: 'critic',
            verdict: 'approve',
          },
        },
      },
    }]);

    assert.equal(evidence.complete, false);
    assert.equal(evidence.blockedReason, 'non_approving_ralplan_consensus_review');
    assert.match(evidence.blockedDetails?.join('\n') ?? '', /architect review verdict=comment is not approve/);
  });

  it('rejects direct consensus when critic review is not approving', () => {
    const evidence = buildRalplanConsensusGateFromSources([{
      source: 'direct-critic-reject',
      value: {
        ralplan_consensus_gate: {
          complete: true,
          sequence: ['architect-review', 'critic-review'],
          ralplan_architect_review: {
            agent_role: 'architect',
            verdict: 'approve',
          },
          ralplan_critic_review: {
            agent_role: 'critic',
            verdict: 'reject',
          },
        },
      },
    }]);

    assert.equal(evidence.complete, false);
    assert.equal(evidence.blockedReason, 'non_approving_ralplan_consensus_review');
    assert.match(evidence.blockedDetails?.join('\n') ?? '', /critic review verdict=reject is not approve/);
  });

  it('accepts direct consensus when architect and critic reviews approve in order', () => {
    const evidence = buildRalplanConsensusGateFromSources([{
      source: 'direct-approval',
      value: {
        ralplan_consensus_gate: {
          complete: true,
          sequence: ['architect-review', 'critic-review'],
          ralplan_architect_review: {
            agent_role: 'architect',
            verdict: 'approve',
            completed_at: '2026-06-12T10:02:00.000Z',
          },
          ralplan_critic_review: {
            agent_role: 'critic',
            verdict: 'approve',
            completed_at: '2026-06-12T10:03:00.000Z',
          },
        },
      },
    }]);

    assert.equal(evidence.complete, true);
    assert.equal(evidence.blockedReason, null);
    assert.equal(evidence.source, 'direct-approval');
  });

  it('rejects missing tracker-backed native evidence by default for autopilot ralplan to ultragoal', () => {
    const decision = canAdvanceAutopilotRalplanToUltragoal({
      cwd: process.cwd(),
      sessionId: 'sess-default-native-required',
      nextState: {
        active: true,
        mode: 'autopilot',
        current_phase: 'ultragoal',
        ralplan_consensus_gate: {
          complete: true,
          sequence: ['architect-review', 'critic-review'],
          ralplan_architect_review: {
            agent_role: 'architect',
            provenance_kind: 'codex_exec',
            verdict: 'approve',
            session_id: 'sess-default-native-required',
            thread_id: 'exec-architect',
            completed_at: '2026-06-12T10:02:00.000Z',
          },
          ralplan_critic_review: {
            agent_role: 'critic',
            provenance_kind: 'codex_exec',
            verdict: 'approve',
            session_id: 'sess-default-native-required',
            thread_id: 'exec-critic',
            completed_at: '2026-06-12T10:03:00.000Z',
          },
        },
      },
    });

    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /tracker-backed native architect and critic lanes/);
  });

  it('accepts fresh valid consensus before stale invalid consensus', () => {
    const evidence = buildRalplanConsensusGateFromSources([
      {
        source: 'fresh-valid',
        value: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              verdict: 'approve',
              completed_at: '2026-06-12T10:02:00.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              verdict: 'approve',
              completed_at: '2026-06-12T10:03:00.000Z',
            },
          },
        },
      },
      {
        source: 'stale-invalid',
        value: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              verdict: 'iterate',
              completed_at: '2026-06-12T09:58:00.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              verdict: 'approve',
              completed_at: '2026-06-12T09:59:00.000Z',
            },
          },
        },
      },
    ]);

    assert.equal(evidence.complete, true);
    assert.equal(evidence.blockedReason, null);
    assert.equal(evidence.source, 'fresh-valid');
  });
  it('rejects invalid next-state complete consensus before falling back to older valid current state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-autopilot-ralplan-next-invalid-terminal-'));
    const sessionId = 'sess-autopilot-next-invalid-terminal';
    const trackingPath = subagentTrackingPath(cwd);
    try {
      await mkdir(join(trackingPath, '..'), { recursive: true });
      await writeFile(trackingPath, JSON.stringify({
        schemaVersion: 1,
        sessions: {
          [sessionId]: {
            session_id: sessionId,
            leader_thread_id: 'thread-leader',
            updated_at: '2026-06-12T10:00:00.000Z',
            threads: {
              'thread-leader': { thread_id: 'thread-leader', kind: 'leader', first_seen_at: '2026-06-12T09:59:00.000Z', last_seen_at: '2026-06-12T09:59:00.000Z', turn_count: 1 },
              'thread-architect-old': { thread_id: 'thread-architect-old', kind: 'subagent', first_seen_at: '2026-06-12T09:59:30.000Z', last_seen_at: '2026-06-12T09:59:30.000Z', completed_at: '2026-06-12T09:59:30.000Z', turn_count: 1 },
              'thread-critic-old': { thread_id: 'thread-critic-old', kind: 'subagent', first_seen_at: '2026-06-12T10:00:00.000Z', last_seen_at: '2026-06-12T10:00:00.000Z', completed_at: '2026-06-12T10:00:00.000Z', turn_count: 1 },
            },
          },
        },
      }, null, 2));

      const nextState = {
        current_phase: 'ralplan',
        return_to_ralplan_reason: 'Code review requested a plan update.',
        handoff_artifacts: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              provenance_kind: 'native_subagent',
              verdict: 'iterate',
              session_id: sessionId,
              thread_id: 'thread-architect-new',
              artifact_path: '.omx/artifacts/architect-new.md',
              tracker_path: '.omx/state/subagent-tracking.json',
              completed_at: '2026-06-12T10:01:00.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: sessionId,
              thread_id: 'thread-critic-new',
              artifact_path: '.omx/artifacts/critic-new.md',
              tracker_path: '.omx/state/subagent-tracking.json',
              completed_at: '2026-06-12T10:02:00.000Z',
            },
          },
        },
      };
      const currentState = {
        current_phase: 'ralplan',
        handoff_artifacts: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: sessionId,
              thread_id: 'thread-architect-old',
              artifact_path: '.omx/artifacts/architect-old.md',
              tracker_path: '.omx/state/subagent-tracking.json',
              completed_at: '2026-06-12T09:59:30.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: sessionId,
              thread_id: 'thread-critic-old',
              artifact_path: '.omx/artifacts/critic-old.md',
              tracker_path: '.omx/state/subagent-tracking.json',
              completed_at: '2026-06-12T10:00:00.000Z',
            },
          },
        },
      };

      const decision = canAdvanceAutopilotRalplanToUltragoal({ cwd, sessionId, nextState, currentState });

      assert.equal(decision.allowed, false);
      assert.equal(decision.evidence?.source, 'next-autopilot-state:handoff_artifacts');
      assert.equal(decision.evidence?.blockedReason, 'non_approving_ralplan_consensus_review');
      assert.match(buildAutopilotRalplanUltragoalGateError(decision), /architect.*verdict=iterate/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects ordered invalid next-state direct consensus before older valid current state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-autopilot-ralplan-next-invalid-direct-'));
    const sessionId = 'sess-autopilot-next-invalid-direct';
    const trackingPath = subagentTrackingPath(cwd);
    try {
      await mkdir(join(trackingPath, '..'), { recursive: true });
      await writeFile(trackingPath, JSON.stringify({
        schemaVersion: 1,
        sessions: {
          [sessionId]: {
            session_id: sessionId,
            leader_thread_id: 'thread-leader',
            updated_at: '2026-06-12T10:05:00.000Z',
            threads: {
              'thread-leader': { thread_id: 'thread-leader', kind: 'leader', first_seen_at: '2026-06-12T09:59:00.000Z', last_seen_at: '2026-06-12T09:59:00.000Z', turn_count: 1 },
              'thread-architect-old': { thread_id: 'thread-architect-old', kind: 'subagent', first_seen_at: '2026-06-12T09:59:30.000Z', last_seen_at: '2026-06-12T09:59:30.000Z', completed_at: '2026-06-12T09:59:30.000Z', turn_count: 1 },
              'thread-critic-old': { thread_id: 'thread-critic-old', kind: 'subagent', first_seen_at: '2026-06-12T10:00:00.000Z', last_seen_at: '2026-06-12T10:00:00.000Z', completed_at: '2026-06-12T10:00:00.000Z', turn_count: 1 },
            },
          },
        },
      }, null, 2));

      const nextState = {
        current_phase: 'ralplan',
        return_to_ralplan_reason: 'Code review requested a plan update.',
        ralplan_consensus_gate: {
          complete: true,
          sequence: ['architect-review', 'critic-review'],
          ralplan_architect_review: {
            agent_role: 'architect',
            provenance_kind: 'native_subagent',
            verdict: 'iterate',
            session_id: sessionId,
            thread_id: 'thread-architect-new',
            artifact_path: '.omx/artifacts/architect-new.md',
            tracker_path: '.omx/state/subagent-tracking.json',
            completed_at: '2026-06-12T10:04:00.000Z',
          },
          ralplan_critic_review: {
            agent_role: 'critic',
            provenance_kind: 'native_subagent',
            verdict: 'approve',
            session_id: sessionId,
            thread_id: 'thread-critic-new',
            artifact_path: '.omx/artifacts/critic-new.md',
            tracker_path: '.omx/state/subagent-tracking.json',
            completed_at: '2026-06-12T10:05:00.000Z',
          },
        },
      };
      const currentState = {
        current_phase: 'ralplan',
        handoff_artifacts: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: sessionId,
              thread_id: 'thread-architect-old',
              artifact_path: '.omx/artifacts/architect-old.md',
              tracker_path: '.omx/state/subagent-tracking.json',
              completed_at: '2026-06-12T09:59:30.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: sessionId,
              thread_id: 'thread-critic-old',
              artifact_path: '.omx/artifacts/critic-old.md',
              tracker_path: '.omx/state/subagent-tracking.json',
              completed_at: '2026-06-12T10:00:00.000Z',
            },
          },
        },
      };

      const decision = canAdvanceAutopilotRalplanToUltragoal({ cwd, sessionId, nextState, currentState });

      assert.equal(decision.allowed, false);
      assert.equal(decision.evidence?.source, 'next-autopilot-state');
      assert.equal(decision.evidence?.blockedReason, 'non_approving_ralplan_consensus_review');
      assert.match(buildAutopilotRalplanUltragoalGateError(decision), /architect.*verdict=iterate/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects stale nested ralplan handoff consensus when parent state returned to ralplan', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-autopilot-ralplan-stale-nested-'));
    const sessionId = 'sess-autopilot-stale-nested';
    const trackingPath = subagentTrackingPath(cwd);
    try {
      await mkdir(join(trackingPath, '..'), { recursive: true });
      await writeFile(trackingPath, JSON.stringify({
        schemaVersion: 1,
        sessions: {
          [sessionId]: {
            session_id: sessionId,
            leader_thread_id: 'thread-leader',
            updated_at: '2026-06-12T10:00:00.000Z',
            threads: {
              'thread-leader': { thread_id: 'thread-leader', kind: 'leader', first_seen_at: '2026-06-12T09:59:00.000Z', last_seen_at: '2026-06-12T09:59:00.000Z', turn_count: 1 },
              'thread-architect-stale': { thread_id: 'thread-architect-stale', kind: 'subagent', first_seen_at: '2026-06-12T09:59:30.000Z', last_seen_at: '2026-06-12T09:59:30.000Z', completed_at: '2026-06-12T09:59:30.000Z', turn_count: 1 },
              'thread-critic-stale': { thread_id: 'thread-critic-stale', kind: 'subagent', first_seen_at: '2026-06-12T10:00:00.000Z', last_seen_at: '2026-06-12T10:00:00.000Z', completed_at: '2026-06-12T10:00:00.000Z', turn_count: 1 },
            },
          },
        },
      }, null, 2));

      const nextState = {
        current_phase: 'ralplan',
        return_to_ralplan_reason: 'Code review requested a plan update.',
        review_cycle: 2,
        handoff_artifacts: {
          ralplan: {
            review_cycle: 2,
            ralplanConsensusGate: {
              complete: true,
              sequence: ['architect-review', 'critic-review'],
              ralplan_architect_review: {
                agent_role: 'architect',
                provenance_kind: 'native_subagent',
                verdict: 'approve',
                session_id: sessionId,
                thread_id: 'thread-architect-stale',
                artifact_path: '.omx/artifacts/architect-stale.md',
                tracker_path: '.omx/state/subagent-tracking.json',
                completed_at: '2026-06-12T09:59:30.000Z',
              },
              ralplan_critic_review: {
                agent_role: 'critic',
                provenance_kind: 'native_subagent',
                verdict: 'approve',
                session_id: sessionId,
                thread_id: 'thread-critic-stale',
                artifact_path: '.omx/artifacts/critic-stale.md',
                tracker_path: '.omx/state/subagent-tracking.json',
                completed_at: '2026-06-12T10:00:00.000Z',
              },
            },
          },
        },
      };

      const decision = canAdvanceAutopilotRalplanToUltragoal({ cwd, sessionId, nextState });

      assert.equal(decision.allowed, false);
      assert.equal(decision.evidence?.blockedReason, 'missing_sequential_architect_then_critic_approval');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects stale raw handoff consensus when parent state returned to ralplan', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-autopilot-ralplan-stale-raw-handoff-'));
    const sessionId = 'sess-autopilot-stale-raw-handoff';
    const trackingPath = subagentTrackingPath(cwd);
    try {
      await mkdir(join(trackingPath, '..'), { recursive: true });
      await writeFile(trackingPath, JSON.stringify({
        schemaVersion: 1,
        sessions: {
          [sessionId]: {
            session_id: sessionId,
            leader_thread_id: 'thread-leader',
            updated_at: '2026-06-12T10:00:00.000Z',
            threads: {
              'thread-leader': { thread_id: 'thread-leader', kind: 'leader', first_seen_at: '2026-06-12T09:59:00.000Z', last_seen_at: '2026-06-12T09:59:00.000Z', turn_count: 1 },
              'thread-architect-stale': { thread_id: 'thread-architect-stale', kind: 'subagent', first_seen_at: '2026-06-12T09:59:30.000Z', last_seen_at: '2026-06-12T09:59:30.000Z', completed_at: '2026-06-12T09:59:30.000Z', turn_count: 1 },
              'thread-critic-stale': { thread_id: 'thread-critic-stale', kind: 'subagent', first_seen_at: '2026-06-12T10:00:00.000Z', last_seen_at: '2026-06-12T10:00:00.000Z', completed_at: '2026-06-12T10:00:00.000Z', turn_count: 1 },
            },
          },
        },
      }, null, 2));

      const currentState = {
        current_phase: 'ralplan',
        return_to_ralplan_reason: 'Code review requested a plan update.',
        review_cycle: 1,
        handoff_artifacts: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: sessionId,
              thread_id: 'thread-architect-stale',
              artifact_path: '.omx/artifacts/architect-stale.md',
              tracker_path: '.omx/state/subagent-tracking.json',
              completed_at: '2026-06-12T09:59:30.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: sessionId,
              thread_id: 'thread-critic-stale',
              artifact_path: '.omx/artifacts/critic-stale.md',
              tracker_path: '.omx/state/subagent-tracking.json',
              completed_at: '2026-06-12T10:00:00.000Z',
            },
          },
        },
      };

      const decision = canAdvanceAutopilotRalplanToUltragoal({ cwd, sessionId, currentState });

      assert.equal(decision.allowed, false);
      assert.equal(decision.evidence?.blockedReason, 'missing_sequential_architect_then_critic_approval');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  for (const { lane, architectVerdict, criticVerdict } of [
    { lane: 'architect', architectVerdict: 'iterate', criticVerdict: 'approve' },
    { lane: 'critic', architectVerdict: 'approve', criticVerdict: 'iterate' },
  ] as const) {
    it(`rejects complete ralplan consensus when ${lane} review verdict is iterate`, () => {
      const state = {
        current_phase: 'ralplan',
        handoff_artifacts: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              provenance_kind: 'native_subagent',
              verdict: architectVerdict,
              session_id: 'sess-autopilot-iterate',
              thread_id: 'thread-architect',
              artifact_path: '.omx/artifacts/architect.md',
              tracker_path: '.omx/state/subagent-tracking.json',
              completed_at: '2026-05-28T18:34:51.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              provenance_kind: 'native_subagent',
              verdict: criticVerdict,
              session_id: 'sess-autopilot-iterate',
              thread_id: 'thread-critic',
              artifact_path: '.omx/artifacts/critic.md',
              tracker_path: '.omx/state/subagent-tracking.json',
              completed_at: '2026-05-28T18:35:10.000Z',
            },
          },
        },
      };

      const decision = canAdvanceAutopilotRalplanToUltragoal({
        cwd: process.cwd(),
        sessionId: 'sess-autopilot-iterate',
        currentState: state,
      });
      assert.equal(decision.allowed, false);
      assert.equal(decision.evidence?.blockedReason, 'non_approving_ralplan_consensus_review');
      const error = buildAutopilotRalplanUltragoalGateError(decision);
      assert.match(error, /non-approving architect or critic review evidence/i);
      assert.doesNotMatch(error, /missing ralplan consensus gate/i);
      assert.match(error, new RegExp(`${lane}.*verdict=iterate`, 'i'));
    });
  }

  it('accepts fresh next-state consensus over stale invalid current-state consensus', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-autopilot-ralplan-fresh-next-valid-'));
    const sessionId = 'sess-autopilot-fresh-next-valid';
    const trackingPath = subagentTrackingPath(cwd);
    try {
      await mkdir(join(trackingPath, '..'), { recursive: true });
      await writeFile(trackingPath, JSON.stringify({
        schemaVersion: 1,
        sessions: {
          [sessionId]: {
            session_id: sessionId,
            leader_thread_id: 'thread-leader',
            updated_at: '2026-06-12T10:03:00.000Z',
            threads: {
              'thread-leader': { thread_id: 'thread-leader', kind: 'leader', first_seen_at: '2026-06-12T09:59:00.000Z', last_seen_at: '2026-06-12T09:59:00.000Z', turn_count: 1 },
              'thread-architect-fresh': { thread_id: 'thread-architect-fresh', kind: 'subagent', first_seen_at: '2026-06-12T10:02:00.000Z', last_seen_at: '2026-06-12T10:02:00.000Z', completed_at: '2026-06-12T10:02:00.000Z', turn_count: 1, mode: 'architect' },
              'thread-critic-fresh': { thread_id: 'thread-critic-fresh', kind: 'subagent', first_seen_at: '2026-06-12T10:03:00.000Z', last_seen_at: '2026-06-12T10:03:00.000Z', completed_at: '2026-06-12T10:03:00.000Z', turn_count: 1, mode: 'critic' },
            },
          },
        },
      }, null, 2));

      const nextState = {
        current_phase: 'ralplan',
        review_cycle: 2,
        handoff_artifacts: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              review_cycle: 2,
              session_id: sessionId,
              thread_id: 'thread-architect-fresh',
              artifact_path: '.omx/artifacts/architect-fresh.md',
              tracker_path: '.omx/state/subagent-tracking.json',
              completed_at: '2026-06-12T10:02:00.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              review_cycle: 2,
              session_id: sessionId,
              thread_id: 'thread-critic-fresh',
              artifact_path: '.omx/artifacts/critic-fresh.md',
              tracker_path: '.omx/state/subagent-tracking.json',
              completed_at: '2026-06-12T10:03:00.000Z',
            },
          },
        },
      };
      const currentState = {
        current_phase: 'ralplan',
        return_to_ralplan_reason: 'Code review requested a plan update.',
        review_cycle: 1,
        handoff_artifacts: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              provenance_kind: 'native_subagent',
              verdict: 'block',
              review_cycle: 1,
              session_id: sessionId,
              thread_id: 'thread-architect-stale',
              artifact_path: '.omx/artifacts/architect-stale.md',
              tracker_path: '.omx/state/subagent-tracking.json',
              completed_at: '2026-06-12T10:00:00.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              review_cycle: 1,
              session_id: sessionId,
              thread_id: 'thread-critic-stale',
              artifact_path: '.omx/artifacts/critic-stale.md',
              tracker_path: '.omx/state/subagent-tracking.json',
              completed_at: '2026-06-12T10:01:00.000Z',
            },
          },
        },
      };

      const decision = canAdvanceAutopilotRalplanToUltragoal({ cwd, sessionId, nextState, currentState });

      assert.equal(decision.allowed, true);
      assert.equal(decision.evidence?.source, 'next-autopilot-state');
      assert.equal(decision.evidence?.blockedReason, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('accepts tracker-backed native reviews without duplicated session, tracker, or artifact fields', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-autopilot-ralplan-tracker-resolved-'));
    const sessionId = 'sess-autopilot-tracker-resolved';
    const trackingPath = subagentTrackingPath(cwd);
    try {
      await mkdir(join(trackingPath, '..'), { recursive: true });
      await writeFile(trackingPath, JSON.stringify({
        schemaVersion: 1,
        sessions: {
          [sessionId]: {
            session_id: sessionId,
            leader_thread_id: 'thread-leader',
            updated_at: '2026-06-12T10:03:00.000Z',
            threads: {
              'thread-leader': { thread_id: 'thread-leader', kind: 'leader', first_seen_at: '2026-06-12T09:59:00.000Z', last_seen_at: '2026-06-12T09:59:00.000Z', turn_count: 1 },
              'thread-architect': { thread_id: 'thread-architect', kind: 'subagent', first_seen_at: '2026-06-12T10:02:00.000Z', last_seen_at: '2026-06-12T10:02:00.000Z', completed_at: '2026-06-12T10:02:00.000Z', turn_count: 1, mode: 'architect' },
              'thread-critic': { thread_id: 'thread-critic', kind: 'subagent', first_seen_at: '2026-06-12T10:03:00.000Z', last_seen_at: '2026-06-12T10:03:00.000Z', completed_at: '2026-06-12T10:03:00.000Z', turn_count: 1, mode: 'critic' },
            },
          },
        },
      }, null, 2));

      const state = {
        current_phase: 'ralplan',
        handoff_artifacts: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              thread_id: 'thread-architect',
              completed_at: '2026-06-12T10:02:00.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              thread_id: 'thread-critic',
              completed_at: '2026-06-12T10:03:00.000Z',
            },
          },
        },
      };

      const decision = canAdvanceAutopilotRalplanToUltragoal({ cwd, sessionId, currentState: state });
      assert.equal(decision.allowed, true);
      assert.equal(decision.evidence?.blockedReason, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects unsupported native evidence even with tracker-backed native consensus', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-autopilot-ralplan-unsupported-veto-'));
    const sessionId = 'sess-autopilot-unsupported-veto';
    const trackingPath = subagentTrackingPath(cwd);
    try {
      await mkdir(join(trackingPath, '..'), { recursive: true });
      await writeFile(trackingPath, JSON.stringify({
        schemaVersion: 1,
        sessions: {
          [sessionId]: {
            session_id: sessionId,
            leader_thread_id: 'thread-leader',
            updated_at: '2026-06-12T10:03:00.000Z',
            threads: {
              'thread-leader': { thread_id: 'thread-leader', kind: 'leader', first_seen_at: '2026-06-12T09:59:00.000Z', last_seen_at: '2026-06-12T09:59:00.000Z', turn_count: 1 },
              'thread-architect': { thread_id: 'thread-architect', kind: 'subagent', first_seen_at: '2026-06-12T10:02:00.000Z', last_seen_at: '2026-06-12T10:02:00.000Z', completed_at: '2026-06-12T10:02:00.000Z', turn_count: 1 },
              'thread-critic': { thread_id: 'thread-critic', kind: 'subagent', first_seen_at: '2026-06-12T10:03:00.000Z', last_seen_at: '2026-06-12T10:03:00.000Z', completed_at: '2026-06-12T10:03:00.000Z', turn_count: 1 },
            },
          },
        },
      }, null, 2));

      const state = {
        current_phase: 'ralplan',
        handoff_artifacts: {
          ralplan: {
            native_subagent_support: {
              status: 'unsupported',
              reason: 'multi_agent_v1_unavailable',
              source: 'post_tool_failure',
            },
          },
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              thread_id: 'thread-architect',
              completed_at: '2026-06-12T10:02:00.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              thread_id: 'thread-critic',
              completed_at: '2026-06-12T10:03:00.000Z',
            },
          },
        },
      };

      const decision = canAdvanceAutopilotRalplanToUltragoal({ cwd, sessionId, currentState: state });
      assert.equal(decision.allowed, false);
      assert.match(decision.reason, /terminalize non-clean/);
      assert.match(buildAutopilotRalplanUltragoalGateError(decision), /blocked\/cancelled\/failed/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects handoff-root unsupported native evidence even with tracker-backed native consensus', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-autopilot-ralplan-unsupported-root-veto-'));
    const sessionId = 'sess-autopilot-unsupported-root-veto';
    const trackingPath = subagentTrackingPath(cwd);
    try {
      await mkdir(join(trackingPath, '..'), { recursive: true });
      await writeFile(trackingPath, JSON.stringify({
        schemaVersion: 1,
        sessions: {
          [sessionId]: {
            session_id: sessionId,
            leader_thread_id: 'thread-leader',
            updated_at: '2026-06-12T10:03:00.000Z',
            threads: {
              'thread-leader': { thread_id: 'thread-leader', kind: 'leader', first_seen_at: '2026-06-12T09:59:00.000Z', last_seen_at: '2026-06-12T09:59:00.000Z', turn_count: 1 },
              'thread-architect': { thread_id: 'thread-architect', kind: 'subagent', first_seen_at: '2026-06-12T10:02:00.000Z', last_seen_at: '2026-06-12T10:02:00.000Z', completed_at: '2026-06-12T10:02:00.000Z', turn_count: 1 },
              'thread-critic': { thread_id: 'thread-critic', kind: 'subagent', first_seen_at: '2026-06-12T10:03:00.000Z', last_seen_at: '2026-06-12T10:03:00.000Z', completed_at: '2026-06-12T10:03:00.000Z', turn_count: 1 },
            },
          },
        },
      }, null, 2));

      const state = {
        current_phase: 'ralplan',
        handoff_artifacts: {
          native_subagent_support: {
            status: 'unsupported',
            reason: 'multi_agent_v1_unavailable',
            source: 'post_tool_failure',
          },
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              thread_id: 'thread-architect',
              completed_at: '2026-06-12T10:02:00.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              thread_id: 'thread-critic',
              completed_at: '2026-06-12T10:03:00.000Z',
            },
          },
        },
      };

      const decision = canAdvanceAutopilotRalplanToUltragoal({ cwd, sessionId, currentState: state });
      assert.equal(decision.allowed, false);
      assert.match(decision.reason, /terminalize non-clean/);
      assert.match(buildAutopilotRalplanUltragoalGateError(decision), /blocked\/cancelled\/failed/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects omitted review session ids when no transition session context exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-autopilot-ralplan-no-session-context-'));
    const trackingPath = subagentTrackingPath(cwd);
    try {
      await mkdir(join(trackingPath, '..'), { recursive: true });
      await writeFile(trackingPath, JSON.stringify({
        schemaVersion: 1,
        sessions: {},
      }, null, 2));

      const state = {
        current_phase: 'ralplan',
        handoff_artifacts: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              thread_id: 'thread-architect',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              thread_id: 'thread-critic',
            },
          },
        },
      };

      const decision = canAdvanceAutopilotRalplanToUltragoal({ cwd, currentState: state });
      assert.equal(decision.allowed, false);
      assert.match(buildAutopilotRalplanUltragoalGateError(decision), /cannot resolve session_id/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects architect and critic reviews that reuse the same native tracker thread', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-autopilot-ralplan-duplicate-thread-'));
    const sessionId = 'sess-autopilot-duplicate-thread';
    const trackingPath = subagentTrackingPath(cwd);
    try {
      await mkdir(join(trackingPath, '..'), { recursive: true });
      await writeFile(trackingPath, JSON.stringify({
        schemaVersion: 1,
        sessions: {
          [sessionId]: {
            session_id: sessionId,
            leader_thread_id: 'thread-leader',
            updated_at: '2026-06-12T10:03:00.000Z',
            threads: {
              'thread-leader': { thread_id: 'thread-leader', kind: 'leader', first_seen_at: '2026-06-12T09:59:00.000Z', last_seen_at: '2026-06-12T09:59:00.000Z', turn_count: 1 },
              'thread-reviewer': { thread_id: 'thread-reviewer', kind: 'subagent', first_seen_at: '2026-06-12T10:02:00.000Z', last_seen_at: '2026-06-12T10:03:00.000Z', completed_at: '2026-06-12T10:03:00.000Z', turn_count: 1 },
            },
          },
        },
      }, null, 2));

      const state = {
        current_phase: 'ralplan',
        handoff_artifacts: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: sessionId,
              thread_id: 'thread-reviewer',
              completed_at: '2026-06-12T10:02:00.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: sessionId,
              thread_id: 'thread-reviewer',
              completed_at: '2026-06-12T10:03:00.000Z',
            },
          },
        },
      };

      const decision = canAdvanceAutopilotRalplanToUltragoal({ cwd, sessionId, currentState: state });
      assert.equal(decision.allowed, false);
      assert.match(buildAutopilotRalplanUltragoalGateError(decision), /distinct native subagent tracker threads/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects tracker-backed native reviews composed from different sessions', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-autopilot-ralplan-cross-session-'));
    const trackingPath = subagentTrackingPath(cwd);
    try {
      await mkdir(join(trackingPath, '..'), { recursive: true });
      await writeFile(trackingPath, JSON.stringify({
        schemaVersion: 1,
        sessions: {
          'sess-architect': {
            session_id: 'sess-architect',
            leader_thread_id: 'thread-leader-a',
            updated_at: '2026-06-12T10:02:00.000Z',
            threads: {
              'thread-leader-a': { thread_id: 'thread-leader-a', kind: 'leader', first_seen_at: '2026-06-12T09:59:00.000Z', last_seen_at: '2026-06-12T09:59:00.000Z', turn_count: 1 },
              'thread-architect': { thread_id: 'thread-architect', kind: 'subagent', first_seen_at: '2026-06-12T10:02:00.000Z', last_seen_at: '2026-06-12T10:02:00.000Z', completed_at: '2026-06-12T10:02:00.000Z', turn_count: 1 },
            },
          },
          'sess-critic': {
            session_id: 'sess-critic',
            leader_thread_id: 'thread-leader-c',
            updated_at: '2026-06-12T10:03:00.000Z',
            threads: {
              'thread-leader-c': { thread_id: 'thread-leader-c', kind: 'leader', first_seen_at: '2026-06-12T09:59:00.000Z', last_seen_at: '2026-06-12T09:59:00.000Z', turn_count: 1 },
              'thread-critic': { thread_id: 'thread-critic', kind: 'subagent', first_seen_at: '2026-06-12T10:03:00.000Z', last_seen_at: '2026-06-12T10:03:00.000Z', completed_at: '2026-06-12T10:03:00.000Z', turn_count: 1 },
            },
          },
        },
      }, null, 2));

      const state = {
        current_phase: 'ralplan',
        handoff_artifacts: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: 'sess-architect',
              thread_id: 'thread-architect',
              completed_at: '2026-06-12T10:02:00.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: 'sess-critic',
              thread_id: 'thread-critic',
              completed_at: '2026-06-12T10:03:00.000Z',
            },
          },
        },
      };

      const decision = canAdvanceAutopilotRalplanToUltragoal({ cwd, currentState: state });
      assert.equal(decision.allowed, false);
      assert.match(buildAutopilotRalplanUltragoalGateError(decision), /same native subagent tracker session/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects stale review session ids even when transition session context exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-autopilot-ralplan-live-session-mismatch-'));
    const sessionId = 'sess-autopilot-live-session';
    const trackingPath = subagentTrackingPath(cwd);
    try {
      await mkdir(join(trackingPath, '..'), { recursive: true });
      await writeFile(trackingPath, JSON.stringify({
        schemaVersion: 1,
        sessions: {
          [sessionId]: {
            session_id: sessionId,
            leader_thread_id: 'thread-leader',
            updated_at: '2026-06-12T10:03:00.000Z',
            threads: {
              'thread-leader': { thread_id: 'thread-leader', kind: 'leader', first_seen_at: '2026-06-12T09:59:00.000Z', last_seen_at: '2026-06-12T09:59:00.000Z', turn_count: 1 },
              'thread-architect': { thread_id: 'thread-architect', kind: 'subagent', first_seen_at: '2026-06-12T10:02:00.000Z', last_seen_at: '2026-06-12T10:02:00.000Z', completed_at: '2026-06-12T10:02:00.000Z', turn_count: 1 },
              'thread-critic': { thread_id: 'thread-critic', kind: 'subagent', first_seen_at: '2026-06-12T10:03:00.000Z', last_seen_at: '2026-06-12T10:03:00.000Z', completed_at: '2026-06-12T10:03:00.000Z', turn_count: 1 },
            },
          },
        },
      }, null, 2));

      const state = {
        current_phase: 'ralplan',
        handoff_artifacts: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              thread_id: 'thread-architect',
              completed_at: '2026-06-12T10:02:00.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: 'sess-stale-critic',
              thread_id: 'thread-critic',
              completed_at: '2026-06-12T10:03:00.000Z',
            },
          },
        },
      };

      const decision = canAdvanceAutopilotRalplanToUltragoal({ cwd, sessionId, currentState: state });
      assert.equal(decision.allowed, false);
      assert.match(buildAutopilotRalplanUltragoalGateError(decision), /critic review session_id=sess-stale-critic does not match/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects tracker-backed native reviews whose subagent threads are not completed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-autopilot-ralplan-incomplete-thread-'));
    const sessionId = 'sess-autopilot-incomplete-thread';
    const trackingPath = subagentTrackingPath(cwd);
    try {
      await mkdir(join(trackingPath, '..'), { recursive: true });
      await writeFile(trackingPath, JSON.stringify({
        schemaVersion: 1,
        sessions: {
          [sessionId]: {
            session_id: sessionId,
            leader_thread_id: 'thread-leader',
            updated_at: '2026-06-12T10:03:00.000Z',
            threads: {
              'thread-leader': { thread_id: 'thread-leader', kind: 'leader', first_seen_at: '2026-06-12T09:59:00.000Z', last_seen_at: '2026-06-12T09:59:00.000Z', turn_count: 1 },
              'thread-architect': { thread_id: 'thread-architect', kind: 'subagent', first_seen_at: '2026-06-12T10:02:00.000Z', last_seen_at: '2026-06-12T10:02:00.000Z', turn_count: 1 },
              'thread-critic': { thread_id: 'thread-critic', kind: 'subagent', first_seen_at: '2026-06-12T10:03:00.000Z', last_seen_at: '2026-06-12T10:03:00.000Z', completed_at: '2026-06-12T10:03:00.000Z', turn_count: 1 },
            },
          },
        },
      }, null, 2));

      const state = {
        current_phase: 'ralplan',
        handoff_artifacts: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: sessionId,
              thread_id: 'thread-architect',
              completed_at: '2026-06-12T10:02:00.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: sessionId,
              thread_id: 'thread-critic',
              completed_at: '2026-06-12T10:03:00.000Z',
            },
          },
        },
      };

      const decision = canAdvanceAutopilotRalplanToUltragoal({ cwd, sessionId, currentState: state });
      assert.equal(decision.allowed, false);
      assert.match(buildAutopilotRalplanUltragoalGateError(decision), /architect tracker thread thread-architect is not completed/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('explains tracker-backed native review schema and observed missing session values', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-autopilot-ralplan-diagnostic-missing-session-'));
    const sessionId = 'sess-autopilot-diagnostic-missing-session';
    const trackingPath = subagentTrackingPath(cwd);
    try {
      await mkdir(join(trackingPath, '..'), { recursive: true });
      await writeFile(trackingPath, JSON.stringify({
        schemaVersion: 1,
        sessions: {},
      }, null, 2));

      const state = {
        current_phase: 'ralplan',
        handoff_artifacts: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: sessionId,
              thread_id: 'thread-architect',
              tracker_path: '.omx/state/subagent-tracking.json',
              completed_at: '2026-06-12T10:02:00.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: sessionId,
              thread_id: 'thread-critic',
              tracker_path: '.omx/state/subagent-tracking.json',
              completed_at: '2026-06-12T10:03:00.000Z',
            },
          },
        },
      };

      const decision = canAdvanceAutopilotRalplanToUltragoal({ cwd, sessionId, currentState: state });
      assert.equal(decision.allowed, false);
      assert.equal(decision.evidence?.diagnostic?.current_session_id, sessionId);
      assert.equal(decision.evidence?.diagnostic?.architect.session_found, false);
      assert.equal(decision.evidence?.diagnostic?.architect.thread_found, false);
      assert.equal(decision.evidence?.diagnostic?.distinct_thread_ids, true);
      const error = buildAutopilotRalplanUltragoalGateError(decision);
      assert.match(error, /Expected:/);
      assert.match(error, /sessions\["<current_session_id>"\]\.threads\["<architect_thread_id>"\]\.kind = "subagent"/);
      assert.match(error, /current_session_id: sess-autopilot-diagnostic-missing-session/);
      assert.match(error, /architect thread_id: thread-architect found: no kind=missing completed=no/);
      assert.match(error, /session_id: sess-autopilot-diagnostic-missing-session session_found=no/);
      assert.match(error, /Re-run native ralplan Architect\/Critic reviews/);
      assert.match(error, /docs\/contracts\/ralplan-consensus-gate\.md/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('explains observed tracker thread kind and completion checks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-autopilot-ralplan-diagnostic-thread-values-'));
    const sessionId = 'sess-autopilot-diagnostic-thread-values';
    const trackingPath = subagentTrackingPath(cwd);
    try {
      await mkdir(join(trackingPath, '..'), { recursive: true });
      await writeFile(trackingPath, JSON.stringify({
        schemaVersion: 1,
        sessions: {
          [sessionId]: {
            session_id: sessionId,
            leader_thread_id: 'thread-leader',
            threads: {
              'thread-architect': { thread_id: 'thread-architect', kind: 'leader', turn_count: 1 },
              'thread-critic': { thread_id: 'thread-critic', kind: 'subagent', completed_at: '2026-06-12T10:03:00.000Z', turn_count: 1 },
            },
          },
        },
      }, null, 2));

      const state = {
        current_phase: 'ralplan',
        handoff_artifacts: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: sessionId,
              thread_id: 'thread-architect',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: sessionId,
              thread_id: 'thread-critic',
            },
          },
        },
      };

      const decision = canAdvanceAutopilotRalplanToUltragoal({ cwd, sessionId, currentState: state });
      assert.equal(decision.allowed, false);
      assert.equal(decision.evidence?.diagnostic?.architect.session_found, true);
      assert.equal(decision.evidence?.diagnostic?.architect.thread_found, true);
      assert.equal(decision.evidence?.diagnostic?.architect.kind, 'leader');
      assert.equal(decision.evidence?.diagnostic?.architect.completed, false);
      const error = buildAutopilotRalplanUltragoalGateError(decision);
      assert.match(error, /architect thread_id: thread-architect found: yes kind=leader completed=no/);
      assert.match(error, /critic thread_id: thread-critic found: yes kind=subagent completed=yes/);
      assert.match(error, /distinct_thread_ids: yes/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects native review evidence from the session leader even when malformed tracking marks it as subagent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-autopilot-ralplan-leader-spoof-'));
    const sessionId = 'sess-autopilot-leader-spoof';
    const trackingPath = subagentTrackingPath(cwd);
    try {
      await mkdir(join(trackingPath, '..'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: 'thread-leader',
      }, null, 2));
      await writeFile(trackingPath, JSON.stringify({
        schemaVersion: 1,
        sessions: {
          [sessionId]: {
            session_id: sessionId,
            leader_thread_id: 'thread-leader',
            updated_at: '2026-05-28T18:34:51.000Z',
            threads: {
              'thread-leader': {
                thread_id: 'thread-leader',
                kind: 'subagent',
                first_seen_at: '2026-05-28T18:34:51.000Z',
                last_seen_at: '2026-05-28T18:34:51.000Z',
                turn_count: 2,
              },
              'thread-critic': {
                thread_id: 'thread-critic',
                kind: 'subagent',
                first_seen_at: '2026-05-28T18:35:10.000Z',
                last_seen_at: '2026-05-28T18:35:10.000Z',
                turn_count: 1,
              },
            },
          },
        },
      }, null, 2));

      const state = {
        current_phase: 'ralplan',
        handoff_artifacts: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: sessionId,
              thread_id: 'thread-leader',
              artifact_path: '.omx/artifacts/architect.md',
              tracker_path: '.omx/state/subagent-tracking.json',
              completed_at: '2026-05-28T18:34:51.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: sessionId,
              thread_id: 'thread-critic',
              artifact_path: '.omx/artifacts/critic.md',
              tracker_path: '.omx/state/subagent-tracking.json',
              completed_at: '2026-05-28T18:35:10.000Z',
            },
          },
        },
      };

      const decision = canAdvanceAutopilotRalplanToUltragoal({ cwd, sessionId, currentState: state });
      assert.equal(decision.allowed, false);
      assert.match(buildAutopilotRalplanUltragoalGateError(decision), /architect tracker thread thread-leader is the session leader/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('accepts fresh native review evidence when tracker leader id aliases a subagent lane', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-autopilot-ralplan-fresh-subagent-alias-'));
    const sessionId = 'sess-autopilot-fresh-subagent-alias';
    const trackingPath = subagentTrackingPath(cwd);
    try {
      await mkdir(join(trackingPath, '..'), { recursive: true });
      await writeFile(trackingPath, JSON.stringify({
        schemaVersion: 1,
        sessions: {
          [sessionId]: {
            session_id: sessionId,
            leader_thread_id: 'thread-architect',
            updated_at: '2026-05-28T18:35:10.000Z',
            threads: {
              'thread-architect': {
                thread_id: 'thread-architect',
                kind: 'subagent',
                first_seen_at: '2026-05-28T18:34:51.000Z',
                last_seen_at: '2026-05-28T18:34:51.000Z',
                completed_at: '2026-05-28T18:34:51.000Z',
                turn_count: 1,
                mode: 'architect',
              },
              'thread-critic': {
                thread_id: 'thread-critic',
                kind: 'subagent',
                first_seen_at: '2026-05-28T18:35:10.000Z',
                last_seen_at: '2026-05-28T18:35:10.000Z',
                completed_at: '2026-05-28T18:35:10.000Z',
                turn_count: 1,
                mode: 'critic',
              },
            },
          },
        },
      }, null, 2));

      const state = {
        current_phase: 'ralplan',
        handoff_artifacts: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: sessionId,
              thread_id: 'thread-architect',
              artifact_path: '.omx/artifacts/architect.md',
              tracker_path: '.omx/state/subagent-tracking.json',
              completed_at: '2026-05-28T18:34:51.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: sessionId,
              thread_id: 'thread-critic',
              artifact_path: '.omx/artifacts/critic.md',
              tracker_path: '.omx/state/subagent-tracking.json',
              completed_at: '2026-05-28T18:35:10.000Z',
            },
          },
        },
      };

      const decision = canAdvanceAutopilotRalplanToUltragoal({ cwd, sessionId, currentState: state });
      assert.equal(decision.allowed, true);
      assert.equal(decision.evidence?.blockedReason, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects native review evidence from the current native session leader', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-autopilot-ralplan-native-leader-'));
    const sessionId = 'sess-autopilot-native-leader';
    const trackingPath = subagentTrackingPath(cwd);
    try {
      await mkdir(join(trackingPath, '..'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: 'thread-leader',
      }, null, 2));
      await writeFile(trackingPath, JSON.stringify({
        schemaVersion: 1,
        sessions: {
          [sessionId]: {
            session_id: sessionId,
            leader_thread_id: 'thread-leader',
            updated_at: '2026-05-28T18:35:10.000Z',
            threads: {
              'thread-leader': {
                thread_id: 'thread-leader',
                kind: 'subagent',
                first_seen_at: '2026-05-28T18:34:51.000Z',
                last_seen_at: '2026-05-28T18:34:51.000Z',
                turn_count: 2,
              },
              'thread-critic': {
                thread_id: 'thread-critic',
                kind: 'subagent',
                first_seen_at: '2026-05-28T18:35:10.000Z',
                last_seen_at: '2026-05-28T18:35:10.000Z',
                turn_count: 1,
              },
            },
          },
        },
      }, null, 2));

      const state = {
        current_phase: 'ralplan',
        handoff_artifacts: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: sessionId,
              thread_id: 'thread-leader',
              artifact_path: '.omx/artifacts/architect.md',
              tracker_path: '.omx/state/subagent-tracking.json',
              completed_at: '2026-05-28T18:34:51.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: sessionId,
              thread_id: 'thread-critic',
              artifact_path: '.omx/artifacts/critic.md',
              tracker_path: '.omx/state/subagent-tracking.json',
              completed_at: '2026-05-28T18:35:10.000Z',
            },
          },
        },
      };

      const decision = canAdvanceAutopilotRalplanToUltragoal({ cwd, sessionId, currentState: state });
      assert.equal(decision.allowed, false);
      assert.match(buildAutopilotRalplanUltragoalGateError(decision), /architect tracker thread thread-leader is the session leader/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
