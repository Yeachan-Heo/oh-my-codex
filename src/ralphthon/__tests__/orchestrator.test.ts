import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RalphthonOrchestrator, parseRalphthonMarkers } from '../orchestrator.js';
import { createRalphthonPrd, findTaskRef } from '../prd.js';
import { createRalphthonRuntimeState, type RalphthonRuntimeState } from '../runtime.js';

describe('parseRalphthonMarkers', () => {
  it('extracts task and hardening markers from pane output', () => {
    const markers = parseRalphthonMarkers([
      'noise',
      '[RALPHTHON_TASK_START] id=T1',
      '[RALPHTHON_TASK_FAILED] id=T1 reason=test failure',
      '[RALPHTHON_HARDENING_GENERATED] wave=2 count=3',
    ].join('\n'));

    assert.deepEqual(markers.map((marker) => marker.type), ['task_start', 'task_failed', 'hardening_generated']);
  });
});

describe('RalphthonOrchestrator', () => {
  it('injects the next pending development task when the leader is idle', async () => {
    let nowMs = Date.parse('2026-03-16T00:00:00.000Z');
    let prd = createRalphthonPrd({
      project: 'task-picker',
      stories: [{
        id: 'S1',
        title: 'Story 1',
        status: 'pending',
        tasks: [{ id: 'T1', desc: 'Implement login', status: 'pending', retries: 0 }],
      }],
    });
    let runtime = createRalphthonRuntimeState('%1');
    const injected: string[] = [];

    const orchestrator = new RalphthonOrchestrator({
      readPrd: async () => prd,
      writePrd: async (next) => { prd = next; },
      readRuntime: async () => runtime,
      writeRuntime: async (next) => { runtime = next; },
      capturePane: async () => 'idle prompt',
      injectPrompt: async (_target, prompt) => { injected.push(prompt); return true; },
      now: () => new Date(nowMs),
    });

    await orchestrator.tick();

    assert.equal(injected.length, 1);
    assert.match(injected[0] || '', /\[RALPHTHON_ASSIGN\] id=T1/);
    assert.equal(runtime.activeTaskId, 'T1');
  });

  it('retries failed tasks up to the configured limit before alerting', async () => {
    let nowMs = Date.parse('2026-03-16T00:00:00.000Z');
    let prd = createRalphthonPrd({
      project: 'retries',
      stories: [{
        id: 'S1',
        title: 'Story 1',
        status: 'pending',
        tasks: [{ id: 'T1', desc: 'Flaky task', status: 'pending', retries: 0 }],
      }],
      config: { maxRetries: 3 },
    });
    let runtime = createRalphthonRuntimeState('%1');
    const alerts: string[] = [];
    let capture = '[RALPHTHON_TASK_FAILED] id=T1 reason=oops';

    const orchestrator = new RalphthonOrchestrator({
      readPrd: async () => prd,
      writePrd: async (next) => { prd = next; },
      readRuntime: async () => runtime,
      writeRuntime: async (next) => { runtime = next; },
      capturePane: async () => capture,
      injectPrompt: async () => true,
      alert: async (message) => { alerts.push(message); },
      now: () => new Date(nowMs),
    });

    await orchestrator.tick();
    assert.equal(prd.stories[0]?.tasks[0]?.status, 'pending');
    assert.equal(prd.stories[0]?.tasks[0]?.retries, 1);

    nowMs += 121_000;
    capture = [
      '[RALPHTHON_TASK_FAILED] id=T1 reason=oops',
      '[RALPHTHON_TASK_FAILED] id=T1 reason=still-bad',
    ].join('\n');
    await orchestrator.tick();
    assert.equal(prd.stories[0]?.tasks[0]?.retries, 2);
    assert.equal(alerts.length, 0);

    nowMs += 121_000;
    capture = [
      '[RALPHTHON_TASK_FAILED] id=T1 reason=oops',
      '[RALPHTHON_TASK_FAILED] id=T1 reason=still-bad',
      '[RALPHTHON_TASK_FAILED] id=T1 reason=third-time',
    ].join('\n');
    await orchestrator.tick();
    assert.equal(prd.stories[0]?.tasks[0]?.status, 'failed');
    assert.equal(prd.stories[0]?.tasks[0]?.retries, 3);
    assert.equal(alerts.length, 1);
  });

  it('reprocesses repeated identical markers across retries by diffing new capture output', async () => {
    let nowMs = Date.parse('2026-03-16T00:00:00.000Z');
    let prd = createRalphthonPrd({
      project: 'retry-starts',
      stories: [{
        id: 'S1',
        title: 'Story 1',
        status: 'pending',
        tasks: [{ id: 'T1', desc: 'Retry me', status: 'pending', retries: 0 }],
      }],
      config: { maxRetries: 3, pollIntervalSec: 1 },
    });
    let runtime = createRalphthonRuntimeState('%1');
    let capture = '[RALPHTHON_TASK_START] id=T1';

    const orchestrator = new RalphthonOrchestrator({
      readPrd: async () => prd,
      writePrd: async (next) => { prd = next; },
      readRuntime: async () => runtime,
      writeRuntime: async (next) => { runtime = next; },
      capturePane: async () => capture,
      injectPrompt: async () => true,
      now: () => new Date(nowMs),
    });

    await orchestrator.tick();
    assert.equal(findTaskRef(prd, 'T1')?.task.status, 'in_progress');

    nowMs += 2_000;
    capture += '\n[RALPHTHON_TASK_FAILED] id=T1 reason=first';
    await orchestrator.tick();
    assert.equal(findTaskRef(prd, 'T1')?.task.status, 'pending');
    assert.equal(findTaskRef(prd, 'T1')?.task.retries, 1);

    nowMs += 2_000;
    capture += '\n[RALPHTHON_TASK_START] id=T1';
    await orchestrator.tick();
    assert.equal(findTaskRef(prd, 'T1')?.task.status, 'in_progress');
  });

  it('recovers stalled in-progress tasks by requeueing and reinjecting them', async () => {
    let nowMs = Date.parse('2026-03-16T00:00:00.000Z');
    let prd = createRalphthonPrd({
      project: 'stalled-in-progress',
      stories: [{
        id: 'S1',
        title: 'Story 1',
        status: 'pending',
        tasks: [{ id: 'T1', desc: 'Long task', status: 'pending', retries: 0 }],
      }],
      config: { pollIntervalSec: 1, idleTimeoutSec: 1 },
    });
    let runtime: RalphthonRuntimeState = {
      ...createRalphthonRuntimeState('%1'),
      activeTaskId: 'T1',
      lastInjectionAt: '2026-03-16T00:00:00.000Z',
      lastInjectedTaskId: 'T1',
      lastOutputChangeAt: '2026-03-16T00:00:00.000Z',
      lastPollAt: '2026-03-16T00:00:00.000Z',
    };
    prd = {
      ...prd,
      stories: [{
        ...prd.stories[0]!,
        tasks: [{ ...prd.stories[0]!.tasks[0]!, status: 'in_progress', startedAt: '2026-03-16T00:00:00.000Z' }],
      }],
    };
    const injected: string[] = [];

    const orchestrator = new RalphthonOrchestrator({
      readPrd: async () => prd,
      writePrd: async (next) => { prd = next; },
      readRuntime: async () => runtime,
      writeRuntime: async (next) => { runtime = next; },
      capturePane: async () => 'quiet pane',
      injectPrompt: async (_target, prompt) => { injected.push(prompt); return true; },
      now: () => new Date(nowMs),
    });

    nowMs += 2_000;
    await orchestrator.tick();

    assert.equal(findTaskRef(prd, 'T1')?.task.status, 'pending');
    assert.equal(findTaskRef(prd, 'T1')?.task.lastError, 'stalled-waiting-for-ralphthon-marker');
    assert.equal(injected.length, 1);
    assert.match(injected[0] || '', /\[RALPHTHON_ASSIGN\] id=T1/);
  });

  it('enters hardening after development work is complete and injects a hardening wave prompt', async () => {
    let nowMs = Date.parse('2026-03-16T00:00:00.000Z');
    let prd = createRalphthonPrd({
      project: 'hardening-mode',
      stories: [{
        id: 'S1',
        title: 'Story 1',
        status: 'done',
        tasks: [{ id: 'T1', desc: 'Core feature', status: 'done', retries: 0 }],
      }],
    });
    let runtime = createRalphthonRuntimeState('%1');
    const injected: string[] = [];

    const orchestrator = new RalphthonOrchestrator({
      readPrd: async () => prd,
      writePrd: async (next) => { prd = next; },
      readRuntime: async () => runtime,
      writeRuntime: async (next) => { runtime = next; },
      capturePane: async () => 'quiet leader pane',
      injectPrompt: async (_target, prompt) => { injected.push(prompt); return true; },
      now: () => new Date(nowMs),
    });

    const result = await orchestrator.tick();

    assert.equal(result.phase, 'hardening');
    assert.equal(prd.phase, 'hardening');
    assert.equal(injected.length, 1);
    assert.match(injected[0] || '', /\[RALPHTHON_HARDENING_WAVE\] wave=1/);
  });


  it('waits for active native subagent threads before injecting another task', async () => {
    let nowMs = Date.parse('2026-03-16T00:00:00.000Z');
    let prd = createRalphthonPrd({
      project: 'subagent-wait',
      stories: [{
        id: 'S1',
        title: 'Story 1',
        status: 'pending',
        tasks: [{ id: 'T1', desc: 'Implement with helpers', status: 'pending', retries: 0 }],
      }],
      config: { pollIntervalSec: 1, idleTimeoutSec: 1 },
    });
    let runtime: RalphthonRuntimeState = {
      ...createRalphthonRuntimeState('%1'),
      subagentSessionId: 'sess-1',
    };
    const injected: string[] = [];

    const orchestrator = new RalphthonOrchestrator({
      readPrd: async () => prd,
      writePrd: async (next) => { prd = next; },
      readRuntime: async () => runtime,
      writeRuntime: async (next) => { runtime = next; },
      readSubagentSummary: async () => ({
        sessionId: 'sess-1',
        leaderThreadId: 'leader-thread',
        allThreadIds: ['leader-thread', 'sub-thread-1'],
        allSubagentThreadIds: ['sub-thread-1'],
        activeSubagentThreadIds: ['sub-thread-1'],
        updatedAt: '2026-03-16T00:00:00.000Z',
      }),
      capturePane: async () => 'quiet pane',
      injectPrompt: async (_target, prompt) => { injected.push(prompt); return true; },
      now: () => new Date(nowMs),
    });

    const result = await orchestrator.tick();

    assert.equal(result.completed, false);
    assert.equal(injected.length, 0);
    assert.deepEqual(runtime.activeSubagentThreadIds, ['sub-thread-1']);
    assert.equal(runtime.subagentWaitReason, 'waiting_for_1_native_subagent_threads');
  });

  it('waits for active native subagent threads before completing hardening', async () => {
    let prd = createRalphthonPrd({
      project: 'subagent-complete-gate',
      stories: [],
      hardening: [],
    });
    prd = {
      ...prd,
      phase: 'hardening',
      runtime: {
        currentHardeningWave: 3,
        consecutiveHardeningNoIssueWaves: 3,
      },
    };
    let runtime: RalphthonRuntimeState = {
      ...createRalphthonRuntimeState('%1'),
      subagentSessionId: 'sess-2',
    };

    const orchestrator = new RalphthonOrchestrator({
      readPrd: async () => prd,
      writePrd: async (next) => { prd = next; },
      readRuntime: async () => runtime,
      writeRuntime: async (next) => { runtime = next; },
      readSubagentSummary: async () => ({
        sessionId: 'sess-2',
        leaderThreadId: 'leader-thread',
        allThreadIds: ['leader-thread', 'sub-thread-1'],
        allSubagentThreadIds: ['sub-thread-1'],
        activeSubagentThreadIds: ['sub-thread-1'],
        updatedAt: '2026-03-16T00:00:00.000Z',
      }),
      capturePane: async () => 'idle',
      injectPrompt: async () => true,
    });

    const result = await orchestrator.tick();

    assert.equal(result.completed, false);
    assert.equal(prd.phase, 'hardening');
    assert.equal(runtime.subagentWaitReason, 'waiting_for_1_native_subagent_threads');
  });

  it('terminates after three hardening waves with no new issues', async () => {
    let prd = createRalphthonPrd({
      project: 'done-done',
      stories: [],
      hardening: [],
    });
    prd = {
      ...prd,
      phase: 'hardening',
      runtime: {
        currentHardeningWave: 3,
        consecutiveHardeningNoIssueWaves: 3,
      },
    };
    let runtime = createRalphthonRuntimeState('%1');
    const modePatches: Array<Record<string, unknown>> = [];

    const orchestrator = new RalphthonOrchestrator({
      readPrd: async () => prd,
      writePrd: async (next) => { prd = next; },
      readRuntime: async () => runtime,
      writeRuntime: async (next) => { runtime = next; },
      capturePane: async () => 'idle',
      injectPrompt: async () => true,
      updateModeState: async (patch) => { modePatches.push(patch); },
    });

    const result = await orchestrator.tick();

    assert.equal(result.completed, true);
    assert.equal(prd.phase, 'complete');
    assert.equal(modePatches.some((patch) => patch.current_phase === 'complete'), true);
  });
});
