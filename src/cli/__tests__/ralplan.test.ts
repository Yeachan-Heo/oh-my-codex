import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { readSubagentTrackingState } from '../../subagents/tracker.js';
import { ralplanCommand } from '../ralplan.js';

async function invokeRoleIntent(cwd: string, args: string[]): Promise<{
  stdout: string[];
  stderr: string[];
  exitCode: number | undefined;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    await ralplanCommand(args, {
      cwd: () => cwd,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    return { stdout, stderr, exitCode: process.exitCode };
  } finally {
    process.exitCode = previousExitCode;
  }
}

async function writeCurrentSession(
  cwd: string,
  sessionId: string,
  nativeLeaderThreadId: string,
  trackerLeaderThreadId: string,
): Promise<void> {
  const stateDir = join(cwd, '.omx', 'state');
  const now = '2026-07-14T00:00:00.000Z';
  await mkdir(stateDir, { recursive: true });
  await Promise.all([
    writeFile(join(stateDir, 'session.json'), JSON.stringify({
      session_id: sessionId,
      native_session_id: nativeLeaderThreadId,
      started_at: now,
      cwd,
    })),
    writeFile(join(stateDir, 'subagent-tracking.json'), JSON.stringify({
      schemaVersion: 1,
      sessions: {
        [sessionId]: {
          session_id: sessionId,
          leader_thread_id: trackerLeaderThreadId,
          updated_at: now,
          threads: {},
        },
      },
      pending_role_intents: [],
    })),
  ]);
}

describe('ralplan role-intent write', () => {
  it('rejects a supplied session that is not the current runtime session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-role-intent-'));
    try {
      await writeCurrentSession(cwd, 'current-session', 'native-leader', 'tracker-leader');

      const result = await invokeRoleIntent(cwd, [
        'role-intent', 'write', '--role', 'architect', '--parent-thread', 'tracker-leader', '--session', 'other-session', '--json',
      ]);

      assert.equal(result.exitCode, 1);
      assert.deepEqual(result.stderr, []);
      assert.deepEqual(JSON.parse(result.stdout.join('\n')), { ok: false, reason: 'session_not_current' });
      assert.deepEqual((await readSubagentTrackingState(cwd)).pending_role_intents, []);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects a parent thread that is not the current session leader', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-role-intent-'));
    try {
      await writeCurrentSession(cwd, 'current-session', 'native-leader', 'tracker-leader');

      const result = await invokeRoleIntent(cwd, [
        'role-intent', 'write', '--role', 'architect', '--parent-thread', 'untrusted-parent', '--json',
      ]);

      assert.equal(result.exitCode, 1);
      assert.deepEqual(result.stderr, []);
      assert.deepEqual(JSON.parse(result.stdout.join('\n')), { ok: false, reason: 'parent_not_active_leader' });
      assert.deepEqual((await readSubagentTrackingState(cwd)).pending_role_intents, []);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('records the authenticated current-session native leader intent with a correlation token receipt', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-role-intent-'));
    try {
      await writeCurrentSession(cwd, 'current-session', 'native-leader', 'tracker-leader');

      const result = await invokeRoleIntent(cwd, [
        'role-intent', 'write', '--role', 'ARCHITECT', '--parent-thread', 'native-leader', '--ttl-ms', '5000', '--json',
      ]);

      assert.equal(result.exitCode, undefined);
      assert.deepEqual(result.stderr, []);
      const receipt = JSON.parse(result.stdout.join('\n')) as {
        ok: boolean;
        intent: {
          role: string;
          session_id: string;
          parent_thread_id: string;
          correlation_token: string;
          expires_at: string;
        };
      };
      assert.equal(receipt.ok, true);
      assert.deepEqual(Object.keys(receipt.intent), ['role', 'session_id', 'parent_thread_id', 'correlation_token', 'expires_at']);
      assert.equal(receipt.intent.role, 'architect');
      assert.equal(receipt.intent.session_id, 'current-session');
      assert.equal(receipt.intent.parent_thread_id, 'native-leader');
      assert.match(receipt.intent.correlation_token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      assert.ok(Number.isFinite(Date.parse(receipt.intent.expires_at)));
      assert.equal((await readSubagentTrackingState(cwd)).pending_role_intents[0]?.correlation_token, receipt.intent.correlation_token);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
