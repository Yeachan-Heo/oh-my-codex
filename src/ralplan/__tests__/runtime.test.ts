import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readModeState, startMode } from '../../modes/base.js';
import { getBaseStateDir, getStatePath } from '../../state/paths.js';
import { writeRoleRoutingMarker } from '../../subagents/role-routing-marker.js';
import { subagentTrackingPath } from '../../subagents/tracker.js';
import { cancelRalplanConsensus, isCompletedAdvisoryCatchRecovery, runRalplanConsensus, __buildRalplanConsensusGateForTests, type RalplanReviewResult } from '../runtime.js';
import { readCurrentRalplanAdvisory } from '../advisory.js';
import {
  __setRalplanAdvisoryLifecycleHooksForTests,
  verifyAdvisoryCatchRecovery,
} from '../runtime-advisory-lifecycle.js';

function sessionStatePath(cwd: string, sessionId: string): string {
  return getStatePath('ralplan', cwd, sessionId);
}

async function writeSessionPointer(cwd: string, sessionId: string): Promise<void> {
  const stateDir = join(cwd, '.omx', 'state');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'session.json'), JSON.stringify({
    session_id: sessionId,
    cwd,
    state_root: stateDir,
  }));
}

async function readScopedRalplanState(cwd: string, sessionId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(sessionStatePath(cwd, sessionId), 'utf-8'));
}

async function writeNativeSubagentTracking(cwd: string, sessionId: string, postActivation = false): Promise<void> {
  const architectCompletedAt = postActivation ? new Date(Date.now() + 1_000).toISOString() : '2026-05-28T00:00:00.000Z';
  const criticStartedAt = postActivation ? new Date(Date.now() + 2_000).toISOString() : '2026-05-28T00:05:00.000Z';
  const criticCompletedAt = postActivation ? new Date(Date.now() + 3_000).toISOString() : '2026-05-28T00:10:00.000Z';
  const trackingPath = subagentTrackingPath(cwd);
  await mkdir(join(trackingPath, '..'), { recursive: true });
  await writeFile(trackingPath, JSON.stringify({
    schemaVersion: 1,
    sessions: {
      [sessionId]: {
        session_id: sessionId,
        leader_thread_id: 'thread-leader',
        updated_at: criticCompletedAt,
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
            role: 'architect',
            provenance_kind: 'native_subagent',
            direct_child_root_id: 'thread-leader',
            direct_child_parent_id: 'thread-leader',
          },
          'thread-critic': {
            thread_id: 'thread-critic',
            kind: 'subagent',
            first_seen_at: criticStartedAt,
            last_seen_at: criticCompletedAt,
            completed_at: criticCompletedAt,
            turn_count: 1,
            role: 'critic',
            provenance_kind: 'native_subagent',
            direct_child_root_id: 'thread-leader',
            direct_child_parent_id: 'thread-leader',
          },
        },
      },
    },
  }, null, 2));
}

async function writeAdaptedSubagentTracking(cwd: string, sessionId: string): Promise<void> {
  await writeNativeSubagentTracking(cwd, sessionId);
  const trackingPath = subagentTrackingPath(cwd);
  const tracking = JSON.parse(await readFile(trackingPath, 'utf-8')) as {
    sessions: Record<string, { threads: Record<string, Record<string, unknown>> }>;
  };
  const threads = tracking.sessions[sessionId]?.threads;
  if (!threads) throw new Error('adapted_subagent_tracking_fixture_missing');
  for (const [threadId, role] of [['thread-architect', 'architect'], ['thread-critic', 'critic']] as const) {
    threads[threadId] = {
      ...threads[threadId],
      role,
      provenance_kind: 'omx_adapted',
    };
  }
  threads['thread-architect'] = {
    ...threads['thread-architect'],
    first_seen_at: '2026-05-28T00:00:00.000Z',
    last_seen_at: '2026-05-28T00:00:00.000Z',
    completed_at: '2026-05-28T00:00:00.000Z',
  };
  threads['thread-critic'] = {
    ...threads['thread-critic'],
    first_seen_at: '2026-05-28T00:05:00.000Z',
    last_seen_at: '2026-05-28T00:05:00.000Z',
    completed_at: '2026-05-28T00:05:00.000Z',
  };
  await writeFile(trackingPath, JSON.stringify(tracking, null, 2));
  writeRoleRoutingMarker(getBaseStateDir(cwd), {
    schema_version: 1,
    cwd,
    session_id: sessionId,
    parent_thread_id: 'thread-leader',
    observed_at: '2026-07-13T10:00:00.000Z',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    evidence: 'OMX adapted role intent consumed for native child SessionStart',
  });
}

