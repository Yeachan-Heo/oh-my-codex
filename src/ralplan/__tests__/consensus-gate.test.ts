import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getBaseStateDir } from '../../state/paths.js';
import { writeRoleRoutingMarker } from '../../subagents/role-routing-marker.js';
import { subagentTrackingPath } from '../../subagents/tracker.js';
import { buildRalplanConsensusGateForCwd, buildRalplanConsensusGateFromSources } from '../consensus-gate.js';

function trackerBackedConsensus(
  sessionId: string,
  provenanceKind: 'native_subagent' | 'omx_adapted',
  overrides: {
    architect?: Record<string, unknown>;
    critic?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    ralplan_consensus_gate: {
      complete: true,
      sequence: ['architect-review', 'critic-review'],
      ralplan_architect_review: {
        agent_role: 'architect',
        provenance_kind: provenanceKind,
        verdict: 'approve',
        session_id: sessionId,
        thread_id: 'thread-architect',
        tracker_path: '.omx/state/subagent-tracking.json',
        completed_at: '2026-07-13T10:00:00.000Z',
        ...overrides.architect,
      },
      ralplan_critic_review: {
        agent_role: 'critic',
        provenance_kind: provenanceKind,
        verdict: 'approve',
        session_id: sessionId,
        thread_id: 'thread-critic',
        tracker_path: '.omx/state/subagent-tracking.json',
        completed_at: '2026-07-13T10:05:00.000Z',
        ...overrides.critic,
      },
    },
  };
}

