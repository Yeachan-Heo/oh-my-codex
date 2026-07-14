import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { __setCrossProcessPublishBarrierForTest, CrossProcessLockLostError, bindPendingRoleIntentUnderLock, buildSubagentResumeLedger, CROSS_PROCESS_LOCK_LEASE_MS, createSubagentTrackingState, crossProcessLockPath, consumePendingRoleIntent, recordSubagentTurn, NATIVE_SUBAGENT_PROVENANCE, OMX_ADAPTED_PROVENANCE, readProcessStartIdentity, readSubagentTrackingState, recordPendingRoleIntent, selectReusableSubagentEntry, summarizeSubagentSession, withCrossProcessFileLockSync } from '../tracker.js';
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

const CROSS_PROCESS_LOCK_HOLDER_SOURCE = `
  const tracker = await import(process.env.OMX_TRACKER_MODULE_URL ?? '');
  const { existsSync, writeFileSync } = await import('node:fs');
  const resourcePath = process.env.OMX_LOCK_RESOURCE_PATH ?? '';
  const readyPath = process.env.OMX_LOCK_READY_PATH ?? '';
  const releasePath = process.env.OMX_LOCK_RELEASE_PATH ?? '';
  const publicationPath = process.env.OMX_LOCK_PUBLICATION_PATH ?? '';
  const waitArray = new Int32Array(new SharedArrayBuffer(4));

  tracker.withCrossProcessFileLockSync(resourcePath, () => {
    if (publicationPath) writeFileSync(publicationPath, 'successor\\n');
    writeFileSync(readyPath, 'ready\\n');
    const deadline = Date.now() + 5_000;
    while (!existsSync(releasePath)) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting to release successor lock');
      Atomics.wait(waitArray, 0, 0, 5);
    }
  });
`;

function crossProcessLockClaim(
  token: string,
  pid: number,
  acquiredAtMs: number,
  host = hostname(),
  pidStartId?: string,
): string {
  return `${JSON.stringify({
    token,
    pid,
    host,
    acquired_at: new Date(acquiredAtMs).toISOString(),
    ...(pidStartId ? { pid_start_id: pidStartId } : {}),
  })}\n`;
}

function spawnCrossProcessLockHolder(
  resourcePath: string,
  readyPath: string,
  releasePath: string,
  publicationPath?: string,
) {
  return spawn(process.execPath, ['--input-type=module', '--eval', CROSS_PROCESS_LOCK_HOLDER_SOURCE], {
    env: {
      ...process.env,
      OMX_TRACKER_MODULE_URL: new URL('../tracker.js', import.meta.url).href,
      OMX_LOCK_RESOURCE_PATH: resourcePath,
      OMX_LOCK_READY_PATH: readyPath,
      OMX_LOCK_RELEASE_PATH: releasePath,
      ...(publicationPath ? { OMX_LOCK_PUBLICATION_PATH: publicationPath } : {}),
    },
  });
}

function waitForFileSync(path: string, timeoutMs = 1_000): void {
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    Atomics.wait(waitArray, 0, 0, 5);
  }
}

