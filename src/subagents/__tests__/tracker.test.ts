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
