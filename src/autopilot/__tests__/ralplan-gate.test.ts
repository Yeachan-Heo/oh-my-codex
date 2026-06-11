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
                turn_count: 1,
                mode: 'architect',
              },
              'thread-critic': {
                thread_id: 'thread-critic',
                kind: 'subagent',
                first_seen_at: '2026-05-28T18:35:10.000Z',
                last_seen_at: '2026-05-28T18:35:10.000Z',
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
