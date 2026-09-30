import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createSubagentTrackingState, readSubagentTrackingState, recordSubagentTurnForSession, subagentTrackingPath } from '../tracker.js';

describe('Subagent Stop completion recording (#3729)', () => {
  it('recordSubagentTurnForSession records completion when called with completed: true', async () => {
    const cwd = mkdtempSync(join(process.cwd(), 'tmp-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });

      const parentSessionId = 'parent-session';
      const childThreadId = 'child-thread';

      // Initialize tracking with parent and child
      let state = createSubagentTrackingState();
      await writeFile(subagentTrackingPath(cwd), JSON.stringify(state));

      // Record the parent session and child thread
      await recordSubagentTurnForSession(cwd, {
        sessionId: parentSessionId,
        threadId: 'parent-thread',
        kind: 'leader',
      });

      await recordSubagentTurnForSession(cwd, {
        sessionId: parentSessionId,
        threadId: childThreadId,
        kind: 'subagent',
        role: 'architect',
      });

      // Verify they were recorded
      let tracking = await readSubagentTrackingState(cwd);
      assert.ok(
        tracking.sessions?.[parentSessionId]?.threads?.[childThreadId],
        'Child thread should be tracked before completion'
      );

      // Now record the completion
      await recordSubagentTurnForSession(cwd, {
        sessionId: parentSessionId,
        threadId: childThreadId,
        completed: true,
        completionSource: 'test-completion',
      });

      // Verify completion was recorded
      tracking = await readSubagentTrackingState(cwd);
      const completedThread = tracking.sessions?.[parentSessionId]?.threads?.[childThreadId];
      assert.ok(completedThread, 'Child thread should still exist after completion');
      assert.ok(completedThread.completed_at, `completed_at should be set. Thread: ${JSON.stringify(completedThread)}`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
