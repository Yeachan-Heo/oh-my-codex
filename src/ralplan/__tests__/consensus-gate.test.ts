import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getBaseStateDir } from '../../state/paths.js';
import { subagentTrackingPath } from '../../subagents/tracker.js';
import { buildRalplanConsensusGateForCwd } from '../consensus-gate.js';

describe('ralplan consensus gate state roots', () => {
  it('ignores ambient root consensus unless the ambient session is bound to this cwd', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-local-'));
    const ambientRoot = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-ambient-'));
    const previousOmxRoot = process.env.OMX_ROOT;
    const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
    const previousOmxTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    try {
      process.env.OMX_ROOT = ambientRoot;
      delete process.env.OMX_STATE_ROOT;
      delete process.env.OMX_TEAM_STATE_ROOT;
      const ambientStateDir = getBaseStateDir(cwd);
      await mkdir(ambientStateDir, { recursive: true });
      await writeFile(join(ambientStateDir, 'ralplan-state.json'), JSON.stringify({
        ralplan_consensus_gate: {
          complete: true,
          sequence: ['architect-review', 'critic-review'],
          ralplan_architect_review: { agent_role: 'architect', verdict: 'approve' },
          ralplan_critic_review: { agent_role: 'critic', verdict: 'approve' },
        },
      }, null, 2));

      const gate = buildRalplanConsensusGateForCwd(cwd);

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'missing_sequential_architect_then_critic_approval');
    } finally {
      if (typeof previousOmxRoot === 'string') process.env.OMX_ROOT = previousOmxRoot;
      else delete process.env.OMX_ROOT;
      if (typeof previousOmxStateRoot === 'string') process.env.OMX_STATE_ROOT = previousOmxStateRoot;
      else delete process.env.OMX_STATE_ROOT;
      if (typeof previousOmxTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousOmxTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(cwd, { recursive: true, force: true });
      await rm(ambientRoot, { recursive: true, force: true });
    }
  });

  it('reads tracker-backed consensus evidence from OMX_STATE_ROOT instead of cwd/.omx/state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-cwd-'));
    const boxedRoot = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-state-root-'));
    const previousOmxRoot = process.env.OMX_ROOT;
    const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
    const previousOmxTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    const sessionId = 'sess-boxed-consensus';
    try {
      delete process.env.OMX_ROOT;
      delete process.env.OMX_TEAM_STATE_ROOT;
      process.env.OMX_STATE_ROOT = boxedRoot;
      const baseStateDir = getBaseStateDir(cwd);
      const sessionDir = join(baseStateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(baseStateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: 'thread-leader',
        cwd,
      }, null, 2));
      await writeFile(subagentTrackingPath(cwd), JSON.stringify({
        schemaVersion: 1,
        sessions: {
          [sessionId]: {
            session_id: sessionId,
            leader_thread_id: 'thread-leader',
            updated_at: '2026-06-11T16:30:00.000Z',
            threads: {
              'thread-leader': {
                thread_id: 'thread-leader',
                kind: 'leader',
                first_seen_at: '2026-06-11T16:29:00.000Z',
                last_seen_at: '2026-06-11T16:29:00.000Z',
                turn_count: 1,
              },
              'thread-architect': {
                thread_id: 'thread-architect',
                kind: 'subagent',
                first_seen_at: '2026-06-11T16:29:30.000Z',
                last_seen_at: '2026-06-11T16:29:30.000Z',
                completed_at: '2026-06-11T16:29:30.000Z',
                turn_count: 1,
              },
              'thread-critic': {
                thread_id: 'thread-critic',
                kind: 'subagent',
                first_seen_at: '2026-06-11T16:30:00.000Z',
                last_seen_at: '2026-06-11T16:30:00.000Z',
                completed_at: '2026-06-11T16:30:00.000Z',
                turn_count: 1,
              },
            },
          },
        },
      }, null, 2));
      await writeFile(join(sessionDir, 'autopilot-state.json'), JSON.stringify({
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
              artifact_path: '.omx/plans/architect.md',
              tracker_path: '.omx/state/subagent-tracking.json',
              completed_at: '2026-06-11T16:29:30.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: sessionId,
              thread_id: 'thread-critic',
              artifact_path: '.omx/plans/critic.md',
              tracker_path: '.omx/state/subagent-tracking.json',
              completed_at: '2026-06-11T16:30:00.000Z',
            },
          },
        },
      }, null, 2));

      const gate = buildRalplanConsensusGateForCwd(cwd, {
        sessionId,
        requireNativeSubagents: true,
      });

      assert.equal(gate.complete, true);
      assert.equal(gate.blockedReason, null);
      assert.match(String(gate.source), new RegExp(`${boxedRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    } finally {
      if (typeof previousOmxRoot === 'string') process.env.OMX_ROOT = previousOmxRoot;
      else delete process.env.OMX_ROOT;
      if (typeof previousOmxStateRoot === 'string') process.env.OMX_STATE_ROOT = previousOmxStateRoot;
      else delete process.env.OMX_STATE_ROOT;
      if (typeof previousOmxTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousOmxTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(cwd, { recursive: true, force: true });
      await rm(boxedRoot, { recursive: true, force: true });
    }
  });

  it('rejects stale top-level handoff consensus during a return-to-ralplan cycle', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-stale-'));
    try {
      const gate = buildRalplanConsensusGateForCwd(cwd, {
        artifacts: {
          current_phase: 'ralplan',
          return_to_ralplan_reason: 'Code review requested changes.',
          handoff_artifacts: {
            ralplan_consensus_gate: {
              complete: true,
              sequence: ['architect-review', 'critic-review'],
              ralplan_architect_review: {
                agent_role: 'architect',
                verdict: 'approve',
                completed_at: '2026-06-11T16:00:00.000Z',
              },
              ralplan_critic_review: {
                agent_role: 'critic',
                verdict: 'approve',
                completed_at: '2026-06-11T16:05:00.000Z',
              },
            },
          },
        },
      });

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'missing_sequential_architect_then_critic_approval');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
