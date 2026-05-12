import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendTeamEvent, claimTask, createTask, initTeamState, transitionTaskStatus } from '../../team/state.js';
import {
  ingestRunningTeamAdapterEvidence,
  initializeRunningTeamAdapterState,
  readRunningTeamAdapterState,
  runningTeamEvidenceLogPath,
} from '../team-adapter.js';

async function setup(name: string): Promise<{ cwd: string; cleanup: () => Promise<void> }> {
  const cwd = await mkdtemp(join(tmpdir(), `omx-runningteam-adapter-${name}-`));
  const previousOmxRoot = process.env.OMX_ROOT;
  const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
  const previousOmxTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
  delete process.env.OMX_ROOT;
  delete process.env.OMX_STATE_ROOT;
  delete process.env.OMX_TEAM_STATE_ROOT;
  await initTeamState(name, 'runningteam adapter test', 'executor', 2, cwd);
  return {
    cwd,
    cleanup: async () => {
      if (previousOmxRoot === undefined) delete process.env.OMX_ROOT;
      else process.env.OMX_ROOT = previousOmxRoot;
      if (previousOmxStateRoot === undefined) delete process.env.OMX_STATE_ROOT;
      else process.env.OMX_STATE_ROOT = previousOmxStateRoot;
      if (previousOmxTeamStateRoot === undefined) delete process.env.OMX_TEAM_STATE_ROOT;
      else process.env.OMX_TEAM_STATE_ROOT = previousOmxTeamStateRoot;
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

describe('runningteam/team-adapter', () => {
  it('ingests team task completion evidence with lane/task/plan correlation and stable cursor', async () => {
    const { cwd, cleanup } = await setup('rt-adapter-a');
    try {
      const task = await createTask('rt-adapter-a', {
        subject: 'implementation lane',
        description: 'implement fixture',
        status: 'pending',
        owner: 'worker-1',
        lane: 'implementation',
        filePaths: ['src/example.ts'],
      }, cwd);
      const claim = await claimTask('rt-adapter-a', task.id, 'worker-1', null, cwd);
      assert.equal(claim.ok, true);
      if (!claim.ok) throw new Error('claim failed');

      const beforeCompletion = await initializeRunningTeamAdapterState({
        cwd,
        sessionId: 'session-a',
        teamName: 'rt-adapter-a',
        workerMap: { 'worker-1': 'implementation' },
        taskMap: { [task.id]: 'implementation' },
      });
      const baseline = await ingestRunningTeamAdapterEvidence({
        cwd,
        sessionId: 'session-a',
        iteration: 1,
        planVersion: 2,
        state: beforeCompletion,
      });
      assert.ok(baseline.ingestedCount >= 0);

      const result = [
        'Changed src/example.ts',
        'PASS - `npm test -- src/example.test.ts` → ok',
        'PASS - `npx tsc --noEmit` → ok',
      ].join('\n');
      const transitioned = await transitionTaskStatus('rt-adapter-a', task.id, 'in_progress', 'completed', claim.claimToken, cwd, { result });
      assert.equal(transitioned.ok, true);

      const first = await ingestRunningTeamAdapterEvidence({
        cwd,
        sessionId: 'session-a',
        iteration: 1,
        planVersion: 2,
      });

      assert.ok(first.ingestedCount >= 1);
      assert.equal(first.events.at(-1)?.type, 'worker_evidence_received');
      assert.equal(first.events.filter((event) => event.type === 'worker_evidence_received').length, 1);
      const event = first.events.at(-1);
      assert.equal(event?.session_id, 'session-a');
      assert.equal(event?.iteration, 1);
      assert.equal(event?.plan_version, 2);
      assert.equal(event?.worker, 'worker-1');
      assert.equal(event?.lane, 'implementation');
      assert.equal(event?.task_id, task.id);
      if (event?.type !== 'worker_evidence_received') throw new Error('expected worker evidence');
      assert.deepEqual(event.files_changed, ['src/example.ts']);
      assert.equal(event.tests_run.some((test) => test.command === 'npm test -- src/example.test.ts' && test.status === 'pass'), true);
      assert.equal(event.commands_run.some((command) => command.command === 'npx tsc --noEmit' && command.exit_code === 0), true);
      assert.equal(typeof first.cursor, 'string');

      const second = await ingestRunningTeamAdapterEvidence({
        cwd,
        sessionId: 'session-a',
        iteration: 1,
        planVersion: 2,
      });
      assert.equal(second.ingestedCount, 0);
      assert.equal(second.cursor, first.cursor);

      const logRaw = await readFile(runningTeamEvidenceLogPath(cwd, 'session-a'), 'utf-8');
      assert.equal(logRaw.trim().split('\n').length, first.ingestedCount);
      const persisted = await readRunningTeamAdapterState(cwd, 'session-a');
      assert.equal(persisted?.event_cursor, first.cursor);
      assert.equal(persisted?.ingested_event_ids?.length, first.ingestedCount);
    } finally {
      await cleanup();
    }
  });

  it('parses task result evidence when task_completed metadata is empty', async () => {
    const { cwd, cleanup } = await setup('rt-adapter-empty-metadata');
    try {
      const task = await createTask('rt-adapter-empty-metadata', {
        subject: 'implementation lane',
        description: 'complete work and report evidence in result text',
        status: 'pending',
        owner: 'worker-1',
        lane: 'implementation',
        filePaths: ['src/runningteam/example.ts'],
      }, cwd);
      const claim = await claimTask('rt-adapter-empty-metadata', task.id, 'worker-1', null, cwd);
      assert.equal(claim.ok, true);
      if (!claim.ok) throw new Error('claim failed');

      const result = [
        'Implemented worker result parsing fallback.',
        'PASS - `npm test -- src/runningteam/__tests__/team-adapter.test.ts` → ok',
        'FAIL - `npx tsc --noEmit` → typecheck failed before production fix',
      ].join('\n');
      const transitioned = await transitionTaskStatus('rt-adapter-empty-metadata', task.id, 'in_progress', 'completed', claim.claimToken, cwd, { result });
      assert.equal(transitioned.ok, true);

      await initializeRunningTeamAdapterState({
        cwd,
        sessionId: 'session-empty-metadata',
        teamName: 'rt-adapter-empty-metadata',
        workerMap: { 'worker-1': 'implementation' },
        taskMap: { [task.id]: 'implementation' },
      });
      await appendTeamEvent('rt-adapter-empty-metadata', {
        type: 'task_completed',
        worker: 'worker-1',
        task_id: task.id,
        reason: 'completed with result-only evidence',
        metadata: {},
      }, cwd);

      const ingested = await ingestRunningTeamAdapterEvidence({
        cwd,
        sessionId: 'session-empty-metadata',
        iteration: 2,
        planVersion: 3,
      });

      const evidence = ingested.events.find((event) => event.type === 'worker_evidence_received');
      assert.ok(evidence, 'task_completed should become worker evidence even when event metadata is empty');
      if (evidence?.type !== 'worker_evidence_received') throw new Error('expected worker evidence');
      assert.deepEqual(evidence.files_changed, ['src/runningteam/example.ts']);
      assert.equal(evidence.tests_run.some((test) => test.command === 'npm test -- src/runningteam/__tests__/team-adapter.test.ts' && test.status === 'pass'), true);
      assert.equal(evidence.commands_run.some((command) => command.command === 'npx tsc --noEmit' && command.exit_code === 1), true);
      assert.equal(evidence.next_needed, 'checkpoint_review');
    } finally {
      await cleanup();
    }
  });

  it('deduplicates normalized worker_idle events and records stale/blocker events without worker evidence claims', async () => {
    const { cwd, cleanup } = await setup('rt-adapter-b');
    try {
      const baseline = await appendTeamEvent('rt-adapter-b', {
        type: 'worker_state_changed',
        worker: 'worker-2',
        task_id: '2',
        state: 'working',
      }, cwd);
      await appendTeamEvent('rt-adapter-b', {
        type: 'worker_idle',
        worker: 'worker-2',
        task_id: '2',
        prev_state: 'working',
      }, cwd);
      await appendTeamEvent('rt-adapter-b', {
        type: 'worker_idle',
        worker: 'worker-2',
        task_id: '2',
        prev_state: 'working',
      }, cwd);
      await appendTeamEvent('rt-adapter-b', {
        type: 'worker_stale_stdout',
        worker: 'worker-2',
        task_id: '2',
        reason: 'stdout stale',
      }, cwd);

      await initializeRunningTeamAdapterState({
        cwd,
        sessionId: 'session-b',
        teamName: 'rt-adapter-b',
        workerMap: { 'worker-2': 'tests' },
        taskMap: { '2': 'tests' },
      });
      const state = await readRunningTeamAdapterState(cwd, 'session-b');
      assert.ok(state);
      if (state) {
        state.event_cursor = baseline.event_id;
      }

      const result = await ingestRunningTeamAdapterEvidence({
        cwd,
        sessionId: 'session-b',
        iteration: 3,
        planVersion: 4,
        state: state ?? undefined,
      });

      assert.equal(result.ingestedCount, 2);
      assert.deepEqual(result.events.map((event) => event.type), ['team_event_ingested', 'team_event_ingested']);
      assert.deepEqual(result.events.map((event) => event.lane), ['tests', 'tests']);
      assert.equal(result.events[1]?.source_team_event_id, result.cursor);
      if (result.events[1]?.type !== 'team_event_ingested') throw new Error('expected team event');
      assert.deepEqual(result.events[1].blockers, ['stdout stale']);
    } finally {
      await cleanup();
    }
  });

  it('uses configured OMX state roots for adapter state and evidence paths', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-runningteam-adapter-root-cwd-'));
    const stateRoot = await mkdtemp(join(tmpdir(), 'omx-runningteam-adapter-root-state-'));
    const previousOmxRoot = process.env.OMX_ROOT;
    const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
    const previousOmxTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    process.env.OMX_ROOT = stateRoot;
    delete process.env.OMX_STATE_ROOT;
    delete process.env.OMX_TEAM_STATE_ROOT;
    try {
      await initTeamState('rt-adapter-root', 'configured root adapter test', 'executor', 1, cwd);
      await initializeRunningTeamAdapterState({
        cwd,
        sessionId: 'session-root',
        teamName: 'rt-adapter-root',
        workerMap: { 'worker-1': 'implementation' },
      });
      await appendTeamEvent('rt-adapter-root', {
        type: 'worker_idle',
        worker: 'worker-1',
        reason: 'idle for configured root evidence',
      }, cwd);
      const ingested = await ingestRunningTeamAdapterEvidence({
        cwd,
        sessionId: 'session-root',
        iteration: 1,
        planVersion: 1,
      });

      assert.equal(ingested.ingestedCount, 1);
      const evidencePath = runningTeamEvidenceLogPath(cwd, 'session-root');
      assert.equal(evidencePath.startsWith(join(stateRoot, '.omx', 'state', 'runningteam')), true);
      assert.equal(evidencePath.startsWith(join(cwd, '.omx', 'state', 'runningteam')), false);
      assert.match(await readFile(evidencePath, 'utf-8'), /team_event_ingested/);
    } finally {
      if (previousOmxRoot === undefined) delete process.env.OMX_ROOT;
      else process.env.OMX_ROOT = previousOmxRoot;
      if (previousOmxStateRoot === undefined) delete process.env.OMX_STATE_ROOT;
      else process.env.OMX_STATE_ROOT = previousOmxStateRoot;
      if (previousOmxTeamStateRoot === undefined) delete process.env.OMX_TEAM_STATE_ROOT;
      else process.env.OMX_TEAM_STATE_ROOT = previousOmxTeamStateRoot;
      await rm(cwd, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('persists merged adapter mappings when reinitialized', async () => {
    const { cwd, cleanup } = await setup('rt-adapter-reinit');
    try {
      await initializeRunningTeamAdapterState({
        cwd,
        sessionId: 'session-reinit',
        teamName: 'rt-adapter-reinit',
        workerMap: { 'worker-1': 'tests' },
        taskMap: { '1': 'tests' },
      });
      await initializeRunningTeamAdapterState({
        cwd,
        sessionId: 'session-reinit',
        teamName: 'rt-adapter-reinit',
        workerMap: { 'worker-2': 'implementation' },
        taskMap: { '2': 'implementation' },
      });

      const persisted = await readRunningTeamAdapterState(cwd, 'session-reinit');
      assert.equal(persisted?.worker_map['worker-1'], 'tests');
      assert.equal(persisted?.worker_map['worker-2'], 'implementation');
      assert.equal(persisted?.task_map['1'], 'tests');
      assert.equal(persisted?.task_map['2'], 'implementation');
    } finally {
      await cleanup();
    }
  });
});
