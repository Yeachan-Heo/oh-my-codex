import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { bindPendingRoleIntentUnderLock, buildSubagentResumeLedger, CROSS_PROCESS_LOCK_LEASE_MS, createSubagentTrackingState, crossProcessLockPath, consumePendingRoleIntent, recordSubagentTurn, NATIVE_SUBAGENT_PROVENANCE, OMX_ADAPTED_PROVENANCE, readSubagentTrackingState, recordPendingRoleIntent, selectReusableSubagentEntry, summarizeSubagentSession, withCrossProcessFileLockSync } from '../tracker.js';
import { NATIVE_SUBAGENT_ROLE_ROUTING_MARKER_FILE, readRoleRoutingMarker, writeRoleRoutingMarker } from '../role-routing-marker.js';

interface PendingRoleIntentRecordWorkerInput {
  operation: 'record';
  cwd: string;
  role: string;
  sessionId: string;
  parentThreadId: string;
  correlationToken: string;
  nowMs: number;
}

interface PendingRoleIntentConsumeWorkerInput {
  operation: 'consume';
  cwd: string;
  sessionId: string;
  parentThreadId: string;
  correlationToken: string;
  nowMs: number;
}

type PendingRoleIntentWorkerInput = PendingRoleIntentRecordWorkerInput | PendingRoleIntentConsumeWorkerInput | PendingRoleIntentRecordTurnWorkerInput;

interface PendingRoleIntentRecordTurnWorkerInput {
  operation: 'record-turn';
  cwd: string;
  sessionId: string;
  threadId: string;
}
type PendingRoleIntentWorkerResult = { ok: boolean; reason?: string } | { role: string; provenanceKind: string } | null;

interface PendingRoleIntentWorker {
  ready: Promise<void>;
  result: Promise<PendingRoleIntentWorkerResult>;
}

const PENDING_ROLE_INTENT_WORKER_SOURCE = `
  import { existsSync } from 'node:fs';

  const input = JSON.parse(process.env.OMX_PENDING_ROLE_INTENT_WORKER_INPUT ?? '{}');
  const tracker = await import(process.env.OMX_TRACKER_MODULE_URL ?? '');
  const startSignal = process.env.OMX_PENDING_ROLE_INTENT_START_SIGNAL ?? '';
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  const startedAt = Date.now();

  process.stdout.write('ready\\n');
  while (!existsSync(startSignal)) {
    if (Date.now() - startedAt > 10_000) {
      throw new Error('Timed out waiting for pending role intent test start signal');
    }
    Atomics.wait(waitArray, 0, 0, 5);
  }

  const result = input.operation === 'record'
    ? tracker.recordPendingRoleIntent(input.cwd, input)
    : input.operation === 'consume'
      ? tracker.consumePendingRoleIntent(input.cwd, input)
      : (await tracker.recordSubagentTurnForSession(input.cwd, input), { ok: true });
  process.stdout.write(JSON.stringify(result));
`;

function spawnPendingRoleIntentWorker(startSignal: string, input: PendingRoleIntentWorkerInput): PendingRoleIntentWorker {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', PENDING_ROLE_INTENT_WORKER_SOURCE], {
    env: {
      ...process.env,
      OMX_PENDING_ROLE_INTENT_START_SIGNAL: startSignal,
      OMX_PENDING_ROLE_INTENT_WORKER_INPUT: JSON.stringify(input),
      OMX_TRACKER_MODULE_URL: new URL('../tracker.js', import.meta.url).href,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!child.stdout || !child.stderr) {
    throw new Error('Pending role intent test worker did not expose output streams');
  }

  let stdout = '';
  let stderr = '';
  let ready = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveResult!: (result: PendingRoleIntentWorkerResult) => void;
  let rejectResult!: (error: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const resultPromise = new Promise<PendingRoleIntentWorkerResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    if (!ready && stdout.includes('ready\n')) {
      ready = true;
      resolveReady();
    }
  });
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.once('error', (error) => {
    if (!ready) rejectReady(error);
    rejectResult(error);
  });
  child.once('close', (code) => {
    if (!ready) {
      rejectReady(new Error(`Pending role intent test worker exited before ready: ${stderr || `code ${code}`}`));
    }
    if (code !== 0) {
      rejectResult(new Error(`Pending role intent test worker failed: ${stderr || `code ${code}`}`));
      return;
    }
    try {
      const resultJson = stdout.slice(stdout.indexOf('ready\n') + 'ready\n'.length);
      resolveResult(JSON.parse(resultJson) as PendingRoleIntentWorkerResult);
    } catch (error) {
      rejectResult(error instanceof Error ? error : new Error(String(error)));
    }
  });

  return { ready: readyPromise, result: resultPromise };
}