async function runApprovedAdvisoryFixture(
  cwd: string,
  sessionId: string,
  duringCriticReview?: () => void | Promise<void>,
) {
  await writeSessionPointer(cwd, sessionId);
  await writeNativeSubagentTracking(cwd, sessionId, true);
  await mkdir(join(cwd, '.omx', 'artifacts'), { recursive: true });
  await writeFile(join(cwd, '.omx', 'artifacts', 'architect.md'), 'APPROVE\n');
  await writeFile(join(cwd, '.omx', 'artifacts', 'critic.md'), 'APPROVE\n');
  return runRalplanConsensus({
    async draft() {
      await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
      const planPath = join(cwd, '.omx', 'plans', 'advisory.md');
      await writeFile(planPath, '# approved plan\n');
      return { planPath, summary: 'draft' };
    },
    async architectReview() {
      return {
        verdict: 'approve' as const, agent_role: 'architect' as const, provenance_kind: 'native_subagent' as const,
        session_id: sessionId, thread_id: 'thread-architect', artifact_path: '.omx/artifacts/architect.md',
      };
    },
    async criticReview() {
      await duringCriticReview?.();
      return {
        verdict: 'approve' as const, agent_role: 'critic' as const, provenance_kind: 'native_subagent' as const,
        session_id: sessionId, thread_id: 'thread-critic', artifact_path: '.omx/artifacts/critic.md',
      };
    },
  }, {
    task: 'produce advisory only', cwd, sessionId, maxIterations: 1, requireNativeSubagents: true,
    workflowVariant: 'advisory', advisoryProducer: 'native', advisoryThreadKind: 'root-or-drift',
    rootThreadId: 'thread-leader', activationTurnId: 'turn-a', closingTurnId: 'turn-a',
  });
}

