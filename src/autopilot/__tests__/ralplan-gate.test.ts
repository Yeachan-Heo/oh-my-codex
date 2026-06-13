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

describe('autopilot ralplan gate', () => {
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
              'thread-architect-fresh': { thread_id: 'thread-architect-fresh', kind: 'subagent', first_seen_at: '2026-06-12T10:02:00.000Z', last_seen_at: '2026-06-12T10:02:00.000Z', completed_at: '2026-06-12T10:02:00.000Z', turn_count: 1 },
              'thread-critic-fresh': { thread_id: 'thread-critic-fresh', kind: 'subagent', first_seen_at: '2026-06-12T10:03:00.000Z', last_seen_at: '2026-06-12T10:03:00.000Z', completed_at: '2026-06-12T10:03:00.000Z', turn_count: 1 },
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