async function runConcurrentPendingRoleIntentWorkers(cwd: string, inputs: [PendingRoleIntentWorkerInput, PendingRoleIntentWorkerInput]): Promise<[PendingRoleIntentWorkerResult, PendingRoleIntentWorkerResult]> {
  const startSignal = join(cwd, 'pending-role-intent-workers-start');
  const workers = inputs.map((input) => spawnPendingRoleIntentWorker(startSignal, input));
  await Promise.all(workers.map((worker) => worker.ready));
  await writeFile(startSignal, 'start\n');
  return Promise.all(workers.map((worker) => worker.result)) as Promise<[PendingRoleIntentWorkerResult, PendingRoleIntentWorkerResult]>;
}

function isSuccessfulRoleIntentRecord(result: PendingRoleIntentWorkerResult): result is { ok: true; reason?: string } {
  return result !== null && 'ok' in result && result.ok === true;
}

function isSingleFlightConflict(result: PendingRoleIntentWorkerResult): result is { ok: false; reason: 'single_flight_conflict' } {
  return result !== null && 'ok' in result && result.ok === false && result.reason === 'single_flight_conflict';
}

function isConsumedRoleIntent(result: PendingRoleIntentWorkerResult): result is { role: string; provenanceKind: string } {
  return result !== null && 'role' in result;
}

