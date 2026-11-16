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
  it('stop hook with stale team lock should NOT tell Codex to continue', async () => {
    const cwd = await workspace();
    const team = 'audit';
    const workerName = 'executor-1';

    // Initialize team state
    await initTeamState(team, 'stop hook lock test', 'executor', 1, cwd);

    // Set up team worker context in environment
    const stateDir = join(cwd, '.omx/state');
    const teamDir = join(stateDir, 'team', team);

    // Write worker identity to make this appear as a team worker
    await writeWorkerIdentity(team, workerName, {
      name: workerName,
      index: 1,
      role: 'executor',
      assigned_tasks: [],
    }, cwd);

    // Create a stale team membership lock
    const lockDir = join(cwd, '.omx/state/.team-locks', `${team}.membership`);
    await staleLock(lockDir, '99999999.0.dead');

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

      // The Stop hook should return a terminal response with continue:false
      // NOT continue:true or decision:block which would cause re-prompting
      assert.ok(result.outputJson, "Stop hook should return output JSON");
      const output = result.outputJson;
      assert.strictEqual(
        output.continue,
        false,
        "Stop hook must return continue:false for team_lock_recovery_required"
      );
      assert.strictEqual(
        output.stopReason,
        "team_lock_recovery_required",
        "Stop hook must return stopReason:team_lock_recovery_required"
      );
      const systemMessage = String(output.systemMessage || "");
      assert.ok(
        systemMessage.includes("stale team lock"),
        "System message should mention stale team lock"
      );
      assert.ok(
        systemMessage.includes(lockDir),
        "System message should include the lock directory path for manual recovery"
      );
      assert.ok(
        !systemMessage.includes("Continue once more"),
        "System message should NOT tell Codex to continue"
      );
    } finally {
      process.env = originalEnv;
    }
  });

  it('preserves lock state when stop hook encounters stale lock', async () => {
    const cwd = await workspace();
    const team = 'audit';

    // Initialize team state
    await initTeamState(team, 'lock preservation test', 'executor', 1, cwd);

    const lockDir = join(cwd, '.omx/state/.team-locks', `${team}.membership`);
    const staleLockToken = '99999999.0.dead';
    await staleLock(lockDir, staleLockToken);

    // Verify lock state before Stop hook
    const beforeOwner = await readFile(join(lockDir, 'owner'), 'utf8');
    const beforeLease = await readFile(join(lockDir, 'lease'), 'utf8');
    assert.equal(beforeOwner, staleLockToken);
    assert.equal(beforeLease, 'abandoned');

    // Write worker identity to make this appear as a team worker
    const workerName = 'executor-1';
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
      // Invoke Stop hook
      await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "test-stop-hook",
          stop_hook_active: false,
        },
        { cwd },
      );

      // Verify lock state is preserved (not auto-deleted)
      const afterOwner = await readFile(join(lockDir, 'owner'), 'utf8');
      const afterLease = await readFile(join(lockDir, 'lease'), 'utf8');
      assert.equal(afterOwner, staleLockToken, "Lock owner should be preserved");
      assert.equal(afterLease, 'abandoned', "Lock lease should be preserved");
    } finally {
      process.env = originalEnv;
    }
  });
});
