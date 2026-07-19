import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ralplanCommand } from '../ralplan.js';
import { dispatchCodexNativeHook } from '../../scripts/codex-native-hook.js';
import { signNativeLaunchClaim } from '../../subagents/native-anchor-auth.js';

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

test('#3212 binds an attested receipt to child SessionStart and releases the next role', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-3212-child-bind-'));
  const canonical = 'omx-child-bind-3212';
  const native = 'native-child-bind-leader-3212';
  const child = 'native-child-bind-worker-3212';
  const launchId = 'launch-child-bind-3212';
  const previous = { CODEX_HOME: process.env.CODEX_HOME, OMX_ROOT: process.env.OMX_ROOT, OMX_ENTRY_PATH: process.env.OMX_ENTRY_PATH, OMX_CODEX_LAUNCH_ID: process.env.OMX_CODEX_LAUNCH_ID };
  try {
    const codexHome = join(cwd, '.codex-home');
    await mkdir(join(codexHome, '.omx'), { recursive: true });
    await writeFile(join(codexHome, '.omx', 'native-anchor-auth.key'), Buffer.alloc(32, 13));
    process.env.CODEX_HOME = codexHome;
    delete process.env.OMX_ROOT;
    process.env.OMX_ENTRY_PATH = join(process.cwd(), 'dist', 'cli', 'omx.js');
    process.env.OMX_CODEX_LAUNCH_ID = launchId;
    await writeJson(join(cwd, '.omx', 'state', 'session.json'), { session_id: canonical, native_session_id: native, cwd });
    await writeJson(join(cwd, '.omx', 'state', 'plugin-hook-launches', `${launchId}.json`), {
      sessionId: native,
      signature: signNativeLaunchClaim(launchId, native),
    });
    const rootTranscript = join(cwd, 'root.jsonl');
    await writeJson(rootTranscript, { type: 'session_meta', payload: { id: native, session_id: native, cwd, originator: 'codex_exec', source: 'exec', thread_source: 'user' } });
    const preTool = await dispatchCodexNativeHook({
      hook_event_name: 'PreToolUse', cwd, session_id: native, transcript_path: rootTranscript,
      tool_name: 'Bash', tool_input: { command: 'omx ralplan role-intent write --role architect --parent-thread "$CODEX_THREAD_ID" --json' },
    }, { cwd });
    assert.equal(preTool.outputJson, null);

    const stdout: string[] = [];
    await ralplanCommand(['role-intent', 'write', '--role', 'architect', '--parent-thread', native, '--session', canonical, '--json'], {
      cwd: () => cwd,
      stdout: (line) => stdout.push(line),
      generateCorrelationToken: () => 'd'.repeat(32),
    });
    const spawnTaskName = JSON.parse(stdout[0]!).spawn_task_name as string;
    const childTranscript = join(cwd, 'child.jsonl');
    await writeJson(childTranscript, { type: 'session_meta', payload: { id: child, session_id: child, source: { subagent: { thread_spawn: { parent_thread_id: native, task_name: spawnTaskName } } } } });
    await dispatchCodexNativeHook({ hook_event_name: 'SessionStart', cwd, session_id: child, transcript_path: childTranscript }, { cwd });

    const tracker = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'subagent-tracking.json'), 'utf8'));
    assert.equal(tracker.sessions[canonical].threads[child].role, 'architect');
    assert.equal(tracker.sessions[canonical].threads[child].provenance_kind, 'omx_adapted');
    assert.equal(tracker.pending_role_intents.length, 0);
    const next: string[] = [];
    await ralplanCommand(['role-intent', 'write', '--role', 'critic', '--parent-thread', native, '--session', canonical, '--json'], {
      cwd: () => cwd,
      stdout: (line) => next.push(line),
      generateCorrelationToken: () => 'e'.repeat(32),
    });
    assert.equal(JSON.parse(next[0]!).intent.role, 'critic');
  } finally {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(cwd, { recursive: true, force: true });
  }
});