function adaptedConsensus(
  sessionId: string,
  overrides: {
    architect?: Record<string, unknown>;
    critic?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return trackerBackedConsensus(sessionId, 'omx_adapted', overrides);
}

function nativeConsensus(
  sessionId: string,
  overrides: {
    architect?: Record<string, unknown>;
    critic?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return trackerBackedConsensus(sessionId, 'native_subagent', overrides);
}

type TrackerBackedSubagentTrackingOptions = {
  architectRole?: string;
  criticRole?: string;
  architectCompletedAt?: string;
  criticFirstSeenAt?: string | null;
  criticCompletedAt?: string;
  writeRoleRoutingMarker?: boolean;
};

async function writeTrackerBackedSubagentTracking(
  cwd: string,
  sessionId: string,
  provenanceKind: 'native_subagent' | 'omx_adapted',
  options: TrackerBackedSubagentTrackingOptions = {},
): Promise<void> {
  const trackingPath = subagentTrackingPath(cwd);
  const architectCompletedAt = options.architectCompletedAt ?? '2026-07-13T10:00:00.000Z';
  const criticFirstSeenAt = options.criticFirstSeenAt === undefined
    ? '2026-07-13T10:05:00.000Z'
    : options.criticFirstSeenAt;
  const criticCompletedAt = options.criticCompletedAt ?? '2026-07-13T10:10:00.000Z';
  await mkdir(join(trackingPath, '..'), { recursive: true });
  await writeFile(trackingPath, JSON.stringify({
    schemaVersion: 1,
    sessions: {
      [sessionId]: {
        session_id: sessionId,
        leader_thread_id: 'thread-leader',
        updated_at: architectCompletedAt,
        threads: {
          'thread-leader': {
            thread_id: 'thread-leader',
            kind: 'leader',
            first_seen_at: architectCompletedAt,
            last_seen_at: architectCompletedAt,
            turn_count: 1,
          },
          'thread-architect': {
            thread_id: 'thread-architect',
            kind: 'subagent',
            first_seen_at: architectCompletedAt,
            last_seen_at: architectCompletedAt,
            completed_at: architectCompletedAt,
            turn_count: 1,
            role: options.architectRole ?? 'architect',
            provenance_kind: provenanceKind,
          },
          'thread-critic': {
            thread_id: 'thread-critic',
            kind: 'subagent',
            ...(criticFirstSeenAt === null ? {} : { first_seen_at: criticFirstSeenAt }),
            last_seen_at: criticCompletedAt,
            completed_at: criticCompletedAt,
            turn_count: 1,
            role: options.criticRole ?? 'critic',
            provenance_kind: provenanceKind,
          },
        },
      },
    },
    pending_role_intents: [],
  }, null, 2));
  if (provenanceKind !== 'omx_adapted' || options.writeRoleRoutingMarker === false) return;
  writeRoleRoutingMarker(getBaseStateDir(cwd), {
    schema_version: 1,
    cwd,
    session_id: sessionId,
    parent_thread_id: 'thread-leader',
    observed_at: architectCompletedAt,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    evidence: 'OMX adapted role intent consumed for native child SessionStart',
  });
}

async function writeAdaptedSubagentTracking(
  cwd: string,
  sessionId: string,
  options: TrackerBackedSubagentTrackingOptions = {},
): Promise<void> {
  await writeTrackerBackedSubagentTracking(cwd, sessionId, 'omx_adapted', options);
}

async function writeNativeSubagentTracking(
  cwd: string,
  sessionId: string,
  options: TrackerBackedSubagentTrackingOptions = {},
): Promise<void> {
  await writeTrackerBackedSubagentTracking(cwd, sessionId, 'native_subagent', options);
}

describe('ralplan consensus gate state roots', () => {

  it('rejects invalid complete consensus even when it appears after a valid source', () => {
    const validConsensus = {
      ralplan_consensus_gate: {
        complete: true,
        sequence: ['architect-review', 'critic-review'],
        ralplan_architect_review: {
          agent_role: 'architect',
          verdict: 'approve',
          completed_at: '2026-06-12T10:00:00.000Z',
        },
        ralplan_critic_review: {
          agent_role: 'critic',
          verdict: 'approve',
          completed_at: '2026-06-12T10:05:00.000Z',
        },
      },
    };
    const invalidConsensus = {
      ralplan_consensus_gate: {
        complete: true,
        sequence: ['architect-review', 'critic-review'],
        ralplan_architect_review: {
          agent_role: 'architect',
          verdict: 'iterate',
          completed_at: '2026-06-12T10:10:00.000Z',
        },
        ralplan_critic_review: {
          agent_role: 'critic',
          verdict: 'approve',
          completed_at: '2026-06-12T10:15:00.000Z',
        },
      },
    };

    const gate = buildRalplanConsensusGateFromSources([
      { source: 'older-valid-source', value: validConsensus },
      { source: 'later-invalid-source', value: invalidConsensus },
    ]);

    assert.equal(gate.complete, false);
    assert.equal(gate.source, 'later-invalid-source');
    assert.equal(gate.blockedReason, 'non_approving_ralplan_consensus_review');
    assert.match(gate.blockedDetails?.join(' ') ?? '', /architect.*verdict=iterate/i);
  });


  it('requires strict direct Architect-before-Critic order evidence', () => {
    const buildGate = (
      form: 'explicit' | 'fallback',
      architectOrder?: string,
      criticOrder?: string,
    ) => {
      const architectReview = {
        agent_role: 'architect',
        verdict: 'approve',
        ...(architectOrder ? { completed_at: architectOrder } : {}),
      };
      const criticReview = {
        agent_role: 'critic',
        verdict: 'approve',
        ...(criticOrder ? { completed_at: criticOrder } : {}),
      };
      return buildRalplanConsensusGateFromSources([{
        source: `direct-order-${form}`,
        value: form === 'explicit'
          ? {
            ralplan_consensus_gate: {
              complete: true,
              sequence: ['architect-review', 'critic-review'],
              ralplan_architect_review: architectReview,
              ralplan_critic_review: criticReview,
            },
          }
          : {
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: architectReview,
            ralplan_critic_review: criticReview,
          },
      }]);
    };

    for (const form of ['explicit', 'fallback'] as const) {
      const valid = buildGate(form, '2026-06-12T10:00:00.000Z', '2026-06-12T10:05:00.000Z');
      assert.equal(valid.complete, true);

      for (const gate of [
        buildGate(form, '2026-06-12T10:00:00.000Z', '2026-06-12T10:00:00.000Z'),
        buildGate(form, '2026-06-12T10:05:00.000Z', '2026-06-12T10:00:00.000Z'),
        buildGate(form, undefined, '2026-06-12T10:05:00.000Z'),
        buildGate(form, '2026-06-12T10:00:00.000Z', undefined),
      ]) {
        assert.equal(gate.complete, false);
        assert.equal(
          gate.blockedReason,
          form === 'explicit'
            ? 'non_approving_ralplan_consensus_review'
            : 'missing_sequential_architect_then_critic_approval',
        );
        if (form === 'explicit') {
          assert.match(gate.blockedDetails?.join(' ') ?? '', /direct review order is not proven strictly architect-before-critic/i);
        }
      }
    }
  });

  it('uses sequence order authoritatively and rejects contradictory timestamps', () => {
    const buildGate = (
      architectSequence: number | undefined,
      criticSequence: number | undefined,
      architectCompletedAt?: string,
      criticCompletedAt?: string,
    ) => buildRalplanConsensusGateFromSources([{
      source: 'sequence-order',
      value: {
        ralplan_consensus_gate: {
          complete: true,
          sequence: ['architect-review', 'critic-review'],
          ralplan_architect_review: {
            agent_role: 'architect',
            verdict: 'approve',
            ...(architectSequence === undefined ? {} : { sequence_index: architectSequence }),
            ...(architectCompletedAt ? { completed_at: architectCompletedAt } : {}),
          },
          ralplan_critic_review: {
            agent_role: 'critic',
            verdict: 'approve',
            ...(criticSequence === undefined ? {} : { sequence_index: criticSequence }),
            ...(criticCompletedAt ? { completed_at: criticCompletedAt } : {}),
          },
        },
      },
    }]);

    assert.equal(buildGate(1, 2).complete, true);
    assert.equal(buildGate(2, 1).complete, false);
    assert.equal(buildGate(1, 1).complete, false);
    assert.equal(buildGate(1, undefined).complete, false);
    assert.equal(buildGate(undefined, 2).complete, false);
    assert.equal(
      buildGate(1, 2, '2026-06-12T10:05:00.000Z', '2026-06-12T10:00:00.000Z').complete,
      false,
    );
    assert.equal(
      buildGate(2, 1, '2026-06-12T10:00:00.000Z', '2026-06-12T10:05:00.000Z').complete,
      false,
    );
  });

  it('does not compare timestamp and sequence freshness domains', () => {
    const timestampConsensus = {
      ralplan_consensus_gate: {
        complete: true,
        sequence: ['architect-review', 'critic-review'],
        ralplan_architect_review: {
          agent_role: 'architect',
          verdict: 'approve',
          completed_at: '2026-06-12T10:00:00.000Z',
        },
        ralplan_critic_review: {
          agent_role: 'critic',
          verdict: 'approve',
          completed_at: '2026-06-12T10:05:00.000Z',
        },
      },
    };
    const sequenceConsensus = {
      ralplan_consensus_gate: {
        complete: true,
        sequence: ['architect-review', 'critic-review'],
        ralplan_architect_review: { agent_role: 'architect', verdict: 'approve', sequence_index: 3 },
        ralplan_critic_review: { agent_role: 'critic', verdict: 'approve', sequence_index: 4 },
      },
    };

    const timestampFirst = buildRalplanConsensusGateFromSources([
      { source: 'timestamp-first', value: timestampConsensus },
      { source: 'sequence-second', value: sequenceConsensus },
    ]);
    assert.equal(timestampFirst.source, 'timestamp-first');

    const sequenceFirst = buildRalplanConsensusGateFromSources([
      { source: 'sequence-first', value: sequenceConsensus },
      { source: 'timestamp-second', value: timestampConsensus },
    ]);
    assert.equal(sequenceFirst.source, 'sequence-first');
  });

  it('rejects malformed complete consensus even when it appears after a valid source', () => {
    const validConsensus = {
      ralplan_consensus_gate: {
        complete: true,
        sequence: ['architect-review', 'critic-review'],
        ralplan_architect_review: {
          agent_role: 'architect',
          verdict: 'approve',
          completed_at: '2026-06-12T10:00:00.000Z',
        },
        ralplan_critic_review: {
          agent_role: 'critic',
          verdict: 'approve',
          completed_at: '2026-06-12T10:05:00.000Z',
        },
      },
    };
    const malformedConsensus = {
      ralplan_consensus_gate: {
        complete: true,
        sequence: ['critic-review', 'architect-review'],
        ralplan_architect_review: {
          agent_role: 'architect',
          verdict: 'approve',
          completed_at: '2026-06-12T10:10:00.000Z',
        },
        ralplan_critic_review: {
          agent_role: 'critic',
          verdict: 'approve',
          completed_at: '2026-06-12T10:15:00.000Z',
        },
      },
    };

    const gate = buildRalplanConsensusGateFromSources([
      { source: 'older-valid-source', value: validConsensus },
      { source: 'later-malformed-source', value: malformedConsensus },
    ]);

    assert.equal(gate.complete, false);
    assert.equal(gate.source, 'later-malformed-source');
    assert.equal(gate.blockedReason, 'non_approving_ralplan_consensus_review');
    assert.match(gate.blockedDetails?.join(' ') ?? '', /sequence is not architect-review then critic-review/i);
  });

  it('lets fresh ordered direct consensus displace stale no-order invalid direct consensus', () => {
    const gate = buildRalplanConsensusGateFromSources([
      {
        source: 'stale-invalid-no-order',
        value: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              verdict: 'iterate',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              verdict: 'approve',
            },
          },
        },
      },
      {
        source: 'fresh-valid-with-order',
        value: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              verdict: 'approve',
              completed_at: '2026-06-12T10:00:00.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              verdict: 'approve',
              completed_at: '2026-06-12T10:05:00.000Z',
            },
          },
        },
      },
    ]);

    assert.equal(gate.complete, true);
    assert.equal(gate.source, 'fresh-valid-with-order');
    assert.equal(gate.blockedReason, null);
  });

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
                role: 'architect',
              },
              'thread-critic': {
                thread_id: 'thread-critic',
                kind: 'subagent',
                first_seen_at: '2026-06-11T16:30:00.000Z',
                last_seen_at: '2026-06-11T16:30:00.000Z',
                completed_at: '2026-06-11T16:30:00.000Z',
                turn_count: 1,
                role: 'critic',
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

  it('accepts ordered native reviews when runtime tracker lags but workspace tracker has completion evidence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-runtime-lag-'));
    const boxedRoot = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-runtime-root-'));
    const previousOmxRoot = process.env.OMX_ROOT;
    const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
    const previousOmxTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    const sessionId = 'sess-runtime-lag-consensus';
    try {
      delete process.env.OMX_ROOT;
      delete process.env.OMX_TEAM_STATE_ROOT;
      process.env.OMX_STATE_ROOT = boxedRoot;
      const runtimeStateDir = getBaseStateDir(cwd);
      const runtimeSessionDir = join(runtimeStateDir, 'sessions', sessionId);
      const workspaceStateDir = join(cwd, '.omx', 'state');
      const workspaceSessionDir = join(workspaceStateDir, 'sessions', sessionId);
      await mkdir(runtimeSessionDir, { recursive: true });
      await mkdir(workspaceSessionDir, { recursive: true });
      await writeFile(join(runtimeStateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: 'thread-leader',
        cwd,
      }, null, 2));
      const laggingTracker = {
        schemaVersion: 1,
        sessions: {
          [sessionId]: {
            session_id: sessionId,
            leader_thread_id: 'thread-leader',
            updated_at: '2026-07-07T04:31:00.000Z',
            threads: {
              'thread-leader': { thread_id: 'thread-leader', kind: 'leader', first_seen_at: '2026-07-07T04:29:00.000Z', last_seen_at: '2026-07-07T04:29:00.000Z', turn_count: 1 },
              'thread-architect': { thread_id: 'thread-architect', kind: 'subagent', first_seen_at: '2026-07-07T04:30:00.000Z', last_seen_at: '2026-07-07T04:30:00.000Z', turn_count: 1, role: 'architect' },
              'thread-critic': { thread_id: 'thread-critic', kind: 'subagent', first_seen_at: '2026-07-07T04:31:00.000Z', last_seen_at: '2026-07-07T04:31:00.000Z', turn_count: 1, role: 'critic' },
            },
          },
        },
      };
      const completedTracker = {
        schemaVersion: 1,
        sessions: {
          [sessionId]: {
            session_id: sessionId,
            leader_thread_id: 'thread-leader',
            updated_at: '2026-07-07T04:33:00.000Z',
            threads: {
              'thread-leader': { thread_id: 'thread-leader', kind: 'leader', first_seen_at: '2026-07-07T04:29:00.000Z', last_seen_at: '2026-07-07T04:29:00.000Z', turn_count: 1 },
              'thread-architect': { thread_id: 'thread-architect', kind: 'subagent', first_seen_at: '2026-07-07T04:30:00.000Z', last_seen_at: '2026-07-07T04:30:00.000Z', completed_at: '2026-07-07T04:30:00.000Z', turn_count: 1, role: 'architect' },
              'thread-critic': { thread_id: 'thread-critic', kind: 'subagent', first_seen_at: '2026-07-07T04:31:00.000Z', last_seen_at: '2026-07-07T04:31:00.000Z', completed_at: '2026-07-07T04:31:00.000Z', turn_count: 1, role: 'critic' },
            },
          },
        },
      };
      await writeFile(subagentTrackingPath(cwd), JSON.stringify(laggingTracker, null, 2));
      await writeFile(join(workspaceStateDir, 'subagent-tracking.json'), JSON.stringify(completedTracker, null, 2));
      await writeFile(join(runtimeSessionDir, 'ralplan-state.json'), JSON.stringify({
        active: false,
        current_phase: 'complete',
        planning_complete: true,
        latest_plan_path: '.omx/plans/prd-clickstack-otel-consumer-20260707T043000Z.md',
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
            completed_at: '2026-07-07T04:30:00.000Z',
          },
          ralplan_critic_review: {
            agent_role: 'critic',
            provenance_kind: 'native_subagent',
            verdict: 'approve',
            session_id: sessionId,
            thread_id: 'thread-critic',
            tracker_path: '.omx/state/subagent-tracking.json',
            completed_at: '2026-07-07T04:31:00.000Z',
          },
        },
      }, null, 2));

      const gate = buildRalplanConsensusGateForCwd(cwd, {
        sessionId,
        requireNativeSubagents: true,
      });

      assert.equal(gate.complete, true);
      assert.equal(gate.blockedReason, null);
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

  it('rejects runtime tracker lag when workspace tracker also lacks completion evidence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-runtime-lag-incomplete-'));
    const boxedRoot = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-runtime-incomplete-root-'));
    const previousOmxRoot = process.env.OMX_ROOT;
    const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
    const previousOmxTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    const sessionId = 'sess-runtime-lag-incomplete-consensus';
    try {
      delete process.env.OMX_ROOT;
      delete process.env.OMX_TEAM_STATE_ROOT;
      process.env.OMX_STATE_ROOT = boxedRoot;
      const runtimeStateDir = getBaseStateDir(cwd);
      const runtimeSessionDir = join(runtimeStateDir, 'sessions', sessionId);
      const workspaceStateDir = join(cwd, '.omx', 'state');
      await mkdir(runtimeSessionDir, { recursive: true });
      await mkdir(workspaceStateDir, { recursive: true });
      await writeFile(join(runtimeStateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: 'thread-leader',
        cwd,
      }, null, 2));
      const incompleteTracker = {
        schemaVersion: 1,
        sessions: {
          [sessionId]: {
            session_id: sessionId,
            leader_thread_id: 'thread-leader',
            updated_at: '2026-07-07T04:31:00.000Z',
            threads: {
              'thread-leader': { thread_id: 'thread-leader', kind: 'leader', first_seen_at: '2026-07-07T04:29:00.000Z', last_seen_at: '2026-07-07T04:29:00.000Z', turn_count: 1 },
              'thread-architect': { thread_id: 'thread-architect', kind: 'subagent', first_seen_at: '2026-07-07T04:30:00.000Z', last_seen_at: '2026-07-07T04:30:00.000Z', turn_count: 1, role: 'architect' },
              'thread-critic': { thread_id: 'thread-critic', kind: 'subagent', first_seen_at: '2026-07-07T04:31:00.000Z', last_seen_at: '2026-07-07T04:31:00.000Z', turn_count: 1, role: 'critic' },
            },
          },
        },
      };
      await writeFile(subagentTrackingPath(cwd), JSON.stringify(incompleteTracker, null, 2));
      await writeFile(join(workspaceStateDir, 'subagent-tracking.json'), JSON.stringify(incompleteTracker, null, 2));
      await writeFile(join(runtimeSessionDir, 'ralplan-state.json'), JSON.stringify({
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
            completed_at: '2026-07-07T04:30:00.000Z',
          },
          ralplan_critic_review: {
            agent_role: 'critic',
            provenance_kind: 'native_subagent',
            verdict: 'approve',
            session_id: sessionId,
            thread_id: 'thread-critic',
            tracker_path: '.omx/state/subagent-tracking.json',
            completed_at: '2026-07-07T04:31:00.000Z',
          },
        },
      }, null, 2));

      const gate = buildRalplanConsensusGateForCwd(cwd, {
        sessionId,
        requireNativeSubagents: true,
      });

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'native_subagent_consensus_evidence_missing');
      assert.match(gate.blockedDetails?.join(' ') ?? '', /thread-architect is not completed/);
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

  it('accepts session-scoped tracker-backed reviews without an explicit sessionId option', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-discovered-session-'));
    const boxedRoot = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-discovered-root-'));
    const previousOmxRoot = process.env.OMX_ROOT;
    const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
    const previousOmxTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    const sessionId = 'sess-discovered-consensus';
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
            updated_at: '2026-06-12T10:03:00.000Z',
            threads: {
              'thread-leader': {
                thread_id: 'thread-leader',
                kind: 'leader',
                first_seen_at: '2026-06-12T09:59:00.000Z',
                last_seen_at: '2026-06-12T09:59:00.000Z',
                turn_count: 1,
              },
              'thread-architect': {
                thread_id: 'thread-architect',
                kind: 'subagent',
                first_seen_at: '2026-06-12T10:02:00.000Z',
                last_seen_at: '2026-06-12T10:02:00.000Z',
                completed_at: '2026-06-12T10:02:00.000Z',
                turn_count: 1,
                role: 'architect',
              },
              'thread-critic': {
                thread_id: 'thread-critic',
                kind: 'subagent',
                first_seen_at: '2026-06-12T10:03:00.000Z',
                last_seen_at: '2026-06-12T10:03:00.000Z',
                completed_at: '2026-06-12T10:03:00.000Z',
                turn_count: 1,
                role: 'critic',
              },
            },
          },
        },
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
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
      }, null, 2));

      const gate = buildRalplanConsensusGateForCwd(cwd, {
        requireNativeSubagents: true,
      });

      assert.equal(gate.complete, true);
      assert.equal(gate.blockedReason, null);
      assert.match(String(gate.source), new RegExp(`${sessionId}/ralplan-state\\.json$`));
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

  it('rejects stale local ralplan state consensus during a return-to-ralplan cycle', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-stale-local-state-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        current_phase: 'complete',
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
      }, null, 2));

      const gate = buildRalplanConsensusGateForCwd(cwd, {
        artifacts: {
          current_phase: 'ralplan',
          return_to_ralplan_reason: 'Code review requested changes.',
          review_cycle: 1,
        },
      });

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'missing_sequential_architect_then_critic_approval');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('ignores stale invalid local ralplan state consensus during a return-to-ralplan cycle', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-stale-invalid-local-state-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        current_phase: 'complete',
        ralplan_consensus_gate: {
          complete: true,
          sequence: ['architect-review', 'critic-review'],
          ralplan_architect_review: {
            agent_role: 'architect',
            verdict: 'iterate',
            completed_at: '2026-06-11T16:00:00.000Z',
          },
          ralplan_critic_review: {
            agent_role: 'critic',
            verdict: 'approve',
            completed_at: '2026-06-11T16:05:00.000Z',
          },
        },
      }, null, 2));

      const gate = buildRalplanConsensusGateForCwd(cwd, {
        artifacts: {
          current_phase: 'ralplan',
          return_to_ralplan_reason: 'Code review requested changes.',
          review_cycle: 1,
        },
      });

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'missing_sequential_architect_then_critic_approval');
      assert.equal(gate.source, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves ordered invalid direct consensus in a return-to-ralplan cycle without review_cycle', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-ordered-invalid-return-'));
    try {
      const gate = buildRalplanConsensusGateForCwd(cwd, {
        artifacts: {
          current_phase: 'ralplan',
          return_to_ralplan_reason: 'Code review requested changes.',
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              verdict: 'iterate',
              completed_at: '2026-06-12T10:00:00.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              verdict: 'approve',
              completed_at: '2026-06-12T10:05:00.000Z',
            },
          },
        },
      });

      assert.equal(gate.complete, false);
      assert.equal(gate.source, 'stage-context-artifacts');
      assert.equal(gate.blockedReason, 'non_approving_ralplan_consensus_review');
      assert.match(gate.blockedDetails?.join(' ') ?? '', /architect.*verdict=iterate/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects local nested handoff consensus when only the local container review_cycle advances', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-local-container-only-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        current_phase: 'complete',
        review_cycle: 2,
        handoff_artifacts: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              verdict: 'approve',
              completed_at: '2026-06-12T10:00:00.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              verdict: 'approve',
              completed_at: '2026-06-12T10:05:00.000Z',
            },
          },
        },
      }, null, 2));

      const gate = buildRalplanConsensusGateForCwd(cwd, {
        artifacts: {
          current_phase: 'ralplan',
          return_to_ralplan_reason: 'Code review requested changes.',
          review_cycle: 1,
        },
      });

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'missing_sequential_architect_then_critic_approval');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('accepts local nested handoff consensus when both reviews carry the advanced review_cycle', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-local-review-fresh-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        current_phase: 'complete',
        review_cycle: 2,
        handoff_artifacts: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              verdict: 'approve',
              review_cycle: 2,
              completed_at: '2026-06-12T10:00:00.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              verdict: 'approve',
              review_cycle: 2,
              completed_at: '2026-06-12T10:05:00.000Z',
            },
          },
        },
      }, null, 2));

      const gate = buildRalplanConsensusGateForCwd(cwd, {
        artifacts: {
          current_phase: 'ralplan',
          return_to_ralplan_reason: 'Code review requested changes.',
          review_cycle: 1,
        },
      });

      assert.equal(gate.complete, true);
      assert.equal(gate.blockedReason, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects local state.handoff_artifacts consensus when only the local container review_cycle advances', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-local-state-container-only-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        current_phase: 'complete',
        review_cycle: 2,
        state: {
          handoff_artifacts: {
            ralplan_consensus_gate: {
              complete: true,
              sequence: ['architect-review', 'critic-review'],
              ralplan_architect_review: {
                agent_role: 'architect',
                verdict: 'approve',
                completed_at: '2026-06-12T10:00:00.000Z',
              },
              ralplan_critic_review: {
                agent_role: 'critic',
                verdict: 'approve',
                completed_at: '2026-06-12T10:05:00.000Z',
              },
            },
          },
        },
      }, null, 2));

      const gate = buildRalplanConsensusGateForCwd(cwd, {
        artifacts: {
          current_phase: 'ralplan',
          return_to_ralplan_reason: 'Code review requested changes.',
          review_cycle: 1,
        },
      });

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'missing_sequential_architect_then_critic_approval');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('accepts local state.handoff_artifacts consensus when nested state and both reviews carry the advanced review_cycle', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-local-state-review-fresh-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        current_phase: 'complete',
        state: {
          current_phase: 'ralplan',
          return_to_ralplan_reason: 'Code review requested changes.',
          review_cycle: 1,
          handoff_artifacts: {
            review_cycle: 2,
            ralplan_consensus_gate: {
              complete: true,
              sequence: ['architect-review', 'critic-review'],
              ralplan_architect_review: {
                agent_role: 'architect',
                verdict: 'approve',
                review_cycle: 2,
                completed_at: '2026-06-12T10:00:00.000Z',
              },
              ralplan_critic_review: {
                agent_role: 'critic',
                verdict: 'approve',
                review_cycle: 2,
                completed_at: '2026-06-12T10:05:00.000Z',
              },
            },
          },
        },
      }, null, 2));

      const gate = buildRalplanConsensusGateForCwd(cwd, {
        artifacts: {
          current_phase: 'ralplan',
          return_to_ralplan_reason: 'Code review requested changes.',
          review_cycle: 1,
        },
      });

      assert.equal(gate.complete, true);
      assert.equal(gate.blockedReason, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects stale review history consensus during a return-to-ralplan cycle', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-stale-history-'));
    try {
      const gate = buildRalplanConsensusGateForCwd(cwd, {
        artifacts: {
          current_phase: 'ralplan',
          return_to_ralplan_reason: 'Code review requested changes.',
          review_history: [{
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
          }],
        },
      });

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'missing_sequential_architect_then_critic_approval');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects stale review array consensus during a return-to-ralplan cycle', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-stale-arrays-'));
    try {
      const gate = buildRalplanConsensusGateForCwd(cwd, {
        artifacts: {
          current_phase: 'ralplan',
          return_to_ralplan_reason: 'Code review requested changes.',
          architectReviews: [{
            agent_role: 'architect',
            verdict: 'approve',
            completed_at: '2026-06-11T16:00:00.000Z',
          }],
          criticReviews: [{
            agent_role: 'critic',
            verdict: 'approve',
            completed_at: '2026-06-11T16:05:00.000Z',
          }],
        },
      });

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'missing_sequential_architect_then_critic_approval');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it('accepts tracker-backed native Architect and Critic lanes with exact ledger role identities and strict order', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-native-ok-'));
    const sessionId = 'sess-native-consensus-ok';
    try {
      await writeNativeSubagentTracking(cwd, sessionId);
      const consensus = nativeConsensus(sessionId);
      const reviews = consensus.ralplan_consensus_gate as Record<string, Record<string, unknown>>;
      delete reviews.ralplan_architect_review!.completed_at;
      delete reviews.ralplan_critic_review!.completed_at;
      const gate = buildRalplanConsensusGateFromSources([{
        source: 'native-consensus',
        value: consensus,
      }], { cwd, sessionId });

      assert.equal(gate.complete, true);
      assert.equal(gate.blockedReason, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses native mode as the role identity and permits truly roleless legacy native lanes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-native-mode-'));
    const sessionId = 'sess-native-consensus-mode';
    try {
      await writeNativeSubagentTracking(cwd, sessionId);
      const trackingPath = subagentTrackingPath(cwd);
      const tracking = JSON.parse(await readFile(trackingPath, 'utf-8')) as {
        sessions: Record<string, { threads: Record<string, Record<string, unknown>> }>;
      };
      const threads = tracking.sessions[sessionId]!.threads;
      for (const [threadId, mode] of [['thread-architect', 'architect'], ['thread-critic', 'critic']] as const) {
        delete threads[threadId]!.role;
        threads[threadId]!.mode = mode;
      }
      await writeFile(trackingPath, JSON.stringify(tracking, null, 2));

      const modeIdentityGate = buildRalplanConsensusGateFromSources([{
        source: 'native-mode-identity',
        value: nativeConsensus(sessionId),
      }], { cwd, sessionId });
      assert.equal(modeIdentityGate.complete, true);

      threads['thread-architect']!.mode = 'planner';
      await writeFile(trackingPath, JSON.stringify(tracking, null, 2));
      const mismatchedModeGate = buildRalplanConsensusGateFromSources([{
        source: 'native-mode-mismatch',
        value: nativeConsensus(sessionId),
      }], { cwd, sessionId });
      assert.equal(mismatchedModeGate.complete, false);
      assert.match(mismatchedModeGate.blockedDetails?.join(' ') ?? '', /thread-architect has mode=planner, expected architect/);

      delete threads['thread-architect']!.mode;
      delete threads['thread-critic']!.mode;
      await writeFile(trackingPath, JSON.stringify(tracking, null, 2));
      const rolelessLegacyGate = buildRalplanConsensusGateFromSources([{
        source: 'native-roleless-legacy',
        value: nativeConsensus(sessionId),
      }], { cwd, sessionId });
      assert.equal(rolelessLegacyGate.complete, true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it('reads a tracker candidate once before evaluating native pair and individual evidence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-native-read-once-'));
    const sessionId = 'sess-native-consensus-read-once';
    try {
      await writeNativeSubagentTracking(cwd, sessionId);
      const trackerPath = subagentTrackingPath(cwd);
      const originalReadFileSync = fs.readFileSync;
      let trackerReadCount = 0;
      const readFileSync = mock.method(fs, 'readFileSync', ((...args: Parameters<typeof fs.readFileSync>) => {
        if (args[0] === trackerPath) trackerReadCount += 1;
        return Reflect.apply(originalReadFileSync, fs, args);
      }) as typeof fs.readFileSync);
      syncBuiltinESMExports();
      try {
        const gate = buildRalplanConsensusGateFromSources([
          { source: 'native-read-once-first', value: nativeConsensus(sessionId) },
          { source: 'native-read-once-second', value: nativeConsensus(sessionId) },
        ], { cwd, sessionId });

        assert.equal(gate.complete, true);
        assert.equal(trackerReadCount, 1);
      } finally {
        readFileSync.mock.restore();
        syncBuiltinESMExports();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects a native lane when the ledger role does not match its review role', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-native-role-'));
    const sessionId = 'sess-native-consensus-role';
    try {
      await writeNativeSubagentTracking(cwd, sessionId, { architectRole: 'planner' });
      const gate = buildRalplanConsensusGateFromSources([{
        source: 'native-role-mismatch',
        value: nativeConsensus(sessionId),
      }], { cwd, sessionId });

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'native_subagent_consensus_evidence_missing');
      assert.match(gate.blockedDetails?.join(' ') ?? '', /thread-architect has role=planner, expected architect/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects a native lane when strict tracker order is missing or reversed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-native-order-'));
    const missingSessionId = 'sess-native-consensus-missing-order';
    const reversedSessionId = 'sess-native-consensus-reversed-order';
    try {
      await writeNativeSubagentTracking(cwd, missingSessionId, { criticFirstSeenAt: null });
      const missingOrderGate = buildRalplanConsensusGateFromSources([{
        source: 'native-missing-order',
        value: nativeConsensus(missingSessionId),
      }], { cwd, sessionId: missingSessionId });

      assert.equal(missingOrderGate.complete, false);
      assert.match(missingOrderGate.blockedDetails?.join(' ') ?? '', /tracker review order is missing.*critic first_seen_at/i);

      await writeNativeSubagentTracking(cwd, reversedSessionId, {
        architectCompletedAt: '2026-07-13T10:10:00.000Z',
        criticFirstSeenAt: '2026-07-13T10:05:00.000Z',
        criticCompletedAt: '2026-07-13T10:15:00.000Z',
      });
      const reversedOrderGate = buildRalplanConsensusGateFromSources([{
        source: 'native-reversed-order',
        value: nativeConsensus(reversedSessionId),
      }], { cwd, sessionId: reversedSessionId });

      assert.equal(reversedOrderGate.complete, false);
      assert.match(reversedOrderGate.blockedDetails?.join(' ') ?? '', /tracker review order is reversed/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not combine pair and individual native evidence from different tracker snapshots', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-native-snapshot-'));
    const boxedRoot = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-native-snapshot-root-'));
    const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
    const sessionId = 'sess-native-consensus-snapshot';
    try {
      process.env.OMX_STATE_ROOT = boxedRoot;
      await writeNativeSubagentTracking(cwd, sessionId, { criticRole: 'planner' });

      delete process.env.OMX_STATE_ROOT;
      await writeNativeSubagentTracking(cwd, sessionId, { architectRole: 'planner' });
      process.env.OMX_STATE_ROOT = boxedRoot;

      const gate = buildRalplanConsensusGateFromSources([{
        source: 'native-snapshot-mismatch',
        value: nativeConsensus(sessionId),
      }], { cwd, sessionId });

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'native_subagent_consensus_evidence_missing');
    } finally {
      if (previousOmxStateRoot === undefined) delete process.env.OMX_STATE_ROOT;
      else process.env.OMX_STATE_ROOT = previousOmxStateRoot;
      await rm(cwd, { recursive: true, force: true });
      await rm(boxedRoot, { recursive: true, force: true });
    }
  });

  it('rejects tracker-backed OMX-adapted Architect and Critic lanes even with valid legacy marker evidence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-adapted-ok-'));
    const sessionId = 'sess-adapted-consensus-ok';
    try {
      await writeAdaptedSubagentTracking(cwd, sessionId);
      const consensus = adaptedConsensus(sessionId);
      const reviews = consensus.ralplan_consensus_gate as Record<string, Record<string, unknown>>;
      delete reviews.ralplan_architect_review!.completed_at;
      delete reviews.ralplan_critic_review!.completed_at;
      const gate = buildRalplanConsensusGateFromSources([{
        source: 'adapted-consensus',
        value: consensus,
      }], { cwd, sessionId });

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'native_subagent_consensus_evidence_missing');
      assert.match(gate.blockedDetails?.join(' ') ?? '', /unsupported omx_adapted provenance/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it('rejects an OMX-adapted lane when tracker order evidence is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-adapted-no-order-'));
    const sessionId = 'sess-adapted-consensus-no-order';
    try {
      await writeAdaptedSubagentTracking(cwd, sessionId, { criticFirstSeenAt: null });
      const gate = buildRalplanConsensusGateFromSources([{
        source: 'adapted-missing-order',
        value: adaptedConsensus(sessionId),
      }], { cwd, sessionId });

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'native_subagent_consensus_evidence_missing');
      assert.match(gate.blockedDetails?.join(' ') ?? '', /unsupported omx_adapted provenance/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects forged OMX-adapted artifact timestamps when tracker ledger order is reversed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-adapted-reversed-order-'));
    const sessionId = 'sess-adapted-consensus-reversed-order';
    try {
      await writeAdaptedSubagentTracking(cwd, sessionId, {
        architectCompletedAt: '2026-07-13T10:10:00.000Z',
        criticFirstSeenAt: '2026-07-13T10:05:00.000Z',
        criticCompletedAt: '2026-07-13T10:15:00.000Z',
      });
      const gate = buildRalplanConsensusGateFromSources([{
        source: 'adapted-forged-artifact-order',
        value: adaptedConsensus(sessionId, {
          architect: { completed_at: '2026-07-13T09:00:00.000Z' },
          critic: { completed_at: '2026-07-13T09:05:00.000Z' },
        }),
      }], { cwd, sessionId, requireNativeSubagents: true });

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'native_subagent_consensus_evidence_missing');
      assert.match(gate.blockedDetails?.join(' ') ?? '', /unsupported omx_adapted provenance/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects an OMX-adapted lane when the ledger role does not match its review role', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-adapted-role-'));
    const sessionId = 'sess-adapted-consensus-role';
    try {
      await writeAdaptedSubagentTracking(cwd, sessionId, { architectRole: 'critic' });
      const gate = buildRalplanConsensusGateFromSources([{
        source: 'adapted-role-mismatch',
        value: adaptedConsensus(sessionId),
      }], { cwd, sessionId, requireNativeSubagents: true });

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'native_subagent_consensus_evidence_missing');
      assert.match(gate.blockedDetails?.join(' ') ?? '', /unsupported omx_adapted provenance/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects OMX-adapted reviews that reuse one tracker thread', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-adapted-reused-thread-'));
    const sessionId = 'sess-adapted-consensus-reused-thread';
    try {
      await writeAdaptedSubagentTracking(cwd, sessionId);
      const gate = buildRalplanConsensusGateFromSources([{
        source: 'adapted-reused-thread',
        value: adaptedConsensus(sessionId, {
          critic: { thread_id: 'thread-architect' },
        }),
      }], { cwd, sessionId, requireNativeSubagents: true });

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'native_subagent_consensus_evidence_missing');
      assert.match(gate.blockedDetails?.join(' ') ?? '', /unsupported omx_adapted provenance/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects OMX-adapted lanes without scoped role-routing-unavailable evidence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-adapted-no-marker-'));
    const sessionId = 'sess-adapted-consensus-no-marker';
    try {
      await writeAdaptedSubagentTracking(cwd, sessionId, { writeRoleRoutingMarker: false });
      const gate = buildRalplanConsensusGateFromSources([{
        source: 'adapted-missing-marker',
        value: adaptedConsensus(sessionId),
      }], { cwd, sessionId, requireNativeSubagents: true });

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'native_subagent_consensus_evidence_missing');
      assert.match(gate.blockedDetails?.join(' ') ?? '', /unsupported omx_adapted provenance/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects a native-provenance artifact that points to OMX-adapted ledger threads', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-adapted-native-claim-'));
    const sessionId = 'sess-adapted-consensus-native-claim';
    try {
      await writeAdaptedSubagentTracking(cwd, sessionId);
      const gate = buildRalplanConsensusGateFromSources([{
        source: 'adapted-native-claim',
        value: adaptedConsensus(sessionId, {
          architect: { provenance_kind: 'native_subagent' },
          critic: { provenance_kind: 'native_subagent' },
        }),
      }], { cwd, sessionId, requireNativeSubagents: true });

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'native_subagent_consensus_evidence_missing');
      assert.match(gate.blockedDetails?.join(' ') ?? '', /conflicting with native_subagent review provenance/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

});