async function waitForChildExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Lock-owner child exited with code ${code}`)));
  });
}

async function stopChild(child: ReturnType<typeof spawn> | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', resolve);
    child.kill();
  });
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

  it('does not let a stale owner release a successor lock', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-subagent-tracker-'));
    const resourcePath = join(cwd, 'lock-resource');
    const lockPath = crossProcessLockPath(resourcePath);
    const successorReadyPath = join(cwd, 'successor-ready');
    const successorReleasePath = join(cwd, 'successor-release');
    let successor: ReturnType<typeof spawn> | undefined;
    try {
      withCrossProcessFileLockSync(resourcePath, () => {
        writeFileSync(lockPath, crossProcessLockClaim('expired-owner-token', process.pid, Date.now() - CROSS_PROCESS_LOCK_LEASE_MS - 1, 'remote-test-host'));
        successor = spawnCrossProcessLockHolder(resourcePath, successorReadyPath, successorReleasePath);
        waitForFileSync(successorReadyPath);
      });

      assert.ok(successor);
      const successorClaim = JSON.parse(readFileSync(lockPath, 'utf-8')) as { token?: unknown; pid?: unknown };
      assert.equal(successorClaim.pid, successor.pid);
      assert.notEqual(successorClaim.token, 'expired-owner-token');
      assert.ok(existsSync(lockPath));

      writeFileSync(successorReleasePath, 'release\n');
      await waitForChildExit(successor);
      assert.equal(existsSync(lockPath), false);
    } finally {
      await stopChild(successor);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('reclaims a dead-owner cross-process lock', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-subagent-tracker-'));
    const resourcePath = join(cwd, 'lock-resource');
    try {
      const child = spawn(process.execPath, ['--eval', '']);
      const deadOwnerPid = child.pid;
      await waitForChildExit(child);
      assert.ok(deadOwnerPid);
      await writeFile(
        crossProcessLockPath(resourcePath),
        crossProcessLockClaim('dead-owner-token', deadOwnerPid, Date.now()),
      );

      assert.equal(withCrossProcessFileLockSync(resourcePath, () => 'dead lock recovered'), 'dead lock recovered');
      assert.equal(existsSync(crossProcessLockPath(resourcePath)), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not steal a live different-pid lock within its lease', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-subagent-tracker-'));
    const resourcePath = join(cwd, 'lock-resource');
    const lockPath = crossProcessLockPath(resourcePath);
    const liveOwner = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1_000)']);
    let operationRan = false;
    try {
      assert.ok(liveOwner.pid);
      const claim = crossProcessLockClaim('live-owner-token', liveOwner.pid, Date.now());
      await writeFile(lockPath, claim);

      assert.throws(
        () => withCrossProcessFileLockSync(resourcePath, () => {
          operationRan = true;
        }, { maxAttempts: 2, retryMs: 1 }),
        /Timed out waiting for cross-process lock/,
      );
      assert.equal(operationRan, false);
      assert.equal(readFileSync(lockPath, 'utf-8'), claim);
    } finally {
      await stopChild(liveOwner);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fences a stalled claimant after a remote-lease successor publishes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-subagent-tracker-'));
    const resourcePath = join(cwd, 'lock-resource');
    const lockPath = crossProcessLockPath(resourcePath);
    const successorReadyPath = join(cwd, 'successor-ready');
    const successorReleasePath = join(cwd, 'successor-release');
    const publicationPath = join(cwd, 'publication');
    let successor: ReturnType<typeof spawn> | undefined;
    try {
      assert.throws(
        () => withCrossProcessFileLockSync(resourcePath, (context) => {
          writeFileSync(
            lockPath,
            crossProcessLockClaim('stalled-remote-token', process.pid, Date.now() - CROSS_PROCESS_LOCK_LEASE_MS - 1, 'remote-test-host'),
          );
          successor = spawnCrossProcessLockHolder(resourcePath, successorReadyPath, successorReleasePath, publicationPath);
          waitForFileSync(successorReadyPath);
          context.assertOwnership();
          writeFileSync(publicationPath, 'stale predecessor\n');
        }),
        CrossProcessLockLostError,
      );
      assert.ok(successor);
      assert.equal(readFileSync(publicationPath, 'utf-8'), 'successor\n');
      assert.ok(existsSync(lockPath));
    } finally {
      if (successor) {
        writeFileSync(successorReleasePath, 'release\n');
        await waitForChildExit(successor);
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('prevents a fenced predecessor from publishing after its staged slot is swept', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-subagent-tracker-'));
    const resourcePath = join(cwd, 'lock-resource');
    const lockPath = crossProcessLockPath(resourcePath);
    let barrierRuns = 0;
    try {
      __setCrossProcessPublishBarrierForTest(() => {
        barrierRuns += 1;
        writeFileSync(
          lockPath,
          crossProcessLockClaim('stalled-remote-token', process.pid, Date.now() - CROSS_PROCESS_LOCK_LEASE_MS - 1, 'remote-test-host'),
        );
        withCrossProcessFileLockSync(resourcePath, (context) => {
          context.publish('S_B');
        }, { maxAttempts: 2, retryMs: 1 });
      });

      assert.throws(
        () => withCrossProcessFileLockSync(resourcePath, (context) => {
          context.publish('S_A');
        }),
        CrossProcessLockLostError,
      );
      assert.equal(barrierRuns, 1);
      assert.equal(readFileSync(resourcePath, 'utf-8'), 'S_B');
    } finally {
      __setCrossProcessPublishBarrierForTest(null);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('reports lock loss when a successor sweeps a staged slot before publication opens it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-subagent-tracker-'));
    const resourcePath = join(cwd, 'lock-resource');
    const lockPath = crossProcessLockPath(resourcePath);
    try {
      withCrossProcessFileLockSync(resourcePath, (context) => {
        writeFileSync(
          lockPath,
          crossProcessLockClaim('stalled-remote-token', process.pid, Date.now() - CROSS_PROCESS_LOCK_LEASE_MS - 1, 'remote-test-host'),
        );
        withCrossProcessFileLockSync(resourcePath, (successor) => {
          successor.publish('S_B');
        }, { maxAttempts: 2, retryMs: 1 });
        assert.throws(() => context.publish('S_A'), CrossProcessLockLostError);
      });
      assert.equal(readFileSync(resourcePath, 'utf-8'), 'S_B');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('recovers despite an abandoned legacy recovery guard', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-subagent-tracker-'));
    const resourcePath = join(cwd, 'lock-resource');
    const lockPath = crossProcessLockPath(resourcePath);
    try {
      await mkdir(`${lockPath}.guard`);
      await writeFile(lockPath, '');
      assert.equal(withCrossProcessFileLockSync(resourcePath, () => 'guard ignored'), 'guard ignored');
      assert.equal(existsSync(lockPath), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not use local pid liveness to reclaim a remote claim before its lease', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-subagent-tracker-'));
    const resourcePath = join(cwd, 'lock-resource');
    const lockPath = crossProcessLockPath(resourcePath);
    const deadOwner = spawn(process.execPath, ['--eval', '']);
    try {
      const deadOwnerPid = deadOwner.pid;
      await waitForChildExit(deadOwner);
      assert.ok(deadOwnerPid);
      const freshRemoteClaim = crossProcessLockClaim('fresh-remote-token', deadOwnerPid, Date.now(), 'remote-test-host');
      await writeFile(lockPath, freshRemoteClaim);
      assert.throws(
        () => withCrossProcessFileLockSync(resourcePath, () => 'must not run', { maxAttempts: 2, retryMs: 1 }),
        /Timed out waiting for cross-process lock/,
      );
      assert.equal(readFileSync(lockPath, 'utf-8'), freshRemoteClaim);

      await writeFile(lockPath, crossProcessLockClaim('expired-remote-token', deadOwnerPid, Date.now() - CROSS_PROCESS_LOCK_LEASE_MS - 1, 'remote-test-host'));
      assert.equal(withCrossProcessFileLockSync(resourcePath, () => 'remote lease recovered'), 'remote lease recovered');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('reclaims a same-host claim held by a reused live pid', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-subagent-tracker-'));
    const resourcePath = join(cwd, 'lock-resource');
    const lockPath = crossProcessLockPath(resourcePath);
    const pidStartId = readProcessStartIdentity(process.pid);
    try {
      if (!pidStartId) return;
      await writeFile(
        lockPath,
        crossProcessLockClaim(
          'reused-pid-token',
          process.pid,
          Date.now(),
          hostname(),
          'bogus-pid-start-id',
        ),
      );
      assert.equal(
        withCrossProcessFileLockSync(resourcePath, () => 'reused pid recovered', { maxAttempts: 1, retryMs: 1 }),
        'reused pid recovered',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses the lease fallback for legacy same-host claims without a process identity', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-subagent-tracker-'));
    const resourcePath = join(cwd, 'lock-resource');
    const lockPath = crossProcessLockPath(resourcePath);
    try {
      await writeFile(
        lockPath,
        crossProcessLockClaim('expired-legacy-token', process.pid, Date.now() - CROSS_PROCESS_LOCK_LEASE_MS - 1),
      );
      assert.equal(
        withCrossProcessFileLockSync(resourcePath, () => 'legacy lease recovered', { maxAttempts: 1, retryMs: 1 }),
        'legacy lease recovered',
      );

      const freshLegacyClaim = crossProcessLockClaim('fresh-legacy-token', process.pid, Date.now());
      await writeFile(lockPath, freshLegacyClaim);
      assert.throws(
        () => withCrossProcessFileLockSync(resourcePath, () => 'must not run', { maxAttempts: 2, retryMs: 1 }),
        /Timed out waiting for cross-process lock/,
      );
      assert.equal(readFileSync(lockPath, 'utf-8'), freshLegacyClaim);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not steal a live same-host identity-matched claim after its lease or mistake its token for ours', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-subagent-tracker-'));
    const resourcePath = join(cwd, 'lock-resource');
    const lockPath = crossProcessLockPath(resourcePath);
    const pidStartId = readProcessStartIdentity(process.pid);
    try {
      if (!pidStartId) return;
      const reusedPidClaim = crossProcessLockClaim(
        'reused-pid-token',
        process.pid,
        Date.now() - CROSS_PROCESS_LOCK_LEASE_MS - 1,
        hostname(),
        pidStartId,
      );
      await writeFile(lockPath, reusedPidClaim);
      assert.throws(
        () => withCrossProcessFileLockSync(resourcePath, () => 'must not run', { maxAttempts: 2, retryMs: 1 }),
        /Timed out waiting for cross-process lock/,
      );
      assert.equal(readFileSync(lockPath, 'utf-8'), reusedPidClaim);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('recovers empty, partial, and malformed cross-process lock claims', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-subagent-tracker-'));
    const resourcePath = join(cwd, 'lock-resource');
    const lockPath = crossProcessLockPath(resourcePath);
    try {
      for (const malformedLock of ['', '{"token":"partial"', 'not valid json\n']) {
        await writeFile(lockPath, malformedLock);
        assert.equal(
          withCrossProcessFileLockSync(resourcePath, () => 'malformed lock recovered', { maxAttempts: 1, retryMs: 1 }),
          'malformed lock recovered',
        );
        assert.equal(existsSync(lockPath), false);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses the shared recoverable lock for role-routing markers', async () => {
    const baseStateDir = await mkdtemp(join(tmpdir(), 'omx-role-routing-marker-'));
    const nowMs = Date.now();
    try {
      await writeFile(
        crossProcessLockPath(join(baseStateDir, NATIVE_SUBAGENT_ROLE_ROUTING_MARKER_FILE)),
        crossProcessLockClaim('expired-marker-token', process.pid, nowMs - CROSS_PROCESS_LOCK_LEASE_MS - 1, 'remote-test-host'),
      );
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

  it('reclaims a same-host claim after a reboot changes the boot id', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-subagent-tracker-'));
    const resourcePath = join(cwd, 'lock-resource');
    const lockPath = crossProcessLockPath(resourcePath);
    const pidStartId = readProcessStartIdentity(process.pid);
    try {
      if (!pidStartId) return;
      const starttime = pidStartId.slice(pidStartId.indexOf(':') + 1);
      const rebootedClaim = crossProcessLockClaim(
        'pre-reboot-token',
        process.pid,
        Date.now(),
        hostname(),
        `pre-reboot-boot-id:${starttime}`,
      );
      await writeFile(lockPath, rebootedClaim);
      assert.equal(
        withCrossProcessFileLockSync(resourcePath, () => 'reboot recovered', { maxAttempts: 1, retryMs: 1 }),
        'reboot recovered',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fences a stalled role-routing marker writer after a successor publishes and leaves no temp artifacts', async () => {
    const baseStateDir = await mkdtemp(join(tmpdir(), 'omx-role-routing-marker-'));
    const markerPath = join(baseStateDir, NATIVE_SUBAGENT_ROLE_ROUTING_MARKER_FILE);
    const lockPath = crossProcessLockPath(markerPath);
    const nowMs = Date.now();
    let barrierRuns = 0;
    const markerFor = (sessionId: string) => ({
      schema_version: 1 as const,
      cwd: '/workspace/project',
      session_id: sessionId,
      parent_thread_id: 'thread-parent',
      observed_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + 60_000).toISOString(),
    });
    try {
      __setCrossProcessPublishBarrierForTest(() => {
        barrierRuns += 1;
        writeFileSync(
          lockPath,
          crossProcessLockClaim('stalled-marker-token', process.pid, nowMs - CROSS_PROCESS_LOCK_LEASE_MS - 1, 'remote-test-host'),
        );
        writeRoleRoutingMarker(baseStateDir, markerFor('sess-successor'));
      });

      assert.throws(() => writeRoleRoutingMarker(baseStateDir, markerFor('sess-stalled')), CrossProcessLockLostError);
      assert.equal(barrierRuns, 1);
      assert.equal(
        readRoleRoutingMarker(baseStateDir, { cwd: '/workspace/project', sessionId: 'sess-successor', parentThreadId: 'thread-parent', nowMs })?.session_id,
        'sess-successor',
      );
      assert.equal(
        readRoleRoutingMarker(baseStateDir, { cwd: '/workspace/project', sessionId: 'sess-stalled', parentThreadId: 'thread-parent', nowMs }),
        null,
      );
      assert.deepEqual(
        readdirSync(baseStateDir).filter((entry) => entry.includes('.stage.') || entry.endsWith('.tmp')),
        [],
      );
    } finally {
      __setCrossProcessPublishBarrierForTest(null);
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
