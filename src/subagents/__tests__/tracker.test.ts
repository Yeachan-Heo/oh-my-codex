import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createSubagentTrackingState,
  recordSubagentTurn,
  summarizeSubagentSession,
} from '../tracker.js';

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
      updatedAt: '2026-03-17T00:01:00.000Z',
    });

    const drained = summarizeSubagentSession(state, 'sess-1', {
      now: '2026-03-17T00:03:30.000Z',
      activeWindowMs: 60_000,
    });
    assert.deepEqual(drained?.activeSubagentThreadIds, []);
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
    assert.equal(
      state.sessions['sess-1']?.threads['sub-thread-1']?.completion_source,
      'notify-fallback-watcher',
    );
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
    const thread = state.sessions['sess-1']?.threads['sub-thread-1'];

    assert.deepEqual(summary?.activeSubagentThreadIds, ['sub-thread-1']);
    assert.equal(thread?.completed_at, undefined);
    assert.equal(thread?.last_completed_turn_id, undefined);
    assert.equal(thread?.completion_source, undefined);
    assert.equal(thread?.last_turn_id, 'turn-3');
  });

});
