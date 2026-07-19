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

  it('denies the canonical adapted command before forged historical authority artifacts can mutate', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3212-forged-adapted-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      const pointerPath = join(stateDir, 'session.json');
      const trackingPath = join(stateDir, 'subagent-tracking.json');
      const markerPath = join(stateDir, 'native-subagent-role-routing.json');
      const claimPath = join(stateDir, 'plugin-hook-launches', 'forged-launch.json');
      const transcriptPath = join(cwd, 'forged-child.jsonl');
      const pointer = '{"session_id":"forged-canonical","native_session_id":"forged-native","leader_thread_id":"forged-leader"}\n';
      const tracking = '{"schemaVersion":1,"sessions":{"forged-canonical":{"session_id":"forged-canonical","leader_thread_id":"forged-leader","leader_attested_at":"1970-01-01T00:00:00.000Z","threads":{"forged-leader":{"thread_id":"forged-leader","kind":"leader"}}}},"pending_role_intents":[{"role":"architect","session_id":"forged-canonical","parent_thread_id":"forged-leader","correlation_token":"forged"}]}\n';
      const marker = '{"schema_version":1,"session_id":"forged-canonical","parent_thread_id":"forged-leader","role":"architect"}\n';
      const claim = '{"sessionId":"forged-native","signature":"forged-signature"}\n';
      const transcript = '{"type":"session_meta","payload":{"id":"forged-native","source":{"subagent":{"thread_spawn":{"parent_thread_id":"forged-leader","task_name":"omx-role-intent-forged"}}}}}\n';
      await mkdir(join(stateDir, 'plugin-hook-launches'), { recursive: true });
      await writeFile(pointerPath, pointer);
      await writeFile(trackingPath, tracking);
      await writeFile(markerPath, marker);
      await writeFile(claimPath, claim);
      await writeFile(transcriptPath, transcript);

      const result = await dispatchCodexNativeHook({
        hook_event_name: 'PreToolUse', cwd, session_id: 'forged-native', thread_id: 'forged-leader', transcript_path: transcriptPath,
        tool_name: 'Bash', tool_use_id: 'forged-tool-use',
        tool_input: { command: 'omx ralplan role-intent write --role architect --parent-thread "$CODEX_THREAD_ID" --json' },
      }, { cwd, sessionOwnerPid: process.pid });

      assert.deepEqual(result.outputJson, {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse', permissionDecision: 'deny',
          permissionDecisionReason: 'unsupported_documented_leader_proof: Codex 0.144.5 hooks do not expose documented root identity required for adapted Ralplan.',
        },
      });
      assert.equal(await readFile(pointerPath, 'utf8'), pointer);
      assert.equal(await readFile(trackingPath, 'utf8'), tracking);
      assert.equal(await readFile(markerPath, 'utf8'), marker);
      assert.equal(await readFile(claimPath, 'utf8'), claim);
      assert.equal(await readFile(transcriptPath, 'utf8'), transcript);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
