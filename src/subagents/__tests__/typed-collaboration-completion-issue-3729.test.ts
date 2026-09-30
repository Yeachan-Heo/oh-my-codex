import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createSubagentTrackingState, readSubagentTrackingState, subagentTrackingPath } from '../tracker.js';
import { dispatchCodexNativeHook } from '../../scripts/codex-native-hook.js';

describe('Issue #3729: Typed native collaboration completion tracking', () => {
  it('records completion of typed collaboration child (architect) in parent session tracking', async () => {
    const cwd = mkdtempSync(join(process.cwd(), 'tmp-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });

      // Parent (root) session info
      const ownerNativeSessionId = 'owner-native-sess-001';
      
      // Child (architect) session info
      const childNativeSessionId = 'child-arch-sess-001';

      // Write initial empty tracking state
      const initialTracking = createSubagentTrackingState();
      await writeFile(subagentTrackingPath(cwd), JSON.stringify(initialTracking));

      // Step 1: SessionStart hook for parent session
      const parentTranscriptPath = join(cwd, 'parent-transcript.jsonl');
      writeFileSync(parentTranscriptPath, JSON.stringify({
        type: 'session_meta',
        payload: { id: ownerNativeSessionId },
      }) + '\n');

      await dispatchCodexNativeHook(
        {
          hook_event_name: 'SessionStart',
          cwd,
          session_id: ownerNativeSessionId,
          sessionId: ownerNativeSessionId,
          transcript_path: parentTranscriptPath,
        },
        { cwd, sessionOwnerPid: process.pid }
      );

      // Step 2: SessionStart hook for typed collaboration child (architect)
      // This payload simulates a Codex App typed collaboration spawn
      const childTranscriptPath = join(cwd, 'child-arch-transcript.jsonl');
      writeFileSync(childTranscriptPath, JSON.stringify({
        type: 'session_meta',
        payload: {
          id: childNativeSessionId,
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: ownerNativeSessionId,
                depth: 1,
                agent_nickname: 'Architect',
                agent_role: 'architect',
              },
            },
          },
        },
      }) + '\n');

      await dispatchCodexNativeHook(
        {
          hook_event_name: 'SessionStart',
          cwd,
          session_id: childNativeSessionId,
          sessionId: childNativeSessionId,
          transcript_path: childTranscriptPath,
        },
        { cwd, sessionOwnerPid: process.pid }
      );

      // Verify child is tracked after SessionStart
      let tracking = await readSubagentTrackingState(cwd);
      const childThreadId = childNativeSessionId;
      const childThread = tracking.sessions?.[ownerNativeSessionId]?.threads?.[childThreadId];
      assert.ok(childThread, `Child thread ${childThreadId} should be tracked after SessionStart in parent session ${ownerNativeSessionId}`);
      assert.equal(childThread.role, 'architect', 'Child should have architect role');
      assert.equal(childThread.kind, 'subagent', 'Child should be marked as subagent');

      // Step 3: Stop hook for the child (representing completion)
      const childStopTranscriptPath = join(cwd, 'child-arch-stop-transcript.jsonl');
      writeFileSync(childStopTranscriptPath, '');

      await dispatchCodexNativeHook(
        {
          hook_event_name: 'Stop',
          cwd,
          session_id: childNativeSessionId,
          sessionId: childNativeSessionId,
          transcript_path: childStopTranscriptPath,
        },
        { cwd, sessionOwnerPid: process.pid }
      );

      // Step 4: Verify completion is tracked in parent session
      tracking = await readSubagentTrackingState(cwd);
      const completedThread = tracking.sessions?.[ownerNativeSessionId]?.threads?.[childThreadId];
      assert.ok(completedThread, 'Child thread should still be present after Stop');
      assert.ok(
        completedThread.completed_at,
        `Child thread should have completed_at set after Stop hook. Current state: ${JSON.stringify(completedThread)}`
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('records completion of typed collaboration child (critic) in parent session tracking', async () => {
    const cwd = mkdtempSync(join(process.cwd(), 'tmp-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });

      // Parent (root) session info
      const ownerNativeSessionId = 'owner-native-sess-002';
      
      // Child (critic) session info
      const childNativeSessionId = 'child-critic-sess-001';

      // Write initial empty tracking state
      const initialTracking = createSubagentTrackingState();
      await writeFile(subagentTrackingPath(cwd), JSON.stringify(initialTracking));

      // Step 1: SessionStart hook for parent session
      const parentTranscriptPath = join(cwd, 'parent-transcript.jsonl');
      writeFileSync(parentTranscriptPath, JSON.stringify({
        type: 'session_meta',
        payload: { id: ownerNativeSessionId },
      }) + '\n');

      await dispatchCodexNativeHook(
        {
          hook_event_name: 'SessionStart',
          cwd,
          session_id: ownerNativeSessionId,
          sessionId: ownerNativeSessionId,
          transcript_path: parentTranscriptPath,
        },
        { cwd, sessionOwnerPid: process.pid }
      );

      // Step 2: SessionStart hook for typed collaboration child (critic)
      const childTranscriptPath = join(cwd, 'child-critic-transcript.jsonl');
      writeFileSync(childTranscriptPath, JSON.stringify({
        type: 'session_meta',
        payload: {
          id: childNativeSessionId,
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: ownerNativeSessionId,
                depth: 1,
                agent_nickname: 'Critic',
                agent_role: 'critic',
              },
            },
          },
        },
      }) + '\n');

      await dispatchCodexNativeHook(
        {
          hook_event_name: 'SessionStart',
          cwd,
          session_id: childNativeSessionId,
          sessionId: childNativeSessionId,
          transcript_path: childTranscriptPath,
        },
        { cwd, sessionOwnerPid: process.pid }
      );

      // Verify child is tracked after SessionStart
      let tracking = await readSubagentTrackingState(cwd);
      const childThreadId = childNativeSessionId;
      const childThread = tracking.sessions?.[ownerNativeSessionId]?.threads?.[childThreadId];
      assert.ok(childThread, `Child thread ${childThreadId} should be tracked after SessionStart`);
      assert.equal(childThread.role, 'critic', 'Child should have critic role');

      // Step 3: Stop hook for the child
      const childStopTranscriptPath = join(cwd, 'child-critic-stop-transcript.jsonl');
      writeFileSync(childStopTranscriptPath, '');

      await dispatchCodexNativeHook(
        {
          hook_event_name: 'Stop',
          cwd,
          session_id: childNativeSessionId,
          sessionId: childNativeSessionId,
          transcript_path: childStopTranscriptPath,
        },
        { cwd, sessionOwnerPid: process.pid }
      );

      // Step 4: Verify completion is tracked
      tracking = await readSubagentTrackingState(cwd);
      const completedThread = tracking.sessions?.[ownerNativeSessionId]?.threads?.[childThreadId];
      assert.ok(completedThread, 'Child thread should still be present after Stop');
      assert.ok(
        completedThread.completed_at,
        `Child thread should have completed_at set after Stop hook. Current state: ${JSON.stringify(completedThread)}`
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
