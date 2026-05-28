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
  it('rejects native review evidence from the session leader even when malformed tracking marks it as subagent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-autopilot-ralplan-leader-spoof-'));
    const sessionId = 'sess-autopilot-leader-spoof';
    const trackingPath = subagentTrackingPath(cwd);
    try {
      await mkdir(join(trackingPath, '..'), { recursive: true });
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
});
