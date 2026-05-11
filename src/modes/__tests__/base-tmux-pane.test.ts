import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMode } from '../base.js';

const STATE_ENV_KEYS = [
  'OMX_ROOT',
  'OMX_STATE_ROOT',
  'OMX_TEAM_STATE_ROOT',
  'OMX_SESSION_ID',
  'CODEX_SESSION_ID',
  'SESSION_ID',
] as const;

async function withIsolatedStateEnv(fn: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of STATE_ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    await fn();
  } finally {
    for (const key of STATE_ENV_KEYS) {
      const value = previous.get(key);
      if (typeof value === 'string') process.env[key] = value;
      else delete process.env[key];
    }
  }
}

describe('modes/base tmux pane capture', () => {
  it('captures tmux_pane_id in mode state on startMode()', async () => {
    await withIsolatedStateEnv(async () => {
      const prev = process.env.TMUX_PANE;
      process.env.TMUX_PANE = '%123';
      const wd = await mkdtemp(join(tmpdir(), 'omx-mode-pane-'));
      try {
        await startMode('ralph', 'test', 1, wd);
        const raw = JSON.parse(await readFile(join(wd, '.omx', 'state', 'ralph-state.json'), 'utf-8'));
        assert.equal(raw.tmux_pane_id, '%123');
        assert.ok(typeof raw.tmux_pane_set_at === 'string' && raw.tmux_pane_set_at.length > 0);
      } finally {
        if (typeof prev === 'string') process.env.TMUX_PANE = prev;
        else delete process.env.TMUX_PANE;
        await rm(wd, { recursive: true, force: true });
      }
    });
  });

  it('blocks exclusive mode startup when another exclusive state file is malformed', async () => {
    await withIsolatedStateEnv(async () => {
      const wd = await mkdtemp(join(tmpdir(), 'omx-mode-malformed-'));
      try {
        const stateDir = join(wd, '.omx', 'state');
        await mkdir(stateDir, { recursive: true });
        await writeFile(join(stateDir, 'ralph-state.json'), '{ "active": true');

        await assert.rejects(
          () => startMode('autopilot', 'test', 1, wd),
          /repair or clear that workflow state yourself via `omx state clear --input '\{"mode":"ralph"\}' --json`/i,
        );
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    });
  });
});
