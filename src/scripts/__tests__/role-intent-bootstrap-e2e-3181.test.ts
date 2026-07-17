import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { recordSubagentTurnForSession, readSubagentTrackingState } from '../../subagents/tracker.js';
import { dispatchCodexNativeHook } from '../codex-native-hook.js';

describe('#3194 role-intent native-hook e2e', () => {
  it('does not treat legacy thread_id as leader authority and preserves a child record', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3194-'));
    try {
      await recordSubagentTurnForSession(cwd, {
        sessionId: 'synthetic-leader-session', threadId: 'synthetic-child-thread', kind: 'subagent',
        leaderThreadId: 'synthetic-leader-thread', timestamp: new Date(0).toISOString(),
      });
      const before = await readSubagentTrackingState(cwd);
      const result = await dispatchCodexNativeHook({
        hook_event_name: 'PreToolUse', cwd, session_id: 'synthetic-child-thread', thread_id: 'synthetic-child-thread',
        tool_name: 'Bash', tool_use_id: 'synthetic-tool-use', tool_input: { command: 'omx ralplan role-intent write --role architect --parent-thread "$CODEX_THREAD_ID" --json' },
      }, { cwd, sessionOwnerPid: process.pid });
      assert.deepEqual(result.outputJson, {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse', permissionDecision: 'deny',
          permissionDecisionReason: 'unsupported_documented_leader_proof: Codex 0.144.5 hooks do not expose documented root identity required for adapted Ralplan.',
        },
      });
      assert.deepEqual(await readSubagentTrackingState(cwd), before);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not create session state for a fresh documented payload without thread_id', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3194-'));
    try {
      const result = await dispatchCodexNativeHook({
        hook_event_name: 'PreToolUse', cwd, session_id: 'synthetic-session', tool_name: 'Bash', tool_use_id: 'synthetic-tool-use',
        tool_input: { command: 'omx ralplan role-intent write --role architect --parent-thread "$CODEX_THREAD_ID" --json' },
      }, { cwd, sessionOwnerPid: process.pid });
      assert.deepEqual(result.outputJson, {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse', permissionDecision: 'deny',
          permissionDecisionReason: 'unsupported_documented_leader_proof: Codex 0.144.5 hooks do not expose documented root identity required for adapted Ralplan.',
        },
      });
      assert.equal(existsSync(join(cwd, '.omx', 'state')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not mutate a foreign or stale pointer before denying the documented payload', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3194-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      const pointerPath = join(stateDir, 'session.json');
      const pointer = '{"session_id":"synthetic-foreign","native_session_id":"synthetic-foreign","started_at":"1970-01-01T00:00:00.000Z"}\n';
      await mkdir(stateDir, { recursive: true });
      await writeFile(pointerPath, pointer);
      const result = await dispatchCodexNativeHook({
        hook_event_name: 'PreToolUse', cwd, session_id: 'synthetic-current', tool_name: 'Bash', tool_use_id: 'synthetic-tool-use',
        tool_input: { command: 'omx ralplan role-intent write --role architect --parent-thread "$CODEX_THREAD_ID" --json' },
      }, { cwd, sessionOwnerPid: process.pid });
      assert.deepEqual(result.outputJson, {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse', permissionDecision: 'deny',
          permissionDecisionReason: 'unsupported_documented_leader_proof: Codex 0.144.5 hooks do not expose documented root identity required for adapted Ralplan.',
        },
      });
      assert.equal(await readFile(pointerPath, 'utf8'), pointer);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
