import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createSubagentTrackingState, readSubagentTrackingState, recordSubagentTurnForSession, subagentTrackingPath } from '../tracker.js';
import { dispatchCodexNativeHook } from '../../scripts/codex-native-hook.js';

describe('Issue #3729: Record agent mode in typed collaboration tracking', () => {
  it('SessionStart for typed collaboration child records agent mode', async () => {
    const cwd = mkdtempSync(join(process.cwd(), 'tmp-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });

      const ownerNativeSessionId = 'owner-native-sess-001';
      const childNativeSessionId = 'child-arch-sess-001';

      const initialTracking = createSubagentTrackingState();
      await writeFile(subagentTrackingPath(cwd), JSON.stringify(initialTracking));

      // SessionStart for parent/owner session
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

      // SessionStart for typed collaboration child (architect)
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

      // Verify child is tracked and has the role recorded
      let tracking = await readSubagentTrackingState(cwd);
      const childThreadId = childNativeSessionId;
      const childThread = tracking.sessions?.[ownerNativeSessionId]?.threads?.[childThreadId];
      assert.ok(childThread, `Child thread should be tracked in owner session ${ownerNativeSessionId}`);
      assert.equal(
        childThread.mode,
        'architect',
        `Child should have mode='architect' set so it can be properly identified. Got: ${JSON.stringify(childThread)}`
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
