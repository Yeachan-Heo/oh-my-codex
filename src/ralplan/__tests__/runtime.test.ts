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
import { cancelRalplanConsensus, runRalplanConsensus } from '../runtime.js';

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

async function writePlanningArtifacts(cwd: string, slug: string): Promise<string> {
  const plansDir = join(cwd, '.omx', 'plans');
  await mkdir(plansDir, { recursive: true });
  const prdPath = join(plansDir, `prd-${slug}.md`);
  await writeFile(prdPath, '# plan\n');
  await writeFile(join(plansDir, `test-spec-${slug}.md`), '# tests\n');
  return prdPath;
}

async function writeNativeSubagentTracking(
  cwd: string,
  sessionId: string,
): Promise<{ architectCompletedAt: string; criticCompletedAt: string }> {
  const architectCompletedAt = new Date(Date.now() + 1_000).toISOString();
  const criticStartedAt = new Date(Date.now() + 2_000).toISOString();
  const criticCompletedAt = new Date(Date.now() + 3_000).toISOString();
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
          },
        },
      },
    },
  }, null, 2));
  return { architectCompletedAt, criticCompletedAt };
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
    for (const key of ['OMX_ROOT', 'OMX_STATE_ROOT', 'OMX_TEAM_STATE_ROOT', 'OMX_SESSION_ID'] as const) {
      const value = savedOmxEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('rejects approval records that are not native subagent evidence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-'));
    const sessionId = 'sess-ralplan-success';
    try {
      await mkdir(join(sessionStatePath(cwd, sessionId), '..'), { recursive: true });
      await writeSessionPointer(cwd, sessionId);

      const seenPhases: string[] = [];
      const result = await runRalplanConsensus({
        async draft(ctx) {
          const state = await readScopedRalplanState(cwd, sessionId);
          seenPhases.push(String(state.current_phase));
          assert.equal(state.current_phase, 'draft');
          assert.equal(state.iteration, 1);

          const plansDir = join(cwd, '.omx', 'plans');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-success.md');
          await writeFile(prdPath, '# plan\n');
          await writeFile(join(plansDir, 'test-spec-success.md'), '# tests\n');
          return { summary: `draft-${ctx.iteration}`, planPath: prdPath, artifacts: { drafted: true } };
        },
        async architectReview() {
          const state = await readScopedRalplanState(cwd, sessionId);
          seenPhases.push(String(state.current_phase));
          assert.equal(state.current_phase, 'architect-review');
          assert.equal(state.iteration, 1);
          return {
            verdict: 'approve',
            summary: 'architect-ok',
            artifacts: { architected: true },
            agent_role: 'architect',
            thread_id: 'thread-architect',
          };
        },
        async criticReview() {
          const state = await readScopedRalplanState(cwd, sessionId);
          seenPhases.push(String(state.current_phase));
          assert.equal(state.current_phase, 'critic-review');
          assert.equal(state.iteration, 1);
          return { verdict: 'approve', summary: 'critic-ok', artifacts: { critiqued: true } };
        },
      }, { task: 'implement live ralplan runtime', cwd, maxIterations: 1 });

      assert.equal(result.status, 'failed');
      assert.equal(result.phase, 'failed');
      assert.equal(result.iteration, 1);
      assert.equal(result.planningComplete, false);
      assert.equal(result.error, 'ralplan_architect_review_provenance_invalid: expected provenance_kind=native_subagent');
      assert.deepEqual(seenPhases, ['draft', 'architect-review']);
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'ralplan-state.json')), false);
      assert.equal(existsSync(sessionStatePath(cwd, sessionId)), true);

      const finalState = await readModeState('ralplan', cwd);
      assert.equal(finalState?.active, false);
      assert.equal(finalState?.current_phase, 'failed');
      assert.equal(finalState?.iteration, 1);
      assert.equal(finalState?.planning_complete, false);
      assert.match(String(finalState?.status_message || ''), /encountered an error/);
      assert.equal(finalState?.latest_architect_verdict, undefined);
      assert.equal(finalState?.latest_critic_verdict, undefined);
      assert.equal((finalState?.ralplan_consensus_gate as { blocked_reason?: string } | undefined)?.blocked_reason, 'architect_review_missing_or_not_approved');
      assert.equal(Array.isArray(finalState?.review_history), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('completes an ordered native pair using runtime-stamped sequence indices', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-stamped-order-'));
    const sessionId = 'sess-ralplan-runtime-stamped-order';
    try {
      await writeSessionPointer(cwd, sessionId);
      const completion = await writeNativeSubagentTracking(cwd, sessionId);
      const result = await runRalplanConsensus({
        async draft() {
          return { planPath: await writePlanningArtifacts(cwd, 'runtime-stamped-order') };
        },
        async architectReview() {
          return {
            verdict: 'approve',
            agent_role: 'architect',
            provenance_kind: 'native_subagent',
            thread_id: 'thread-architect',
            completed_at: completion.architectCompletedAt,
          };
        },
        async criticReview() {
          return {
            verdict: 'approve',
            agent_role: 'critic',
            provenance_kind: 'native_subagent',
            thread_id: 'thread-critic',
            completed_at: completion.criticCompletedAt,
          };
        },
      }, { task: 'runtime stamps ordered reviews', cwd, sessionId, maxIterations: 1 });

      assert.equal(result.status, 'completed', result.error ?? JSON.stringify(result.ralplanConsensusGate));
      assert.equal(result.ralplanConsensusGate.complete, true);
      assert.equal(result.ralplanConsensusGate.authority_policy, 'local_owner_lifecycle');
      assert.equal(result.ralplanConsensusGate.ralplan_architect_review?.sequence_index, 1);
      assert.equal(result.ralplanConsensusGate.ralplan_critic_review?.sequence_index, 2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps an explicit session isolated from a different current-session pointer', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-explicit-session-'));
    const pointerSessionId = 'sess-ralplan-pointer';
    const explicitSessionId = 'sess-ralplan-explicit';
    try {
      await writeSessionPointer(cwd, pointerSessionId);
      const pointerState = {
        active: true,
        mode: 'ralplan',
        current_phase: 'pointer-sentinel',
        marker: 'must-remain-untouched',
      };
      await mkdir(join(sessionStatePath(cwd, pointerSessionId), '..'), { recursive: true });
      await writeFile(sessionStatePath(cwd, pointerSessionId), JSON.stringify(pointerState, null, 2));
      const completion = await writeNativeSubagentTracking(cwd, explicitSessionId);

      const result = await runRalplanConsensus({
        async draft() {
          const explicitState = await readScopedRalplanState(cwd, explicitSessionId);
          assert.equal(explicitState.current_phase, 'draft');
          return { planPath: await writePlanningArtifacts(cwd, 'explicit-session') };
        },
        async architectReview() {
          const explicitState = await readScopedRalplanState(cwd, explicitSessionId);
          assert.equal(explicitState.current_phase, 'architect-review');
          return {
            verdict: 'approve',
            agent_role: 'architect',
            provenance_kind: 'native_subagent',
            thread_id: 'thread-architect',
            completed_at: completion.architectCompletedAt,
          };
        },
        async criticReview() {
          const explicitState = await readScopedRalplanState(cwd, explicitSessionId);
          assert.equal(explicitState.current_phase, 'critic-review');
          return {
            verdict: 'approve',
            agent_role: 'critic',
            provenance_kind: 'native_subagent',
            thread_id: 'thread-critic',
            completed_at: completion.criticCompletedAt,
          };
        },
      }, {
        task: 'keep explicit session isolated',
        cwd,
        sessionId: explicitSessionId,
        maxIterations: 1,
      });

      assert.equal(result.status, 'completed', result.error ?? JSON.stringify(result.ralplanConsensusGate));
      const explicitFinalState = await readScopedRalplanState(cwd, explicitSessionId);
      assert.equal(explicitFinalState.current_phase, 'complete');
      assert.equal(explicitFinalState.active, false);
      assert.deepEqual(await readScopedRalplanState(cwd, pointerSessionId), pointerState);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps runtime-stamped review order monotonic when Architect iterates before approval', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-architect-iterate-order-'));
    const sessionId = 'sess-ralplan-architect-iterate-order';
    try {
      await mkdir(join(sessionStatePath(cwd, sessionId), '..'), { recursive: true });
      await writeSessionPointer(cwd, sessionId);
      const completion = await writeNativeSubagentTracking(cwd, sessionId);

      const result = await runRalplanConsensus({
        async draft() {
          return { planPath: await writePlanningArtifacts(cwd, 'architect-iterate-order') };
        },
        async architectReview(ctx) {
          return {
            verdict: ctx.iteration === 1 ? 'iterate' : 'approve',
            agent_role: 'architect',
            provenance_kind: 'native_subagent',
            thread_id: 'thread-architect',
            completed_at: completion.architectCompletedAt,
          };
        },
        async criticReview() {
          return {
            verdict: 'approve',
            agent_role: 'critic',
            provenance_kind: 'native_subagent',
            thread_id: 'thread-critic',
            completed_at: completion.criticCompletedAt,
          };
        },
      }, {
        task: 'runtime preserves review event order across iterations',
        cwd,
        sessionId,
        maxIterations: 2,
        requireNativeSubagents: true,
      });

      assert.equal(result.status, 'completed', result.error ?? JSON.stringify(result.ralplanConsensusGate));
      assert.deepEqual(result.architectReviews.map((review) => review.sequence_index), [1, 2]);
      assert.deepEqual(result.criticReviews.map((review) => review.sequence_index), [3]);
      assert.equal(result.ralplanConsensusGate.complete, true);
      assert.equal(result.ralplanConsensusGate.authority_policy, 'local_owner_lifecycle');
      assert.equal(result.ralplanConsensusGate.ralplan_architect_review?.sequence_index, 2);
      assert.equal(result.ralplanConsensusGate.ralplan_critic_review?.sequence_index, 3);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('blocks caller-supplied sequence indices that reverse Architect and Critic order', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-reversed-sequence-'));
    try {
      const result = await runRalplanConsensus({
        async draft() {
          return { planPath: await writePlanningArtifacts(cwd, 'reversed-sequence') };
        },
        async architectReview() {
          return {
            verdict: 'approve',
            agent_role: 'architect',
            provenance_kind: 'native_subagent',
            thread_id: 'thread-architect',
            sequence_index: 2,
          };
        },
        async criticReview() {
          return {
            verdict: 'approve',
            agent_role: 'critic',
            provenance_kind: 'native_subagent',
            thread_id: 'thread-critic',
            sequence_index: 1,
          };
        },
      }, { task: 'reject reversed sequence evidence', cwd, maxIterations: 1 });

      assert.equal(result.status, 'failed');
      assert.equal(result.ralplanConsensusGate.complete, false);
      assert.equal(result.ralplanConsensusGate.authority_policy, null);
      assert.equal(
        result.ralplanConsensusGate.blocked_reason,
        'missing_sequential_architect_then_critic_approval',
      );
      assert.equal(result.ralplanConsensusGate.ralplan_architect_review?.sequence_index, 2);
      assert.equal(result.ralplanConsensusGate.ralplan_critic_review?.sequence_index, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('blocks timestamp evidence that conflicts with Architect-then-Critic sequence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-reversed-timestamp-'));
    try {
      const result = await runRalplanConsensus({
        async draft() {
          return { planPath: await writePlanningArtifacts(cwd, 'reversed-timestamp') };
        },
        async architectReview() {
          return {
            verdict: 'approve',
            agent_role: 'architect',
            provenance_kind: 'native_subagent',
            thread_id: 'thread-architect',
            sequence_index: 1,
            completed_at: '2026-08-05T12:10:00.000Z',
          };
        },
        async criticReview() {
          return {
            verdict: 'approve',
            agent_role: 'critic',
            provenance_kind: 'native_subagent',
            thread_id: 'thread-critic',
            sequence_index: 2,
            completed_at: '2026-08-05T12:05:00.000Z',
          };
        },
      }, { task: 'reject conflicting timestamp evidence', cwd, maxIterations: 1 });

      assert.equal(result.status, 'failed');
      assert.equal(result.ralplanConsensusGate.complete, false);
      assert.equal(result.ralplanConsensusGate.authority_policy, null);
      assert.equal(
        result.ralplanConsensusGate.blocked_reason,
        'missing_sequential_architect_then_critic_approval',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('records planning-only terminal state when consensus approves without a selected execution lane', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-planning-only-'));
    const sessionId = 'sess-ralplan-runtime-planning-only';
    try {
      await writeSessionPointer(cwd, sessionId);
      const completion = await writeNativeSubagentTracking(cwd, sessionId);
      const result = await runRalplanConsensus({
        async draft() {
          return {
            summary: 'draft lifecycle evidence',
            planPath: await writePlanningArtifacts(cwd, 'planning-only'),
          };
        },
        async architectReview() {
          return {
            agent_role: 'architect',
            verdict: 'approve',
            provenance_kind: 'native_subagent',
            thread_id: 'thread-architect',
            sequence_index: 1,
            completed_at: completion.architectCompletedAt,
          };
        },
        async criticReview() {
          return {
            agent_role: 'critic',
            verdict: 'approve',
            provenance_kind: 'native_subagent',
            thread_id: 'thread-critic',
            sequence_index: 2,
            completed_at: completion.criticCompletedAt,
          };
        },
      }, {
        task: 'complete local-owner planning without execution handoff',
        cwd,
        sessionId,
        maxIterations: 1,
      });

      assert.equal(result.status, 'completed', result.error ?? JSON.stringify(result.ralplanConsensusGate));
      assert.equal(result.phase, 'complete');
      assert.equal(result.error, undefined);
      assert.equal(result.ralplanConsensusGate.complete, true);
      assert.equal(result.ralplanConsensusGate.blocked_reason, null);
      assert.equal(result.ralplanConsensusGate.ralplan_architect_review?.agent_role, 'architect');
      assert.equal(result.ralplanConsensusGate.ralplan_critic_review?.agent_role, 'critic');
      assert.equal(existsSync(getStatePath('ultragoal', cwd)), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not start execution handoff from local lifecycle approval', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-execution-handoff-'));
    const sessionId = 'sess-ralplan-runtime-execution-handoff';
    try {
      await writeSessionPointer(cwd, sessionId);
      const completion = await writeNativeSubagentTracking(cwd, sessionId);
      const result = await runRalplanConsensus({
        async draft() {
          const plansDir = join(cwd, '.omx', 'plans');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-handoff.md');
          await writeFile(prdPath, '# plan\n');
          await writeFile(join(plansDir, 'test-spec-handoff.md'), '# tests\n');
          return { summary: 'draft', planPath: prdPath };
        },
        async architectReview() {
          assert.equal(existsSync(getStatePath('ultragoal', cwd)), false);
          return {
            verdict: 'approve', summary: 'architect ok', agent_role: 'architect',
            provenance_kind: 'native_subagent', thread_id: 'thread-architect',
            completed_at: completion.architectCompletedAt,
          };
        },
        async criticReview() {
          assert.equal(existsSync(getStatePath('ultragoal', cwd)), false);
          return {
            verdict: 'approve', summary: 'critic ok', agent_role: 'critic',
            provenance_kind: 'native_subagent', thread_id: 'thread-critic',
            completed_at: completion.criticCompletedAt,
          };
        },
      }, { task: 'approval does not start ultragoal', cwd, sessionId, maxIterations: 1, selectedExecutionLane: 'ultragoal' });

      assert.equal(result.status, 'completed', result.error ?? JSON.stringify(result.ralplanConsensusGate));
      assert.equal(result.error, undefined);
      assert.equal(result.executionHandoffStarted, false);
      assert.equal(existsSync(getStatePath('ultragoal', cwd)), false);
      const finalState = await readModeState('ralplan', cwd);
      assert.equal(finalState?.handoff_artifacts, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('passes and enforces reusable Architect lane on re-review iterations', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-architect-reuse-'));
    const sessionId = 'sess-ralplan-runtime-architect-reuse';
    try {
      await writeSessionPointer(cwd, sessionId);
      const completion = await writeNativeSubagentTracking(cwd, sessionId);
      const architectThreads: Array<string | undefined> = [];
      const result = await runRalplanConsensus({
        async draft(ctx) {
          const plansDir = join(cwd, '.omx', 'plans');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-reuse.md');
          await writeFile(prdPath, '# plan\n');
          await writeFile(join(plansDir, 'test-spec-reuse.md'), '# tests\n');
          return { summary: `draft-${ctx.iteration}`, planPath: prdPath };
        },
        async architectReview(ctx) {
          architectThreads.push(ctx.reusableRoleLanes.architect?.thread_id);
          return {
            verdict: 'approve',
            summary: `architect-${ctx.iteration}`,
            agent_role: 'architect',
            provenance_kind: 'native_subagent',
            thread_id: ctx.reusableRoleLanes.architect?.thread_id ?? 'thread-architect',
            completed_at: completion.architectCompletedAt,
          };
        },
        async criticReview(ctx) {
          return {
            verdict: ctx.iteration === 1 ? 'iterate' : 'approve',
            summary: `critic-${ctx.iteration}`,
            agent_role: 'critic',
            provenance_kind: 'native_subagent',
            thread_id: 'thread-critic',
            completed_at: completion.criticCompletedAt,
          };
        },
      }, { task: 'reuse architect lane', cwd, sessionId, maxIterations: 3 });

      assert.equal(result.status, 'completed', result.error ?? JSON.stringify(result.ralplanConsensusGate));
      assert.deepEqual(architectThreads, [undefined, 'thread-architect']);
      assert.deepEqual(result.architectReviews.map((review) => review.thread_id), ['thread-architect', 'thread-architect']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed when a re-review Architect pass spawns a fresh lane without a new-lane reason', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-architect-reuse-deny-'));
    const sessionId = 'sess-ralplan-runtime-architect-reuse-deny';
    try {
      await writeSessionPointer(cwd, sessionId);
      await writeNativeSubagentTracking(cwd, sessionId);
      const result = await runRalplanConsensus({
        async draft(ctx) {
          const plansDir = join(cwd, '.omx', 'plans');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-reuse-deny.md');
          await writeFile(prdPath, '# plan\n');
          await writeFile(join(plansDir, 'test-spec-reuse-deny.md'), '# tests\n');
          return { summary: `draft-${ctx.iteration}`, planPath: prdPath };
        },
        async architectReview(ctx) {
          return {
            verdict: 'approve',
            summary: `architect-${ctx.iteration}`,
            agent_role: 'architect',
            provenance_kind: 'native_subagent',
            thread_id: ctx.iteration === 1 ? 'thread-architect-1' : 'thread-architect-2',
          };
        },
        async criticReview(ctx) {
          return {
            verdict: ctx.iteration === 1 ? 'iterate' : 'approve',
            summary: `critic-${ctx.iteration}`,
            agent_role: 'critic',
            provenance_kind: 'native_subagent',
            thread_id: 'thread-critic',
          };
        },
      }, { task: 'reject fresh architect lane', cwd, sessionId, maxIterations: 3 });

      assert.equal(result.status, 'failed');
      assert.match(result.error || '', /ralplan_architect_lane_reuse_required/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails Autopilot-required consensus when approvals lack native subagent provenance', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-native-required-missing-'));
    const sessionId = 'sess-ralplan-native-required-missing';
    try {
      await mkdir(join(sessionStatePath(cwd, sessionId), '..'), { recursive: true });
      await writeSessionPointer(cwd, sessionId);

      const result = await runRalplanConsensus({
        async draft() {
          const plansDir = join(cwd, '.omx', 'plans');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-native-missing.md');
          await writeFile(prdPath, '# plan\n');
          await writeFile(join(plansDir, 'test-spec-native-missing.md'), '# tests\n');
          return { summary: 'draft', planPath: prdPath };
        },
        async architectReview() {
          return { verdict: 'approve', summary: 'artifact-only architect ok' };
        },
        async criticReview() {
          return { verdict: 'approve', summary: 'artifact-only critic ok' };
        },
      }, {
        task: 'require native reviews',
        cwd,
        sessionId,
        maxIterations: 1,
        requireNativeSubagents: true,
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.ralplanConsensusGate.complete, false);
      assert.equal(result.ralplanConsensusGate.blocked_reason, 'architect_review_missing_or_not_approved');
      assert.match(result.error || '', /ralplan_architect_review_role_missing/);
      assert.equal(result.architectReviews.length, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects planner-as-architect review role when native evidence is required', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-planner-as-architect-'));
    const sessionId = 'sess-ralplan-planner-as-architect';
    try {
      await mkdir(join(sessionStatePath(cwd, sessionId), '..'), { recursive: true });
      await writeSessionPointer(cwd, sessionId);

      const result = await runRalplanConsensus({
        async draft() {
          const plansDir = join(cwd, '.omx', 'plans');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-planner-as-architect.md');
          await writeFile(prdPath, '# plan\n');
          await writeFile(join(plansDir, 'test-spec-planner-as-architect.md'), '# tests\n');
          return { summary: 'draft', planPath: prdPath };
        },
        async architectReview() {
          return {
            verdict: 'approve',
            summary: 'planner incorrectly reported as architect',
            provenance_kind: 'native_subagent',
            session_id: sessionId,
            thread_id: 'thread-architect',
            agent_role: 'planner' as never,
          };
        },
        async criticReview() {
          return { verdict: 'approve', summary: 'should not run', agent_role: 'critic' };
        },
      }, {
        task: 'reject planner-as-architect native review',
        cwd,
        sessionId,
        maxIterations: 1,
        requireNativeSubagents: true,
      });

      assert.equal(result.status, 'failed');
      assert.match(result.error || '', /ralplan_architect_review_role_mismatch/);
      assert.equal(result.architectReviews.length, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects native/thread-backed missing-role reviews instead of rewriting them into consensus roles', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-native-missing-role-'));
    const sessionId = 'sess-ralplan-native-missing-role';
    try {
      await mkdir(join(sessionStatePath(cwd, sessionId), '..'), { recursive: true });
      await writeSessionPointer(cwd, sessionId);
      await writeNativeSubagentTracking(cwd, sessionId);

      const result = await runRalplanConsensus({
        async draft() {
          const plansDir = join(cwd, '.omx', 'plans');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-native-missing-role.md');
          await writeFile(prdPath, '# plan\n');
          await writeFile(join(plansDir, 'test-spec-native-missing-role.md'), '# tests\n');
          return { summary: 'draft', planPath: prdPath };
        },
        async architectReview() {
          return {
            verdict: 'approve',
            summary: 'native architect omitted role',
            provenance_kind: 'native_subagent',
            session_id: sessionId,
            thread_id: 'thread-architect',
            tracker_path: '.omx/state/subagent-tracking.json',
          };
        },
        async criticReview() {
          return {
            verdict: 'approve',
            summary: 'native critic ok',
            provenance_kind: 'native_subagent',
            session_id: sessionId,
            thread_id: 'thread-critic',
            agent_role: 'critic',
            tracker_path: '.omx/state/subagent-tracking.json',
          };
        },
      }, {
        task: 'reject native missing-role review',
        cwd,
        sessionId,
        maxIterations: 1,
        requireNativeSubagents: true,
      });

      assert.equal(result.status, 'failed');
      assert.match(result.error || '', /ralplan_architect_review_role_missing/);
      assert.equal(result.architectReviews.length, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not relabel completed non-review tracker threads from review payloads', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-no-authority-relabel-'));
    const sessionId = 'sess-ralplan-no-authority-relabel';
    try {
      await writeSessionPointer(cwd, sessionId);
      const completion = await writeNativeSubagentTracking(cwd, sessionId);
      const trackingPath = subagentTrackingPath(cwd);
      const tracking = JSON.parse(await readFile(trackingPath, 'utf-8')) as {
        sessions: Record<string, { threads: Record<string, Record<string, unknown>> }>;
      };
      tracking.sessions[sessionId].threads['thread-architect'] = {
        ...tracking.sessions[sessionId].threads['thread-architect'],
        role: 'executor',
        mode: 'executor',
      };
      tracking.sessions[sessionId].threads['thread-critic'] = {
        ...tracking.sessions[sessionId].threads['thread-critic'],
        role: 'planner',
        mode: 'planner',
      };
      await writeFile(trackingPath, JSON.stringify(tracking, null, 2));

      const result = await runRalplanConsensus({
        async draft() {
          return { planPath: await writePlanningArtifacts(cwd, 'no-authority-relabel') };
        },
        async architectReview() {
          return {
            verdict: 'approve',
            agent_role: 'architect',
            provenance_kind: 'native_subagent',
            thread_id: 'thread-architect',
            completed_at: completion.architectCompletedAt,
          };
        },
        async criticReview() {
          return {
            verdict: 'approve',
            agent_role: 'critic',
            provenance_kind: 'native_subagent',
            thread_id: 'thread-critic',
            completed_at: completion.criticCompletedAt,
          };
        },
      }, {
        task: 'review payload cannot mint tracker authority',
        cwd,
        sessionId,
        maxIterations: 1,
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.ralplanConsensusGate.complete, false);
      assert.equal(result.ralplanConsensusGate.authority_policy, null);
      const finalTracking = JSON.parse(await readFile(trackingPath, 'utf-8')) as {
        sessions: Record<string, {
          threads: Record<string, {
            role?: string;
            mode?: string;
            provenance_kind?: string;
            completed_at?: string;
          }>;
        }>;
      };
      assert.deepEqual(
        {
          role: finalTracking.sessions[sessionId].threads['thread-architect'].role,
          mode: finalTracking.sessions[sessionId].threads['thread-architect'].mode,
          provenance_kind: finalTracking.sessions[sessionId].threads['thread-architect'].provenance_kind,
          completed_at: finalTracking.sessions[sessionId].threads['thread-architect'].completed_at,
        },
        {
          role: 'executor',
          mode: 'executor',
          provenance_kind: 'native_subagent',
          completed_at: completion.architectCompletedAt,
        },
      );
      assert.deepEqual(
        {
          role: finalTracking.sessions[sessionId].threads['thread-critic'].role,
          mode: finalTracking.sessions[sessionId].threads['thread-critic'].mode,
          provenance_kind: finalTracking.sessions[sessionId].threads['thread-critic'].provenance_kind,
          completed_at: finalTracking.sessions[sessionId].threads['thread-critic'].completed_at,
        },
        {
          role: 'planner',
          mode: 'planner',
          provenance_kind: 'native_subagent',
          completed_at: completion.criticCompletedAt,
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not relabel or recomplete reused non-review threads through two draft iterations', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-no-draft-authority-relabel-'));
    const sessionId = 'sess-ralplan-no-draft-authority-relabel';
    try {
      await writeSessionPointer(cwd, sessionId);
      const completion = await writeNativeSubagentTracking(cwd, sessionId);
      const trackingPath = subagentTrackingPath(cwd);
      const tracking = JSON.parse(await readFile(trackingPath, 'utf-8')) as {
        sessions: Record<string, { threads: Record<string, Record<string, unknown>> }>;
      };
      tracking.sessions[sessionId].threads['thread-architect'] = {
        ...tracking.sessions[sessionId].threads['thread-architect'],
        role: 'executor',
        mode: 'executor',
      };
      tracking.sessions[sessionId].threads['thread-critic'] = {
        ...tracking.sessions[sessionId].threads['thread-critic'],
        role: 'planner',
        mode: 'planner',
      };
      await writeFile(trackingPath, JSON.stringify(tracking, null, 2));

      const result = await runRalplanConsensus({
        async draft(ctx) {
          return {
            planPath: await writePlanningArtifacts(cwd, `no-draft-authority-relabel-${ctx.iteration}`),
            thread_id: ctx.iteration === 1 ? 'thread-architect' : 'thread-critic',
            agent_role: ctx.iteration === 1 ? 'architect' : 'critic',
          };
        },
        async architectReview(ctx) {
          return {
            verdict: ctx.iteration === 1 ? 'iterate' : 'approve',
            agent_role: 'architect',
            provenance_kind: 'native_subagent',
            thread_id: 'thread-architect',
          };
        },
        async criticReview() {
          return {
            verdict: 'approve',
            agent_role: 'critic',
            provenance_kind: 'native_subagent',
            thread_id: 'thread-critic',
          };
        },
      }, {
        task: 'draft payload cannot mint tracker authority',
        cwd,
        sessionId,
        maxIterations: 2,
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.iteration, 2);
      assert.equal(result.ralplanConsensusGate.complete, false);
      assert.equal(result.ralplanConsensusGate.authority_policy, null);
      const finalTracking = JSON.parse(await readFile(trackingPath, 'utf-8')) as {
        sessions: Record<string, {
          threads: Record<string, {
            role?: string;
            mode?: string;
            provenance_kind?: string;
            completed_at?: string;
          }>;
        }>;
      };
      assert.deepEqual(
        {
          role: finalTracking.sessions[sessionId].threads['thread-architect'].role,
          mode: finalTracking.sessions[sessionId].threads['thread-architect'].mode,
          provenance_kind: finalTracking.sessions[sessionId].threads['thread-architect'].provenance_kind,
          completed_at: finalTracking.sessions[sessionId].threads['thread-architect'].completed_at,
        },
        {
          role: 'executor',
          mode: 'executor',
          provenance_kind: 'native_subagent',
          completed_at: completion.architectCompletedAt,
        },
      );
      assert.deepEqual(
        {
          role: finalTracking.sessions[sessionId].threads['thread-critic'].role,
          mode: finalTracking.sessions[sessionId].threads['thread-critic'].mode,
          provenance_kind: finalTracking.sessions[sessionId].threads['thread-critic'].provenance_kind,
          completed_at: finalTracking.sessions[sessionId].threads['thread-critic'].completed_at,
        },
        {
          role: 'planner',
          mode: 'planner',
          provenance_kind: 'native_subagent',
          completed_at: completion.criticCompletedAt,
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves existing tracker completion for review threads without native-required mode', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-preserve-completion-'));
    const sessionId = 'sess-ralplan-preserve-completion';
    try {
      await mkdir(join(sessionStatePath(cwd, sessionId), '..'), { recursive: true });
      await writeSessionPointer(cwd, sessionId);
      const completion = await writeNativeSubagentTracking(cwd, sessionId);

      const result = await runRalplanConsensus({
        async draft() {
          const plansDir = join(cwd, '.omx', 'plans');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-preserve-completion.md');
          await writeFile(prdPath, '# plan\n');
          await writeFile(join(plansDir, 'test-spec-preserve-completion.md'), '# tests\n');
          return { summary: 'draft', planPath: prdPath };
        },
        async architectReview() {
          return {
            verdict: 'approve',
            summary: 'architect ok',
            provenance_kind: 'native_subagent',
            thread_id: 'thread-architect',
            agent_role: 'architect',
            completed_at: completion.architectCompletedAt,
          };
        },
        async criticReview() {
          return {
            verdict: 'approve',
            summary: 'critic ok',
            provenance_kind: 'native_subagent',
            thread_id: 'thread-critic',
            agent_role: 'critic',
            completed_at: completion.criticCompletedAt,
          };
        },
      }, {
        task: 'preserve existing review completion evidence',
        cwd,
        sessionId,
        maxIterations: 1,
      });

      assert.equal(result.status, 'completed', result.error ?? JSON.stringify(result.ralplanConsensusGate));
      assert.equal(result.error, undefined);
      const tracking = JSON.parse(await readFile(subagentTrackingPath(cwd), 'utf-8')) as {
        sessions?: Record<string, { threads?: Record<string, { completed_at?: string }> }>;
      };
      assert.equal(tracking.sessions?.[sessionId]?.threads?.['thread-architect']?.completed_at, completion.architectCompletedAt);
      assert.equal(tracking.sessions?.[sessionId]?.threads?.['thread-critic']?.completed_at, completion.criticCompletedAt);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not fabricate native tracker completion from approved review bookkeeping alone', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-native-bookkeeping-only-'));
    const sessionId = 'sess-ralplan-native-bookkeeping-only';
    try {
      await mkdir(join(sessionStatePath(cwd, sessionId), '..'), { recursive: true });
      await writeSessionPointer(cwd, sessionId);

      const result = await runRalplanConsensus({
        async draft() {
          const plansDir = join(cwd, '.omx', 'plans');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-native-bookkeeping-only.md');
          await writeFile(prdPath, '# plan\n');
          await writeFile(join(plansDir, 'test-spec-native-bookkeeping-only.md'), '# tests\n');
          return { summary: 'draft', planPath: prdPath };
        },
        async architectReview() {
          return {
            verdict: 'approve',
            summary: 'native architect ok',
            provenance_kind: 'native_subagent',
            session_id: sessionId,
            thread_id: 'thread-architect',
            artifact_path: '.omx/artifacts/architect.md',
            agent_role: 'architect',
            tracker_path: '.omx/state/subagent-tracking.json',
          };
        },
        async criticReview() {
          return {
            verdict: 'approve',
            summary: 'native critic ok',
            provenance_kind: 'native_subagent',
            session_id: sessionId,
            thread_id: 'thread-critic',
            artifact_path: '.omx/artifacts/critic.md',
            agent_role: 'critic',
            tracker_path: '.omx/state/subagent-tracking.json',
          };
        },
      }, {
        task: 'require native reviews without fabricated completion',
        cwd,
        sessionId,
        maxIterations: 1,
        requireNativeSubagents: true,
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.ralplanConsensusGate.complete, false);
      assert.equal(result.ralplanConsensusGate.blocked_reason, 'native_subagent_consensus_evidence_missing');
      assert.equal(result.error, 'ralplan_consensus_not_reached_after_1_iterations');

      const tracking = JSON.parse(await readFile(subagentTrackingPath(cwd), 'utf-8')) as {
        sessions?: Record<string, {
          threads?: Record<string, { completed_at?: string }>;
        }>;
      };
      assert.equal(tracking.sessions?.[sessionId]?.threads?.['thread-architect']?.completed_at, undefined);
      assert.equal(tracking.sessions?.[sessionId]?.threads?.['thread-critic']?.completed_at, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('accepts Autopilot-required consensus with tracker-backed native architect and critic lanes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-native-required-ok-'));
    const sessionId = 'sess-ralplan-native-required-ok';
    try {
      await mkdir(join(sessionStatePath(cwd, sessionId), '..'), { recursive: true });
      await writeSessionPointer(cwd, sessionId);
      const completion = await writeNativeSubagentTracking(cwd, sessionId);

      const result = await runRalplanConsensus({
        async draft() {
          const plansDir = join(cwd, '.omx', 'plans');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-native-ok.md');
          await writeFile(prdPath, '# plan\n');
          await writeFile(join(plansDir, 'test-spec-native-ok.md'), '# tests\n');
          return { summary: 'draft', planPath: prdPath };
        },
        async architectReview() {
          return {
            verdict: 'approve',
            summary: 'native architect ok',
            provenance_kind: 'native_subagent',
            session_id: sessionId,
            thread_id: 'thread-architect',
            artifact_path: '.omx/artifacts/architect.md',
            agent_role: 'architect',
            tracker_path: '.omx/state/subagent-tracking.json',
            completed_at: completion.architectCompletedAt,
          };
        },
        async criticReview() {
          return {
            verdict: 'approve',
            summary: 'native critic ok',
            provenance_kind: 'native_subagent',
            session_id: sessionId,
            thread_id: 'thread-critic',
            artifact_path: '.omx/artifacts/critic.md',
            agent_role: 'critic',
            tracker_path: '.omx/state/subagent-tracking.json',
            completed_at: completion.criticCompletedAt,
          };
        },
      }, {
        task: 'require native reviews',
        cwd,
        sessionId,
        maxIterations: 1,
        requireNativeSubagents: true,
      });

      assert.equal(result.status, 'completed', result.error ?? JSON.stringify(result.ralplanConsensusGate));
      assert.equal(result.phase, 'complete');
      assert.equal(result.planningComplete, true);
      assert.equal(result.ralplanConsensusGate.complete, true);
      assert.equal(result.ralplanConsensusGate.authority_policy, 'local_owner_lifecycle');
      assert.equal(result.ralplanConsensusGate.blocked_reason, null);
      assert.equal(result.ralplanConsensusGate.ralplan_architect_review?.thread_id, 'thread-architect');
      assert.equal(result.ralplanConsensusGate.ralplan_critic_review?.thread_id, 'thread-critic');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('rejects Autopilot-required consensus with legacy OMX-adapted Architect and Critic lanes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-adapted-required-ok-'));
    const sessionId = 'sess-ralplan-adapted-required-ok';
    try {
      await mkdir(join(sessionStatePath(cwd, sessionId), '..'), { recursive: true });
      await writeSessionPointer(cwd, sessionId);
      const completion = await writeNativeSubagentTracking(cwd, sessionId);
      await writeAdaptedSubagentTracking(cwd, sessionId);

      const result = await runRalplanConsensus({
        async draft() {
          const plansDir = join(cwd, '.omx', 'plans');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-adapted-ok.md');
          await writeFile(prdPath, '# plan\n');
          await writeFile(join(plansDir, 'test-spec-adapted-ok.md'), '# tests\n');
          return { summary: 'draft', planPath: prdPath };
        },
        async architectReview() {
          return {
            verdict: 'approve',
            summary: 'adapted architect ok',
            provenance_kind: 'omx_adapted' as never,
            session_id: sessionId,
            thread_id: 'thread-architect',
            artifact_path: '.omx/artifacts/architect.md',
            agent_role: 'architect',
            tracker_path: '.omx/state/subagent-tracking.json',
          };
        },
        async criticReview() {
          return {
            verdict: 'approve',
            summary: 'adapted critic ok',
            provenance_kind: 'omx_adapted' as never,
            session_id: sessionId,
            thread_id: 'thread-critic',
            artifact_path: '.omx/artifacts/critic.md',
            agent_role: 'critic',
            tracker_path: '.omx/state/subagent-tracking.json',
          };
        },
      }, {
        task: 'require adapted reviews',
        cwd,
        sessionId,
        maxIterations: 1,
        requireNativeSubagents: true,
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.ralplanConsensusGate.complete, false);
      assert.equal(result.ralplanConsensusGate.blocked_reason, 'architect_review_missing_or_not_approved');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails Autopilot-required consensus when native reviews reuse one subagent thread', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-native-same-thread-'));
    const sessionId = 'sess-ralplan-native-same-thread';
    try {
      await mkdir(join(sessionStatePath(cwd, sessionId), '..'), { recursive: true });
      await writeSessionPointer(cwd, sessionId);
      await writeNativeSubagentTracking(cwd, sessionId);

      const result = await runRalplanConsensus({
        async draft() {
          const plansDir = join(cwd, '.omx', 'plans');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-native-same-thread.md');
          await writeFile(prdPath, '# plan\n');
          await writeFile(join(plansDir, 'test-spec-native-same-thread.md'), '# tests\n');
          return { summary: 'draft', planPath: prdPath };
        },
        async architectReview() {
          return {
            verdict: 'approve',
            summary: 'native architect ok',
            provenance_kind: 'native_subagent',
            session_id: sessionId,
            thread_id: 'thread-architect',
            artifact_path: '.omx/artifacts/architect.md',
            agent_role: 'architect',
            tracker_path: '.omx/state/subagent-tracking.json',
          };
        },
        async criticReview() {
          return {
            verdict: 'approve',
            summary: 'native critic reuses architect thread',
            provenance_kind: 'native_subagent',
            session_id: sessionId,
            thread_id: 'thread-architect',
            artifact_path: '.omx/artifacts/critic.md',
            agent_role: 'critic',
            tracker_path: '.omx/state/subagent-tracking.json',
          };
        },
      }, {
        task: 'require distinct native reviews',
        cwd,
        sessionId,
        maxIterations: 1,
        requireNativeSubagents: true,
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.ralplanConsensusGate.complete, false);
      assert.equal(result.ralplanConsensusGate.blocked_reason, 'native_subagent_consensus_evidence_missing');
      assert.equal(result.error, 'ralplan_consensus_not_reached_after_1_iterations');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not complete or call Critic when Architect has not approved', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-architect-reject-'));
    const sessionId = 'sess-ralplan-architect-reject';
    try {
      await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
      await writeSessionPointer(cwd, sessionId);
      await writeNativeSubagentTracking(cwd, sessionId);

      let criticCalls = 0;
      const result = await runRalplanConsensus({
        async draft() {
          const plansDir = join(cwd, '.omx', 'plans');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-reject.md');
          await writeFile(prdPath, '# plan\n');
          await writeFile(join(plansDir, 'test-spec-reject.md'), '# tests\n');
          return { summary: 'draft', planPath: prdPath };
        },
        async architectReview() {
          return {
            verdict: 'iterate',
            summary: 'architect needs changes',
            agent_role: 'architect',
            provenance_kind: 'native_subagent',
            thread_id: 'thread-architect',
          };
        },
        async criticReview() {
          criticCalls += 1;
          return { verdict: 'approve', summary: 'should not run' };
        },
      }, { task: 'reject before critic', cwd, sessionId, maxIterations: 1 });

      assert.equal(result.status, 'failed');
      assert.equal(criticCalls, 0);
      assert.equal(result.ralplanConsensusGate.complete, false);
      assert.equal(result.ralplanConsensusGate.blocked_reason, 'architect_review_missing_or_not_approved');

      const finalState = await readModeState('ralplan', cwd);
      assert.equal(finalState?.current_phase, 'failed');
      assert.equal((finalState?.ralplan_consensus_gate as { complete?: boolean } | undefined)?.complete, false);
      assert.equal(
        (finalState?.ralplan_consensus_gate as { ralplan_architect_review?: { agent_role?: string } } | undefined)?.ralplan_architect_review?.agent_role,
        'architect',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('increments iteration when critic requests a re-review loop', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-loop-'));
    const sessionId = 'sess-ralplan-loop';
    try {
      await mkdir(join(sessionStatePath(cwd, sessionId), '..'), { recursive: true });
      await writeSessionPointer(cwd, sessionId);
      const completion = await writeNativeSubagentTracking(cwd, sessionId);

      const draftIterations: number[] = [];
      const criticVerdicts: string[] = [];
      let criticCalls = 0;

      const result = await runRalplanConsensus({
        async draft(ctx) {
          const state = await readScopedRalplanState(cwd, sessionId);
          draftIterations.push(Number(state.iteration));
          assert.equal(state.current_phase, 'draft');

          const plansDir = join(cwd, '.omx', 'plans');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-loop.md');
          await writeFile(prdPath, '# loop plan\n');
          await writeFile(join(plansDir, 'test-spec-loop.md'), '# loop tests\n');
          return { summary: `draft-${ctx.iteration}`, planPath: prdPath };
        },
        async architectReview(ctx) {
          const state = await readScopedRalplanState(cwd, sessionId);
          assert.equal(state.current_phase, 'architect-review');
          return {
            verdict: 'approve',
            summary: `architect-${ctx.iteration}`,
            agent_role: 'architect',
            provenance_kind: 'native_subagent',
            thread_id: 'thread-architect',
            completed_at: completion.architectCompletedAt,
          };
        },
        async criticReview(ctx) {
          const state = await readScopedRalplanState(cwd, sessionId);
          assert.equal(state.current_phase, 'critic-review');
          criticCalls += 1;
          const verdict = criticCalls === 1 ? 'iterate' : 'approve';
          criticVerdicts.push(verdict);
          return {
            verdict,
            summary: `critic-${ctx.iteration}-${verdict}`,
            agent_role: 'critic',
            provenance_kind: 'native_subagent',
            thread_id: 'thread-critic',
            completed_at: completion.criticCompletedAt,
          };
        },
      }, { task: 'loop until approval', cwd, sessionId, maxIterations: 3 });

      assert.equal(result.status, 'completed', result.error ?? JSON.stringify(result.ralplanConsensusGate));
      assert.equal(result.iteration, 2);
      assert.equal(result.error, undefined);
      assert.deepEqual(draftIterations, [1, 2]);
      assert.deepEqual(criticVerdicts, ['iterate', 'approve']);

      const finalState = await readModeState('ralplan', cwd);
      assert.equal(finalState?.current_phase, 'complete');
      assert.equal(finalState?.iteration, 2);
      assert.equal((finalState?.review_history as Array<unknown>).length, 2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not complete when critic approves after an architect rejection', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-architect-reject-'));
    const sessionId = 'sess-ralplan-architect-reject';
    try {
      await mkdir(join(sessionStatePath(cwd, sessionId), '..'), { recursive: true });
      await writeSessionPointer(cwd, sessionId);
      await writeNativeSubagentTracking(cwd, sessionId);
      const plansDir = join(cwd, '.omx', 'plans');
      await mkdir(plansDir, { recursive: true });
      await writeFile(join(plansDir, 'prd-reject.md'), '# plan\n');
      await writeFile(join(plansDir, 'test-spec-reject.md'), '# tests\n');

      const result = await runRalplanConsensus({
        async draft() {
          return { summary: 'draft' };
        },
        async architectReview() {
          return { verdict: 'reject', summary: 'architect rejects' };
        },
        async criticReview() {
          return { verdict: 'approve', summary: 'critic approves malformed flow' };
        },
      }, { task: 'reject then approve must fail', cwd, maxIterations: 1 });

      assert.equal(result.status, 'failed');
      assert.equal(result.phase, 'failed');
      assert.equal(result.planningComplete, false);
      const finalState = await readModeState('ralplan', cwd);
      assert.equal(finalState?.current_phase, 'failed');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed when consensus approves with a mismatched stale test spec', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-mismatched-artifacts-'));
    const sessionId = 'sess-ralplan-mismatched-artifacts';
    try {
      await mkdir(join(sessionStatePath(cwd, sessionId), '..'), { recursive: true });
      await writeSessionPointer(cwd, sessionId);
      await writeNativeSubagentTracking(cwd, sessionId);

      const result = await runRalplanConsensus({
        async draft() {
          const plansDir = join(cwd, '.omx', 'plans');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-new.md');
          await writeFile(prdPath, '# new plan\n');
          await writeFile(join(plansDir, 'test-spec-old.md'), '# old tests\n');
          return { summary: 'draft mismatched artifacts', planPath: prdPath };
        },
        async architectReview() {
          return {
            verdict: 'approve', summary: 'architect ok', agent_role: 'architect',
            provenance_kind: 'native_subagent', thread_id: 'thread-architect',
          };
        },
        async criticReview() {
          return {
            verdict: 'approve', summary: 'critic ok', agent_role: 'critic',
            provenance_kind: 'native_subagent', thread_id: 'thread-critic',
          };
        },
      }, { task: 'approve with mismatched artifacts', cwd, sessionId, maxIterations: 1 });

      assert.equal(result.status, 'failed');
      assert.equal(result.phase, 'failed');
      assert.equal(result.planningComplete, false);
      assert.equal(result.error, 'ralplan_planning_artifacts_missing_after_consensus');
      assert.equal(result.ralplanConsensusGate.complete, true);
      assert.equal(result.ralplanConsensusGate.authority_policy, 'local_owner_lifecycle');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed when consensus approves without required planning artifacts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-no-artifacts-'));
    const sessionId = 'sess-ralplan-no-artifacts';
    try {
      await mkdir(join(sessionStatePath(cwd, sessionId), '..'), { recursive: true });
      await writeSessionPointer(cwd, sessionId);
      await writeNativeSubagentTracking(cwd, sessionId);

      const result = await runRalplanConsensus({
        async draft() {
          return { summary: 'draft without prd/test spec' };
        },
        async architectReview() {
          return {
            verdict: 'approve', summary: 'architect ok', agent_role: 'architect',
            provenance_kind: 'native_subagent', thread_id: 'thread-architect',
          };
        },
        async criticReview() {
          return {
            verdict: 'approve', summary: 'critic ok', agent_role: 'critic',
            provenance_kind: 'native_subagent', thread_id: 'thread-critic',
          };
        },
      }, { task: 'approve without artifacts', cwd, sessionId, maxIterations: 1 });

      assert.equal(result.status, 'failed');
      assert.equal(result.phase, 'failed');
      assert.equal(result.planningComplete, false);
      assert.equal(result.error, 'ralplan_planning_artifacts_missing_after_consensus');
      assert.equal(result.ralplanConsensusGate.complete, true);
      assert.equal(result.ralplanConsensusGate.authority_policy, 'local_owner_lifecycle');

      const finalState = await readModeState('ralplan', cwd);
      assert.equal(finalState?.current_phase, 'failed');
      assert.equal(finalState?.planning_complete, false);
      assert.equal(finalState?.error, 'ralplan_planning_artifacts_missing_after_consensus');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
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

      const finalState = await readModeState('ralplan', cwd);
      assert.equal(finalState?.active, false);
      assert.equal(finalState?.current_phase, 'failed');
      assert.match(String(finalState?.status_message || ''), /Status: failed/);
      assert.match(String(finalState?.error || ''), /architect blew up/);
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

      await startMode('ralplan', 'cancel me', 2, cwd);
      await cancelRalplanConsensus(cwd);

      const finalState = await readModeState('ralplan', cwd);
      assert.equal(finalState?.active, false);
      assert.equal(finalState?.current_phase, 'cancelled');
      assert.ok(typeof finalState?.completed_at === 'string' && finalState.completed_at.length > 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