describe('ralplan runtime', () => {
  let savedOmxEnv: Pick<NodeJS.ProcessEnv, 'OMX_ROOT' | 'OMX_STATE_ROOT' | 'OMX_TEAM_STATE_ROOT' | 'OMX_SESSION_ID'>;

  beforeEach(() => {
    savedOmxEnv = {
      OMX_ROOT: process.env.OMX_ROOT,
      OMX_STATE_ROOT: process.env.OMX_STATE_ROOT,
      OMX_TEAM_STATE_ROOT: process.env.OMX_TEAM_STATE_ROOT,
      OMX_SESSION_ID: process.env.OMX_SESSION_ID,
    };
    delete process.env.OMX_ROOT;
    delete process.env.OMX_STATE_ROOT;
    delete process.env.OMX_TEAM_STATE_ROOT;
    delete process.env.OMX_SESSION_ID;
  });

  afterEach(() => {
    __setRalplanAdvisoryLifecycleHooksForTests({});
    for (const key of ['OMX_ROOT', 'OMX_STATE_ROOT', 'OMX_TEAM_STATE_ROOT', 'OMX_SESSION_ID'] as const) {
      const value = savedOmxEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('preserves the primary failure when Advisory reconciliation verification throws', async () => {
    const primary = new Error('primary');
    const recovery = new Error('reconcile failed');
    __setRalplanAdvisoryLifecycleHooksForTests({ reconcile: async () => { throw recovery; } });
    await assert.rejects(
      verifyAdvisoryCatchRecovery({ cwd: '/tmp', sessionId: 'session-a', generationId: 'generation-a', primaryError: primary }),
      (error: unknown) => error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === recovery,
    );
  });

  it('preserves the primary failure when Advisory binding verification throws', async () => {
    const primary = new Error('primary');
    const bindingError = new Error('binding read failed');
    __setRalplanAdvisoryLifecycleHooksForTests({
      reconcile: async () => ({ corruption: null, fence: { state: 'closed' }, journal: { outcome: 'approved' } } as never),
      readBinding: async () => { throw bindingError; },
    });
    await assert.rejects(
      verifyAdvisoryCatchRecovery({ cwd: '/tmp', sessionId: 'session-a', generationId: 'generation-a', primaryError: primary }),
      (error: unknown) => error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === bindingError,
    );
  });

  it('distinguishes valid approved catch recovery from explicit absence', async () => {
    const input = { cwd: '/tmp', sessionId: 'session-a', generationId: 'generation-a', primaryError: new Error('primary') };
    __setRalplanAdvisoryLifecycleHooksForTests({
      reconcile: async () => ({ corruption: null, fence: { state: 'closed' }, journal: { outcome: 'approved' } } as never),
      readBinding: async () => ({ mode: 'ralplan', session_id: 'session-a', workflow_variant: 'advisory', advisory_generation_id: 'generation-a', active: false }),
    });
    assert.equal(await verifyAdvisoryCatchRecovery(input), true);
    __setRalplanAdvisoryLifecycleHooksForTests({ reconcile: async () => null, readBinding: async () => null });
    assert.equal(await verifyAdvisoryCatchRecovery(input), false);
  });











  it('marks failed cleanly when execution throws', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-fail-'));
    const sessionId = 'sess-ralplan-fail';
    try {
      await mkdir(join(sessionStatePath(cwd, sessionId), '..'), { recursive: true });
      await writeSessionPointer(cwd, sessionId);

      const result = await runRalplanConsensus({
        async draft() {
          return { summary: 'draft' };
        },
        async architectReview() {
          throw new Error('architect blew up');
        },
        async criticReview() {
          throw new Error('should not run');
        },
      }, { task: 'failing ralplan runtime', cwd });

      assert.equal(result.status, 'failed');
      assert.match(result.error || '', /architect blew up/);

      const finalState = await readScopedRalplanState(cwd, sessionId);
      assert.equal(finalState?.active, false);
      assert.equal(finalState?.current_phase, 'failed');
      assert.match(String(finalState?.status_message || ''), /Status: failed/);
      assert.match(String(finalState?.error || ''), /architect blew up/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps Ralplan in the explicit session and advances its Autopilot parent to Ultragoal', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-autopilot-'));
    const sessionId = 'sess-ralplan-autopilot';
    try {
      await writeSessionPointer(cwd, sessionId);
      await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'plans', 'plan.md'), '# Plan\n');
      await mkdir(join(cwd, '.omx', 'specs'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'specs', 'requirements.md'), '# Requirements\n');
      await startMode('autopilot', 'supervised planning', 3, cwd, sessionId);
      const { updateAutopilotPipelineState } = await import('../../modes/base.js');
      await updateAutopilotPipelineState({
        active: true,
        current_phase: 'ralplan',
        workingDirectory: cwd,
        session_id: sessionId,
        review_cycle: 1,
        deep_interview_gate: { status: 'complete', rationale: 'Requirements complete.' },
        handoff_artifacts: { deep_interview: { spec_path: '.omx/specs/requirements.md' } },
      }, cwd, sessionId);

      const result = await runRalplanConsensus({
        async draft() { return { summary: 'draft', planPath: '.omx/plans/plan.md' }; },
        async architectReview() { return { verdict: 'approve', agent_role: 'architect' }; },
        async criticReview() { return { verdict: 'approve', agent_role: 'critic' }; },
      }, { task: 'supervised planning', cwd, sessionId, selectedExecutionLane: 'ultragoal' });

      assert.equal(result.status, 'completed', result.error ?? 'Ralplan should complete');
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'ralplan-state.json')), false);
      const ralplan = await readScopedRalplanState(cwd, sessionId);
      assert.equal(ralplan.current_phase, 'complete');
      assert.equal((ralplan.ralplan_execution_handoff as Record<string, unknown>).session_id, sessionId);
      const autopilot = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'sessions', sessionId, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(autopilot.current_phase, 'ultragoal');
      assert.equal((autopilot.ralplan_execution_handoff as Record<string, unknown>).session_id, sessionId);
      assert.equal((autopilot.ralplan_execution_handoff as Record<string, unknown>).source, 'autopilot');
      assert.equal((autopilot.ralplan_consensus_gate as Record<string, unknown>).complete, true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('marks cancelled state cleanly', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-cancel-'));
    const sessionId = 'sess-ralplan-cancel';
    try {
      await mkdir(join(sessionStatePath(cwd, sessionId), '..'), { recursive: true });
      await writeSessionPointer(cwd, sessionId);

      await startMode('ralplan', 'cancel me', 2, cwd, sessionId);
      await cancelRalplanConsensus(cwd, sessionId);

      const finalState = await readScopedRalplanState(cwd, sessionId);
      assert.equal(finalState?.active, false);
      assert.equal(finalState?.current_phase, 'cancelled');
      assert.ok(typeof finalState?.completed_at === 'string' && finalState.completed_at.length > 0);
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'ralplan-state.json')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('ralplan advisory runtime', () => {
  it('rejects the restricted Advisory start profile without its matching durable intent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-advisory-profile-'));
    const sessionId = 'sess-advisory-profile';
    try {
      await writeSessionPointer(cwd, sessionId);
      await assert.rejects(
        () => startMode('ralplan', 'cannot mint advisory state', 1, cwd, sessionId, {
          kind: 'ralplan-advisory', sessionId, generationId: 'generation-a',
          rootThreadId: 'thread-leader', activationTurnId: 'turn-a',
          activationPrompt: 'cannot mint advisory state',
        }),
        /ralplan_advisory_start_profile_intent_mismatch/,
      );
      assert.equal(existsSync(sessionStatePath(cwd, sessionId)), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('publishes a complete Advisory binding on the first mode write and retries after an intent-only crash', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-advisory-intent-retry-'));
    const sessionId = 'sess-advisory-intent-retry';
    const priorNodeEnv = process.env.NODE_ENV;
    const priorFailpoint = process.env.OMX_RALPLAN_ADVISORY_STARTUP_FAILPOINT;
    try {
      process.env.NODE_ENV = 'test';
      process.env.OMX_RALPLAN_ADVISORY_STARTUP_FAILPOINT = 'after_intent';
      await writeSessionPointer(cwd, sessionId);
      await writeNativeSubagentTracking(cwd, sessionId, true);
      await mkdir(join(cwd, '.omx', 'artifacts'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'artifacts', 'architect.md'), 'APPROVE\n');
      await writeFile(join(cwd, '.omx', 'artifacts', 'critic.md'), 'APPROVE\n');
      const executor = {
        async draft() {
          await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
          const planPath = join(cwd, '.omx', 'plans', 'advisory.md');
          await writeFile(planPath, '# approved plan\n');
          return { planPath, summary: 'draft' };
        },
        async architectReview() {
          return { verdict: 'approve' as const, agent_role: 'architect' as const, provenance_kind: 'native_subagent' as const, session_id: sessionId, thread_id: 'thread-architect', artifact_path: '.omx/artifacts/architect.md' };
        },
        async criticReview() {
          return { verdict: 'approve' as const, agent_role: 'critic' as const, provenance_kind: 'native_subagent' as const, session_id: sessionId, thread_id: 'thread-critic', artifact_path: '.omx/artifacts/critic.md' };
        },
      };
      const options = {
        task: 'retry advisory startup', cwd, sessionId, maxIterations: 1, requireNativeSubagents: true,
        workflowVariant: 'advisory' as const, advisoryProducer: 'native', advisoryThreadKind: 'root-or-drift', rootThreadId: 'thread-leader', activationTurnId: 'turn-intent', closingTurnId: 'turn-intent',
      };

      await assert.rejects(() => runRalplanConsensus(executor, options), /startup_test_failpoint:after_intent/);
      assert.equal(existsSync(sessionStatePath(cwd, sessionId)), false, 'intent must precede every mode write');
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'sessions', sessionId, 'ralplan-advisory', 'rollover-intent.json')), true);

      delete process.env.OMX_RALPLAN_ADVISORY_STARTUP_FAILPOINT;
      const result = await runRalplanConsensus(executor, options);
      assert.equal(result.status, 'completed', result.error ?? 'retry should complete');
      const state = await readScopedRalplanState(cwd, sessionId);
      assert.equal(state.workflow_variant, 'advisory');
      assert.equal(state.execution_handoff_authorized, false);
      assert.equal(state.host_verified, false);
    } finally {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorNodeEnv;
      if (priorFailpoint === undefined) delete process.env.OMX_RALPLAN_ADVISORY_STARTUP_FAILPOINT; else process.env.OMX_RALPLAN_ADVISORY_STARTUP_FAILPOINT = priorFailpoint;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('retries idempotently after the Advisory mode binding is durable but activation is not committed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-advisory-mode-retry-'));
    const sessionId = 'sess-advisory-mode-retry';
    const priorNodeEnv = process.env.NODE_ENV;
    const priorFailpoint = process.env.OMX_RALPLAN_ADVISORY_STARTUP_FAILPOINT;
    try {
      process.env.NODE_ENV = 'test';
      process.env.OMX_RALPLAN_ADVISORY_STARTUP_FAILPOINT = 'after_mode';
      await writeSessionPointer(cwd, sessionId);
      await writeNativeSubagentTracking(cwd, sessionId, true);
      await mkdir(join(cwd, '.omx', 'artifacts'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'artifacts', 'architect.md'), 'APPROVE\n');
      await writeFile(join(cwd, '.omx', 'artifacts', 'critic.md'), 'APPROVE\n');
      const executor = {
        async draft() {
          await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
          const planPath = join(cwd, '.omx', 'plans', 'advisory.md');
          await writeFile(planPath, '# approved plan\n');
          return { planPath, summary: 'draft' };
        },
        async architectReview() { return { verdict: 'approve' as const, agent_role: 'architect' as const, provenance_kind: 'native_subagent' as const, session_id: sessionId, thread_id: 'thread-architect', artifact_path: '.omx/artifacts/architect.md' }; },
        async criticReview() { return { verdict: 'approve' as const, agent_role: 'critic' as const, provenance_kind: 'native_subagent' as const, session_id: sessionId, thread_id: 'thread-critic', artifact_path: '.omx/artifacts/critic.md' }; },
      };
      const options = {
        task: 'retry bound advisory startup', cwd, sessionId, maxIterations: 1, requireNativeSubagents: true,
        workflowVariant: 'advisory' as const, advisoryProducer: 'native', advisoryThreadKind: 'root-or-drift', rootThreadId: 'thread-leader', activationTurnId: 'turn-mode', closingTurnId: 'turn-mode',
      };

      await assert.rejects(() => runRalplanConsensus(executor, options), /startup_test_failpoint:after_mode/);
      const firstBinding = await readScopedRalplanState(cwd, sessionId);
      assert.equal(firstBinding.workflow_variant, 'advisory');
      assert.equal(firstBinding.execution_handoff_authorized, false);
      assert.equal(firstBinding.host_verified, false);
      const generationId = String(firstBinding.advisory_generation_id);

      delete process.env.OMX_RALPLAN_ADVISORY_STARTUP_FAILPOINT;
      const result = await runRalplanConsensus(executor, options);
      assert.equal(result.status, 'completed', result.error ?? 'retry should complete');
      const projection = await readCurrentRalplanAdvisory(cwd, sessionId);
      assert.equal(projection?.activation.generation_id, generationId, 'retry must reuse the durable generation intent');
    } finally {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorNodeEnv;
      if (priorFailpoint === undefined) delete process.env.OMX_RALPLAN_ADVISORY_STARTUP_FAILPOINT; else process.env.OMX_RALPLAN_ADVISORY_STARTUP_FAILPOINT = priorFailpoint;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not mutate a standard or foreign Advisory binding that wins after intent preparation', async () => {
    const priorNodeEnv = process.env.NODE_ENV;
    const priorFailpoint = process.env.OMX_RALPLAN_ADVISORY_STARTUP_FAILPOINT;
    try {
      process.env.NODE_ENV = 'test';
      for (const competitor of ['standard', 'foreign-advisory'] as const) {
        const cwd = await mkdtemp(join(tmpdir(), `omx-ralplan-advisory-race-${competitor}-`));
        const sessionId = `sess-advisory-race-${competitor}`;
        try {
          await writeSessionPointer(cwd, sessionId);
          const executor = {
            async draft() { return { summary: 'unreachable' }; },
            async architectReview() { return { verdict: 'approve' as const }; },
            async criticReview() { return { verdict: 'approve' as const }; },
          };
          const options = {
            task: `race ${competitor}`, cwd, sessionId, maxIterations: 1,
            workflowVariant: 'advisory' as const, advisoryProducer: 'native', advisoryThreadKind: 'root-or-drift', rootThreadId: 'thread-leader',
            activationTurnId: 'turn-race', closingTurnId: 'turn-race',
          };
          process.env.OMX_RALPLAN_ADVISORY_STARTUP_FAILPOINT = 'after_intent';
          await assert.rejects(() => runRalplanConsensus(executor, options), /startup_test_failpoint:after_intent/);

          const competingBinding = competitor === 'standard'
            ? { active: true, mode: 'ralplan', session_id: sessionId, current_phase: 'draft' }
            : {
              active: true, mode: 'ralplan', session_id: sessionId, current_phase: 'draft',
              workflow_variant: 'advisory', advisory_generation_id: 'foreign-generation',
              execution_handoff_authorized: false, host_verified: false,
            };
          await mkdir(join(sessionStatePath(cwd, sessionId), '..'), { recursive: true });
          const competingBytes = `${JSON.stringify(competingBinding, null, 2)}\n`;
          await writeFile(sessionStatePath(cwd, sessionId), competingBytes);
          delete process.env.OMX_RALPLAN_ADVISORY_STARTUP_FAILPOINT;

          await assert.rejects(
            () => runRalplanConsensus(executor, options),
            /ralplan_advisory_start_binding_conflict/,
          );
          assert.equal(await readFile(sessionStatePath(cwd, sessionId), 'utf-8'), competingBytes);
        } finally {
          await rm(cwd, { recursive: true, force: true });
        }
      }
    } finally {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorNodeEnv;
      if (priorFailpoint === undefined) delete process.env.OMX_RALPLAN_ADVISORY_STARTUP_FAILPOINT; else process.env.OMX_RALPLAN_ADVISORY_STARTUP_FAILPOINT = priorFailpoint;
    }
  });

  it('returns completed only after a byte-bound tracker-backed lifecycle closes the durable fence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-advisory-runtime-'));
    const sessionId = 'sess-advisory-runtime';
    try {
      await mkdir(join(sessionStatePath(cwd, sessionId), '..'), { recursive: true });
      await writeSessionPointer(cwd, sessionId);
      await writeNativeSubagentTracking(cwd, sessionId, true);
      await mkdir(join(cwd, '.omx', 'artifacts'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'artifacts', 'architect.md'), 'APPROVE\n');
      await writeFile(join(cwd, '.omx', 'artifacts', 'critic.md'), 'APPROVE\n');
      const result = await runRalplanConsensus({
        async draft() {
          await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
          const planPath = join(cwd, '.omx', 'plans', 'advisory.md');
          await writeFile(planPath, '# approved plan\n');
          return { planPath, summary: 'draft' };
        },
        async architectReview() {
          return {
            verdict: 'approve', agent_role: 'architect', provenance_kind: 'native_subagent',
            session_id: sessionId, thread_id: 'thread-architect', artifact_path: '.omx/artifacts/architect.md',
          };
        },
        async criticReview() {
          return {
            verdict: 'approve', agent_role: 'critic', provenance_kind: 'native_subagent',
            session_id: sessionId, thread_id: 'thread-critic', artifact_path: '.omx/artifacts/critic.md',
          };
        },
      }, {
        task: 'produce advisory only', cwd, sessionId, maxIterations: 1, requireNativeSubagents: true,
        workflowVariant: 'advisory', advisoryProducer: 'native', advisoryThreadKind: 'root-or-drift', rootThreadId: 'thread-leader', activationTurnId: 'turn-a', closingTurnId: 'turn-a',
      });
      assert.equal(result.status, 'completed', result.error ?? 'advisory runtime did not complete');
      assert.equal(result.planningComplete, true);
      assert.equal(result.executionHandoffAuthorized, false);
      assert.equal(result.ralplanConsensusGate.complete, false);
      assert.equal(result.ralplanReviewLifecycle?.complete, true);
      const projection = await readCurrentRalplanAdvisory(cwd, sessionId);
      assert.equal(projection?.fence?.state, 'closed');
      assert.equal(projection?.journal?.phase, 'committed');
      const state = await readScopedRalplanState(cwd, sessionId);
      assert.equal(state.active, false);
      assert.equal(state.workflow_variant, 'advisory');
      assert.equal(state.execution_handoff_authorized, false);
      assert.equal(state.status_message, 'Status: advisory complete — local review lifecycle approved; control returned to the caller without an automatic execution handoff. Later user instructions follow normal host rules.');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed when the Architect artifact changes after Architect review', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-advisory-architect-baseline-'));
    const sessionId = 'sess-advisory-architect-baseline';
    try {
      const result = await runApprovedAdvisoryFixture(cwd, sessionId, async () => {
        await writeFile(join(cwd, '.omx', 'artifacts', 'architect.md'), 'MUTATED\n');
      });
      assert.equal(result.status, 'failed');
      assert.match(result.error ?? '', /review_artifact_baseline_mismatch/);
      const projection = await readCurrentRalplanAdvisory(cwd, sessionId);
      assert.notEqual(projection?.journal?.outcome, 'approved');
      assert.equal(projection?.journal?.integrity_status, 'proven');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closeout revalidation when the Critic artifact changes after lifecycle projection', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-advisory-critic-baseline-'));
    const sessionId = 'sess-advisory-critic-baseline';
    let projections = 0;
    try {
      __setRalplanAdvisoryLifecycleHooksForTests({
        beforeProjectLifecycle: async () => {
          projections += 1;
          if (projections === 2) {
            await writeFile(join(cwd, '.omx', 'artifacts', 'critic.md'), 'MUTATED\n');
          }
        },
      });
      await assert.rejects(
        runApprovedAdvisoryFixture(cwd, sessionId),
        /closeout_binding_mismatch/,
      );
      const projection = await readCurrentRalplanAdvisory(cwd, sessionId);
      assert.notEqual(projection?.fence?.state, 'closed');
      assert.notEqual(projection?.journal?.integrity_status, 'proven');
    } finally {
      __setRalplanAdvisoryLifecycleHooksForTests({});
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('recovers a stored approved journal in the runtime catch path', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-advisory-runtime-catch-'));
    const sessionId = 'sess-advisory-runtime-catch';
    const priorNodeEnv = process.env.NODE_ENV;
    const priorFailpoint = process.env.OMX_RALPLAN_ADVISORY_FAILPOINT;
    try {
      process.env.NODE_ENV = 'test';
      process.env.OMX_RALPLAN_ADVISORY_FAILPOINT = 'journal-prepare';
      await mkdir(join(sessionStatePath(cwd, sessionId), '..'), { recursive: true });
      await writeSessionPointer(cwd, sessionId);
      await writeNativeSubagentTracking(cwd, sessionId, true);
      await mkdir(join(cwd, '.omx', 'artifacts'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'artifacts', 'architect.md'), 'APPROVE\n');
      await writeFile(join(cwd, '.omx', 'artifacts', 'critic.md'), 'APPROVE\n');
      const result = await runRalplanConsensus({
        async draft() {
          await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
          const planPath = join(cwd, '.omx', 'plans', 'advisory.md');
          await writeFile(planPath, '# approved plan\n');
          return { planPath, summary: 'draft' };
        },
        async architectReview() {
          return { verdict: 'approve', agent_role: 'architect', provenance_kind: 'native_subagent', session_id: sessionId, thread_id: 'thread-architect', artifact_path: '.omx/artifacts/architect.md' };
        },
        async criticReview() {
          return { verdict: 'approve', agent_role: 'critic', provenance_kind: 'native_subagent', session_id: sessionId, thread_id: 'thread-critic', artifact_path: '.omx/artifacts/critic.md' };
        },
      }, {
        task: 'recover approved advisory', cwd, sessionId, maxIterations: 1, requireNativeSubagents: true,
        workflowVariant: 'advisory', advisoryProducer: 'native', advisoryThreadKind: 'root-or-drift', rootThreadId: 'thread-leader', activationTurnId: 'turn-a', closingTurnId: 'turn-a',
      });
      assert.equal(result.status, 'completed', result.error ?? 'runtime did not recover approved journal');
      const projection = await readCurrentRalplanAdvisory(cwd, sessionId);
      assert.equal(projection?.journal?.outcome, 'approved');
      assert.equal(projection?.fence?.state, 'closed');
      assert.equal(result.planningComplete, true);
    } finally {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorNodeEnv;
      if (priorFailpoint === undefined) delete process.env.OMX_RALPLAN_ADVISORY_FAILPOINT; else process.env.OMX_RALPLAN_ADVISORY_FAILPOINT = priorFailpoint;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed for every invalid catch recovery projection or binding', () => {
    const sessionId = 'sess-advisory-runtime-catch';
    const generationId = 'generation-a';
    const recovered = {
      fence: { state: 'closed' },
      journal: { outcome: 'approved' },
      corruption: null,
    };
    const binding = {
      mode: 'ralplan', session_id: sessionId, workflow_variant: 'advisory',
      advisory_generation_id: generationId, active: false,
    };
    assert.equal(isCompletedAdvisoryCatchRecovery(recovered, binding, sessionId, generationId), true);

    for (const corruption of [
      'closed_without_committed_journal', 'admin_event_invalid', 'rollover_pending_admin', 'live_session_binding_conflict',
    ]) {
      assert.equal(isCompletedAdvisoryCatchRecovery({ ...recovered, corruption }, binding, sessionId, generationId), false, corruption);
    }
    for (const invalidBinding of [
      null,
      { ...binding, active: true },
      { ...binding, session_id: 'other-session' },
      { ...binding, advisory_generation_id: 'other-generation' },
      { mode: 'ralplan', session_id: sessionId, workflow_variant: 'advisory', active: false },
    ]) {
      assert.equal(isCompletedAdvisoryCatchRecovery(recovered, invalidBinding, sessionId, generationId), false);
    }
  });

  it('quality gate verdict: blocking gate with "reject" verdict blocks consensus', () => {
    const architectReview: RalplanReviewResult = { verdict: 'approve', agent_role: 'architect' };
    const criticReview: RalplanReviewResult = { verdict: 'approve', agent_role: 'critic' };
    const gate = __buildRalplanConsensusGateForTests([architectReview], [criticReview], {
      iteration: 1,
      gateResults: [
        { skill: 'test-gate', iteration: 1, verdict: 'reject' as const, summary: 'blocked', mode: 'blocking' },
      ],
      qualityGatesComplete: true,
      nativeEvidenceComplete: true,
    });
    assert.equal(gate.complete, false, 'blocking gate with reject verdict should block consensus');
    assert.equal(gate.blocked_reason, 'quality_gate_not_approved:test-gate');
  });

  it('quality gate verdict: blocking gate with "iterate" verdict blocks consensus', () => {
    const architectReview: RalplanReviewResult = { verdict: 'approve', agent_role: 'architect' };
    const criticReview: RalplanReviewResult = { verdict: 'approve', agent_role: 'critic' };
    const gate = __buildRalplanConsensusGateForTests([architectReview], [criticReview], {
      iteration: 1,
      gateResults: [
        { skill: 'test-gate', iteration: 1, verdict: 'iterate' as const, summary: 'needs revision', mode: 'blocking' },
      ],
      qualityGatesComplete: true,
      nativeEvidenceComplete: true,
    });
    assert.equal(gate.complete, false, 'blocking gate with iterate verdict should block consensus');
    assert.equal(gate.blocked_reason, 'quality_gate_not_approved:test-gate');
  });

  it('quality gate verdict: blocking gate with "unavailable" verdict does NOT block consensus', () => {
    const architectReview: RalplanReviewResult = { verdict: 'approve', agent_role: 'architect' };
    const criticReview: RalplanReviewResult = { verdict: 'approve', agent_role: 'critic' };
    const gate = __buildRalplanConsensusGateForTests([architectReview], [criticReview], {
      iteration: 1,
      gateResults: [
        { skill: 'missing-skill', iteration: 1, verdict: 'unavailable', summary: 'skill not found', mode: 'blocking' },
      ],
      qualityGatesComplete: true,
      nativeEvidenceComplete: true,
    });
    assert.equal(gate.complete, true, 'blocking gate with unavailable verdict should NOT block consensus');
    assert.equal(gate.blocked_reason, null, 'unavailable verdict should not set a blocked reason');
  });
});
