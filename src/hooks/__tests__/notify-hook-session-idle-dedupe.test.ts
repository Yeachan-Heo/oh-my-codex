import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SESSION_ID = 'sess-idle-dedupe';

function buildSessionIdlePlugin(targetPath: string): string {
  return `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const TARGET_PATH = ${JSON.stringify(targetPath)};

export async function onHookEvent(event) {
  if (event.event !== 'session-idle') return;
  mkdirSync(dirname(TARGET_PATH), { recursive: true });
  let count = 0;
  try {
    const existing = JSON.parse(readFileSync(TARGET_PATH, 'utf-8'));
    count = Number(existing?.count) || 0;
  } catch {
    count = 0;
  }
  writeFileSync(TARGET_PATH, JSON.stringify({
    count: count + 1,
    last_reason: event.context?.reason || '',
    last_status: event.context?.status || '',
    last_session_name: event.context?.session_name || '',
  }, null, 2));
}
`;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf-8')) as T;
}

function runNotifyHook(
  repoRoot: string,
  cwd: string,
  lastAssistantMessage: string,
  turnId: string,
  envOverrides: Record<string, string> = {},
) {
  const payload = {
    cwd,
    type: 'agent-turn-complete',
    thread_id: 'thread-session-idle',
    turn_id: turnId,
    input_messages: [],
    last_assistant_message: lastAssistantMessage,
  };

  return spawnSync(process.execPath, ['dist/scripts/notify-hook.js', JSON.stringify(payload)], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: {
      ...process.env,
      OMX_TEAM_WORKER: '',
      TMUX: '',
      TMUX_PANE: '',
      ...envOverrides,
    },
  });
}

describe('notify-hook session-idle dedupe', () => {
  it('suppresses repeated unchanged post_turn_idle_notification hook events once the first hook dispatch succeeds', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-idle-dedupe-'));
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

    try {
      const stateDir = join(wd, '.omx', 'state');
      const hooksDir = join(wd, '.omx', 'hooks');
      const pluginStatePath = join(wd, '.omx', 'plugin-state', 'session-idle.json');
      const hookStatePath = join(stateDir, 'sessions', SESSION_ID, 'session-idle-hook-state.json');

      await mkdir(stateDir, { recursive: true });
      await mkdir(hooksDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: SESSION_ID }, null, 2));
      await writeFile(join(hooksDir, 'session-idle-counter.mjs'), buildSessionIdlePlugin(pluginStatePath), 'utf-8');

      const first = runNotifyHook(repoRoot, wd, 'Waiting for your next instruction.', 'turn-idle-1');
      assert.equal(first.status, 0, first.stderr || first.stdout);

      const second = runNotifyHook(repoRoot, wd, 'Waiting for your next instruction.', 'turn-idle-2');
      assert.equal(second.status, 0, second.stderr || second.stdout);

      const pluginState = await readJson<{ count: number; last_reason: string; last_status: string }>(pluginStatePath);
      assert.equal(pluginState.count, 1);
      assert.equal(pluginState.last_reason, 'post_turn_idle_notification');
      assert.equal(pluginState.last_status, 'blocked');
      assert.equal(existsSync(hookStatePath), true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('re-emits session-idle hook events when the idle fingerprint meaningfully changes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-idle-dedupe-change-'));
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

    try {
      const stateDir = join(wd, '.omx', 'state');
      const hooksDir = join(wd, '.omx', 'hooks');
      const pluginStatePath = join(wd, '.omx', 'plugin-state', 'session-idle.json');

      await mkdir(stateDir, { recursive: true });
      await mkdir(hooksDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: SESSION_ID }, null, 2));
      await writeFile(join(hooksDir, 'session-idle-counter.mjs'), buildSessionIdlePlugin(pluginStatePath), 'utf-8');

      const first = runNotifyHook(repoRoot, wd, 'Waiting on review.', 'turn-idle-3');
      assert.equal(first.status, 0, first.stderr || first.stdout);

      const second = runNotifyHook(repoRoot, wd, 'Waiting on user input.', 'turn-idle-4');
      assert.equal(second.status, 0, second.stderr || second.stdout);

      const pluginState = await readJson<{ count: number }>(pluginStatePath);
      assert.equal(pluginState.count, 2);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps post_turn_idle_notification hook dedupe active even when lifecycle cooldown is disabled', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-idle-dedupe-zero-cooldown-'));
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

    try {
      const stateDir = join(wd, '.omx', 'state');
      const hooksDir = join(wd, '.omx', 'hooks');
      const pluginStatePath = join(wd, '.omx', 'plugin-state', 'session-idle.json');

      await mkdir(stateDir, { recursive: true });
      await mkdir(hooksDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: SESSION_ID }, null, 2));
      await writeFile(join(hooksDir, 'session-idle-counter.mjs'), buildSessionIdlePlugin(pluginStatePath), 'utf-8');

      const first = runNotifyHook(repoRoot, wd, 'Waiting for your next instruction.', 'turn-idle-5', {
        OMX_IDLE_COOLDOWN_SECONDS: '0',
      });
      assert.equal(first.status, 0, first.stderr || first.stdout);

      const second = runNotifyHook(repoRoot, wd, 'Waiting for your next instruction.', 'turn-idle-6', {
        OMX_IDLE_COOLDOWN_SECONDS: '0',
      });
      assert.equal(second.status, 0, second.stderr || second.stdout);

      const pluginState = await readJson<{ count: number; last_reason: string }>(pluginStatePath);
      assert.equal(pluginState.count, 1);
      assert.equal(pluginState.last_reason, 'post_turn_idle_notification');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