describe('subagents/tracker', () => {
  it('tracks leader and subagent threads per session and computes active windows', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'sess-1',
      threadId: 'leader-thread',
      turnId: 'turn-1',
      timestamp: '2026-03-17T00:00:00.000Z',
      mode: 'ralph',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-1',
      threadId: 'sub-thread-1',
      turnId: 'turn-2',
      timestamp: '2026-03-17T00:00:30.000Z',
      mode: 'ralph',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-1',
      threadId: 'sub-thread-2',
      turnId: 'turn-3',
      timestamp: '2026-03-17T00:01:00.000Z',
      mode: 'ralph',
    });

    const active = summarizeSubagentSession(state, 'sess-1', {
      now: '2026-03-17T00:01:15.000Z',
      activeWindowMs: 60_000,
    });
    assert.deepEqual(active, {
      sessionId: 'sess-1',
      leaderThreadId: 'leader-thread',
      allThreadIds: ['leader-thread', 'sub-thread-1', 'sub-thread-2'],
      allSubagentThreadIds: ['sub-thread-1', 'sub-thread-2'],
      activeSubagentThreadIds: ['sub-thread-1', 'sub-thread-2'],
      savedSubagents: [
        {
          agentId: 'sub-thread-1',
          threadId: 'sub-thread-1',
          role: 'ralph',
          laneId: 'ralph',
          status: 'available',
        },
        {
          agentId: 'sub-thread-2',
          threadId: 'sub-thread-2',
          role: 'ralph',
          laneId: 'ralph',
          status: 'available',
        },
      ],
      updatedAt: '2026-03-17T00:01:00.000Z',
    });

    const drained = summarizeSubagentSession(state, 'sess-1', {
      now: '2026-03-17T00:03:30.000Z',
      activeWindowMs: 60_000,
    });
    assert.deepEqual(drained?.activeSubagentThreadIds, []);
  });

  it('can record an explicitly spawned subagent as subagent even when it is the first seen thread', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'sess-ralplan',
      threadId: 'thread-architect',
      timestamp: '2026-05-28T17:59:43.270Z',
      mode: 'architect',
      kind: 'subagent',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-ralplan',
      threadId: 'thread-critic',
      timestamp: '2026-05-28T18:01:49.547Z',
      mode: 'critic',
      kind: 'subagent',
    });

    const summary = summarizeSubagentSession(state, 'sess-ralplan', {
      now: '2026-05-28T18:02:00.000Z',
      activeWindowMs: 120_000,
    });

    assert.equal(state.sessions['sess-ralplan']?.leader_thread_id, undefined);
    assert.equal(state.sessions['sess-ralplan']?.threads['thread-architect']?.kind, 'subagent');
    assert.equal(state.sessions['sess-ralplan']?.threads['thread-critic']?.kind, 'subagent');
    assert.deepEqual(summary?.allSubagentThreadIds, ['thread-architect', 'thread-critic']);
  });

  it('keeps an explicitly spawned first-seen subagent as subagent after a generic follow-up turn', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'sess-ralplan',
      threadId: 'thread-architect',
      timestamp: '2026-05-28T17:59:43.270Z',
      mode: 'architect',
      kind: 'subagent',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-ralplan',
      threadId: 'thread-architect',
      turnId: 'turn-after-session-start',
      timestamp: '2026-05-28T18:00:05.000Z',
      mode: 'architect',
    });

    assert.equal(state.sessions['sess-ralplan']?.leader_thread_id, undefined);
    assert.equal(state.sessions['sess-ralplan']?.threads['thread-architect']?.kind, 'subagent');
    assert.equal(state.sessions['sess-ralplan']?.threads['thread-architect']?.turn_count, 2);
    assert.equal(state.sessions['sess-ralplan']?.threads['thread-architect']?.last_turn_id, 'turn-after-session-start');
  });

  it('does not promote existing subagent evidence when the same thread later acts as a parent', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'sess-ralplan',
      threadId: 'thread-architect',
      timestamp: '2026-05-28T17:59:43.270Z',
      mode: 'architect',
      kind: 'subagent',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-ralplan',
      threadId: 'thread-architect',
      timestamp: '2026-05-28T18:00:10.000Z',
      mode: 'architect',
      kind: 'leader',
    });

    assert.equal(state.sessions['sess-ralplan']?.leader_thread_id, undefined);
    assert.equal(state.sessions['sess-ralplan']?.threads['thread-architect']?.kind, 'subagent');
  });

  it('does not promote a known subagent when it becomes an immediate parent', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'sess-ralplan',
      threadId: 'thread-architect',
      timestamp: '2026-05-28T17:59:43.270Z',
      mode: 'architect',
      kind: 'subagent',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-ralplan',
      threadId: 'thread-researcher',
      timestamp: '2026-05-28T18:00:10.000Z',
      mode: 'researcher',
      kind: 'subagent',
      leaderThreadId: 'thread-architect',
    });

    const summary = summarizeSubagentSession(state, 'sess-ralplan', {
      now: '2026-05-28T18:00:11.000Z',
      activeWindowMs: 120_000,
    });

    assert.equal(state.sessions['sess-ralplan']?.leader_thread_id, undefined);
    assert.equal(state.sessions['sess-ralplan']?.threads['thread-architect']?.kind, 'subagent');
    assert.equal(state.sessions['sess-ralplan']?.threads['thread-researcher']?.kind, 'subagent');
    assert.deepEqual(summary?.allSubagentThreadIds, ['thread-architect', 'thread-researcher']);
  });

  it('does not downgrade a known leader when later native metadata claims the same thread as subagent', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'sess-ralplan',
      threadId: 'thread-leader',
      timestamp: '2026-05-28T17:59:40.000Z',
      mode: 'ralplan',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-ralplan',
      threadId: 'thread-leader',
      timestamp: '2026-05-28T17:59:43.270Z',
      mode: 'architect',
      kind: 'subagent',
    });

    assert.equal(state.sessions['sess-ralplan']?.leader_thread_id, 'thread-leader');
    assert.equal(state.sessions['sess-ralplan']?.threads['thread-leader']?.kind, 'leader');
  });

  it('excludes a corrupt leader thread from trusted subagent summaries even when kind is subagent', () => {
    const state = createSubagentTrackingState();
    state.sessions['sess-corrupt'] = {
      session_id: 'sess-corrupt',
      leader_thread_id: 'thread-leader',
      updated_at: '2026-05-28T19:04:17.000Z',
      threads: {
        'thread-leader': {
          thread_id: 'thread-leader',
          kind: 'subagent',
          first_seen_at: '2026-05-28T19:04:17.000Z',
          last_seen_at: '2026-05-28T19:04:17.000Z',
          turn_count: 2,
        },
        'thread-child': {
          thread_id: 'thread-child',
          kind: 'subagent',
          first_seen_at: '2026-05-28T19:04:18.000Z',
          last_seen_at: '2026-05-28T19:04:18.000Z',
          turn_count: 1,
        },
      },
    };

    const summary = summarizeSubagentSession(state, 'sess-corrupt', {
      now: '2026-05-28T19:04:19.000Z',
      activeWindowMs: 120_000,
    });

    assert.deepEqual(summary?.allSubagentThreadIds, ['thread-child']);
    assert.deepEqual(summary?.activeSubagentThreadIds, ['thread-child']);
  });

  it('reconciles completed subagent threads before reporting active wait state', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'sess-1',
      threadId: 'leader-thread',
      turnId: 'turn-1',
      timestamp: '2026-03-17T00:00:00.000Z',
      mode: 'ralplan',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-1',
      threadId: 'sub-thread-1',
      turnId: 'turn-2',
      timestamp: '2026-03-17T00:00:30.000Z',
      mode: 'architect',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-1',
      threadId: 'sub-thread-1',
      turnId: 'turn-3',
      timestamp: '2026-03-17T00:00:45.000Z',
      mode: 'architect',
      completed: true,
      completionSource: 'notify-fallback-watcher',
    });

    const summary = summarizeSubagentSession(state, 'sess-1', {
      now: '2026-03-17T00:01:00.000Z',
      activeWindowMs: 120_000,
    });

    assert.deepEqual(summary?.allSubagentThreadIds, ['sub-thread-1']);
    assert.deepEqual(summary?.activeSubagentThreadIds, []);
    assert.equal(state.sessions['sess-1']?.threads['sub-thread-1']?.completion_source, 'notify-fallback-watcher');
  });

  it('preserves explicit unavailable and closed status in summaries even when threads are still recent', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'sess-1',
      threadId: 'leader-thread',
      turnId: 'turn-1',
      timestamp: '2026-03-17T00:00:00.000Z',
      mode: 'ralplan',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-1',
      threadId: 'sub-thread-unavailable',
      turnId: 'turn-2',
      timestamp: '2026-03-17T00:00:30.000Z',
      mode: 'architect',
      status: 'unavailable',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-1',
      threadId: 'sub-thread-closed',
      turnId: 'turn-3',
      timestamp: '2026-03-17T00:00:45.000Z',
      mode: 'critic',
      status: 'closed',
    });

    const summary = summarizeSubagentSession(state, 'sess-1', {
      now: '2026-03-17T00:01:00.000Z',
      activeWindowMs: 120_000,
    });

    const ledger = buildSubagentResumeLedger(state, 'sess-1', {
      now: '2026-03-17T00:01:00.000Z',
      activeWindowMs: 120_000,
    });

    assert.deepEqual(summary?.activeSubagentThreadIds, []);
    assert.deepEqual(summary?.savedSubagents, [
      {
        agentId: 'sub-thread-closed',
        threadId: 'sub-thread-closed',
        role: 'critic',
        laneId: 'critic',
        status: 'closed',
      },
      {
        agentId: 'sub-thread-unavailable',
        threadId: 'sub-thread-unavailable',
        role: 'architect',
        laneId: 'architect',
        status: 'unavailable',
      },
    ]);
    assert.deepEqual(ledger?.activeSubagentThreadIds, []);
  });

  it('reactivates a notify-fallback-completed subagent thread after a later non-complete turn', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'sess-1',
      threadId: 'leader-thread',
      turnId: 'turn-1',
      timestamp: '2026-03-17T00:00:00.000Z',
      mode: 'ralplan',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-1',
      threadId: 'sub-thread-1',
      turnId: 'turn-2',
      timestamp: '2026-03-17T00:00:30.000Z',
      mode: 'architect',
      completed: true,
      completionSource: 'notify-fallback-watcher',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-1',
      threadId: 'sub-thread-1',
      turnId: 'turn-3',
      timestamp: '2026-03-17T00:01:00.000Z',
      mode: 'architect',
    });

    const summary = summarizeSubagentSession(state, 'sess-1', {
      now: '2026-03-17T00:01:15.000Z',
      activeWindowMs: 120_000,
    });
    const ledger = buildSubagentResumeLedger(state, 'sess-1', {
      now: '2026-03-17T00:01:15.000Z',
      activeWindowMs: 120_000,
    });
    const thread = state.sessions['sess-1']?.threads['sub-thread-1'];

    assert.deepEqual(summary?.activeSubagentThreadIds, ['sub-thread-1']);
    assert.deepEqual(summary?.savedSubagents, [
      {
        agentId: 'sub-thread-1',
        threadId: 'sub-thread-1',
        role: 'architect',
        laneId: 'architect',
        status: 'available',
      },
    ]);
    assert.deepEqual(ledger?.activeSubagentThreadIds, ['sub-thread-1']);
    assert.equal(ledger?.savedSubagents[0]?.status, 'available');
    assert.equal(thread?.status, undefined);
    assert.equal(thread?.completed_at, undefined);
    assert.equal(thread?.last_completed_turn_id, undefined);
    assert.equal(thread?.completion_source, undefined);
    assert.equal(thread?.last_turn_id, 'turn-3');
  });

  it('records role and lane metadata for restart resume/reuse summaries', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'sess-conductor',
      threadId: 'thread-leader',
      timestamp: '2026-06-29T00:00:00.000Z',
      mode: 'ralph',
      kind: 'leader',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-conductor',
      threadId: 'thread-executor',
      timestamp: '2026-06-29T00:00:30.000Z',
      mode: 'executor',
      role: 'executor',
      provenanceKind: NATIVE_SUBAGENT_PROVENANCE,
      laneId: 'implementation-fix',
      scope: 'runtime hook guard',
      agentNickname: 'worker-1',
      kind: 'subagent',
      leaderThreadId: 'thread-leader',
    });

    const summary = summarizeSubagentSession(state, 'sess-conductor', {
      now: '2026-06-29T00:01:00.000Z',
      activeWindowMs: 120_000,
    });

    assert.deepEqual(summary?.savedSubagents, [
      {
        agentId: 'thread-executor',
        threadId: 'thread-executor',
        role: 'executor',
        laneId: 'implementation-fix',
        scope: 'runtime hook guard',
        agentNickname: 'worker-1',
        status: 'available',
      },
    ]);
    assert.equal(state.sessions['sess-conductor']?.threads['thread-executor']?.role, 'executor');
    assert.equal(state.sessions['sess-conductor']?.threads['thread-executor']?.lane_id, 'implementation-fix');
    assert.equal(state.sessions['sess-conductor']?.threads['thread-executor']?.provenance_kind, NATIVE_SUBAGENT_PROVENANCE);
  });

  it('builds a reusable ledger that preserves unavailable status and handoff summaries', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'sess-conductor',
      threadId: 'thread-leader',
      timestamp: '2026-06-29T00:00:00.000Z',
      mode: 'ralph',
      kind: 'leader',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-conductor',
      threadId: 'thread-architect',
      timestamp: '2026-06-29T00:00:30.000Z',
      mode: 'architect',
      role: 'architect',
      laneId: 'plan-review',
      scope: 'runtime hook guard',
      agentNickname: 'reviewer-1',
      kind: 'subagent',
      leaderThreadId: 'thread-leader',
      lastHandoffSummary: 'architect reviewed v1 and requested reuse of the same lane',
      status: 'available',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-conductor',
      threadId: 'thread-critic',
      timestamp: '2026-06-29T00:01:00.000Z',
      mode: 'critic',
      role: 'critic',
      laneId: 'risk-review',
      scope: 'runtime hook guard',
      kind: 'subagent',
      leaderThreadId: 'thread-leader',
      lastHandoffSummary: 'critic paused pending planner response',
      status: 'unavailable',
    });

    const ledger = buildSubagentResumeLedger(state, 'sess-conductor', {
      now: '2026-06-29T00:01:30.000Z',
      activeWindowMs: 120_000,
    });

    assert.ok(ledger);
    assert.deepEqual(
      ledger?.resumeTargets.map((entry) => entry.agentId),
      ['thread-architect', 'thread-critic'],
    );
    assert.equal(ledger?.savedSubagents.find((entry) => entry.agentId === 'thread-architect')?.status, 'available');
    assert.equal(ledger?.savedSubagents.find((entry) => entry.agentId === 'thread-architect')?.lastHandoffSummary, 'architect reviewed v1 and requested reuse of the same lane');
    assert.equal(ledger?.savedSubagents.find((entry) => entry.agentId === 'thread-critic')?.status, 'unavailable');
    assert.equal(ledger?.savedSubagents.find((entry) => entry.agentId === 'thread-critic')?.lastHandoffSummary, 'critic paused pending planner response');
    assert.deepEqual(
      selectReusableSubagentEntry(ledger?.resumeTargets ?? [], {
        role: 'architect',
        laneId: 'plan-review',
        scope: 'runtime hook guard',
      })?.agentId,
      'thread-architect',
    );
    assert.equal(
      selectReusableSubagentEntry(
        [
          {
            agentId: 'thread-executor',
            threadId: 'thread-executor',
            role: 'executor',
            laneId: 'plan-review',
            scope: 'runtime hook guard',
            status: 'available',
            lastSeenAt: '2026-06-29T00:01:25.000Z',
          },
          {
            agentId: 'thread-architect',
            threadId: 'thread-architect',
            role: 'architect',
            laneId: 'plan-review',
            scope: 'runtime hook guard',
            status: 'closed',
            lastSeenAt: '2026-06-29T00:01:20.000Z',
          },
        ],
        {
          role: 'architect',
          laneId: 'plan-review',
          scope: 'runtime hook guard',
        },
      )?.agentId,
      'thread-architect',
    );
    assert.equal(
      selectReusableSubagentEntry(
        [
          {
            agentId: 'thread-critic',
            threadId: 'thread-critic',
            role: 'critic',
            laneId: 'risk-review',
            scope: 'runtime hook guard',
            status: 'unavailable',
          },
        ],
        {
          role: 'critic',
          laneId: 'risk-review',
          scope: 'runtime hook guard',
        },
      ),
      null,
    );
    assert.equal(
      selectReusableSubagentEntry(
        [
          {
            agentId: 'thread-executor',
            threadId: 'thread-executor',
            role: 'executor',
            laneId: 'plan-review',
            scope: 'runtime hook guard',
            status: 'available',
          },
        ],
        {
          role: 'architect',
          laneId: 'plan-review',
          scope: 'runtime hook guard',
        },
      ),
      null,
    );
    assert.deepEqual(
      ledger?.unavailableSubagents.map((entry) => entry.agentId),
      ['thread-critic'],
    );
  });

  it('preserves explicit closed ledger status so older available lanes win reuse selection', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'sess-conductor',
      threadId: 'thread-leader',
      timestamp: '2026-06-29T00:00:00.000Z',
      mode: 'ralph',
      kind: 'leader',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-conductor',
      threadId: 'thread-available-older',
      timestamp: '2026-06-29T00:00:30.000Z',
      mode: 'executor',
      role: 'executor',
      laneId: 'implementation-fix',
      scope: 'conductor reuse ledger',
      kind: 'subagent',
      leaderThreadId: 'thread-leader',
      status: 'available',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-conductor',
      threadId: 'thread-closed-recent',
      timestamp: '2026-06-29T00:01:30.000Z',
      mode: 'executor',
      role: 'executor',
      laneId: 'implementation-fix',
      scope: 'conductor reuse ledger',
      kind: 'subagent',
      leaderThreadId: 'thread-leader',
      status: 'closed',
    });

    const ledger = buildSubagentResumeLedger(state, 'sess-conductor', {
      now: '2026-06-29T00:01:45.000Z',
      activeWindowMs: 120_000,
    });

    assert.ok(ledger);
    assert.equal(ledger.savedSubagents.find((entry) => entry.agentId === 'thread-closed-recent')?.status, 'closed');
    assert.deepEqual(
      ledger.resumeTargets.map((entry) => entry.agentId),
      ['thread-available-older', 'thread-closed-recent'],
    );
    assert.equal(
      selectReusableSubagentEntry(ledger.resumeTargets, {
        role: 'executor',
        laneId: 'implementation-fix',
        scope: 'conductor reuse ledger',
      })?.agentId,
      'thread-available-older',
    );
  });

  it('reclaims stale or dead cross-process lock owners', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-subagent-tracker-'));
    const resourcePath = join(cwd, 'lock-resource');
    try {
      await writeFile(crossProcessLockPath(resourcePath), `${JSON.stringify({
        pid: process.pid,
        host: 'test-host',
        acquired_at: new Date(Date.now() - CROSS_PROCESS_LOCK_LEASE_MS - 1).toISOString(),
      })}\n`);
      assert.equal(withCrossProcessFileLockSync(resourcePath, () => 'stale lock recovered'), 'stale lock recovered');

      const child = spawn(process.execPath, ['--eval', '']);
      const deadOwnerPid = child.pid;
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Lock-owner child exited with code ${code}`)));
      });
      assert.ok(deadOwnerPid);
      await writeFile(crossProcessLockPath(resourcePath), `${JSON.stringify({
        pid: deadOwnerPid,
        host: 'test-host',
        acquired_at: new Date().toISOString(),
      })}\n`);
      assert.equal(withCrossProcessFileLockSync(resourcePath, () => 'dead lock recovered'), 'dead lock recovered');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses the shared recoverable lock for role-routing markers', async () => {
    const baseStateDir = await mkdtemp(join(tmpdir(), 'omx-role-routing-marker-'));
    const nowMs = Date.now();
    try {
      await writeFile(crossProcessLockPath(join(baseStateDir, NATIVE_SUBAGENT_ROLE_ROUTING_MARKER_FILE)), `${JSON.stringify({
        pid: process.pid,
        host: 'test-host',
        acquired_at: new Date(nowMs - CROSS_PROCESS_LOCK_LEASE_MS - 1).toISOString(),
      })}\n`);
      writeRoleRoutingMarker(baseStateDir, {
        schema_version: 1,
        cwd: '/workspace/project',
        session_id: 'sess-role-routing-marker',
        parent_thread_id: 'thread-parent',
        observed_at: new Date(nowMs).toISOString(),
        expires_at: new Date(nowMs + 60_000).toISOString(),
      });
      assert.equal(
        readRoleRoutingMarker(baseStateDir, {
          cwd: '/workspace/project',
          sessionId: 'sess-role-routing-marker',
          parentThreadId: 'thread-parent',
          nowMs,
        })?.session_id,
        'sess-role-routing-marker',
      );
    } finally {
      await rm(baseStateDir, { recursive: true, force: true });
    }
  });

  it('rejects pending role intents for unknown roles', () => {
    assert.deepEqual(
      recordPendingRoleIntent(process.cwd(), {
        role: 'not-a-known-role',
        sessionId: 'sess-role-intent',
        parentThreadId: 'thread-parent',
        correlationToken: 'correlation-token',
      }),
      { ok: false, reason: 'unknown_role' },
    );
  });

  it('rejects pending role intents with an empty correlation token', () => {
    assert.deepEqual(
      recordPendingRoleIntent(process.cwd(), {
        role: 'architect',
        sessionId: 'sess-role-intent',
        parentThreadId: 'thread-parent',
        correlationToken: '',
      }),
      { ok: false, reason: 'invalid_correlation_token' },
    );
  });

  it('rejects a second live role intent for the same parent thread', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-subagent-tracker-'));
    try {
      assert.equal(
        recordPendingRoleIntent(cwd, {
          role: 'architect',
          sessionId: 'sess-role-intent',
          parentThreadId: 'thread-parent',
          correlationToken: 'architect-token',
          nowMs: 1_000,
        }).ok,
        true,
      );
      assert.deepEqual(
        recordPendingRoleIntent(cwd, {
          role: 'critic',
          sessionId: 'sess-role-intent',
          parentThreadId: 'thread-parent',
          correlationToken: 'critic-token',
          nowMs: 1_001,
        }),
        { ok: false, reason: 'single_flight_conflict' },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('serializes concurrent pending role intent records across processes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-subagent-tracker-'));
    try {
      const results = await runConcurrentPendingRoleIntentWorkers(cwd, [
        {
          operation: 'record',
          cwd,
          role: 'architect',
          sessionId: 'sess-role-intent-concurrent-record',
          parentThreadId: 'thread-parent',
          correlationToken: 'architect-token',
          nowMs: 1_000,
        },
        {
          operation: 'record',
          cwd,
          role: 'critic',
          sessionId: 'sess-role-intent-concurrent-record',
          parentThreadId: 'thread-parent',
          correlationToken: 'critic-token',
          nowMs: 1_000,
        },
      ]);

      assert.equal(results.filter(isSuccessfulRoleIntentRecord).length, 1);
      assert.equal(results.filter(isSingleFlightConflict).length, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('binds a pending role intent only when its correlation token matches', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-subagent-tracker-'));
    const input = {
      sessionId: 'sess-role-intent',
      parentThreadId: 'thread-parent',
      nowMs: 1_001,
    };
    let bindCount = 0;
    const bind = (state: ReturnType<typeof createSubagentTrackingState>, intent: { role: string; provenanceKind: typeof OMX_ADAPTED_PROVENANCE }) => {
      bindCount += 1;
      assert.deepEqual(intent, { role: 'architect', provenanceKind: OMX_ADAPTED_PROVENANCE });
      return state;
    };
    try {
      assert.equal(
        recordPendingRoleIntent(cwd, {
          role: 'architect',
          sessionId: input.sessionId,
          parentThreadId: input.parentThreadId,
          correlationToken: 'expected-token',
          nowMs: 1_000,
        }).ok,
        true,
      );
      assert.equal(bindPendingRoleIntentUnderLock(cwd, input, bind), null);
      assert.equal(bindPendingRoleIntentUnderLock(cwd, { ...input, correlationToken: 'wrong-token' }, bind), null);
      assert.equal((await readSubagentTrackingState(cwd)).pending_role_intents[0]?.correlation_token, 'expected-token');
      assert.deepEqual(
        bindPendingRoleIntentUnderLock(cwd, { ...input, correlationToken: 'expected-token' }, bind),
        { role: 'architect', provenanceKind: OMX_ADAPTED_PROVENANCE },
      );
      assert.equal(bindCount, 1);
      assert.deepEqual((await readSubagentTrackingState(cwd)).pending_role_intents, []);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('consumes a pending role intent exactly once', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-subagent-tracker-'));
    try {
      assert.equal(
        recordPendingRoleIntent(cwd, {
          role: 'architect',
          sessionId: 'sess-role-intent',
          parentThreadId: 'thread-parent',
          correlationToken: 'architect-token',
          nowMs: 1_000,
        }).ok,
        true,
      );
      assert.deepEqual(
        consumePendingRoleIntent(cwd, {
          sessionId: 'sess-role-intent',
          parentThreadId: 'thread-parent',
          correlationToken: 'architect-token',
          nowMs: 1_001,
        }),
        { role: 'architect', provenanceKind: OMX_ADAPTED_PROVENANCE },
      );
      assert.equal(
        consumePendingRoleIntent(cwd, {
          sessionId: 'sess-role-intent',
          parentThreadId: 'thread-parent',
          correlationToken: 'architect-token',
          nowMs: 1_002,
        }),
        null,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('serializes concurrent pending role intent consumes across processes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-subagent-tracker-'));
    try {
      assert.equal(
        recordPendingRoleIntent(cwd, {
          role: 'architect',
          sessionId: 'sess-role-intent-concurrent-consume',
          parentThreadId: 'thread-parent',
          correlationToken: 'architect-token',
          nowMs: 1_000,
        }).ok,
        true,
      );

      const results = await runConcurrentPendingRoleIntentWorkers(cwd, [
        {
          operation: 'consume',
          cwd,
          sessionId: 'sess-role-intent-concurrent-consume',
          parentThreadId: 'thread-parent',
          correlationToken: 'architect-token',
          nowMs: 1_001,
        },
        {
          operation: 'consume',
          cwd,
          sessionId: 'sess-role-intent-concurrent-consume',
          parentThreadId: 'thread-parent',
          correlationToken: 'architect-token',
          nowMs: 1_001,
        },
      ]);

      assert.equal(results.filter(isConsumedRoleIntent).length, 1);
      assert.equal(results.filter((result) => result === null).length, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('serializes lifecycle tracking writes with pending role intent records and consumes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-subagent-tracker-'));
    const sessionId = 'sess-role-intent-lifecycle-race';
    const parentThreadId = 'thread-parent';
    const correlationToken = 'architect-token';
    try {
      const recordResults = await runConcurrentPendingRoleIntentWorkers(cwd, [
        {
          operation: 'record',
          cwd,
          role: 'architect',
          sessionId,
          parentThreadId,
          correlationToken,
          nowMs: 1_000,
        },
        {
          operation: 'record-turn',
          cwd,
          sessionId,
          threadId: 'thread-lifecycle-before-consume',
        },
      ]);
      assert.equal(isSuccessfulRoleIntentRecord(recordResults[0]), true);
      assert.equal(isSuccessfulRoleIntentRecord(recordResults[1]), true);

      const recorded = await readSubagentTrackingState(cwd);
      assert.equal(recorded.pending_role_intents.length, 1);
      assert.equal(recorded.pending_role_intents[0]?.role, 'architect');
      assert.equal(recorded.sessions[sessionId]?.threads['thread-lifecycle-before-consume']?.kind, 'leader');

      const consumeResults = await runConcurrentPendingRoleIntentWorkers(cwd, [
        {
          operation: 'consume',
          cwd,
          sessionId,
          parentThreadId,
          correlationToken,
          nowMs: 1_001,
        },
        {
          operation: 'record-turn',
          cwd,
          sessionId,
          threadId: 'thread-lifecycle-after-consume',
        },
      ]);
      assert.equal(isConsumedRoleIntent(consumeResults[0]), true);
      assert.equal(isSuccessfulRoleIntentRecord(consumeResults[1]), true);

      const consumed = await readSubagentTrackingState(cwd);
      assert.deepEqual(consumed.pending_role_intents, []);
      assert.equal(consumed.sessions[sessionId]?.threads['thread-lifecycle-before-consume']?.kind, 'leader');
      assert.equal(consumed.sessions[sessionId]?.threads['thread-lifecycle-after-consume']?.kind, 'subagent');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not consume expired pending role intents', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-subagent-tracker-'));
    try {
      assert.equal(
        recordPendingRoleIntent(cwd, {
          role: 'architect',
          sessionId: 'sess-role-intent',
          parentThreadId: 'thread-parent',
          correlationToken: 'architect-token',
          nowMs: 1_000,
          ttlMs: 10,
        }).ok,
        true,
      );
      assert.equal(
        consumePendingRoleIntent(cwd, {
          sessionId: 'sess-role-intent',
          parentThreadId: 'thread-parent',
          correlationToken: 'architect-token',
          nowMs: 1_010,
        }),
        null,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
