import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { dispatchCodexNativeHook } from "../codex-native-hook.js";
import { initTeamState, writeWorkerIdentity } from "../../team/state.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "omx-issue-4086-stop-hook-lock-"));
  roots.push(cwd);
  return cwd;
}

async function staleLock(lockDir: string, token?: string): Promise<void> {
  await mkdir(lockDir, { recursive: true });
  if (token !== undefined) await writeFile(join(lockDir, 'owner'), token);
  await writeFile(join(lockDir, 'lease'), 'abandoned');
  const old = new Date(Date.now() - 10 * 60_000);
  await utimes(join(lockDir, 'lease'), old, old);
  await utimes(lockDir, old, old);
}

describe('issue #4086: stop hook with stale team lock', () => {
  it('stop hook with stale team lock should return continue:false (terminal)', async () => {
    const cwd = await workspace();
    const team = 'audit';
    const workerName = 'executor-1';

    // Initialize team state
    await initTeamState(team, 'stop hook lock test', 'executor', 1, cwd);

    // Write worker identity to make this appear as a team worker
    await writeWorkerIdentity(team, workerName, {
      name: workerName,
      index: 1,
      role: 'executor',
      assigned_tasks: [],
    }, cwd);

    // Create a stale team membership lock
    const lockDir = join(cwd, '.omx/state/.team-locks', `${team}.membership`);
    const staleLockToken = '99999999.0.dead';
    await staleLock(lockDir, staleLockToken);

    // Set up environment to identify as a team worker
    const originalEnv = process.env;
    process.env.OMX_TEAM_WORKER_NAME = workerName;
    process.env.OMX_TEAM_WORKER_TEAM_NAME = team;
    process.env.OMX_TEAM_WORKER_TEAM_LEADER = 'leader-1';
    process.env.OMX_TEAM_WORKER_INTERNAL_CANONICAL = 'true';

    try {
      // Invoke Stop hook while team has a stale lock
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "test-stop-hook",
          stop_hook_active: false,
        },
        { cwd },
      );

      // Exact assertions for terminal output: continue:false, no decision, no reason
      assert.ok(result.outputJson, 'outputJson must be present');
      const outputJson = result.outputJson as Record<string, unknown>;
      
      assert.strictEqual(
        outputJson.continue,
        false,
        'continue must be false to make Stop terminal'
      );
      
      assert.strictEqual(
        outputJson.decision,
        undefined,
        'decision must be undefined for terminal output (no decision property)'
      );
      
      assert.strictEqual(
        outputJson.reason,
        undefined,
        'reason must be undefined so model never receives recovery instructions'
      );
      
      assert.strictEqual(
        outputJson.stopReason,
        'team_lock_recovery_required',
        'stopReason must identify the lock recovery issue'
      );
      
      // Recovery steps must be only in systemMessage, never exposed to model as decision/reason
      const systemMessage = String(outputJson.systemMessage || '');
      assert.ok(
        systemMessage.length > 0,
        'systemMessage must contain recovery instructions'
      );
      assert.ok(
        systemMessage.includes('stale lock') || systemMessage.includes(lockDir),
        'systemMessage must describe the stale lock location'
      );
    } finally {
      process.env = originalEnv;
    }
  });

  it('two consecutive Stop invocations are both terminal with lock preserved', async () => {
    const cwd = await workspace();
    const team = 'audit';
    const workerName = 'executor-1';

    // Initialize team state
    await initTeamState(team, 'lock preservation test', 'executor', 1, cwd);

    const lockDir = join(cwd, '.omx/state/.team-locks', `${team}.membership`);
    const staleLockToken = '99999999.0.dead';
    await staleLock(lockDir, staleLockToken);

    // Write worker identity
    await writeWorkerIdentity(team, workerName, {
      name: workerName,
      index: 1,
      role: 'executor',
      assigned_tasks: [],
    }, cwd);

    const originalEnv = process.env;
    process.env.OMX_TEAM_WORKER_NAME = workerName;
    process.env.OMX_TEAM_WORKER_TEAM_NAME = team;
    process.env.OMX_TEAM_WORKER_TEAM_LEADER = 'leader-1';
    process.env.OMX_TEAM_WORKER_INTERNAL_CANONICAL = 'true';

    try {
      // First Stop invocation
      const result1 = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "test-stop-hook-1",
          stop_hook_active: false,
        },
        { cwd },
      );

      assert.ok(result1.outputJson, 'First Stop result must have outputJson');
      const output1 = result1.outputJson as Record<string, unknown>;
      assert.strictEqual(
        output1.continue,
        false,
        'First Stop must have continue:false (terminal)'
      );
      assert.strictEqual(
        output1.stopReason,
        'team_lock_recovery_required',
        'First Stop must identify lock recovery reason'
      );

      // Verify lock state is preserved after first Stop
      let owner = await readFile(join(lockDir, 'owner'), 'utf8');
      let lease = await readFile(join(lockDir, 'lease'), 'utf8');
      assert.strictEqual(owner, staleLockToken, 'Lock owner must be preserved after first Stop');
      assert.strictEqual(lease, 'abandoned', 'Lock lease must be preserved after first Stop');

      // Second Stop invocation (simulating operator retrying after fixing)
      const result2 = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "test-stop-hook-2",
          stop_hook_active: false,
        },
        { cwd },
      );

      assert.ok(result2.outputJson, 'Second Stop result must have outputJson');
      const output2 = result2.outputJson as Record<string, unknown>;
      assert.strictEqual(
        output2.continue,
        false,
        'Second Stop must have continue:false (terminal)'
      );
      assert.strictEqual(
        output2.stopReason,
        'team_lock_recovery_required',
        'Second Stop must identify lock recovery reason'
      );

      // Verify lock state is still preserved
      owner = await readFile(join(lockDir, 'owner'), 'utf8');
      lease = await readFile(join(lockDir, 'lease'), 'utf8');
      assert.strictEqual(owner, staleLockToken, 'Lock owner must be preserved after second Stop');
      assert.strictEqual(lease, 'abandoned', 'Lock lease must be preserved after second Stop');
    } finally {
      process.env = originalEnv;
    }
  });
});
