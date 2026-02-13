import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOTIFY_HOOK_SCRIPT = new URL('../../../scripts/notify-hook.js', import.meta.url);

async function withTempWorkingDir(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-notify-linked-sync-'));
  await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function runNotifyHook(cwd: string, extraPayload: Record<string, unknown> = {}): void {
  const payload = {
    cwd,
    type: 'agent-turn-complete',
    'thread-id': 'thread-test',
    'turn-id': 'turn-test',
    'input-messages': ['test input'],
    'last-assistant-message': 'test output',
    ...extraPayload,
  };

  const result = spawnSync(process.execPath, [NOTIFY_HOOK_SCRIPT.pathname, JSON.stringify(payload)], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2));
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf-8')) as T;
}

describe('notify-hook linked team -> ralph terminal sync', () => {
  it('updates root ralph state when linked team enters terminal phase', async () => {
    await withTempWorkingDir(async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      const teamStatePath = join(stateDir, 'team-state.json');
      const ralphStatePath = join(stateDir, 'ralph-state.json');

      await writeJson(teamStatePath, {
        active: false,
        current_phase: 'complete',
        linked_ralph: true,
        completed_at: '2026-02-10T00:00:00.000Z',
      });
      await writeJson(ralphStatePath, {
        active: true,
        current_phase: 'execution',
        linked_team: true,
      });

      runNotifyHook(cwd);

      const ralphState = await readJson<Record<string, unknown>>(ralphStatePath);
      assert.equal(ralphState.active, false);
      assert.equal(ralphState.current_phase, 'complete');
      assert.equal(ralphState.linked_team_terminal_phase, 'complete');
      assert.equal(ralphState.linked_team_terminal_at, '2026-02-10T00:00:00.000Z');
      assert.equal(ralphState.completed_at, '2026-02-10T00:00:00.000Z');
      assert.ok(typeof ralphState.last_turn_at === 'string');
    });
  });

  it('updates session-scoped ralph state when linked session team enters terminal phase', async () => {
    await withTempWorkingDir(async (cwd) => {
      const sessionId = 'session_1';
      const sessionStateDir = join(cwd, '.omx', 'state', 'sessions', sessionId);
      const teamStatePath = join(sessionStateDir, 'team-state.json');
      const ralphStatePath = join(sessionStateDir, 'ralph-state.json');

      await mkdir(sessionStateDir, { recursive: true });
      await writeJson(teamStatePath, {
        active: false,
        current_phase: 'failed',
        linked_ralph: true,
      });
      await writeJson(ralphStatePath, {
        active: true,
        current_phase: 'execution',
        linked_team: true,
      });

      runNotifyHook(cwd);

      const ralphState = await readJson<Record<string, unknown>>(ralphStatePath);
      assert.equal(ralphState.active, false);
      assert.equal(ralphState.current_phase, 'failed');
      assert.equal(ralphState.linked_team_terminal_phase, 'failed');
      assert.ok(typeof ralphState.linked_team_terminal_at === 'string');
      assert.ok(typeof ralphState.completed_at === 'string');
      assert.ok(typeof ralphState.last_turn_at === 'string');
    });
  });

  it('does not update ralph state when team/ralph are not linked', async () => {
    await withTempWorkingDir(async (cwd) => {
      const stateDir = join(cwd, '.omx', 'state');
      const teamStatePath = join(stateDir, 'team-state.json');
      const ralphStatePath = join(stateDir, 'ralph-state.json');

      await writeJson(teamStatePath, {
        active: false,
        current_phase: 'complete',
        linked_ralph: false,
      });
      await writeJson(ralphStatePath, {
        active: true,
        current_phase: 'execution',
        linked_team: false,
      });

      runNotifyHook(cwd);

      const ralphState = await readJson<Record<string, unknown>>(ralphStatePath);
      assert.equal(ralphState.active, true);
      assert.equal(ralphState.current_phase, 'execution');
      assert.equal(ralphState.linked_team_terminal_phase, undefined);
      assert.equal(ralphState.linked_team_terminal_at, undefined);
    });
  });
});
